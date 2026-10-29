// Channel alerts: the durable record of the events an administrator must hear about.
//
// A channel alert is not a projection. The fact itself is the event: a channel that
// was disabled and later re-enabled still happened, and the operator must still be
// able to read about it. The row is the single source of truth, and the notification
// feed reads it.
//
// Three rules shape this module:
//
//   * No PII. Identifiers and our own closed-vocabulary codes only. No phone
//     numbers, no message text, no provider error bodies, no tokens.
//   * Tenant scoped. Every query filters by `company_id`, and the dedupe key is
//     unique per company, so two tenants never collide and never see each other.
//   * Deduplicated. A repeated trigger — the same revoked access seen by two
//     workers, the same operation failing twice — produces one alert.

import { randomUUID } from 'node:crypto';
import type { Db, Tx } from '../platform/db.ts';

/** The four events the routing design asks to be alerted about. */
export const CHANNEL_ALERT_KINDS = [
  'channel_disabled',
  'refresh_exhausted',
  'send_rejected',
  'manual_review',
] as const;
export type ChannelAlertKind = (typeof CHANNEL_ALERT_KINDS)[number];

/**
 * Our own error vocabulary. A provider's error text is never stored: it can carry
 * a chat id, a phone number or a token fragment, and it changes between providers.
 * The transport maps its own failure onto one of these codes.
 */
export const CHANNEL_ALERT_ERROR_CODES = [
  'ACCESS_REVOKED',
  'TOKEN_REFRESH_FAILED',
  'SEND_REJECTED',
  'OUTCOME_UNKNOWN',
  'CHANNEL_DISABLED',
] as const;
export type ChannelAlertErrorCode = (typeof CHANNEL_ALERT_ERROR_CODES)[number];

export type ChannelAlertDeps = { schema: string };

export type RaiseChannelAlertInput = {
  companyId: string;
  connectionId: string;
  kind: ChannelAlertKind;
  /**
   * Tenant-scoped deduplication key. It identifies the subject of the event, not
   * its text: a connection version, an operation id, a provider message id.
   */
  dedupeKey: string;
  errorCode?: ChannelAlertErrorCode | null;
  connectionState?: string | null;
  conversationId?: string | null;
  externalMessageId?: string | null;
};

export type ChannelAlert = {
  id: string;
  companyId: string;
  connectionId: string;
  kind: ChannelAlertKind;
  dedupeKey: string;
  recipientStaffId: string;
  errorCode: string | null;
  connectionState: string | null;
  conversationId: string | null;
  externalMessageId: string | null;
  createdAt: string;
};

export type RaiseChannelAlertResult =
  /** The alert was stored. */
  | { status: 'raised'; alert: ChannelAlert }
  /** The same event was already alerted; the stored alert is returned unchanged. */
  | { status: 'duplicate'; alert: ChannelAlert }
  /** No recipient is configured for this channel: nothing is stored, nothing fails. */
  | { status: 'skipped_no_recipient' };

function q(sql: string, schema: string): string {
  return sql.replaceAll('__S__', `"${schema}"`);
}

const ALERT_COLUMNS =
  'id, company_id, connection_id, kind, dedupe_key, recipient_staff_id, error_code, connection_state, conversation_id, external_message_id, created_at';

type AlertRow = {
  id: string;
  company_id: string;
  connection_id: string;
  kind: ChannelAlertKind;
  dedupe_key: string;
  recipient_staff_id: string;
  error_code: string | null;
  connection_state: string | null;
  conversation_id: string | null;
  external_message_id: string | null;
  created_at: Date;
};

