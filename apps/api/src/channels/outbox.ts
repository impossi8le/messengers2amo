import { randomUUID } from 'node:crypto';
import type { Db } from '../platform/db.ts';
import type { ChannelAdapter, SendContent, SendOutcome } from './types.ts';
import { CapabilityNotAllowedError, OutboxJobNotFoundError } from './errors.ts';
import { disableChannelAndAlert, raiseAlert, toAlertErrorCode } from './alerts.ts';

export type OutboxJobRow = {
  id: string;
  state: string;
  attempt_count: number;
  available_at: string | Date;
  payload: Record<string, unknown>;
};

export type SendJobPayload = {
  connectionId: string;
  externalChatId: string;
  content: SendContent;
  /** The staff member on whose behalf the message was accepted. */
  actorId?: string;
};

export type DispatchResult = {
  skipped: boolean;
  outcome: SendOutcome | null;
  retryScheduled: boolean;
};

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
const JOB_KIND = 'channel.send';
const DEFAULT_MAX_ATTEMPTS = 5;
const BASE_BACKOFF_SECONDS = 5;
const MAX_BACKOFF_SECONDS = 300;

/**
 * Idempotent enqueue. The unique (company, job_kind, intent_key) constraint is
 * the single source of truth: a repeated CRM event returns the same job.
 */
