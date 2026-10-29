import { randomUUID } from 'node:crypto';
import { withTransaction, type Db, type Tx } from '../platform/db.ts';
import { payloadFingerprint } from '../telegram/canonical.ts';
import { InboxConflictError } from '../telegram/inbox.ts';
import type { ChannelAdapter, ChatKind, NormalizedContent, NormalizedEvent, RawInbound, ReceiptStatus } from './types.ts';
import { WebhookVerificationError } from './errors.ts';
import { buildMessageJob } from '../integrations/amocrm/projection.ts';
import { PROJECTION_JOB_KIND } from '../integrations/amocrm/sync.ts';
import { loadActiveAccountForConnection } from '../integrations/amocrm/store.ts';

export type ConnectionScope = {
  companyId: string;
  connectionId: string;
  bindingEpoch: number;
};

export type IngestResult = {
  /** Newly committed inbox events. */
  accepted: number;
  /** Events already present by provider key (provider retry or duplicate delivery). */
  duplicates: number;
  /** CRM projection jobs created by this call. */
  crmProjections: number;
  /** Effective receipt status after applying ordering rules. */
  effectiveStatuses: { providerMessageId: string; status: ReceiptStatus }[];
  handshake?: { type: 'confirmation'; response: string };
};

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

/** Receipt ordering: read cannot be downgraded by a late delivered/failed event. */
const RECEIPT_RANK: Record<ReceiptStatus, number> = { read: 3, delivered: 2, failed: 1 };

export async function ingestWebhook(input: {
  db: Db;
  schema: string;
  adapter: ChannelAdapter;
  connection: ConnectionScope;
  raw: RawInbound;
  /**
   * Observability hook invoked once a CRM projection job is actually committed to
   * the outbox. It is never called for a group/unknown chat that the policy denied:
   * the filter runs before any projection is planned.
   */
  onCrmProjection?: (payload: {
    companyId: string;
    connectionId: string;
    bindingEpoch: number;
    conversationId: string;
    messageId: string;
    externalChatId: string;
    chatKind: ChatKind;
  }) => void;
}): Promise<IngestResult> {
  const { db, schema, adapter, connection, raw } = input;
  if (!SCHEMA_PATTERN.test(schema)) throw new Error('INVALID_SCHEMA');

  // Verification precedes every side effect, including the inbox insert.
  const verified = adapter.verifyInbound(raw);
  if (!verified.ok) throw new WebhookVerificationError(verified.reason);

  const parsed = adapter.parseInbound(raw);
  if (parsed.handshake) {
    return { accepted: 0, duplicates: 0, crmProjections: 0, effectiveStatuses: [], handshake: parsed.handshake };
  }

  const result: IngestResult = { accepted: 0, duplicates: 0, crmProjections: 0, effectiveStatuses: [] };

  await withTransaction(db, async (tx) => {
    for (const event of parsed.events) {
      const inserted = await insertInboxEvent(tx, schema, connection, event, raw);
      if (!inserted) {
        result.duplicates += 1;
      } else {
        result.accepted += 1;
      }

      if (event.kind === 'message.received') {
        if (inserted) {
          const projection = await archiveInboundMessage(tx, schema, connection, event);
          if (projection) {
            result.crmProjections += 1;
            input.onCrmProjection?.({
              companyId: connection.companyId,
              connectionId: connection.connectionId,
              bindingEpoch: connection.bindingEpoch,
              conversationId: projection.conversationId,
              messageId: projection.messageId,
              externalChatId: event.externalChatId,
              chatKind: event.chatKind,
            });
          }
        }
      } else {
        // Receipt evidence is append-only and independently idempotent; the
        // effective status is derived from all evidence, so ordering is safe.
        await insertReceiptEvidence(tx, schema, connection, event, raw);
        const status = await effectiveReceiptStatus(tx, schema, connection, event.providerMessageId);
        if (status) result.effectiveStatuses.push({ providerMessageId: event.providerMessageId, status });
      }
    }
  });

  return result;
}

