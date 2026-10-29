import { randomUUID } from 'node:crypto';
import { withTransaction, type Db, type Tx } from '../platform/db.ts';
import { payloadFingerprint } from './canonical.ts';

export type TelegramScope = {
  companyId: string;
  connectionId: string;
  bindingEpoch: number;
};

export type InboxRecordResult = {
  eventId: string;
  duplicate: boolean;
  checkpoint: number;
};

export class InboxConflictError extends Error {
  readonly code = 'inbox_payload_conflict';
  readonly providerEventKey: string;
  constructor(providerEventKey: string) {
    super('inbox_payload_conflict');
    this.providerEventKey = providerEventKey;
  }
}

const TELEGRAM_EVENT_PREFIX = 'tg:update:';

export function telegramProviderEventKey(updateId: number): string {
  return `${TELEGRAM_EVENT_PREFIX}${updateId}`;
}

export function extractUpdateId(update: unknown): number | null {
  if (!update || typeof update !== 'object' || Array.isArray(update)) return null;
  const value = (update as Record<string, unknown>).update_id;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}

const KIND_BY_FIELD: Record<string, string> = {
  message: 'message',
  edited_message: 'edited_message',
  channel_post: 'channel_post',
  edited_channel_post: 'edited_channel_post',
  business_message: 'business_message',
  edited_business_message: 'edited_business_message',
  callback_query: 'callback_query',
  inline_query: 'inline_query',
  chosen_inline_result: 'chosen_inline_result',
  shipping_query: 'shipping_query',
  pre_checkout_query: 'pre_checkout_query',
  poll: 'poll',
  poll_answer: 'poll_answer',
  my_chat_member: 'my_chat_member',
  chat_member: 'chat_member',
  chat_join_request: 'chat_join_request',
  message_reaction: 'message_reaction',
  message_reaction_count: 'message_reaction_count',
};

export function updateKind(update: Record<string, unknown>): string {
  for (const key of Object.keys(update)) {
    if (key === 'update_id') continue;
    const kind = KIND_BY_FIELD[key];
    if (kind) return kind;
  }
  return 'update';
}

function messageLike(update: Record<string, unknown>): Record<string, unknown> | null {
  const kind = updateKind(update);
  const value = update[kind];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function updateOccurredAt(update: Record<string, unknown>): Date | null {
  const holder = messageLike(update);
  const date = holder?.date;
  if (typeof date === 'number' && Number.isFinite(date) && date >= 0) return new Date(date * 1000);
  return null;
}

/**
 * Durable checkpoint is derived exclusively from committed inbox rows, so it
 * can never move ahead of storage. A failed insert/rollback leaves it intact.
 */
export async function readTelegramCheckpoint(db: Db | Tx, scope: TelegramScope): Promise<number> {
  const { rows } = await db.query<{ checkpoint: string }>(
    `SELECT COALESCE(MAX((payload->>'update_id')::bigint), 0)::text AS checkpoint
       FROM inbox_events
      WHERE company_id = $1 AND connection_id = $2 AND binding_epoch = $3
        AND payload->>'update_id' IS NOT NULL`,
    [scope.companyId, scope.connectionId, scope.bindingEpoch],
  );
  return Number(rows[0]?.checkpoint ?? 0);
}

export type InsertOutcome = { eventId: string; duplicate: boolean };

/**
 * Inserts one update inside an existing transaction. The unique partial index
 * is the deduplication authority; an existing row with different content is a
 * conflict rather than an overwrite.
 */
export async function insertTelegramUpdate(
  tx: Tx,
  scope: TelegramScope,
  update: Record<string, unknown>,
): Promise<InsertOutcome> {
  const updateId = extractUpdateId(update);
  if (updateId === null) throw new Error('invalid_telegram_update');
  const providerEventKey = telegramProviderEventKey(updateId);
  const incomingFingerprint = payloadFingerprint(update);

  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO inbox_events
       (company_id, id, connection_id, binding_epoch, provider_event_key, payload_major,
        kind, payload, provenance, state, occurred_at)
     VALUES ($1,$2,$3,$4,$5,2,$6,$7::jsonb,'live','pending',$8)
     ON CONFLICT (company_id, connection_id, binding_epoch, provider_event_key)
       WHERE provider_event_key IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [
      scope.companyId,
      randomUUID(),
      scope.connectionId,
      scope.bindingEpoch,
      providerEventKey,
      updateKind(update),
      JSON.stringify(update),
      updateOccurredAt(update),
    ],
  );

  if (inserted.rowCount === 1) {
    const created = inserted.rows[0];
    if (!created) throw new Error('inbox_insert_missing_row');
    return { eventId: created.id, duplicate: false };
  }

  const existing = await tx.query<{ id: string; payload: Record<string, unknown> }>(
    `SELECT id, payload FROM inbox_events
      WHERE company_id = $1 AND connection_id = $2 AND binding_epoch = $3 AND provider_event_key = $4`,
    [scope.companyId, scope.connectionId, scope.bindingEpoch, providerEventKey],
  );
  const row = existing.rows[0];
  if (!row) throw new Error('inbox_conflict_row_missing');
  if (payloadFingerprint(row.payload) !== incomingFingerprint) {
    throw new InboxConflictError(providerEventKey);
  }
  return { eventId: row.id, duplicate: true };
}

/**
 * Persists one Telegram update and returns only after the transaction commits.
 * The caller may send the provider ACK only when this resolves successfully.
 */
export async function recordTelegramUpdate(
  db: Db,
  scope: TelegramScope,
  update: Record<string, unknown>,
): Promise<InboxRecordResult> {
  return withTransaction(db, async (tx) => {
    const outcome = await insertTelegramUpdate(tx, scope, update);
    const checkpoint = await readTelegramCheckpoint(tx, scope);
    return { ...outcome, checkpoint };
  });
}
