// Telegram inbox processor.
//
// The webhook only guarantees durable storage of the raw update. This module turns
// a committed inbox event into the domain facts the rest of the platform reads:
// conversation, inbound message (with its first content version), the active work
// item, and the open attention obligation. It runs inside one transaction with the
// inbox state change, so a crash cannot leave a half-applied update.

import { randomUUID } from 'node:crypto';
import { withTransaction, type Db, type Tx } from '../platform/db.ts';
import { openIncomingInTransaction, type AttentionRepoDeps } from '../repo/attention.ts';
import type { TelegramScope } from './inbox.ts';
import { buildMessageJob } from '../integrations/amocrm/projection.ts';
import { loadActiveAccountForConnection } from '../integrations/amocrm/store.ts';
import { telegramMediaOf } from './media.ts';
import { TELEGRAM_MEDIA_JOB_KIND } from './media-projection.ts';

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
const INBOX_BATCH_LIMIT = 100;

type ChatKind = 'private' | 'group' | 'unknown';

export type AppliedUpdate = {
  applied: boolean;
  conversationId?: string;
  messageId?: string;
  workItemId?: string;
};

export type ProcessResult = {
  /** Pending inbox events moved to `processed`. */
  processed: number;
  /** Events that produced a message and an obligation. */
  applied: number;
};

function qualified(schema: string, table: string): string {
  if (!SCHEMA_PATTERN.test(schema)) throw new Error('INVALID_SCHEMA');
  return `"${schema}"."${table}"`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function chatKindOf(value: unknown): ChatKind {
  if (value === 'private') return 'private';
  if (value === 'group' || value === 'supergroup' || value === 'channel') return 'group';
  return 'unknown';
}

/**
 * Only the normalized content is stored. Provider-specific payloads are reduced to
 * an explicit `unsupported` fact instead of leaking raw transport bodies.
 */
function contentOf(message: Record<string, unknown>): Record<string, unknown> {
  const media = telegramMediaOf(message);
  if (media) return { kind: 'attachment', text: typeof message.caption === 'string' ? message.caption : '', telegramMedia: media };
  if (typeof message.text === 'string') return { kind: 'text', text: message.text };
  if (Array.isArray(message.photo)) return { kind: 'unsupported', providerType: 'photo' };
  if (asRecord(message.document)) return { kind: 'unsupported', providerType: 'document' };
  if (asRecord(message.audio)) return { kind: 'unsupported', providerType: 'audio' };
  if (asRecord(message.video)) return { kind: 'unsupported', providerType: 'video' };
  if (asRecord(message.voice)) return { kind: 'unsupported', providerType: 'voice' };
  return { kind: 'unsupported', providerType: 'unknown' };
}

function senderProfileOf(message: Record<string, unknown>, kind: ChatKind): Record<string, string> {
  if (kind !== 'private') return {};
  const sender = asRecord(message.from);
  if (!sender) return {};
  const part = (value: unknown) => typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 128) : '';
  const senderName = [part(sender.first_name), part(sender.last_name)].filter(Boolean).join(' ');
  const username = typeof sender.username === 'string' ? sender.username.trim().replace(/^@/, '') : '';
  return { ...(senderName ? { senderName } : {}), ...(/^[a-zA-Z0-9_]{1,32}$/.test(username) ? { senderUsername: username } : {}) };
}

type InboundMessage = {
  messageId: string;
  chatId: string;
  chatKind: ChatKind;
  content: Record<string, unknown>;
  occurredAt: Date | null;
};

/** Returns null for updates that carry no inbound message (receipts, callbacks...). */
function inboundMessageOf(update: Record<string, unknown>): InboundMessage | null {
  const message = asRecord(update.message);
  if (!message) return null;
  const chat = asRecord(message.chat);
  const messageId = message.message_id;
  const chatId = chat?.id;
  if (typeof messageId !== 'number' && typeof messageId !== 'string') return null;
  if (typeof chatId !== 'number' && typeof chatId !== 'string') return null;
  const date = message.date;
  const occurredAt =
    typeof date === 'number' && Number.isFinite(date) && date >= 0 ? new Date(date * 1000) : null;
  return {
    messageId: String(messageId),
    chatId: String(chatId),
    chatKind: chatKindOf(chat?.type),
    content: { ...contentOf(message), ...senderProfileOf(message, chatKindOf(chat?.type)) },
    occurredAt,
  };
}

