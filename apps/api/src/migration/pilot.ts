// Observational parallel pilot (#18): reconciliation of old and new contour events
// plus the single-owner fence that prevents two senders on one channel asset.
//
// This module never talks to a provider. It compares already-collected facts and
// persists only ownership claims, so it is safe to run while Wazzup stays live.

import { withTransaction, type Db, type Tx } from '../platform/db.ts';

export const PILOT_CLASSIFICATIONS = [
  'match',
  'delay',
  'filtered',
  'normalization_error',
  'real_loss',
  'duplicate',
] as const;

export type PilotClassification = (typeof PILOT_CLASSIFICATIONS)[number];

/** Categories that make the pilot reconciliation fail. Delay and filter are explainable. */
export const BLOCKING_CLASSIFICATIONS = ['normalization_error', 'real_loss', 'duplicate'] as const;

export type PilotEvent = {
  /** Stable provider event key (or provider message id when the provider has no event key). */
  eventKey: string;
  direction: 'in' | 'out';
  /** Provider timestamp. */
  occurredAt: string;
  /** When this contour observed the event; defaults to occurredAt. */
  observedAt?: string | null;
  contentKind: 'text' | 'attachment' | 'unsupported';
  text?: string | null;
  mediaId?: string | null;
  /** External chat id used for conversation matching. */
  conversationKey: string;
  /** Resolved contact id, if the contour mapped one. */
  contactKey?: string | null;
  /** Whether an open attention obligation exists for this event. */
  waiting: boolean;
  /** Old-contour events that are deliberately not expected in the new contour. */
  filterReason?: string | null;
};

export type PilotComparisonInput = {
  oldEvents: readonly PilotEvent[];
  newEvents: readonly PilotEvent[];
  /** Allowed observation lag before a matching event is reported as delayed. */
  maxDelayMs?: number;
  /** Reconciliation snapshot time; a recent missing event may still be in flight. */
  snapshotAt?: string | Date;
  /** Optional policy hook for filters that are not stored on the event itself. */
  isFiltered?: (event: PilotEvent) => string | null;
};

export type PilotEventResult = {
  eventKey: string;
  classification: PilotClassification;
  reasons: string[];
  oldEvent: PilotEvent | null;
  newEvent: PilotEvent | null;
  delayMs: number | null;
};

export type PilotReport = {
  totals: Record<PilotClassification, number>;
  results: PilotEventResult[];
  /** No blocking discrepancy remains: every difference is a delay or an explained filter. */
  reconciled: boolean;
  blocking: PilotClassification[];
};

const DEFAULT_MAX_DELAY_MS = 60_000;
const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

function timeOf(value: string | Date | null | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? Number.NaN : parsed;
  }
  return Number.NaN;
}

function normalize(value: string | null | undefined): string | null {
  return value === null || value === undefined || value === '' ? null : value;
}

function compareFields(oldEvent: PilotEvent, newEvent: PilotEvent): string[] {
  const reasons: string[] = [];
  if (oldEvent.direction !== newEvent.direction) reasons.push('direction_mismatch');
  if (oldEvent.contentKind !== newEvent.contentKind) reasons.push('content_mismatch');
  if (oldEvent.contentKind === 'text' && normalize(oldEvent.text) !== normalize(newEvent.text)) {
    reasons.push('content_mismatch');
  }
  if (oldEvent.contentKind === 'attachment' && normalize(oldEvent.mediaId) !== normalize(newEvent.mediaId)) {
    reasons.push('content_mismatch');
  }
  if (oldEvent.conversationKey !== newEvent.conversationKey) reasons.push('conversation_mismatch');
  if (normalize(oldEvent.contactKey) !== normalize(newEvent.contactKey)) reasons.push('contact_mismatch');
  if (oldEvent.waiting !== newEvent.waiting) reasons.push('waiting_mismatch');
  return [...new Set(reasons)];
}

function result(
  eventKey: string,
  classification: PilotClassification,
  reasons: string[],
  oldEvent: PilotEvent | null,
  newEvent: PilotEvent | null,
  delayMs: number | null = null,
): PilotEventResult {
  return { eventKey, classification, reasons, oldEvent, newEvent, delayMs };
}

/**
 * Compares one reconciliation window.
 *
 * Rules:
 * - `filtered` is decided by the old contour's explicit filter reason, so it is
 *   an explanation rather than a loss.
 * - A missing event whose age is inside the delay window is `delay`; after the
 *   window it becomes `real_loss`.
 * - A present event with different content/mapping/waiting is `normalization_error`.
 * - Extra deliveries of the same key are `duplicate`.
 * - An event seen only in the new contour is an unexplained normalization anomaly.
 */
