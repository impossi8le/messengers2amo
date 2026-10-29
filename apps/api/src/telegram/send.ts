import { randomUUID } from 'node:crypto';
import { withTransaction, type Db, type Tx } from '../platform/db.ts';
import { logEvent } from '../platform/logger.ts';
import { disableChannelAndAlert, raiseAlert } from '../channels/alerts.ts';
import { confirmSendCoverage } from '../repo/attention.ts';
import { payloadFingerprint } from './canonical.ts';
import type { TelegramTransport, TransportOutcome } from './transport.ts';
import { authorizeCrmChannelSend } from '../integrations/amocrm/directory-access.ts';
import type { CrmOwnerResolver } from '../integrations/amocrm/directory-owner.ts';
import {outboundConnectionAllowed,outboundScopeAllowed,type OutboundPolicy} from '../platform/outbound-policy.ts';

export type SendCommand = {
  commandType: string;
  idempotencyKey: string;
  actorId: string;
  workItemId: string;
  conversationId: string;
  content: Record<string, unknown>;
  deadlineSeconds: number;
  /**
   * Sealed compose snapshot the reply was written against. It is part of the
   * immutable intent: the same key with another snapshot is a different command.
   */
  snapshotId?: string | null;
};

export type AcceptedCommand = {
  operationId: string;
  duplicate: boolean;
  state: string;
};

export class IdempotencyConflictError extends Error {
  readonly code = 'idempotency_conflict';
  constructor() {
    super('idempotency_conflict');
  }
}

export type WorkerOptions = {
  companyId: string;
  connectionId: string;
  owner: string;
  leaseMs: number;
  transport: TelegramTransport;
  schema?: string;
  resolveCrmOwner?:CrmOwnerResolver;
  outboundPolicy?:OutboundPolicy;
};

export type WorkerResult = {
  claimed: number;
  sent: number;
  failed: number;
  unknown: number;
  rateLimited: number;
};

export const SEND_JOB_KIND = 'telegram.send';
export const MAX_SEND_ATTEMPTS = 3;

type SendContext = {
  companyId: string;
  connectionId: string;
  bindingEpoch: number;
};

/**
 * The fingerprint covers the immutable intent described by L03: route, content,
 * coverage and the requested deadline policy. The absolute deadline is stored
 * separately so a retry of the same command stays the same logical operation.
 */
function commandFingerprint(ctx: SendContext, command: SendCommand): string {
  return payloadFingerprint({
    commandType: command.commandType,
    workItemId: command.workItemId,
    conversationId: command.conversationId,
    connectionId: ctx.connectionId,
    bindingEpoch: ctx.bindingEpoch,
    snapshotId: command.snapshotId ?? null,
    content: command.content,
    coverage: 'unconfirmed',
    deadlineSeconds: command.deadlineSeconds,
  });
}

async function readOperation(
  tx: Tx,
  companyId: string,
  commandType: string,
  idempotencyKey: string,
): Promise<{ id: string; state: string; payload_fingerprint: string } | null> {
  const { rows } = await tx.query<{ id: string; state: string; payload_fingerprint: string }>(
    `SELECT id, state, payload_fingerprint FROM send_operations
      WHERE company_id = $1 AND command_type = $2 AND idempotency_key = $3`,
    [companyId, commandType, idempotencyKey],
  );
  return rows[0] ?? null;
}

/**
 * Accepts one logical send. The unique (company, command_type, idempotency_key)
 * constraint decides the winner; a loser compares fingerprints and either
 * returns the original operation or raises a conflict. A job is enqueued in the
 * same transaction as the operation (transactional outbox).
 *
 * The operation starts in `accepted`: acceptance by our server is not delivery and
 * not even a dispatch. Only the worker moves it to `dispatching`/`sent`/`unknown`.
 */
