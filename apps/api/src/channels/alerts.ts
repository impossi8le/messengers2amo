// Channel alert triggers.
//
// Four events must reach the administrator who owns the channel
// (`connection_routes.alert_staff_id`):
//
//   * the channel went to `disabled` — access was revoked or the bot was blocked;
//   * a token refresh failed after every retry;
//   * a send came back as a confirmed rejection;
//   * a message landed in the review queue — its outcome is unknown.
//
// This module owns the two rules that the triggers share:
//
//   1. Revoked access disables the channel. A connection whose access was revoked
//      must stop receiving and sending: leaving it `active` would keep the worker
//      calling a provider that has already refused us. The transition is written
//      on the caller's transaction, so it lands with the state change that caused
//      it.
//
//   2. No PII crosses the boundary. The alert payload carries identifiers and our
//      own error codes only — never provider error text, never a phone number,
//      never a message body. The provider's words are mapped onto a closed
//      vocabulary before they reach the store.
//
// A missing recipient skips cleanly. A storage failure propagates so a caller's
// transaction cannot commit a state transition without its durable notification.

import { withTransaction, type Db, type Tx } from '../platform/db.ts';
import { logEvent } from '../platform/logger.ts';
import {
  raiseChannelAlert,
  type ChannelAlertKind,
  type ChannelAlertErrorCode,
  type ChannelAlertDeps,
} from '../repo/alerts.ts';

export type ChannelAlertDepsWithSchema = ChannelAlertDeps;

export type RaiseAlertInput = {
  companyId: string;
  connectionId: string;
  kind: ChannelAlertKind;
  /**
   * The subject of the event, used for deduplication. It must identify the event
   * itself, not its text: a connection version, an operation id, a job id.
   */
  dedupeKey: string;
  errorCode?: ChannelAlertErrorCode | null;
  /** The administrative state the connection was in when the alert was raised. */
  connectionState?: string | null;
  conversationId?: string | null;
  externalMessageId?: string | null;
};

/**
 * Writes one alert, addressed to the channel's configured recipient.
 *
 * Returns false when the channel has no recipient: the alert is skipped cleanly
 * and the caller continues. The connection's own state still records the problem,
 * so nothing is lost — only the notification has nowhere to go.
 */
export async function raiseAlert(
  db: Db | Tx,
  deps: ChannelAlertDepsWithSchema,
  input: RaiseAlertInput,
): Promise<boolean> {
  try {
    const result = await raiseChannelAlert(db, deps, {
      companyId: input.companyId,
      connectionId: input.connectionId,
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      errorCode: input.errorCode ?? null,
      connectionState: input.connectionState ?? null,
      conversationId: input.conversationId ?? null,
      externalMessageId: input.externalMessageId ?? null,
    });
    if (result.status === 'skipped_no_recipient') {
      logEvent('info', 'channel.alert.skipped', {
        companyId: input.companyId,
        connectionId: input.connectionId,
        alertKind: input.kind,
        reason: 'no_alert_recipient',
      });
      return false;
    }
    logEvent('info', 'channel.alert.raised', {
      companyId: input.companyId,
      connectionId: input.connectionId,
      alertKind: input.kind,
      alertStatus: result.status,
      alertId: result.alert.id,
    });
    return true;
  } catch {
    logEvent('warn', 'channel.alert.failed', {
      companyId: input.companyId,
      connectionId: input.connectionId,
      alertKind: input.kind,
      reason: 'alert_write_failed',
    });
    throw new Error('channel_alert_write_failed');
  }
}

/**
 * Disables a connection whose access was revoked and raises the alert.
 *
 * The transition is idempotent: a connection that is already `disabled` stays
 * disabled and no second state change is written. The alert is deduplicated on the
 * caller's event key, so the same revocation seen twice yields one alert.
 *
 * "Preserve unknown send rules" means this never touches the send path: a message
 * whose outcome is unknown stays unknown and is still reviewed by a human. Only
 * the channel's administrative state changes here.
 */
export async function disableChannelAndAlert(
  db: Db | Tx,
  deps: ChannelAlertDepsWithSchema,
  input: {
    companyId: string;
    connectionId: string;
    /** Identifies the revocation; the same revocation must not alert twice. */
    dedupeKey: string;
    errorCode?: ChannelAlertErrorCode | null;
    conversationId?: string | null;
    externalMessageId?: string | null;
  },
): Promise<{ disabled: boolean; alerted: boolean }> {
  if ('totalCount' in db) {
    return withTransaction(db, (tx) => disableChannelAndAlert(tx, deps, input));
  }
  const table = `"${deps.schema}".connections`;
  const { rows } = await db.query<{ state: string }>(
    `SELECT state FROM ${table} WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [input.companyId, input.connectionId],
  );
  const connection = rows[0];
  if (!connection) {
    // The connection is gone; there is nothing to disable and nobody to alert.
    return { disabled: false, alerted: false };
  }

  let disabled = false;
  if (connection.state !== 'disabled') {
    await db.query(
      `UPDATE ${table}
          SET state = 'disabled', ingress_enabled = false, send_enabled = false, version = version + 1
        WHERE company_id = $1 AND id = $2 AND state <> 'disabled'`,
      [input.companyId, input.connectionId],
    );
    disabled = true;
  }

  const alerted = await raiseAlert(db, deps, {
    companyId: input.companyId,
    connectionId: input.connectionId,
    kind: 'channel_disabled',
    // The caller's key identifies the revocation itself. The connection version
    // must not be part of it: the version moves when the channel is disabled, so
    // the same revocation seen twice would look like two different events and
    // would alert twice. A later, genuinely new revocation carries a new key.
    dedupeKey: input.dedupeKey,
    errorCode: input.errorCode ?? 'ACCESS_REVOKED',
    connectionState: 'disabled',
    conversationId: input.conversationId ?? null,
    externalMessageId: input.externalMessageId ?? null,
  });

  return { disabled, alerted };
}

/**
 * Maps a transport error code onto the alert vocabulary.
 *
 * The provider's own words are never stored: they can carry a chat id, a phone
 * number or a token fragment, and they differ between providers. Only our own
 * codes reach the alert.
 */
export function toAlertErrorCode(outcome: {
  status: string;
  errorCode?: string | undefined;
}): ChannelAlertErrorCode {
  switch (outcome.errorCode) {
    case 'AUTH_REQUIRED':
      return 'ACCESS_REVOKED';
      return 'ACCESS_REVOKED';
    case 'NO_PROVIDER_MESSAGE_ID':
    case 'ADAPTER_ERROR':
      return 'OUTCOME_UNKNOWN';
    default:
      return 'SEND_REJECTED';
  }
}