async function ensureConversation(
  tx: Tx,
  schema: string,
  scope: TelegramScope,
  chatId: string,
  chatKind: ChatKind,
): Promise<string> {
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO ${qualified(schema, 'conversations')}
       (company_id, id, connection_id, binding_epoch, external_chat_id, chat_kind)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (company_id, connection_id, binding_epoch, external_chat_id) DO NOTHING
     RETURNING id`,
    [scope.companyId, randomUUID(), scope.connectionId, scope.bindingEpoch, chatId, chatKind],
  );
  const created = inserted.rows[0]?.id;
  if (created) return created;

  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM ${qualified(schema, 'conversations')}
      WHERE company_id = $1 AND connection_id = $2 AND binding_epoch = $3 AND external_chat_id = $4`,
    [scope.companyId, scope.connectionId, scope.bindingEpoch, chatId],
  );
  const id = existing.rows[0]?.id;
  if (!id) throw new Error('CONVERSATION_UPSERT_FAILED');
  return id;
}

/**
 * Archives the message and its first content version. A provider message id that
 * was already archived is not duplicated; the inbox update is then a replay at the
 * message level and produces no second obligation.
 */
async function ensureMessage(
  tx: Tx,
  schema: string,
  scope: TelegramScope,
  conversationId: string,
  message: InboundMessage,
): Promise<string | null> {
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO ${qualified(schema, 'messages')}
       (company_id, id, conversation_id, direction, provider_message_id, current_content_version, provenance)
     VALUES ($1,$2,$3,'in',$4,1,'live')
     ON CONFLICT (company_id, conversation_id, provider_message_id) DO NOTHING
     RETURNING id`,
    [scope.companyId, randomUUID(), conversationId, message.messageId],
  );
  const messageId = inserted.rows[0]?.id;
  if (!messageId) return null;

  await tx.query(
    `INSERT INTO ${qualified(schema, 'message_versions')}
       (company_id, message_id, content_version, content, observed_at)
     VALUES ($1,$2,1,$3::jsonb,$4)`,
    [scope.companyId, messageId, JSON.stringify(message.content), message.occurredAt ?? new Date()],
  );
  return messageId;
}

/**
 * One active work item per conversation. The conversation row is locked first, so
 * two updates for the same chat cannot both create a work item and race the partial
 * unique index.
 */
async function ensureWorkItem(tx: Tx, schema: string, scope: TelegramScope, conversationId: string): Promise<string> {
  await tx.query(
    `SELECT id FROM ${qualified(schema, 'conversations')} WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [scope.companyId, conversationId],
  );

  const active = await tx.query<{ id: string }>(
    `SELECT id FROM ${qualified(schema, 'work_items')}
      WHERE company_id = $1 AND conversation_id = $2 AND state NOT IN ('resolved','cancelled')
      FOR UPDATE`,
    [scope.companyId, conversationId],
  );
  const existing = active.rows[0]?.id;
  if (existing) return existing;

  const workItemId = randomUUID();
  await tx.query(
    `INSERT INTO ${qualified(schema, 'work_items')} (company_id, id, conversation_id, state)
     VALUES ($1,$2,$3,'queued')`,
    [scope.companyId, workItemId, conversationId],
  );
  return workItemId;
}