export function comparePilotEvents(input: PilotComparisonInput): PilotReport {
  const maxDelayMs = input.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const snapshotMs = timeOf(input.snapshotAt ?? new Date());
  const totals: Record<PilotClassification, number> = {
    match: 0,
    delay: 0,
    filtered: 0,
    normalization_error: 0,
    real_loss: 0,
    duplicate: 0,
  };
  const results: PilotEventResult[] = [];

  const newByKey = new Map<string, PilotEvent[]>();
  for (const event of input.newEvents) {
    const bucket = newByKey.get(event.eventKey);
    if (bucket) bucket.push(event);
    else newByKey.set(event.eventKey, [event]);
  }

  const oldKeys = new Set<string>();
  for (const oldEvent of input.oldEvents) {
    const key = oldEvent.eventKey;
    if (oldKeys.has(key)) {
      results.push(result(key, 'duplicate', ['duplicate_in_old'], oldEvent, null));
      continue;
    }
    oldKeys.add(key);

    const candidates = newByKey.get(key) ?? [];
    const observed = candidates[0];
    if (!observed) {
      const filterReason = normalize(oldEvent.filterReason) ?? normalize(input.isFiltered?.(oldEvent));
      if (filterReason) {
        results.push(result(key, 'filtered', [`filtered:${filterReason}`], oldEvent, null));
        continue;
      }
      const occurredMs = timeOf(oldEvent.occurredAt);
      const ageMs = snapshotMs - occurredMs;
      if (Number.isFinite(ageMs) && ageMs <= maxDelayMs) {
        results.push(result(key, 'delay', ['delay_window_open'], oldEvent, null, ageMs));
      } else {
        results.push(result(key, 'real_loss', ['not_observed'], oldEvent, null));
      }
      continue;
    }

    const mismatches = compareFields(oldEvent, observed);
    if (mismatches.length > 0) {
      results.push(result(key, 'normalization_error', mismatches, oldEvent, observed));
    } else {
      const delayMs = timeOf(observed.observedAt ?? observed.occurredAt) - timeOf(oldEvent.occurredAt);
      if (Number.isFinite(delayMs) && delayMs > maxDelayMs) {
        results.push(result(key, 'delay', ['delay_exceeds_threshold'], oldEvent, observed, delayMs));
      } else {
        results.push(result(key, 'match', [], oldEvent, observed, Number.isFinite(delayMs) ? delayMs : null));
      }
    }

    for (const extra of candidates.slice(1)) {
      results.push(result(key, 'duplicate', ['duplicate_new_event'], oldEvent, extra));
    }
  }

  for (const [key, candidates] of newByKey) {
    if (oldKeys.has(key)) continue;
    const [first, ...rest] = candidates;
    results.push(result(key, 'normalization_error', ['unexpected_event'], null, first ?? null));
    for (const extra of rest) {
      results.push(result(key, 'duplicate', ['duplicate_new_event'], null, extra));
    }
  }

  for (const row of results) totals[row.classification] += 1;
  const blocking = BLOCKING_CLASSIFICATIONS.filter((classification) => totals[classification] > 0);

  return { totals, results, reconciled: blocking.length === 0, blocking: [...blocking] };
}

// ---------------------------------------------------------------------------
// Single-owner fence
// ---------------------------------------------------------------------------

export type SendOwnershipInput = {
  schema: string;
  companyId: string;
  /** Stable asset alias from the migration inventory (one physical number/bot/community). */
  channelKey: string;
  owner: string;
};

export type SendOwnershipClaim = {
  owner: string;
  acquired: boolean;
};

export class SendOwnershipConflictError extends Error {
  readonly code = 'SEND_OWNERSHIP_CONFLICT';
  readonly channelKey: string;
  readonly currentOwner: string;
  readonly requestedOwner: string;
  constructor(channelKey: string, currentOwner: string, requestedOwner: string) {
    super(`channel ${channelKey} already has send owner ${currentOwner}; refusing ${requestedOwner}`);
    this.name = 'SendOwnershipConflictError';
    this.channelKey = channelKey;
    this.currentOwner = currentOwner;
    this.requestedOwner = requestedOwner;
  }
}

export class SendOwnerMissingError extends Error {
  readonly code = 'SEND_OWNER_MISSING';
  readonly channelKey: string;
  constructor(channelKey: string) {
    super(`channel ${channelKey} has no send owner`);
    this.name = 'SendOwnerMissingError';
    this.channelKey = channelKey;
  }
}