export async function acceptSendCommandInTransaction(
  tx: Tx,
  ctx: SendContext,
  command: SendCommand,
): Promise<AcceptedCommand> {
  const fingerprint = commandFingerprint(ctx, command);

  const inserted = await tx.query<{ id: string; state: string }>(
    `INSERT INTO send_operations
       (company_id, id, work_item_id, conversation_id, connection_id, binding_epoch, snapshot_id,
        actor_id, command_type, idempotency_key, payload_fingerprint, state, coverage, content, deadline)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'accepted','unconfirmed',$12::jsonb,
             now() + ($13::text || ' seconds')::interval)
     ON CONFLICT (company_id, command_type, idempotency_key) DO NOTHING
     RETURNING id, state`,
    [
      ctx.companyId,
      randomUUID(),
      command.workItemId,
      command.conversationId,
      ctx.connectionId,
      ctx.bindingEpoch,
      command.snapshotId ?? null,
      command.actorId,
      command.commandType,
      command.idempotencyKey,
      fingerprint,
      JSON.stringify(command.content),
      String(command.deadlineSeconds),
    ],
  );

  if (inserted.rowCount === 0) {
    const existing = await readOperation(tx, ctx.companyId, command.commandType, command.idempotencyKey);
    if (!existing) throw new Error('idempotency_row_missing');
    if (existing.payload_fingerprint !== fingerprint) throw new IdempotencyConflictError();
    return { operationId: existing.id, duplicate: true, state: existing.state };
  }

  const operation = inserted.rows[0];
  if (!operation) throw new Error('send_operation_missing_row');
  await tx.query(
    `INSERT INTO outbox_jobs (company_id, id, job_kind, intent_key, payload, state, available_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,'pending',now())
     ON CONFLICT (company_id, job_kind, intent_key) DO NOTHING`,
    [
      ctx.companyId,
      randomUUID(),
      SEND_JOB_KIND,
      `${command.commandType}:${command.idempotencyKey}`,
      JSON.stringify({
        operationId: operation.id,
        connectionId: ctx.connectionId,
        conversationId: command.conversationId,
        workItemId: command.workItemId,
      }),
    ],
  );
  return { operationId: operation.id, duplicate: false, state: operation.state };
}

/**
 * Accepts one logical send. The unique (company, command_type, idempotency_key)
 * constraint decides the winner; a loser compares fingerprints and either
 * returns the original operation or raises a conflict. A job is enqueued in the
 * same transaction as the operation (transactional outbox).
 */
export async function acceptSendCommand(db: Db, ctx: SendContext, command: SendCommand): Promise<AcceptedCommand> {
  return withTransaction(db, (tx) => acceptSendCommandInTransaction(tx, ctx, command));
}

type ClaimedJob = {
  id: string;
  fence: number;
  attemptCount: number;
  operationId: string;
  /**
   * True when the job was picked up from a `leased` row whose lease had
   * expired: its previous owner may have died at any point, so the operation
   * state decides whether a fresh dispatch is safe.
   */
  reclaimed: boolean;
};

async function claimJob(db: Db, options: WorkerOptions): Promise<ClaimedJob | null> {
  const pilot=options.outboundPolicy?.mode==='pilot'?options.outboundPolicy:null;
  const { rows } = await db.query<{
    id: string;
    fence: string;
    attempt_count: number;
    operation_id: string;
    reclaimed: boolean;
  }>(
    `WITH candidate AS (
       SELECT j.company_id, j.id, j.state = 'leased' AS reclaimed FROM outbox_jobs j
        JOIN send_operations o ON o.company_id=j.company_id AND o.id=j.payload->>'operationId'
        JOIN conversations c ON c.company_id=o.company_id AND c.id=o.conversation_id AND c.binding_epoch=o.binding_epoch
        WHERE j.company_id = $1
          AND j.job_kind = $2
          AND j.payload->>'connectionId' = $3 AND o.connection_id=$3
          AND ($6::text IS NULL OR (o.conversation_id=$6 AND o.binding_epoch=$7::bigint
            AND o.created_at>=$8::timestamptz AND j.created_at>=$8::timestamptz))
          AND (
                (j.state = 'pending' AND j.available_at <= now())
             OR (j.state = 'leased' AND j.lease_until <= now())
          )
        ORDER BY j.available_at, j.created_at
        FOR UPDATE OF j SKIP LOCKED
        LIMIT 1
     )
     UPDATE outbox_jobs j
        SET state = 'leased',
            lease_owner = $4,
            lease_until = now() + ($5::text || ' milliseconds')::interval,
            fence = j.fence + 1,
            attempt_count = j.attempt_count + 1
       FROM candidate
      WHERE j.company_id = candidate.company_id AND j.id = candidate.id
      RETURNING j.id, j.fence, j.attempt_count, j.payload->>'operationId' AS operation_id, candidate.reclaimed`,
    [options.companyId, SEND_JOB_KIND, options.connectionId, options.owner, String(options.leaseMs),
      pilot?.conversationId??null,pilot?.bindingEpoch??null,pilot?.activatedAfter??null],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    fence: Number(row.fence),
    attemptCount: row.attempt_count,
    operationId: row.operation_id,
    reclaimed: row.reclaimed,
  };
}

