import type { Db } from '../platform/db.ts';
import { MediaService } from '../media/service.ts';
import type { ObjectStorage } from '../media/storage.ts';
import type { InboundMessageInput } from '../integrations/amocrm/sync.ts';
import { raiseAlert } from '../channels/alerts.ts';
import { downloadTelegramMedia, TelegramMediaError, type TelegramMediaReference } from './media.ts';
import { crmMediaUrl } from '../media/crm-access.ts';

const DOWNLOAD_LIMIT = 20 * 1024 * 1024;
export const TELEGRAM_MEDIA_JOB_KIND = 'telegram.media';

type StoredMessage = {
  id: string; content: Record<string, unknown>; connection_id: string; binding_epoch: string;
  external_chat_id: string; credential_ref: string | null; channel_mode: string; allowed: boolean;
};

function reference(value: unknown): TelegramMediaReference {
  const item = value as TelegramMediaReference | null;
  if (!item || !['picture','file','video','voice','audio'].includes(item.type) ||
      typeof item.fileId !== 'string' || !item.fileId || item.fileId.length > 1024 ||
      typeof item.fileName !== 'string' || !item.fileName || typeof item.mimeType !== 'string' ||
      (item.sizeBytes !== null && (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0))) {
    throw new Error('crm_media_reference_invalid');
  }
  return item;
}