async function insertInboxEvent(
  tx: Tx,
  schema: string,
  connection: ConnectionScope,
  event: NormalizedEvent,
  raw: RawInbound,
): Promise<boolean> {
  const occurredAt = new Date(event.occurredAt);
  const receivedAt = raw.receivedAt ?? new Date();
  const payload = toInboxPayload(event);
  const { rowCount } = await tx.query(
    `INSERT INTO "${schema}".inbox_events
       (company_id, id, connection_id, binding_epoch, provider_event_key, payload_major, kind, payload,
        provenance, state, occurred_at, received_at)
     VALUES ($1,$2,$3,$4,$5,2,$6,$7::jsonb,'live','pending',$8,$9)
     ON CONFLICT (company_id, connection_id, binding_epoch, provider_event_key)
       WHERE provider_event_key IS NOT NULL
     DO NOTHING`,
    [
      connection.companyId,
      randomUUID(),
      connection.connectionId,
      connection.bindingEpoch,
      event.providerEventKey,
      event.kind,
      JSON.stringify(payload),
      Number.isNaN(occurredAt.getTime()) ? null : occurredAt.toISOString(),
      receivedAt.toISOString(),
    ],
  );
  if ((rowCount ?? 0) > 0) return true;

  // The provider reused an event key. An identical normalized fact is a
  // duplicate delivery and is ACKed; different content is a conflict and must
  // never overwrite the committed fact (same rule as the Telegram inbox).
  const existing = await tx.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM "${schema}".inbox_events
      WHERE company_id = $1 AND connection_id = $2 AND binding_epoch = $3 AND provider_event_key = $4`,
    [connection.companyId, connection.connectionId, connection.bindingEpoch, event.providerEventKey],
  );
  const row = existing.rows[0];
  if (!row) throw new Error('INBOX_CONFLICT_ROW_MISSING');
  if (payloadFingerprint(row.payload) !== payloadFingerprint(payload)) {
    throw new InboxConflictError(event.providerEventKey);
  }
  return false;
}

/**
 * The inbox payload is the normalized fact. It intentionally excludes raw
 * provider bodies: the raw webhook may contain more personal data than needed.
 */
function toInboxPayload(event: NormalizedEvent): Record<string, unknown> {
  if (event.kind === 'message.received') {
    return {
      externalChatId: event.externalChatId,
      chatKind: event.chatKind,
      providerMessageId: event.providerMessageId,
      content: event.content,
    };
  }
  return {
    providerMessageId: event.providerMessageId,
    status: event.status,
    externalChatId: event.externalChatId,
    chatKind: event.chatKind,
  };
}

async function archiveInboundMessage(
  tx: Tx,
  schema: string,
  connection: ConnectionScope,
  event: Extract<NormalizedEvent, { kind: 'message.received' }>,
): Promise<{ conversationId: string; messageId: string } | null> {
  const conversationId = await ensureConversation(tx, schema, connection, event.externalChatId, event.chatKind);

  const messageId = randomUUID();
  const { rowCount } = await tx.query(
    `INSERT INTO "${schema}".messages
       (company_id, id, conversation_id, direction, provider_message_id, current_content_version, provenance)
     VALUES ($1,$2,$3,'in',$4,1,'live')
     ON CONFLICT (company_id, conversation_id, provider_message_id) DO NOTHING`,
    [connection.companyId, messageId, conversationId, event.providerMessageId],
  );
  if ((rowCount ?? 0) === 0) {
    // The provider reused an ID we already archived; history stays intact.
    return null;
  }

  await tx.query(
    `INSERT INTO "${schema}".message_versions (company_id, message_id, content_version, content, observed_at)
     VALUES ($1,$2,1,$3::jsonb,$4)`,
    [connection.companyId, messageId, JSON.stringify(contentToJson(event.content)), event.occurredAt],
  );

  // The group/unknown filter runs before any CRM effect is planned. A denied chat
  // keeps its archived message but produces no projection job.
  const allowed = await crmImportAllowed(tx, schema, connection, event.externalChatId, event.chatKind);
  if (!allowed) return null;

  // Without an active CRM account there is nowhere to project into; a job would
  // only burn its retries and land in `failed`.
  const accountId = await loadActiveAccountForConnection(tx, schema, connection);
  if (!accountId) return null;

  const { rowCount: jobCount } = await tx.query(
    `INSERT INTO "${schema}".outbox_jobs (company_id, id, job_kind, intent_key, payload)
     VALUES ($1,$2,$3,$4,$5::jsonb)
     ON CONFLICT (company_id, job_kind, intent_key) DO NOTHING`,
    [
      connection.companyId,
      randomUUID(),
      PROJECTION_JOB_KIND,
      `inbox:${event.providerEventKey}`,
      JSON.stringify(
        buildMessageJob({
          companyId: connection.companyId,
          accountId,
          conversationId,
          providerMessageId: event.providerMessageId,
          direction: 'in',
          text: textOfContent(event.content),
          occurredAt: occurredAtOf(event.occurredAt),
        }),
      ),
    ],
  );
  return (jobCount ?? 0) > 0 ? { conversationId, messageId } : null;
}

/** The projection stores text only; attachment captions stand in for a message body. */
function textOfContent(content: NormalizedContent): string | undefined {
  if (content.kind === 'text') return content.text;
  if (content.kind === 'attachment') return content.caption;
  return undefined;
}

function occurredAtOf(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function ensureConversation(
  tx: Tx,
  schema: string,
  connection: ConnectionScope,
  externalChatId: string,
  chatKind: ChatKind,
): Promise<string> {
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO "${schema}".conversations
       (company_id, id, connection_id, binding_epoch, external_chat_id, chat_kind)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (company_id, connection_id, binding_epoch, external_chat_id) DO NOTHING
     RETURNING id`,
    [connection.companyId, randomUUID(), connection.connectionId, connection.bindingEpoch, externalChatId, chatKind],
  );
  const created = inserted.rows[0]?.id;
  if (created) return created;

  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM "${schema}".conversations
     WHERE company_id=$1 AND connection_id=$2 AND binding_epoch=$3 AND external_chat_id=$4`,
    [connection.companyId, connection.connectionId, connection.bindingEpoch, externalChatId],
  );
  const id = existing.rows[0]?.id;
  if (!id) throw new Error('CONVERSATION_UPSERT_FAILED');
  return id;
}

/**
 * Delegates the group allowlist decision to the database function, so the
 * deny-by-default policy cannot be bypassed by application code.
 */
async function crmImportAllowed(
  tx: Tx,
  schema: string,
  connection: ConnectionScope,
  externalChatId: string,
  chatKind: ChatKind,
): Promise<boolean> {
  if (chatKind === 'unknown') return false;
  const { rows } = await tx.query<{ allowed: boolean }>(
    `SELECT "${schema}".channel_crm_import_allowed($1,$2,$3,$4,$5) AS allowed`,
    [connection.companyId, connection.connectionId, connection.bindingEpoch, externalChatId, chatKind],
  );
  return rows[0]?.allowed === true;
}

async function insertReceiptEvidence(
  tx: Tx,
  schema: string,
  connection: ConnectionScope,
  event: Extract<NormalizedEvent, { kind: 'message.delivery_observed' | 'message.read_observed' }>,
  raw: RawInbound,
): Promise<void> {
  const observedAt = new Date(event.occurredAt);
  const receivedAt = raw.receivedAt ?? new Date();
  await tx.query(
    `INSERT INTO "${schema}".provider_receipt_evidence
       (company_id, id, connection_id, binding_epoch, external_chat_id, provider_message_id,
        kind, status, evidence_key, provider_event_key, occurred_at, received_at, observed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (company_id, connection_id, binding_epoch, kind, evidence_key) DO NOTHING`,
    [
      connection.companyId,
      randomUUID(),
      connection.connectionId,
      connection.bindingEpoch,
      event.externalChatId,
      event.providerMessageId,
      event.kind,
      event.status,
      event.providerEventKey,
      event.providerEventKey,
      Number.isNaN(observedAt.getTime()) ? null : observedAt.toISOString(),
      receivedAt.toISOString(),
      Number.isNaN(observedAt.getTime()) ? receivedAt.toISOString() : observedAt.toISOString(),
    ],
  );
}

async function effectiveReceiptStatus(
  tx: Tx,
  schema: string,
  connection: ConnectionScope,
  providerMessageId: string,
): Promise<ReceiptStatus | null> {
  const { rows } = await tx.query<{ status: ReceiptStatus }>(
    `SELECT status FROM "${schema}".provider_receipt_evidence
     WHERE company_id=$1 AND connection_id=$2 AND binding_epoch=$3 AND provider_message_id=$4`,
    [connection.companyId, connection.connectionId, connection.bindingEpoch, providerMessageId],
  );
  let best: ReceiptStatus | null = null;
  for (const row of rows) {
    if (!best || RECEIPT_RANK[row.status] > RECEIPT_RANK[best]) best = row.status;
  }
  return best;
}

function contentToJson(content: NormalizedContent): Record<string, unknown> {
  switch (content.kind) {
    case 'text':
      return { kind: 'text', text: content.text };
    case 'attachment':
      return { kind: 'attachment', mediaId: content.mediaId, caption: content.caption };
    case 'unsupported':
      return { kind: 'unsupported', providerType: content.providerType };
  }
}