type DispatchTarget = {
  state: string;
  conversationId: string;
  externalChatId: string;
  text: string;
  deadlineExpired: boolean;
  authorized: boolean;
  connectionId:string;
  bindingEpoch:number;
  currentBindingEpoch:number;
  createdAt:Date;
  replyToMessageId?:string;
  quoteAllowed:boolean;
};

async function loadDispatchTarget(tx: Tx, companyId: string, operationId: string,resolveOwner?:CrmOwnerResolver): Promise<DispatchTarget | null> {
  const { rows } = await tx.query<{
    state: string;
    conversation_id: string;
    external_chat_id: string;
    text: string | null;
    deadline_expired: boolean;
    actor_id:string;connection_id:string;binding_epoch:string;current_binding_epoch:string;created_at:Date;reply_to_message_id:string|null;quote_allowed:boolean;
  }>(
    `SELECT o.state, o.conversation_id, c.external_chat_id, o.content->>'text' AS text,o.actor_id,o.connection_id,
            o.binding_epoch,c.binding_epoch AS current_binding_epoch,o.created_at,
            o.content->>'replyToMessageId' AS reply_to_message_id,
            (NOT (o.content ? 'replyToMessageId') OR EXISTS(SELECT 1 FROM messages qm
              WHERE qm.company_id=o.company_id AND qm.conversation_id=o.conversation_id AND qm.provider_message_id=o.content->>'replyToMessageId')) AS quote_allowed,
            o.deadline <= now() AS deadline_expired
       FROM send_operations o
       JOIN conversations c ON c.company_id = o.company_id AND c.id = o.conversation_id
      WHERE o.company_id = $1 AND o.id = $2`,
    [companyId, operationId],
  );
  const row = rows[0];
  if (!row || typeof row.text !== 'string') return null;
  const schema=(await tx.query<{schema:string}>('SELECT current_schema() AS schema')).rows[0]!.schema;
  const access=await authorizeCrmChannelSend(tx,schema,{companyId,connectionId:row.connection_id,conversationId:row.conversation_id,staffId:row.actor_id,resolveOwner});
  return {
    state: row.state,
    conversationId: row.conversation_id,
    externalChatId: row.external_chat_id,
    text: row.text,
    deadlineExpired: row.deadline_expired,
    authorized:access.allowed,
    connectionId:row.connection_id,bindingEpoch:Number(row.binding_epoch),currentBindingEpoch:Number(row.current_binding_epoch),createdAt:row.created_at,
    replyToMessageId:row.reply_to_message_id??undefined,quoteAllowed:row.quote_allowed,
  };
}

type AttemptWrite = {
  attemptId: string;
  attemptNo: number;
};

async function beginAttempt(tx: Tx, companyId: string, job: ClaimedJob): Promise<AttemptWrite> {
  const attemptId = randomUUID();
  await tx.query(
    `INSERT INTO send_attempts (company_id, id, operation_id, attempt_no, dispatch_fence, state)
     VALUES ($1,$2,$3,$4,$5,'dispatching')`,
    [companyId, attemptId, job.operationId, job.attemptCount, job.fence],
  );
  await tx.query(
    `UPDATE send_operations
        SET state = 'dispatching', version = version + 1
      WHERE company_id = $1 AND id = $2 AND state IN ('accepted','queued')`,
    [companyId, job.operationId],
  );
  return { attemptId, attemptNo: job.attemptCount };
}

type CompletionKind = 'sent' | 'failed' | 'unknown' | 'rate_limited';

function classify(outcome: TransportOutcome): CompletionKind {
  return outcome.outcome;
}