/** Private bytes are persisted once; CRM receives a stable, revocable download capability. */
export function createTelegramMediaHandlers(deps: {
  db: Db; schema: string; storage: ObjectStorage | null; sessionSecret: string;
  resolveBotToken: (input: { companyId: string; connectionId: string; credentialRef: string | null }) => string | null;
  fetch?: typeof fetch;
  archiveContractRef?: string | null;
  crmMediaBaseUrl?: string | null;
}) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(deps.schema)) throw new Error('INVALID_SCHEMA');
  const table = (name: string) => `"${deps.schema}"."${name}"`;
  const service = deps.storage ? new MediaService({
    db: deps.db, schema: deps.schema, storage: deps.storage, sessionSecret: deps.sessionSecret,
    archiveContractRef: deps.archiveContractRef,
  }) : null;
  const run = async (input: InboundMessageInput, archiveOnly = false): Promise<InboundMessageInput> => {
    if (input.direction !== 'in') return input;
    const found = await deps.db.query<StoredMessage>(
      `SELECT m.id,v.content,c.connection_id,c.binding_epoch,c.external_chat_id,n.credential_ref,n.channel_mode,
              ${table('channel_crm_import_allowed')}(c.company_id,c.connection_id,c.binding_epoch,c.external_chat_id,c.chat_kind) AS allowed
         FROM ${table('messages')} m
         JOIN ${table('message_versions')} v ON v.company_id=m.company_id AND v.message_id=m.id AND v.content_version=m.current_content_version
         JOIN ${table('conversations')} c ON c.company_id=m.company_id AND c.id=m.conversation_id
         JOIN ${table('connections')} n ON n.company_id=c.company_id AND n.id=c.connection_id AND n.binding_epoch=c.binding_epoch
        WHERE m.company_id=$1 AND m.conversation_id=$2 AND m.provider_message_id=$3 AND m.direction='in'
          AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM ${table('connection_routes')} r
               WHERE r.company_id=c.company_id AND r.connection_id=c.connection_id AND r.crm_account_id=$4))`,
      [input.companyId,input.conversationId,input.providerMessageId,archiveOnly ? null : input.accountId],
    );
    const message = found.rows[0];
    if (!message) throw new Error('crm_media_message_missing');
    // The domain handles denied routes without importing; no download may occur first.
    if (!archiveOnly && !message.allowed) return { ...input, attachment: undefined };
    if (message.content.kind !== 'attachment') {
      if (message.content.kind === 'unsupported') throw new Error('crm_message_content_unsupported');
      return input;
    }
    if (message.channel_mode !== 'telegram_bot') throw new Error('crm_media_channel_unsupported');
    if (!service || !deps.storage) throw new Error('crm_media_storage_unavailable');
    const media = reference(message.content.telegramMedia);
    const review = async (): Promise<never> => {
      await raiseAlert(deps.db, { schema: deps.schema }, {
        companyId: input.companyId, connectionId: message.connection_id, kind: 'manual_review',
        dedupeKey: `crm_media:${input.conversationId}:${input.providerMessageId}`,
        errorCode: 'OUTCOME_UNKNOWN', conversationId: input.conversationId,
        externalMessageId: input.providerMessageId,
      });
      throw new Error('crm_media_rejected');
    };
    let existing = await deps.db.query<{
      id: string; storage_state: string; state: string; s3_key: string | null; byte_size: string; sha256: string | null;
    }>(
      `SELECT a.id,a.storage_state,m.state,a.s3_key,a.byte_size,a.sha256 FROM ${table('attachments')} a
         LEFT JOIN ${table('media_assets')} m ON m.company_id=a.company_id AND m.storage_key=a.s3_key
        WHERE a.company_id=$1 AND a.message_id=$2 AND a.conversation_id=$3
          AND a.connection_id=$4 AND a.binding_epoch=$5 ORDER BY a.id LIMIT 2`,
      [input.companyId,message.id,input.conversationId,message.connection_id,message.binding_epoch],
    );
    if (existing.rows.length > 1) return review();
    if (!existing.rows.length) {
      const token = deps.resolveBotToken({companyId:input.companyId,connectionId:message.connection_id,credentialRef:message.credential_ref});
      if (!token) throw new Error('crm_media_credentials_unavailable');
      // Oversized attachments still get a durable placeholder; no provider request.
      let bytes: Uint8Array | null = null;
      let unavailableReason: 'too_large' | 'provider_rejected' | undefined;
      if (media.sizeBytes !== null && media.sizeBytes > DOWNLOAD_LIMIT) unavailableReason = 'too_large';
      else {
        try { bytes = await downloadTelegramMedia({botToken:token,fileId:media.fileId,fetch:deps.fetch}); }
        catch (error) {
          if (!(error instanceof TelegramMediaError) || error.code === 'telegram_media_unavailable') throw error;
          unavailableReason = error.code === 'telegram_media_too_large' ? 'too_large' : 'provider_rejected';
        }
      }
      const ingested = await service.ingestInboundAttachment({
        companyId:input.companyId,conversationId:input.conversationId,connectionId:message.connection_id,
        bindingEpoch:Number(message.binding_epoch),externalChatId:message.external_chat_id,
        messageId:message.id,externalMessageId:input.providerMessageId,externalAttachmentId:media.fileId,
        fileName:media.fileName,declaredMimeType:media.mimeType,bytes,unavailableReason,
      });
      if (!ingested.accepted) return review();
      existing = await deps.db.query(
        `SELECT a.id,a.storage_state,m.state,a.s3_key,a.byte_size,a.sha256 FROM ${table('attachments')} a
           JOIN ${table('media_assets')} m ON m.company_id=a.company_id AND m.storage_key=a.s3_key
          WHERE a.company_id=$1 AND a.id=$2`, [input.companyId,ingested.attachmentId],
      );
    }
    const asset = existing.rows[0];
    if (!asset || asset.storage_state !== 'verified' || asset.state !== 'ready' || !asset.s3_key) return review();
    const head = await deps.storage.head(asset.s3_key);
    const sizeBytes = Number(asset.byte_size);
    if (!head || head.sizeBytes !== sizeBytes || (head.sha256 && head.sha256 !== asset.sha256)) return review();
    if (archiveOnly) return input;
    const url = crmMediaUrl({baseUrl:deps.crmMediaBaseUrl,secret:deps.sessionSecret,
      companyId:input.companyId,accountId:input.accountId,attachmentId:asset.id});
    return { ...input, text: typeof message.content.text === 'string' ? message.content.text : '',
      attachment: {type:media.type,url,fileName:media.fileName,sizeBytes} };
  };
  return {
    prepareMessage: (input: InboundMessageInput) => run(input),
    archiveMessage: async (payload: unknown): Promise<void> => {
      const item = payload as Record<string,unknown> | null;
      if (!item || !['companyId','conversationId','providerMessageId'].every((key) =>
        typeof item[key] === 'string' && item[key].length > 0 && item[key].length <= 128)) {
        throw new Error('invalid_telegram_media_job');
      }
      await run({companyId:item.companyId as string,conversationId:item.conversationId as string,
        providerMessageId:item.providerMessageId as string,accountId:'',direction:'in'},true);
    },
  };
}

export function createTelegramMediaProjection(deps: Parameters<typeof createTelegramMediaHandlers>[0]) {
  return createTelegramMediaHandlers(deps).prepareMessage;
}