/** Applies one inbox payload inside the caller's transaction. */
export async function applyTelegramUpdate(
  tx: Tx,
  deps: AttentionRepoDeps,
  scope: TelegramScope,
  update: Record<string, unknown>,
): Promise<AppliedUpdate> {
  const message = inboundMessageOf(update);
  if (!message) return { applied: false };

  const conversationId = await ensureConversation(tx, deps.schema, scope, message.chatId, message.chatKind);
  const messageId = await ensureMessage(tx, deps.schema, scope, conversationId, message);
  if (!messageId) return { applied: false, conversationId };

  const workItemId = await ensureWorkItem(tx, deps.schema, scope, conversationId);
  await openIncomingInTransaction(tx, deps, {
    companyId: scope.companyId,
    workItemId,
    messageId,
    contentVersion: 1,
  });
  if (message.content.kind === 'attachment') {
    await tx.query(
      `INSERT INTO ${qualified(deps.schema,'outbox_jobs')}(company_id,id,job_kind,intent_key,payload)
       VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,
      [scope.companyId,randomUUID(),TELEGRAM_MEDIA_JOB_KIND,
        `telegram_media:${scope.connectionId}:${scope.bindingEpoch}:${message.messageId}`,
        JSON.stringify({companyId:scope.companyId,conversationId,providerMessageId:message.messageId})],
    );
  }
  const gate=await tx.query<{allowed:boolean}>(
    `SELECT ${qualified(deps.schema,'channel_crm_import_allowed')}($1,$2,$3,$4,$5) AS allowed`,
    [scope.companyId,scope.connectionId,scope.bindingEpoch,message.chatId,message.chatKind],
  );
  if (gate.rows[0]?.allowed) {
    const accountId=await loadActiveAccountForConnection(tx,deps.schema,scope);
    if (accountId) await tx.query(
      `INSERT INTO ${qualified(deps.schema,'outbox_jobs')}(company_id,id,job_kind,intent_key,payload)
       VALUES ($1,$2,'amocrm.projection',$3,$4::jsonb) ON CONFLICT DO NOTHING`,
      [scope.companyId,randomUUID(),`telegram:${scope.connectionId}:${scope.bindingEpoch}:${message.messageId}`,
       JSON.stringify(buildMessageJob({companyId:scope.companyId,accountId,conversationId,providerMessageId:message.messageId,direction:'in',text:typeof message.content.text==='string'?message.content.text:'',occurredAt:message.occurredAt,
         senderName:typeof message.content.senderName==='string'?message.content.senderName:undefined,
         senderUsername:typeof message.content.senderUsername==='string'?message.content.senderUsername:undefined}))],
    );
  }
  return { applied: true, conversationId, messageId, workItemId };
}

/**
 * Drains pending inbox events for one connection. Each event is claimed with
 * `FOR UPDATE SKIP LOCKED`, applied and marked `processed` in the same transaction,
 * so concurrent processors cannot double-apply an update.
 */
export async function processPendingTelegramUpdates(
  db: Db,
  deps: AttentionRepoDeps,
  scope: TelegramScope,
  options: { limit?: number } = {},
): Promise<ProcessResult> {
  if (!SCHEMA_PATTERN.test(deps.schema)) throw new Error('INVALID_SCHEMA');
  const limit = options.limit ?? INBOX_BATCH_LIMIT;
  const result: ProcessResult = { processed: 0, applied: 0 };

  for (let index = 0; index < limit; index += 1) {
    const outcome = await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ id: string; payload: Record<string, unknown> }>(
        `SELECT id, payload FROM ${qualified(deps.schema, 'inbox_events')}
          WHERE company_id = $1 AND connection_id = $2 AND binding_epoch = $3 AND state = 'pending'
            AND provider_event_key LIKE 'tg:update:%'
          ORDER BY received_at, id
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
        [scope.companyId, scope.connectionId, scope.bindingEpoch],
      );
      const event = rows[0];
      if (!event) return null;

      const applied = await applyTelegramUpdate(tx, deps, scope, event.payload);
      await tx.query(
        `UPDATE ${qualified(deps.schema, 'inbox_events')}
            SET state = 'processed', processed_at = clock_timestamp()
          WHERE company_id = $1 AND id = $2`,
        [scope.companyId, event.id],
      );
      return applied;
    });

    if (!outcome) break;
    result.processed += 1;
    if (outcome.applied) result.applied += 1;
  }

  return result;
}

export type DrainResult = ProcessResult & { connections: number };

/**
 * Applies pending updates for every connection that has any. This is the entry
 * point the running process calls on a timer: the webhook's only job is durable
 * storage, so an unprocessed event is retried here instead of being lost.
 */
export async function drainTelegramInbox(
  db: Db,
  deps: AttentionRepoDeps,
  options: { limitPerConnection?: number } = {},
): Promise<DrainResult> {
  if (!SCHEMA_PATTERN.test(deps.schema)) throw new Error('INVALID_SCHEMA');
  const { rows } = await db.query<{ company_id: string; connection_id: string; binding_epoch: string }>(
    `SELECT DISTINCT company_id, connection_id, binding_epoch
       FROM ${qualified(deps.schema, 'inbox_events')}
      WHERE state = 'pending' AND provider_event_key LIKE 'tg:update:%'`,
  );

  const total: DrainResult = { processed: 0, applied: 0, connections: rows.length };
  for (const row of rows) {
    const result = await processPendingTelegramUpdates(
      db,
      deps,
      {
        companyId: row.company_id,
        connectionId: row.connection_id,
        bindingEpoch: Number(row.binding_epoch),
      },
      { limit: options.limitPerConnection },
    );
    total.processed += result.processed;
    total.applied += result.applied;
  }
  return total;
}