/**
 * Records the provider result. Attempt evidence is always written; the
 * operation and job are updated only while this worker still holds the fence.
 */
async function completeAttempt(
  db: Db,
  options: WorkerOptions,
  job: ClaimedJob,
  attempt: AttemptWrite,
  outcome: TransportOutcome,
  target: DispatchTarget,
): Promise<'applied' | 'fenced'> {
  return withTransaction(db, async (tx) => {
    const kind = classify(outcome);
    const attemptState = kind === 'sent' ? 'sent' : kind === 'unknown' ? 'unknown' : 'failed';
    const providerMessageId = outcome.outcome === 'sent' ? outcome.providerMessageId : null;
    await tx.query(
      `UPDATE send_attempts
          SET state = $3, provider_message_id = $4, completed_at = now()
        WHERE company_id = $1 AND id = $2`,
      [options.companyId, attempt.attemptId, attemptState, providerMessageId],
    );

    const owner = await tx.query<{ fence: string; lease_owner: string | null }>(
      `SELECT fence, lease_owner FROM outbox_jobs WHERE company_id = $1 AND id = $2 FOR UPDATE`,
      [options.companyId, job.id],
    );
    const current = owner.rows[0];
    if (!current || Number(current.fence) !== job.fence || current.lease_owner !== options.owner) {
      logEvent('warn', 'telegram.send.fenced', {
        companyId: options.companyId,
        operationId: job.operationId,
        attemptNo: attempt.attemptNo,
      });
      return 'fenced';
    }

    if (kind === 'sent') {
      await tx.query(
        `UPDATE send_operations
            SET state = 'sent', provider_message_id = $3, version = version + 1
          WHERE company_id = $1 AND id = $2 AND state = 'dispatching'`,
        [options.companyId, job.operationId, providerMessageId],
      );
      await tx.query(
        `UPDATE outbox_jobs
            SET state = 'completed', lease_owner = NULL, lease_until = NULL
          WHERE company_id = $1 AND id = $2`,
        [options.companyId, job.id],
      );
      // The customer-facing history is built from `messages`, which only the
      // inbound path filled. Without this row an operator sends a reply and it
      // never appears in the dialog they are looking at.
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO messages
           (company_id, id, conversation_id, direction, provider_message_id, current_content_version, provenance)
         VALUES ($1,$2,$3,'out',$4,1,'live')
         ON CONFLICT (company_id, conversation_id, provider_message_id) DO NOTHING
         RETURNING id`,
        [options.companyId, randomUUID(), target.conversationId, providerMessageId],
      );
      const messageId = inserted.rows[0]?.id;
      if (messageId) {
        await tx.query(
          `INSERT INTO message_versions (company_id, message_id, content_version, content, observed_at)
           VALUES ($1,$2,1,$3::jsonb,now())`,
          [options.companyId, messageId, JSON.stringify({ kind: 'text', text: target.text })],
        );
      }
      const savedMessage=messageId??(await tx.query<{id:string}>(`SELECT id FROM messages WHERE company_id=$1 AND conversation_id=$2 AND provider_message_id=$3 AND direction='out'`,
        [options.companyId,target.conversationId,providerMessageId])).rows[0]?.id;
      await tx.query(`UPDATE amocrm_message_links SET actual_provider_message_id=$3,message_id=$4 WHERE company_id=$1 AND operation_id=$2`,
        [options.companyId,job.operationId,providerMessageId,savedMessage??null]);
      return 'applied';
    }

    if (kind === 'rate_limited') {
      const canRetry = job.attemptCount < MAX_SEND_ATTEMPTS;
      if (canRetry) {
        const retryAfter = outcome.outcome === 'rate_limited' ? outcome.retryAfterSeconds : 1;
        await tx.query(
          `UPDATE send_operations SET state = 'queued', version = version + 1
            WHERE company_id = $1 AND id = $2 AND state = 'dispatching'`,
          [options.companyId, job.operationId],
        );
        await tx.query(
          `UPDATE outbox_jobs
              SET state = 'pending', lease_owner = NULL, lease_until = NULL,
                  available_at = now() + ($3::text || ' seconds')::interval
            WHERE company_id = $1 AND id = $2`,
          [options.companyId, job.id, String(retryAfter)],
        );
        return 'applied';
      }
      await tx.query(
        `UPDATE send_operations SET state = 'failed', version = version + 1
          WHERE company_id = $1 AND id = $2 AND state = 'dispatching'`,
        [options.companyId, job.operationId],
      );
      await tx.query(
        `UPDATE outbox_jobs SET state = 'failed', lease_owner = NULL, lease_until = NULL
          WHERE company_id = $1 AND id = $2`,
        [options.companyId, job.id],
      );
      return 'applied';
    }

    const operationState = kind === 'unknown' ? 'unknown' : 'failed';
    const jobState = kind === 'unknown' ? 'unknown' : 'failed';
    await tx.query(
      `UPDATE send_operations SET state = $3, version = version + 1
        WHERE company_id = $1 AND id = $2 AND state = 'dispatching'`,
      [options.companyId, job.operationId, operationState],
    );
    await tx.query(
      `UPDATE outbox_jobs SET state = $3, lease_owner = NULL, lease_until = NULL
        WHERE company_id = $1 AND id = $2`,
      [options.companyId, job.id, jobState],
    );
    return 'applied';
  });
}

async function releaseUnsendableJob(db: Db, companyId: string, jobId: string, state: 'completed' | 'cancelled'): Promise<void> {
  await db.query(
    `UPDATE outbox_jobs SET state = $3, lease_owner = NULL, lease_until = NULL
      WHERE company_id = $1 AND id = $2 AND state = 'leased'`,
    [companyId, jobId, state],
  );
}

/**
 * Closes a job only while this worker still holds its fence, so a reclaimed
 * job's previous owner can never overwrite the resolution.
 */
async function finishJob(
  tx: Tx,
  options: WorkerOptions,
  job: ClaimedJob,
  state: 'completed' | 'failed' | 'unknown' | 'cancelled',
  lastError: string | null,
): Promise<void> {
  await tx.query(
    `UPDATE outbox_jobs
        SET state = $3, lease_owner = NULL, lease_until = NULL,
            payload = CASE WHEN $4::text IS NULL THEN payload
                           ELSE payload || jsonb_build_object('lastError', $4::text) END
      WHERE company_id = $1 AND id = $2 AND fence = $5 AND lease_owner = $6`,
    [options.companyId, job.id, state, lastError, job.fence, options.owner],
  );
}

type ReclaimResolution = 'resend' | 'ambiguous' | 'terminal' | 'missing';

/**
 * Decides what an expired lease means for the operation behind it.
 *
 * A dispatch is only repeated when the operation never entered `dispatching`
 * and no attempt was left mid-flight. If the previous owner could already have
 * reached the provider, the operation becomes `unknown` (reconciliation), never
 * a blind resend.
 */
async function resolveReclaimedJob(db: Db, options: WorkerOptions, job: ClaimedJob): Promise<ReclaimResolution> {
  return withTransaction(db, async (tx) => {
    const locked = await tx.query<{ state: string }>(
      `SELECT state FROM send_operations WHERE company_id = $1 AND id = $2 FOR UPDATE`,
      [options.companyId, job.operationId],
    );
    const operation = locked.rows[0];
    if (!operation) {
      await finishJob(tx, options, job, 'completed', null);
      return 'missing';
    }

    if (operation.state === 'dispatching') {
      await tx.query(
        `UPDATE send_attempts SET state = 'unknown', completed_at = now()
          WHERE company_id = $1 AND operation_id = $2 AND state = 'dispatching'`,
        [options.companyId, job.operationId],
      );
      await tx.query(
        `UPDATE send_operations SET state = 'unknown', version = version + 1
          WHERE company_id = $1 AND id = $2 AND state = 'dispatching'`,
        [options.companyId, job.operationId],
      );
      await finishJob(tx, options, job, 'unknown', 'dispatch_unconfirmed');
      return 'ambiguous';
    }

    if (operation.state === 'accepted' || operation.state === 'queued') {
      const inFlight = await tx.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM send_attempts
          WHERE company_id = $1 AND operation_id = $2 AND state = 'dispatching'`,
        [options.companyId, job.operationId],
      );
      if (Number(inFlight.rows[0]?.c ?? 0) > 0) {
        await tx.query(
          `UPDATE send_attempts SET state = 'unknown', completed_at = now()
            WHERE company_id = $1 AND operation_id = $2 AND state = 'dispatching'`,
          [options.companyId, job.operationId],
        );
        await tx.query(
          `UPDATE send_operations SET state = 'unknown', version = version + 1
            WHERE company_id = $1 AND id = $2 AND state IN ('accepted','queued','dispatching')`,
          [options.companyId, job.operationId],
        );
        await finishJob(tx, options, job, 'unknown', 'dispatch_unconfirmed');
        return 'ambiguous';
      }
      return 'resend';
    }

    const jobState =
      operation.state === 'sent'
        ? 'completed'
        : operation.state === 'unknown'
          ? 'unknown'
          : operation.state === 'cancelled'
            ? 'cancelled'
            : 'failed';
    await finishJob(tx, options, job, jobState, null);
    return 'terminal';
  });
}