export async function enqueueSend(
  db: Db,
  input: { schema: string; companyId: string; intentKey: string; payload: SendJobPayload },
): Promise<{ jobId: string; created: boolean }> {
  if (!SCHEMA_PATTERN.test(input.schema)) throw new Error('INVALID_SCHEMA');
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO "${input.schema}".outbox_jobs (company_id, id, job_kind, intent_key, payload)
     VALUES ($1,$2,$3,$4,$5::jsonb)
     ON CONFLICT (company_id, job_kind, intent_key) DO NOTHING
     RETURNING id`,
    [input.companyId, randomUUID(), JOB_KIND, input.intentKey, JSON.stringify(input.payload)],
  );
  const created = inserted.rows[0]?.id;
  if (created) return { jobId: created, created: true };

  const existing = await db.query<{ id: string }>(
    `SELECT id FROM "${input.schema}".outbox_jobs WHERE company_id=$1 AND job_kind=$2 AND intent_key=$3`,
    [input.companyId, JOB_KIND, input.intentKey],
  );
  const id = existing.rows[0]?.id;
  if (!id) throw new OutboxJobNotFoundError(input.intentKey);
  return { jobId: id, created: false };
}

/**
 * Claims one pending job and performs exactly one provider attempt.
 *
 * State machine:
 *   sent                       -> completed
 *   failed + retryable         -> pending with backoff (bounded attempts)
 *   failed + not retryable     -> failed
 *   unknown (timeout, 2xx w/o id) -> unknown, never retried blindly
 */
export async function dispatchSend(input: {
  db: Db;
  schema: string;
  adapter: ChannelAdapter;
  jobId: string;
  maxAttempts?: number;
  owner?: string;
  /**
   * Pre-dispatch send gate (channel read/send ACL). It is evaluated again here,
   * not only when the message was accepted, so a revoked permission stops the
   * message before any provider call. A denial is permanent: no retry is scheduled.
   */
  authorize?: (input: { companyId: string; connectionId: string; actorId: string }) => Promise<boolean>;
}): Promise<DispatchResult> {
  const { db, schema, adapter, jobId } = input;
  if (!SCHEMA_PATTERN.test(schema)) throw new Error('INVALID_SCHEMA');
  const owner = input.owner ?? `worker-${process.pid}`;
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const claimed = await db.query<OutboxJobRow & { intent_key: string; company_id: string }>(
    `UPDATE "${schema}".outbox_jobs
     SET state='leased', lease_owner=$2, lease_until=now() + interval '60 seconds',
         attempt_count=attempt_count+1, fence=fence+1
     WHERE id=$1 AND state='pending' AND available_at <= now()
     RETURNING id, company_id, intent_key, state, attempt_count, available_at, payload`,
    [jobId, owner],
  );
  const job = claimed.rows[0];
  if (!job) {
    const existing = await db.query<{ state: string }>(
      `SELECT state FROM "${schema}".outbox_jobs WHERE id=$1`,
      [jobId],
    );
    if (!existing.rows[0]) throw new OutboxJobNotFoundError(jobId);
    return { skipped: true, outcome: null, retryScheduled: false };
  }

  const payload = parseSendPayload(job.payload);
  if (!payload) {
    await finish(db, schema, jobId, 'failed', { errorCode: 'INVALID_PAYLOAD' });
    return { skipped: false, outcome: { status: 'failed', errorCode: 'INVALID_PAYLOAD', retryable: false }, retryScheduled: false };
  }

  if (input.authorize) {
    // Without a known actor the permission cannot be proven; an unproven ACL is
    // never treated as granted.
    const allowed =
      payload.actorId !== undefined &&
      (await input.authorize({
        companyId: job.company_id,
        connectionId: payload.connectionId,
        actorId: payload.actorId,
      }));
    if (!allowed) {
      await finish(db, schema, jobId, 'failed', { errorCode: 'SEND_FORBIDDEN' });
      // The permission was revoked: a confirmed rejection that no retry can fix.
      await raiseAlert(db, { schema }, {
        companyId: job.company_id,
        connectionId: payload.connectionId,
        kind: 'send_rejected',
        dedupeKey: `send_rejected:${job.id}`,
        errorCode: 'ACCESS_REVOKED',
      });
      return { skipped: false, outcome: { status: 'failed', errorCode: 'SEND_FORBIDDEN', retryable: false }, retryScheduled: false };
    }
  }

  let outcome: SendOutcome;
  try {
    outcome = await adapter.send({
      externalChatId: payload.externalChatId,
      idempotencyKey: job.intent_key,
      content: payload.content,
    });
  } catch (error) {
    if (error instanceof CapabilityNotAllowedError) {
      // A capability refusal is a permanent, explainable outcome: no attempt
      // was made and repeating it cannot help.
      await finish(db, schema, jobId, 'failed', { errorCode: error.code, capability: error.capability });
      throw error;
    }
    await finish(db, schema, jobId, 'unknown', { errorCode: 'ADAPTER_ERROR' });
    return { skipped: false, outcome: { status: 'unknown', errorCode: 'ADAPTER_ERROR' }, retryScheduled: false };
  }

  if (outcome.status === 'sent') {
    await finish(db, schema, jobId, 'completed', {
      status: 'sent',
      providerMessageId: outcome.providerMessageId,
      // Delivery is a separate provider fact; nothing is recorded here.
    });
    return { skipped: false, outcome, retryScheduled: false };
  }

  if (outcome.status === 'unknown') {
    await finish(db, schema, jobId, 'unknown', { status: 'unknown', errorCode: outcome.errorCode });
    // An unknown outcome is not a failure: the message may still have been
    // delivered. It goes to the review queue, and the administrator is told that
    // a human has to look at it. The `unknown` send rule is preserved — nothing is
    // retried and nothing is marked failed.
    await raiseAlert(db, { schema }, {
      companyId: job.company_id,
      connectionId: payload.connectionId,
      kind: 'manual_review',
      dedupeKey: `manual_review:${job.id}`,
      errorCode: 'OUTCOME_UNKNOWN',
    });
    return { skipped: false, outcome, retryScheduled: false };
  }

  if (outcome.retryable && job.attempt_count < maxAttempts) {
    const delay = Math.min(BASE_BACKOFF_SECONDS * 2 ** (job.attempt_count - 1), MAX_BACKOFF_SECONDS);
    await db.query(
      `UPDATE "${schema}".outbox_jobs
       SET state='pending', lease_owner=NULL, lease_until=NULL,
           available_at = now() + ($2 || ' seconds')::interval,
           payload = payload || $3::jsonb
       WHERE id=$1`,
      [jobId, String(delay), JSON.stringify({ lastError: outcome.errorCode, attempts: job.attempt_count })],
    );
    return { skipped: false, outcome, retryScheduled: true };
  }

  await finish(db, schema, jobId, 'failed', { status: 'failed', errorCode: outcome.errorCode, retryable: outcome.retryable });
  if (outcome.errorCode === 'AUTH_REQUIRED') {
    await disableChannelAndAlert(db, { schema }, {
      companyId: job.company_id, connectionId: payload.connectionId,
      dedupeKey: `channel_auth_revoked:${job.id}`, errorCode: 'ACCESS_REVOKED',
    });
  }
  // A confirmed rejection is permanent: the provider refused, and retrying cannot
  // help. The alert says so, in our own vocabulary — the provider's error text
  // never reaches the store.
  await raiseAlert(db, { schema }, {
    companyId: job.company_id,
    connectionId: payload.connectionId,
    kind: 'send_rejected',
    dedupeKey: `send_rejected:${job.id}`,
    errorCode: toAlertErrorCode(outcome),
  });
  return { skipped: false, outcome, retryScheduled: false };
}

async function finish(
  db: Db,
  schema: string,
  jobId: string,
  state: 'completed' | 'failed' | 'unknown',
  result: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `UPDATE "${schema}".outbox_jobs
     SET state=$2, lease_owner=NULL, lease_until=NULL, payload = payload || $3::jsonb
     WHERE id=$1`,
    [jobId, state, JSON.stringify({ result })],
  );
}

function parseSendPayload(payload: unknown): SendJobPayload | null {
  if (payload === null || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const externalChatId = record.externalChatId;
  const content = record.content as Record<string, unknown> | undefined;
  if (typeof externalChatId !== 'string' || !externalChatId) return null;
  if (!content || typeof content !== 'object') return null;
  const actorId = typeof record.actorId === 'string' && record.actorId.length > 0 ? record.actorId : undefined;
  if (content.kind === 'text' && typeof content.text === 'string') {
    return { connectionId: String(record.connectionId ?? ''), externalChatId, actorId, content: { kind: 'text', text: content.text } };
  }
  if (content.kind === 'attachment' && typeof content.mediaId === 'string') {
    return {
      connectionId: String(record.connectionId ?? ''),
      externalChatId,
      actorId,
      content: { kind: 'attachment', mediaId: content.mediaId, caption: typeof content.caption === 'string' ? content.caption : '' },
    };
  }
  return null;
}