function toAlert(row: AlertRow): ChannelAlert {
  return {
    id: row.id,
    companyId: row.company_id,
    connectionId: row.connection_id,
    kind: row.kind,
    dedupeKey: row.dedupe_key,
    recipientStaffId: row.recipient_staff_id,
    errorCode: row.error_code,
    connectionState: row.connection_state,
    conversationId: row.conversation_id,
    externalMessageId: row.external_message_id,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * The staff member a channel's alerts go to. Read from the route, because that is
 * where the administrator writes it. A connection without a route, or a route
 * without `alert_staff_id`, has no recipient — the caller skips the alert cleanly
 * instead of failing or storing an alert nobody can read.
 */
export async function resolveAlertRecipient(
  db: Db | Tx,
  deps: ChannelAlertDeps,
  input: { companyId: string; connectionId: string },
): Promise<string | null> {
  const { rows } = await db.query<{ alert_staff_id: string | null }>(
    q(
      `SELECT alert_staff_id FROM __S__.connection_routes
        WHERE company_id = $1 AND connection_id = $2`,
      deps.schema,
    ),
    [input.companyId, input.connectionId],
  );
  return rows[0]?.alert_staff_id ?? null;
}

/**
 * Stores one alert, addressed to the route's `alert_staff_id`.
 *
 * The recipient is resolved here rather than by the caller, so no code path can
 * address an alert to an arbitrary staff member. The insert is a no-op on a
 * repeated dedupe key: the unique constraint is the single source of truth for
 * deduplication, and it holds across processes.
 */
export async function raiseChannelAlert(
  db: Db | Tx,
  deps: ChannelAlertDeps,
  input: RaiseChannelAlertInput,
): Promise<RaiseChannelAlertResult> {
  if (
    !CHANNEL_ALERT_KINDS.includes(input.kind) ||
    (input.errorCode != null && !CHANNEL_ALERT_ERROR_CODES.includes(input.errorCode))
  ) {
    throw new Error('INVALID_CHANNEL_ALERT_CODE');
  }
  const recipient = await resolveAlertRecipient(db, deps, {
    companyId: input.companyId,
    connectionId: input.connectionId,
  });
  // No recipient configured: skip cleanly. Not an error — the channel simply has
  // nobody to notify, and the connection's own state still records the problem.
  if (!recipient) return { status: 'skipped_no_recipient' };

  const inserted = await db.query<AlertRow>(
    q(
      `INSERT INTO __S__.channel_alerts
         (company_id, id, connection_id, kind, dedupe_key, recipient_staff_id,
          error_code, connection_state, conversation_id, external_message_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (company_id, dedupe_key) DO NOTHING
       RETURNING ${ALERT_COLUMNS}`,
      deps.schema,
    ),
    [
      input.companyId,
      randomUUID(),
      input.connectionId,
      input.kind,
      input.dedupeKey,
      recipient,
      input.errorCode ?? null,
      input.connectionState ?? null,
      input.conversationId ?? null,
      input.externalMessageId ?? null,
    ],
  );
  const created = inserted.rows[0];
  if (created) return { status: 'raised', alert: toAlert(created) };

  // The same event was already alerted. The stored row is returned so the caller
  // can log the deduplication without knowing the id beforehand.
  const existing = await db.query<AlertRow>(
    q(
      `SELECT ${ALERT_COLUMNS} FROM __S__.channel_alerts
        WHERE company_id = $1 AND dedupe_key = $2`,
      deps.schema,
    ),
    [input.companyId, input.dedupeKey],
  );
  const row = existing.rows[0];
  if (!row) throw new Error('CHANNEL_ALERT_LOST');
  return { status: 'duplicate', alert: toAlert(row) };
}

/**
 * The alerts addressed to one staff member, newest first. The feed reads them with
 * a keyset cursor on `(created_at, id)`, so the timestamps travel as PostgreSQL
 * text: a JS Date would truncate microseconds and the cursor row itself could
 * satisfy the comparison again.
 */
export async function listChannelAlertsForRecipient(
  db: Db,
  deps: ChannelAlertDeps,
  input: {
    companyId: string;
    recipientStaffId: string;
    after: { at: string; id: string } | null;
    limit: number;
  },
): Promise<ChannelAlert[]> {
  const params: unknown[] = [input.companyId, input.recipientStaffId];
  let cursorClause = '';
  if (input.after !== null) {
    params.push(input.after.at);
    const atParam = params.length;
    params.push(input.after.id);
    const idParam = params.length;
    cursorClause = `AND (a.created_at, a.id) < ($${atParam}::timestamptz, $${idParam}::text)`;
  }
  params.push(input.limit);
  const { rows } = await db.query<AlertRow>(
    q(
      `SELECT ${ALERT_COLUMNS} FROM __S__.channel_alerts a
        WHERE a.company_id = $1 AND a.recipient_staff_id = $2 ${cursorClause}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $${params.length}`,
      deps.schema,
    ),
    params,
  );
  return rows.map(toAlert);
}