/**
 * Records a terminal, explainable outcome for an operation whose deadline
 * passed before any provider request was made.
 */
async function failDeadline(tx: Tx, options: WorkerOptions, job: ClaimedJob, attempt: AttemptWrite): Promise<void> {
  await tx.query(
    `UPDATE send_attempts SET state = 'failed', completed_at = now()
      WHERE company_id = $1 AND id = $2`,
    [options.companyId, attempt.attemptId],
  );
  await tx.query(
    `UPDATE send_operations SET state = 'failed', version = version + 1
      WHERE company_id = $1 AND id = $2 AND state = 'dispatching'`,
    [options.companyId, job.operationId],
  );
  await finishJob(tx, options, job, 'failed', 'deadline_exceeded');
}

/**
 * Claims at most one outbox job and performs at most one provider request.
 * Ambiguous results are terminal for automatic processing.
 */
export async function runSendWorker(db: Db, options: WorkerOptions): Promise<WorkerResult> {
  const result: WorkerResult = { claimed: 0, sent: 0, failed: 0, unknown: 0, rateLimited: 0 };
  const policy=options.outboundPolicy??{mode:'all'};
  if(!outboundConnectionAllowed(policy,options))return result;
  const job = await claimJob(db, options);
  if (!job) return result;
  result.claimed = 1;

  if (job.reclaimed) {
    const resolution = await resolveReclaimedJob(db, options, job);
    if (resolution !== 'resend') {
      if (resolution === 'ambiguous') result.unknown = 1;
      if (resolution === 'ambiguous') {
        const schema = options.schema ?? (await db.query<{ schema: string }>('SELECT current_schema() AS schema')).rows[0]!.schema;
        await raiseAlert(db, { schema }, {
          companyId: options.companyId, connectionId: options.connectionId,
          kind: 'manual_review', dedupeKey: `telegram_send:${job.operationId}`, errorCode: 'OUTCOME_UNKNOWN',
        });
      }
      logEvent('warn', 'telegram.send.reclaimed', {
        companyId: options.companyId,
        operationId: job.operationId,
        resolution,
      });
      return result;
    }
  }

  const prepared = await withTransaction(db, async (tx) => {
    const target = await loadDispatchTarget(tx, options.companyId, job.operationId,options.resolveCrmOwner);
    if (!target || (target.state !== 'accepted' && target.state !== 'queued')) {
      return { kind: 'none' as const, target: null as DispatchTarget | null, attempt: null as AttemptWrite | null };
    }
    if(target.bindingEpoch!==target.currentBindingEpoch||!outboundScopeAllowed(policy,{companyId:options.companyId,
      connectionId:target.connectionId,bindingEpoch:target.bindingEpoch,conversationId:target.conversationId,createdAt:target.createdAt})){
      await tx.query(`UPDATE outbox_jobs SET state='pending',lease_owner=NULL,lease_until=NULL,attempt_count=GREATEST(0,attempt_count-1)
        WHERE company_id=$1 AND id=$2 AND fence=$3 AND lease_owner=$4`,[options.companyId,job.id,job.fence,options.owner]);
      return {kind:'policy' as const,target:null,attempt:null};
    }
    const attempt = await beginAttempt(tx, options.companyId, job);
    if (target.deadlineExpired) {
      await failDeadline(tx, options, job, attempt);
      return { kind: 'deadline' as const, target, attempt };
    }
    return { kind: 'send' as const, target, attempt };
  });

  if(prepared.kind==='policy')return result;
  if (prepared.kind === 'none' || !prepared.target || !prepared.attempt) {
    // Already terminal (for example a fenced duplicate): nothing to send.
    await releaseUnsendableJob(db, options.companyId, job.id, 'completed');
    return result;
  }

  if (prepared.kind === 'deadline') {
    result.failed = 1;
    logEvent('info', 'telegram.send.deadline_exceeded', {
      companyId: options.companyId,
      operationId: job.operationId,
      attemptNo: prepared.attempt.attemptNo,
    });
    return result;
  }

  let outcome: TransportOutcome;
  try {
    outcome = prepared.target.authorized&&prepared.target.quoteAllowed&&outboundScopeAllowed(policy,{companyId:options.companyId,connectionId:prepared.target.connectionId,
      bindingEpoch:prepared.target.bindingEpoch,conversationId:prepared.target.conversationId,createdAt:prepared.target.createdAt}) ? await options.transport.sendMessage({ chatId: prepared.target.externalChatId, text: prepared.target.text,
        ...(prepared.target.replyToMessageId?{replyToMessageId:prepared.target.replyToMessageId}:{}) }) :
      {outcome:'failed',code:'channel_access_denied'};
  } catch {
    outcome = { outcome: 'unknown', reason: 'network' };
  }

  const completion = await completeAttempt(db, options, job, prepared.attempt, outcome, prepared.target);
  logEvent('info', 'telegram.send.completed', {
    companyId: options.companyId,
    operationId: job.operationId,
    attemptNo: prepared.attempt.attemptNo,
    outcome: outcome.outcome,
    fenced: completion === 'fenced',
  });

  if (completion === 'fenced') return result;

  if (outcome.outcome === 'unknown' || outcome.outcome === 'failed' ||
      (outcome.outcome === 'rate_limited' && job.attemptCount >= MAX_SEND_ATTEMPTS)) {
    const schema = options.schema ?? (await db.query<{ schema: string }>('SELECT current_schema() AS schema')).rows[0]!.schema;
    const deps = { schema };
    if (outcome.outcome === 'failed' && outcome.code === 'provider_401') {
      await disableChannelAndAlert(db, deps, {
        companyId: options.companyId, connectionId: options.connectionId,
        dedupeKey: `telegram_auth_revoked:${job.operationId}`, errorCode: 'ACCESS_REVOKED',
      });
    }
    await raiseAlert(db, deps, {
      companyId: options.companyId, connectionId: options.connectionId,
      kind: outcome.outcome === 'unknown' ? 'manual_review' : 'send_rejected',
      dedupeKey: `telegram_send:${job.operationId}`,
      errorCode: outcome.outcome === 'unknown' ? 'OUTCOME_UNKNOWN' : 'SEND_REJECTED',
      conversationId: prepared.target.conversationId,
    });
  }

  if (outcome.outcome === 'sent') {
    // The reply's snapshot names the questions it answers. Nothing applied that
    // plan after the send, so the client's questions stayed open forever.
    try {
      const { rows } = await db.query<{ schema: string }>('SELECT current_schema() AS schema');
      const schema = rows[0]?.schema;
      if (schema) {
        await confirmSendCoverage(db, { schema }, { companyId: options.companyId, operationId: job.operationId });
      }
    } catch (error) {
      // The message is already delivered; coverage is a projection and the
      // operator can still confirm it by hand.
      logEvent('warn', 'telegram.send.coverage_failed', {
        companyId: options.companyId,
        operationId: job.operationId,
        reason: (error as Error).message,
      });
    }
  }

  switch (outcome.outcome) {
    case 'sent':
      result.sent = 1;
      break;
    case 'rate_limited':
      if (job.attemptCount < MAX_SEND_ATTEMPTS) result.rateLimited = 1;
      else result.failed = 1;
      break;
    case 'unknown':
      result.unknown = 1;
      break;
    default:
      result.failed = 1;
  }
  return result;
}
