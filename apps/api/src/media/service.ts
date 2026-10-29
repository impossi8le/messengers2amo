import { randomBytes } from 'node:crypto';
import type { Db } from '../platform/db.ts';
import { withTransaction } from '../platform/db.ts';
import type { ObjectStorage } from './storage.ts';
import { sha256Hex } from './storage.ts';
import {
  defaultLimits,
  displayNameFromStorageKey,
  isAllowedMimeType,
  normalizeMimeType,
  PLACEHOLDER_MIME_TYPE,
  PLACEHOLDER_NAME_PREFIX,
  sanitizeFileName,
  type MediaLimits,
} from './policy.ts';
import { fetchRemoteObject, type RemoteFetchPolicy } from './ssrf.ts';
import { checkContentType } from './sniff.ts';

export type MediaErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'STALE_EPOCH'
  | 'CAPABILITY_BLOCKED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export class MediaError extends Error {
  readonly statusCode: number;
  readonly code: MediaErrorCode;
  readonly retryable: boolean;

  constructor(statusCode: number, code: MediaErrorCode, retryable = false) {
    super(code);
    this.name = 'MediaError';
    this.statusCode = statusCode;
    this.code = code;
    this.retryable = retryable;
  }
}

export type MediaAssetState = 'pending_upload' | 'quarantined' | 'ready' | 'rejected';

export type MediaAssetView = {
  id: string;
  state: MediaAssetState;
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string | null;
};

export type MediaUploadAccepted = {
  asset: MediaAssetView;
  uploadPath: string;
  expiresAt: string;
};

export type MediaAccessGrant = {
  mediaId: string;
  expiresAt: string;
  downloadPath: string;
};

export type UploadRequestInput = {
  idempotencyKey: string;
  displayName: string;
  mimeType: string;
  sizeBytes: number;
};

export type InboundAttachmentInput = {
  companyId: string;
  conversationId: string;
  connectionId: string;
  bindingEpoch: number;
  externalChatId: string;
  messageId: string;
  externalMessageId: string | null;
  externalAttachmentId: string;
  fileName: string;
  declaredMimeType: string;
  bytes: Uint8Array | null;
  remoteUrl?: string | null;
  /** Provider download was refused before bytes became available. */
  unavailableReason?: 'too_large' | 'provider_rejected';
  declaredSha256?: string | null;
};

export type IngestResult = {
  attachmentId: string;
  mediaId: string | null;
  accepted: boolean;
  reason: string | null;
  duplicate: boolean;
};

export type AttachmentReplyInput = {
  idempotencyKey: string;
  snapshotId: string;
  expectedAssignmentVersion: number;
  selectedObligations: Array<{ obligationId: string; contentVersion: number }>;
  mediaIds: string[];
  caption: string;
  deadline: string;
};

export type MediaServiceDeps = {
  db: Db;
  schema: string;
  storage: ObjectStorage;
  sessionSecret: string;
  now?: () => number;
  limits?: Partial<MediaLimits>;
  remoteFetch?: RemoteFetchPolicy | null;
  archiveContractRef?: string | null;
  uploadTtlSeconds?: number;
  grantTtlSeconds?: number;
};

type MediaRow = {
  id: string;
  state: MediaAssetState;
  storage_key: string | null;
  reservation_id: string | null;
  expires_at: Date | null;
  mime_type: string | null;
  byte_size: string | number | null;
  sha256: string | null;
};

type AttachmentRow = {
  id: string;
  s3_key: string | null;
  storage_state: string;
  archive_status: string;
  mime_type: string;
  original_name: string;
};

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_UPLOAD_TTL_SECONDS = 900;
const DEFAULT_GRANT_TTL_SECONDS = 300;

function isoTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

function mediaPath(id: string): string {
  return `/api/v2/media/${encodeURIComponent(id)}/content`;
}

/**
 * Per-attempt object key: the filename stays the last segment (it drives the display
 * name), while an attempt directory isolates concurrent writers of one asset.
 */
function attemptStorageKey(storageKey: string): string {
  const slash = storageKey.lastIndexOf('/');
  const directory = slash === -1 ? '' : storageKey.slice(0, slash + 1);
  const fileName = slash === -1 ? storageKey : storageKey.slice(slash + 1);
  return `${directory}attempt-${randomBytes(8).toString('hex')}/${fileName}`;
}

function numberOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class MediaService {
  private readonly deps: MediaServiceDeps;
  private readonly limits: MediaLimits;
  private readonly grants = new Map<string, number>();

  // An expired grant is only deleted when that same key is read again, so grants
  // that are issued and never used would stay for the life of the process. Sweep
  // on issue instead: grants are short-lived, so this keeps the map bounded.
  private pruneExpiredGrants(): void {
    const now = this.now();
    for (const [key, expiresAtMs] of this.grants) {
      if (expiresAtMs <= now) this.grants.delete(key);
    }
  }

  constructor(deps: MediaServiceDeps) {
    if (!SCHEMA_PATTERN.test(deps.schema)) throw new Error('INVALID_SCHEMA');
    this.deps = deps;
    this.limits = defaultLimits(deps.limits);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private table(name: string): string {
    return `"${this.deps.schema}"."${name}"`;
  }

  private toView(row: MediaRow): MediaAssetView {
    const key = row.storage_key ?? '';
    return {
      id: row.id,
      state: row.state,
      displayName: key ? displayNameFromStorageKey(key) : 'attachment',
      mimeType: row.mime_type ?? PLACEHOLDER_MIME_TYPE,
      sizeBytes: numberOrNull(row.byte_size) ?? 0,
      sha256: row.sha256,
    };
  }

  private async loadAsset(companyId: string, mediaId: string): Promise<MediaRow> {
    const { rows } = await this.deps.db.query<MediaRow>(
      `SELECT id, state, storage_key, reservation_id, expires_at, mime_type, byte_size, sha256
         FROM ${this.table('media_assets')} WHERE company_id=$1 AND id=$2`,
      [companyId, mediaId],
    );
    const row = rows[0];
    if (!row) throw new MediaError(404, 'NOT_FOUND');
    return row;
  }

  async requestUpload(companyId: string, input: UploadRequestInput): Promise<MediaUploadAccepted> {
    if (input.sizeBytes > this.limits.maxFileBytes) throw new MediaError(413, 'VALIDATION_FAILED');
    const mimeType = normalizeMimeType(input.mimeType);
    if (!isAllowedMimeType(mimeType, this.limits.allowedMimeTypes)) {
      throw new MediaError(415, 'VALIDATION_FAILED');
    }
    if (!mimeType) throw new MediaError(415, 'VALIDATION_FAILED');
    const displayName = sanitizeFileName(input.displayName);

    const existing = await this.deps.db.query<MediaRow>(
      `SELECT id, state, storage_key, reservation_id, expires_at, mime_type, byte_size, sha256
         FROM ${this.table('media_assets')} WHERE company_id=$1 AND reservation_id=$2`,
      [companyId, input.idempotencyKey],
    );
    const row = existing.rows[0];
    if (row) {
      const sameRequest =
        row.mime_type === mimeType &&
        numberOrNull(row.byte_size) === input.sizeBytes &&
        (row.storage_key ?? '').endsWith(`/${displayName}`);
      if (!sameRequest) throw new MediaError(409, 'IDEMPOTENCY_CONFLICT');
      return {
        asset: this.toView(row),
        uploadPath: mediaPath(row.id),
        expiresAt: isoTimestamp(row.expires_at ? row.expires_at.getTime() : this.now()),
      };
    }

    const id = `med_${randomBytes(16).toString('hex')}`;
    const storageKey = `media/${sanitizeFileName(companyId)}/${id}/${displayName}`;
    const expiresAtMs = this.now() + (this.deps.uploadTtlSeconds ?? DEFAULT_UPLOAD_TTL_SECONDS) * 1000;
    const inserted = await this.deps.db.query<MediaRow>(
      `INSERT INTO ${this.table('media_assets')}
         (company_id,id,state,storage_key,reservation_id,expires_at,mime_type,byte_size)
       VALUES ($1,$2,'pending_upload',$3,$4,$5,$6,$7)
       RETURNING id, state, storage_key, reservation_id, expires_at, mime_type, byte_size, sha256`,
      [companyId, id, storageKey, input.idempotencyKey, new Date(expiresAtMs), mimeType, input.sizeBytes],
    );
    const created = inserted.rows[0];
    if (!created) throw new MediaError(500, 'INTERNAL_ERROR');
    return { asset: this.toView(created), uploadPath: mediaPath(id), expiresAt: isoTimestamp(expiresAtMs) };
  }

  async uploadBytes(
    companyId: string,
    mediaId: string,
    bytes: Uint8Array,
    declaredSha256?: string | null,
  ): Promise<MediaAssetView> {
    const asset = await this.loadAsset(companyId, mediaId);
    const computed = sha256Hex(bytes);

    if (asset.state === 'ready') {
      if (asset.sha256 === computed && numberOrNull(asset.byte_size) === bytes.byteLength) {
        return this.toView(asset);
      }
      throw new MediaError(409, 'IDEMPOTENCY_CONFLICT');
    }
    if (asset.state !== 'pending_upload') throw new MediaError(409, 'VERSION_CONFLICT');
    if (asset.expires_at && asset.expires_at.getTime() <= this.now()) throw new MediaError(404, 'NOT_FOUND');
    if (bytes.byteLength > this.limits.maxFileBytes) throw new MediaError(413, 'VALIDATION_FAILED');
    if (numberOrNull(asset.byte_size) !== bytes.byteLength) throw new MediaError(422, 'VALIDATION_FAILED');

    if (declaredSha256 !== null && declaredSha256 !== undefined) {
      const declared = declaredSha256.trim().toLowerCase();
      if (!SHA256_PATTERN.test(declared) || declared !== computed) {
        await this.rejectAsset(companyId, mediaId);
        throw new MediaError(422, 'VALIDATION_FAILED');
      }
    }

    // The declared MIME type is only a claim: the bytes and the file name must agree
    // with it, or the asset is rejected instead of being published as `ready`.
    const declaredType = asset.mime_type ?? PLACEHOLDER_MIME_TYPE;
    const fileName = displayNameFromStorageKey(asset.storage_key ?? '');
    const verdict = checkContentType(bytes, declaredType, fileName);
    if (!verdict.ok) {
      await this.rejectAsset(companyId, mediaId);
      throw new MediaError(422, 'VALIDATION_FAILED');
    }

    const storageKey = asset.storage_key;
    if (!storageKey) throw new MediaError(409, 'VERSION_CONFLICT');
    // Each attempt writes its own object. The CAS below publishes that key together
    // with `ready`, so a losing attempt can never overwrite the winner's bytes.
    const attemptKey = attemptStorageKey(storageKey);
    await this.deps.storage.put(attemptKey, bytes, asset.mime_type ?? PLACEHOLDER_MIME_TYPE);
    const head = await this.deps.storage.head(attemptKey);
    // Storage may be unable to report a digest (plain S3 HEAD); the locally computed
    // digest still stands. A reported digest must match exactly.
    if (!head || head.sizeBytes !== bytes.byteLength || (head.sha256 !== '' && head.sha256 !== computed)) {
      await this.deps.storage.remove(attemptKey).catch(() => undefined);
      await this.deps.db.query(
        `UPDATE ${this.table('media_assets')} SET state='quarantined'
          WHERE company_id=$1 AND id=$2 AND state='pending_upload'`,
        [companyId, mediaId],
      );
      throw new MediaError(503, 'UPSTREAM_UNAVAILABLE', true);
    }

    const updated = await this.deps.db.query<MediaRow>(
      `UPDATE ${this.table('media_assets')}
          SET state='ready', sha256=$3, byte_size=$4, storage_key=$5
        WHERE company_id=$1 AND id=$2 AND state='pending_upload'
        RETURNING id, state, storage_key, reservation_id, expires_at, mime_type, byte_size, sha256`,
      [companyId, mediaId, computed, bytes.byteLength, attemptKey],
    );
    const ready = updated.rows[0];
    if (!ready) {
      // Unreferenced attempt object; never leave it behind.
      await this.deps.storage.remove(attemptKey).catch(() => undefined);
      const current = await this.loadAsset(companyId, mediaId);
      if (current.state === 'ready' && current.sha256 === computed) return this.toView(current);
      throw new MediaError(409, 'VERSION_CONFLICT');
    }
    return this.toView(ready);
  }

  private async rejectAsset(companyId: string, mediaId: string): Promise<void> {
    await this.deps.db.query(
      `UPDATE ${this.table('media_assets')} SET state='rejected'
        WHERE company_id=$1 AND id=$2 AND state='pending_upload'`,
      [companyId, mediaId],
    );
  }

  /**
   * Workshop scope applies to every media operation, before any metadata, state or
   * bytes are revealed. Media inherits its workshop from the conversations it is
   * attached to; an unattached operator upload stays company-scoped. A foreign asset
   * is reported exactly like a missing one so its existence never leaks.
   */
  private async assertWorkshopAccess(
    companyId: string,
    workshopId: string | null,
    storageKey: string,
  ): Promise<void> {
    if (workshopId === null) return;
    const { rows } = await this.deps.db.query<{ linked: boolean; allowed: boolean }>(
      `SELECT
         EXISTS (SELECT 1 FROM ${this.table('attachments')} a
                  WHERE a.company_id=$1 AND a.s3_key=$2) AS linked,
         EXISTS (SELECT 1 FROM ${this.table('attachments')} a
                   JOIN ${this.table('connection_routes')} r
                     ON r.company_id=a.company_id AND r.connection_id=a.connection_id
                  WHERE a.company_id=$1 AND a.s3_key=$2 AND r.workshop_id=$3) AS allowed`,
      [companyId, storageKey, workshopId],
    );
    const row = rows[0];
    if (row?.linked && !row.allowed) throw new MediaError(404, 'NOT_FOUND');
  }

  async getAsset(companyId: string, workshopId: string | null, mediaId: string): Promise<MediaAssetView> {
    const asset = await this.loadAsset(companyId, mediaId);
    await this.assertWorkshopAccess(companyId, workshopId, asset.storage_key ?? '');
    return this.toView(asset);
  }

  /**
   * Media access follows the conversation/channel it came from. Operator uploads
   * that are not attached to any channel stay company-scoped.
   */
  private async assertReadAccess(companyId: string, staffId: string, role: string, storageKey: string): Promise<void> {
    if (role === 'admin' || role === 'manage') return;
    const linked = await this.deps.db.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM ${this.table('attachments')} a
           JOIN ${this.table('channel_permissions')} p
             ON p.company_id=a.company_id AND p.connection_id=a.connection_id AND p.staff_id=$3
          WHERE a.company_id=$1 AND a.s3_key=$2 AND p.can_read
       ) AS allowed`,
      [companyId, storageKey, staffId],
    );
    if (linked.rows[0]?.allowed) return;
    const anyLink = await this.deps.db.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${this.table('attachments')} WHERE company_id=$1 AND s3_key=$2) AS present`,
      [companyId, storageKey],
    );
    if (anyLink.rows[0]?.present) throw new MediaError(403, 'FORBIDDEN');
  }

  async issueAccessGrant(
    companyId: string,
    staffId: string,
    role: string,
    workshopId: string | null,
    mediaId: string,
  ): Promise<MediaAccessGrant> {
    const asset = await this.loadAsset(companyId, mediaId);
    // Authorization comes before state: a foreign asset must look missing, never 409.
    await this.assertWorkshopAccess(companyId, workshopId, asset.storage_key ?? '');
    if (asset.state !== 'ready' || !asset.storage_key) throw new MediaError(409, 'VERSION_CONFLICT');
    await this.assertReadAccess(companyId, staffId, role, asset.storage_key);
    const expiresAtMs = this.now() + (this.deps.grantTtlSeconds ?? DEFAULT_GRANT_TTL_SECONDS) * 1000;
    this.pruneExpiredGrants();
    this.grants.set(`${companyId}:${staffId}:${mediaId}`, expiresAtMs);
    return { mediaId, expiresAt: isoTimestamp(expiresAtMs), downloadPath: mediaPath(mediaId) };
  }

  async readContent(
    companyId: string,
    staffId: string,
    role: string,
    workshopId: string | null,
    mediaId: string,
  ): Promise<{ bytes: Uint8Array; mimeType: string; fileName: string }> {
    const asset = await this.loadAsset(companyId, mediaId);
    // Same order as the grant: workshop, then grant, then resource state.
    await this.assertWorkshopAccess(companyId, workshopId, asset.storage_key ?? '');
    const expiresAtMs = this.grants.get(`${companyId}:${staffId}:${mediaId}`);
    if (!expiresAtMs || expiresAtMs <= this.now()) {
      this.grants.delete(`${companyId}:${staffId}:${mediaId}`);
      throw new MediaError(403, 'FORBIDDEN');
    }
    await this.assertReadAccess(companyId, staffId, role, asset.storage_key ?? '');
    if (asset.state !== 'ready' || !asset.storage_key) throw new MediaError(409, 'VERSION_CONFLICT');
    const bytes = await this.deps.storage.get(asset.storage_key);
    if (!bytes) throw new MediaError(503, 'UPSTREAM_UNAVAILABLE', true);
    const view = this.toView(asset);
    return { bytes, mimeType: view.mimeType, fileName: view.displayName };
  }

  /**
   * Ingest is keyed by the originating event, so redelivery of the same provider
   * attachment resolves to the same attachment/media pair and never duplicates rows.
   */
  async ingestInboundAttachment(input: InboundAttachmentInput): Promise<IngestResult> {
    const digest = sha256Hex(
      Buffer.from(
        [input.companyId, input.conversationId, input.externalMessageId ?? input.messageId, input.externalAttachmentId].join('\n'),
        'utf8',
      ),
    ).slice(0, 32);
    const attachmentId = `att_${digest}`;
    const mediaId = `med_${digest}`;
    const fileName = sanitizeFileName(input.fileName);
    const declaredMime = normalizeMimeType(input.declaredMimeType);
    // Only a provider id the message actually owns may be referenced; otherwise the
    // attachment keeps an unknown provider id and can be reconciled later.
    const externalMessageId = await this.resolveExternalMessageId(input);

    const existing = await this.deps.db.query<AttachmentRow>(
      `SELECT id, s3_key, storage_state, archive_status, mime_type, original_name
         FROM ${this.table('attachments')} WHERE company_id=$1 AND id=$2`,
      [input.companyId, attachmentId],
    );
    const previous = existing.rows[0];
    if (previous) {
      let existingMediaId: string | null = null;
      if (previous.storage_state === 'verified' && previous.s3_key) {
        const media = await this.deps.db.query<{ id: string }>(
          `SELECT id FROM ${this.table('media_assets')} WHERE company_id=$1 AND storage_key=$2`,
          [input.companyId, previous.s3_key],
        );
        existingMediaId = media.rows[0]?.id ?? null;
      }
      const accepted = previous.storage_state === 'verified';
      return {
        attachmentId,
        mediaId: existingMediaId,
        accepted,
        reason: accepted ? null : 'previously_rejected',
        duplicate: true,
      };
    }

    let bytes: Uint8Array | null = input.bytes ?? null;
    let reason: string | null = null;
    if (!bytes) {
      if (!input.remoteUrl) {
        reason = input.unavailableReason ?? 'no_content';
      } else if (!this.deps.remoteFetch) {
        reason = 'remote_blocked';
      } else {
        try {
          bytes = await fetchRemoteObject(input.remoteUrl, this.deps.remoteFetch);
        } catch {
          reason = 'remote_blocked';
        }
      }
    }
    if (!bytes) {
      return this.createPlaceholder(input, attachmentId, mediaId, fileName, declaredMime, reason ?? 'no_content', 0, externalMessageId);
    }

    const sizeBytes = bytes.byteLength;
    if (sizeBytes > this.limits.maxFileBytes) {
      return this.createPlaceholder(input, attachmentId, mediaId, fileName, declaredMime, 'too_large', sizeBytes, externalMessageId);
    }
    if (!isAllowedMimeType(declaredMime, this.limits.allowedMimeTypes)) {
      return this.createPlaceholder(input, attachmentId, mediaId, fileName, declaredMime, 'mime_not_allowed', sizeBytes, externalMessageId);
    }
    // The provider's declared type is untrusted: bytes that are plainly something
    // else (an executable called photo.png) keep a placeholder, never `ready`.
    const contentType = checkContentType(bytes, declaredMime ?? PLACEHOLDER_MIME_TYPE, fileName);
    if (!contentType.ok) {
      return this.createPlaceholder(
        input,
        attachmentId,
        mediaId,
        fileName,
        declaredMime,
        'content_mime_mismatch',
        sizeBytes,
        externalMessageId,
      );
    }
    const sha256 = sha256Hex(bytes);
    if (input.declaredSha256) {
      const declared = input.declaredSha256.trim().toLowerCase();
      if (SHA256_PATTERN.test(declared) && declared !== sha256) {
        return this.createPlaceholder(input, attachmentId, mediaId, fileName, declaredMime, 'sha_mismatch', sizeBytes, externalMessageId);
      }
    }

    const storageKey = `media/${sanitizeFileName(input.companyId)}/${mediaId}/${fileName}`;
    await this.deps.storage.put(storageKey, bytes, declaredMime ?? PLACEHOLDER_MIME_TYPE);
    const head = await this.deps.storage.head(storageKey);
    if (!head || head.sizeBytes !== sizeBytes || (head.sha256 !== '' && head.sha256 !== sha256)) {
      return this.createPlaceholder(input, attachmentId, mediaId, fileName, declaredMime, 'storage_mismatch', sizeBytes, externalMessageId);
    }

    const contractRef = this.deps.archiveContractRef ?? null;
    let inserted = false;
    await withTransaction(this.deps.db, async (tx) => {
      await tx.query(
        `INSERT INTO ${this.table('media_assets')}
           (company_id,id,state,storage_key,reservation_id,mime_type,byte_size,sha256)
         VALUES ($1,$2,'ready',$3,$4,$5,$6,$7)
         ON CONFLICT (company_id,id) DO NOTHING`,
        [input.companyId, mediaId, storageKey, `inbound:${attachmentId}`, declaredMime, sizeBytes, sha256],
      );
      const attachment = await tx.query(
        `INSERT INTO ${this.table('attachments')}
           (company_id,id,message_id,conversation_id,connection_id,binding_epoch,external_chat_id,
            external_message_id,original_name,mime_type,byte_size,s3_key,sha256,storage_state,archive_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'verified','pending')
         ON CONFLICT (company_id,id) DO NOTHING
         RETURNING id`,
        [
          input.companyId,
          attachmentId,
          input.messageId,
          input.conversationId,
          input.connectionId,
          input.bindingEpoch,
          input.externalChatId,
          externalMessageId,
          fileName,
          declaredMime,
          sizeBytes,
          storageKey,
          sha256,
        ],
      );
      inserted = (attachment.rowCount ?? 0) > 0;
      await tx.query(
        `INSERT INTO ${this.table('archive_handoff_jobs')}
           (company_id,id,attachment_id,intent_key,delivery_enabled,contract_ref,state)
         VALUES ($1,$2,$3,$4,$5,$6,'pending')
         ON CONFLICT (company_id,intent_key) DO NOTHING`,
        [input.companyId, `ahj_${randomBytes(12).toString('hex')}`, attachmentId, `archive:${attachmentId}`, contractRef !== null, contractRef],
      );
    });

    return {
      attachmentId,
      mediaId: inserted ? mediaId : null,
      accepted: true,
      reason: null,
      duplicate: !inserted,
    };
  }

  private async resolveExternalMessageId(input: InboundAttachmentInput): Promise<string | null> {
    if (!input.externalMessageId) return null;
    const { rows } = await this.deps.db.query<{ provider_message_id: string | null }>(
      `SELECT provider_message_id FROM ${this.table('messages')}
        WHERE company_id=$1 AND id=$2 AND conversation_id=$3`,
      [input.companyId, input.messageId, input.conversationId],
    );
    const providerMessageId = rows[0]?.provider_message_id ?? null;
    return providerMessageId === input.externalMessageId ? providerMessageId : null;
  }

  /** Honest placeholder: the message survives, the bytes are never stored. */
  private async createPlaceholder(
    input: InboundAttachmentInput,
    attachmentId: string,
    mediaId: string,
    fileName: string,
    declaredMime: string | null,
    reason: string,
    sizeBytes: number,
    externalMessageId: string | null,
  ): Promise<IngestResult> {
    await withTransaction(this.deps.db, async (tx) => {
      await tx.query(
        `INSERT INTO ${this.table('media_assets')}
           (company_id,id,state,reservation_id,mime_type,byte_size)
         VALUES ($1,$2,'rejected',$3,$4,$5)
         ON CONFLICT (company_id,id) DO NOTHING`,
        [input.companyId, mediaId, `inbound:${attachmentId}`, declaredMime ?? PLACEHOLDER_MIME_TYPE, sizeBytes],
      );
      await tx.query(
        `INSERT INTO ${this.table('attachments')}
           (company_id,id,message_id,conversation_id,connection_id,binding_epoch,external_chat_id,
            external_message_id,original_name,mime_type,byte_size,storage_state,archive_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'failed','failed')
         ON CONFLICT (company_id,id) DO NOTHING`,
        [
          input.companyId,
          attachmentId,
          input.messageId,
          input.conversationId,
          input.connectionId,
          input.bindingEpoch,
          input.externalChatId,
          externalMessageId,
          `${PLACEHOLDER_NAME_PREFIX} ${fileName}`.slice(0, 255),
          PLACEHOLDER_MIME_TYPE,
          sizeBytes,
        ],
      );
    });
    return { attachmentId, mediaId: null, accepted: false, reason, duplicate: false };
  }

  async createArchiveHandoff(companyId: string, attachmentId: string): Promise<{ id: string; state: string }> {
    const attachment = await this.deps.db.query<{ storage_state: string }>(
      `SELECT storage_state FROM ${this.table('attachments')} WHERE company_id=$1 AND id=$2`,
      [companyId, attachmentId],
    );
    const row = attachment.rows[0];
    if (!row) throw new MediaError(404, 'NOT_FOUND');
    if (row.storage_state !== 'verified') throw new MediaError(409, 'VERSION_CONFLICT');
    const contractRef = this.deps.archiveContractRef ?? null;
    const inserted = await this.deps.db.query<{ id: string; state: string }>(
      `INSERT INTO ${this.table('archive_handoff_jobs')}
         (company_id,id,attachment_id,intent_key,delivery_enabled,contract_ref,state)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')
       ON CONFLICT (company_id,intent_key) DO NOTHING
       RETURNING id, state`,
      [companyId, `ahj_${randomBytes(12).toString('hex')}`, attachmentId, `archive:${attachmentId}`, contractRef !== null, contractRef],
    );
    if (inserted.rows[0]) return inserted.rows[0];
    const existing = await this.deps.db.query<{ id: string; state: string }>(
      `SELECT id, state FROM ${this.table('archive_handoff_jobs')} WHERE company_id=$1 AND intent_key=$2`,
      [companyId, `archive:${attachmentId}`],
    );
    const job = existing.rows[0];
    if (!job) throw new MediaError(500, 'INTERNAL_ERROR');
    return job;
  }

  /**
   * "Stored in S3" is not "acknowledged by the archive". Handoff stays disabled
   * until an explicit archive contract reference is configured.
   */
  async confirmArchiveIndex(companyId: string, jobId: string, ackRef: string): Promise<void> {
    if (!this.deps.archiveContractRef) throw new MediaError(409, 'CAPABILITY_BLOCKED');
    const found = await this.deps.db.query<{ id: string; state: string; delivery_enabled: boolean; attachment_id: string }>(
      `SELECT id, state, delivery_enabled, attachment_id
         FROM ${this.table('archive_handoff_jobs')} WHERE company_id=$1 AND id=$2`,
      [companyId, jobId],
    );
    const job = found.rows[0];
    if (!job) throw new MediaError(404, 'NOT_FOUND');
    if (!job.delivery_enabled) throw new MediaError(409, 'CAPABILITY_BLOCKED');
    if (job.state === 'indexed') return;
    if (ackRef.trim().length === 0 || ackRef.length > 255) throw new MediaError(400, 'VALIDATION_FAILED');
    await withTransaction(this.deps.db, async (tx) => {
      await tx.query(
        `UPDATE ${this.table('archive_handoff_jobs')} SET state='indexed'
          WHERE company_id=$1 AND id=$2 AND delivery_enabled`,
        [companyId, jobId],
      );
      await tx.query(
        `UPDATE ${this.table('attachments')} SET archive_status='indexed', index_ack_ref=$3
          WHERE company_id=$1 AND id=$2 AND storage_state='verified'`,
        [companyId, job.attachment_id, ackRef],
      );
    });
  }

  async createAttachmentReply(
    companyId: string,
    staffId: string,
    role: string,
    workshopId: string | null,
    workItemId: string,
    body: AttachmentReplyInput,
  ): Promise<Record<string, unknown>> {
    // The work item must live in the caller's workshop; a foreign one is reported as
    // missing, exactly like operator/routes.ts does for every work item command.
    const work = await this.deps.db.query<{
      conversation_id: string;
      assignment_version: string | number;
      connection_id: string;
      binding_epoch: string | number;
    }>(
      `SELECT w.conversation_id, w.assignment_version, c.connection_id, c.binding_epoch
         FROM ${this.table('work_items')} w
         JOIN ${this.table('conversations')} c
           ON c.company_id=w.company_id AND c.id=w.conversation_id
        WHERE w.company_id=$1 AND w.id=$2
          AND ($3::text IS NULL OR EXISTS (
            SELECT 1 FROM ${this.table('connection_routes')} r
             WHERE r.company_id=c.company_id AND r.connection_id=c.connection_id
               AND r.workshop_id=$3))`,
      [companyId, workItemId, workshopId],
    );
    const workItem = work.rows[0];
    if (!workItem) throw new MediaError(404, 'NOT_FOUND');
    if (Number(workItem.assignment_version) !== body.expectedAssignmentVersion) {
      throw new MediaError(409, 'VERSION_CONFLICT');
    }
    if (body.mediaIds.length !== 1) throw new MediaError(400, 'VALIDATION_FAILED');

    let totalBytes = 0;
    for (const mediaId of body.mediaIds) {
      const asset = await this.loadAsset(companyId, mediaId);
      await this.assertWorkshopAccess(companyId, workshopId, asset.storage_key ?? '');
      // The sender must be able to read what they attach.
      await this.assertReadAccess(companyId, staffId, role, asset.storage_key ?? '');
      if (asset.state !== 'ready') throw new MediaError(409, 'VERSION_CONFLICT');
      totalBytes += numberOrNull(asset.byte_size) ?? 0;
    }
    if (totalBytes > this.limits.maxMessageBytes) throw new MediaError(413, 'VALIDATION_FAILED');

    const deadline = new Date(body.deadline);
    if (Number.isNaN(deadline.getTime())) throw new MediaError(400, 'VALIDATION_FAILED');

    const content = {
      mediaIds: body.mediaIds,
      caption: body.caption,
      snapshotId: body.snapshotId,
      expectedAssignmentVersion: body.expectedAssignmentVersion,
      selectedObligations: body.selectedObligations,
    };
    const fingerprint = sha256Hex(Buffer.from(JSON.stringify(content), 'utf8'));

    const existing = await this.deps.db.query<{
      id: string;
      state: string;
      coverage: string;
      provider_message_id: string | null;
      payload_fingerprint: string;
    }>(
      `SELECT id, state, coverage, provider_message_id, payload_fingerprint
         FROM ${this.table('send_operations')}
        WHERE company_id=$1 AND command_type='attachment_reply' AND idempotency_key=$2`,
      [companyId, body.idempotencyKey],
    );
    const previous = existing.rows[0];
    if (previous) {
      // Same key with different content is a client error, never a silent replay.
      if (previous.payload_fingerprint !== fingerprint) throw new MediaError(409, 'IDEMPOTENCY_CONFLICT');
      return this.toSendOperation(previous, body);
    }

    // Snapshot sealing/validation belongs to the composer work stream; when the
    // snapshot exists we reference it, otherwise the request is stored without it.
    const snapshot = await this.deps.db.query(
      `SELECT 1 FROM ${this.table('reply_snapshots')}
        WHERE company_id=$1 AND id=$2 AND work_item_id=$3 AND conversation_id=$4`,
      [companyId, body.snapshotId, workItemId, workItem.conversation_id],
    );
    const snapshotId = (snapshot.rowCount ?? 0) > 0 ? body.snapshotId : null;

    const inserted = await this.deps.db.query<{
      id: string;
      state: string;
      coverage: string;
      provider_message_id: string | null;
    }>(
      `INSERT INTO ${this.table('send_operations')}
         (company_id,id,work_item_id,conversation_id,connection_id,binding_epoch,snapshot_id,actor_id,
          command_type,idempotency_key,payload_fingerprint,state,coverage,content,deadline)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'attachment_reply',$9,$10,'accepted','unconfirmed',$11::jsonb,$12)
       ON CONFLICT (company_id,command_type,idempotency_key) DO NOTHING
       RETURNING id, state, coverage, provider_message_id`,
      [
        companyId,
        `sop_${randomBytes(12).toString('hex')}`,
        workItemId,
        workItem.conversation_id,
        workItem.connection_id,
        Number(workItem.binding_epoch),
        snapshotId,
        staffId,
        body.idempotencyKey,
        fingerprint,
        JSON.stringify(content),
        deadline,
      ],
    );
    const operation = inserted.rows[0];
    if (operation) return this.toSendOperation(operation, body);
    const raced = await this.deps.db.query<{
      id: string;
      state: string;
      coverage: string;
      provider_message_id: string | null;
      payload_fingerprint: string;
    }>(
      `SELECT id, state, coverage, provider_message_id, payload_fingerprint
         FROM ${this.table('send_operations')}
        WHERE company_id=$1 AND command_type='attachment_reply' AND idempotency_key=$2`,
      [companyId, body.idempotencyKey],
    );
    const winner = raced.rows[0];
    if (!winner) throw new MediaError(500, 'INTERNAL_ERROR');
    if (winner.payload_fingerprint !== fingerprint) throw new MediaError(409, 'IDEMPOTENCY_CONFLICT');
    return this.toSendOperation(winner, body);
  }

  private toSendOperation(
    row: { id: string; state: string; coverage: string; provider_message_id: string | null },
    body: AttachmentReplyInput,
  ): Record<string, unknown> {
    return {
      id: row.id,
      state: row.state,
      providerMessageId: row.provider_message_id,
      coverage: row.coverage,
      selectedRefs: body.selectedObligations,
      deliveryEvidence: null,
      readEvidence: null,
    };
  }
}