function requireIdentity(input: SendOwnershipInput): void {
  if (!SCHEMA_PATTERN.test(input.schema)) throw new Error('INVALID_SCHEMA');
  if (!input.companyId) throw new Error('INVALID_COMPANY');
  if (!input.channelKey) throw new Error('INVALID_CHANNEL_KEY');
  if (!input.owner) throw new Error('INVALID_OWNER');
}

async function claimOnTx(tx: Tx, input: SendOwnershipInput): Promise<SendOwnershipClaim> {
  const inserted = await tx.query<{ owner: string }>(
    `INSERT INTO "${input.schema}".channel_send_owners (company_id, channel_key, owner)
     VALUES ($1,$2,$3)
     ON CONFLICT (company_id, channel_key) DO NOTHING
     RETURNING owner`,
    [input.companyId, input.channelKey, input.owner],
  );
  const created = inserted.rows[0];
  if (created) return { owner: created.owner, acquired: true };

  const existing = await tx.query<{ owner: string }>(
    `SELECT owner FROM "${input.schema}".channel_send_owners
      WHERE company_id=$1 AND channel_key=$2`,
    [input.companyId, input.channelKey],
  );
  const current = existing.rows[0]?.owner;
  if (!current) throw new SendOwnerMissingError(input.channelKey);
  if (current !== input.owner) {
    throw new SendOwnershipConflictError(input.channelKey, current, input.owner);
  }
  return { owner: current, acquired: false };
}

/**
 * Claims send ownership for a channel asset. The primary key on
 * (company_id, channel_key) is the fence: a second, different owner is refused
 * explicitly and the current owner is never overwritten.
 */
export async function claimSendOwnership(db: Db, input: SendOwnershipInput): Promise<SendOwnershipClaim> {
  requireIdentity(input);
  return withTransaction(db, (tx) => claimOnTx(tx, input));
}

export async function getSendOwner(
  db: Db,
  input: { schema: string; companyId: string; channelKey: string },
): Promise<string | null> {
  if (!SCHEMA_PATTERN.test(input.schema)) throw new Error('INVALID_SCHEMA');
  const { rows } = await db.query<{ owner: string }>(
    `SELECT owner FROM "${input.schema}".channel_send_owners
      WHERE company_id=$1 AND channel_key=$2`,
    [input.companyId, input.channelKey],
  );
  return rows[0]?.owner ?? null;
}

/** Explicit handover primitive: only the current owner can release the asset. */
export async function releaseSendOwnership(
  db: Db,
  input: SendOwnershipInput,
): Promise<boolean> {
  requireIdentity(input);
  return withTransaction(db, async (tx) => {
    const removed = await tx.query(
      `DELETE FROM "${input.schema}".channel_send_owners
        WHERE company_id=$1 AND channel_key=$2 AND owner=$3
        RETURNING owner`,
      [input.companyId, input.channelKey, input.owner],
    );
    if ((removed.rowCount ?? 0) > 0) return true;

    const existing = await tx.query<{ owner: string }>(
      `SELECT owner FROM "${input.schema}".channel_send_owners
        WHERE company_id=$1 AND channel_key=$2`,
      [input.companyId, input.channelKey],
    );
    const current = existing.rows[0]?.owner;
    if (current && current !== input.owner) {
      throw new SendOwnershipConflictError(input.channelKey, current, input.owner);
    }
    return false;
  });
}

/**
 * Enables outbound sending for a connection only after it owns the channel asset.
 * The ownership claim and the connection flag change commit atomically: if the
 * asset belongs to another contour, `send_enabled` is left untouched.
 */
export async function enableSending(
  db: Db,
  input: SendOwnershipInput & { connectionId: string },
): Promise<SendOwnershipClaim & { sendEnabled: true }> {
  requireIdentity(input);
  if (!input.connectionId) throw new Error('INVALID_CONNECTION');
  return withTransaction(db, async (tx) => {
    const claim = await claimOnTx(tx, input);
    const connection = await tx.query<{ send_enabled: boolean }>(
      `SELECT send_enabled FROM "${input.schema}".connections
        WHERE company_id=$1 AND id=$2`,
      [input.companyId, input.connectionId],
    );
    if (!connection.rows[0]) throw new Error(`CONNECTION_NOT_FOUND:${input.connectionId}`);
    if (!connection.rows[0].send_enabled) {
      // Bump the lifecycle version so a stale optimistic update cannot silently
      // turn the sender off (or a second sender on) behind this fence.
      await tx.query(
        `UPDATE "${input.schema}".connections
            SET send_enabled=true, version=version+1
          WHERE company_id=$1 AND id=$2 AND send_enabled=false`,
        [input.companyId, input.connectionId],
      );
    }
    return { owner: claim.owner, acquired: claim.acquired, sendEnabled: true as const };
  });
}
