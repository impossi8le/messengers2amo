import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from '../helpers/db.ts';
import { seedSendContext } from '../helpers/telegram.ts';
import {
  acceptSendCommand,
  runSendWorker,
  SEND_JOB_KIND,
  type SendCommand,
  type WorkerOptions,
  type WorkerResult,
} from '../../src/telegram/send.ts';
import type { Db } from '../../src/platform/db.ts';
import type { TelegramTransport } from '../../src/telegram/transport.ts';
import { formatSummary, nowMs, sleep, summarize } from './support.ts';

/**
 * Load profile for the send path.
 *
 * 100 logical sends are accepted first (transactional outbox), then 8 workers
 * drain the queue concurrently against a fake transport that takes 5 ms per
 * call. The 5 ms is long enough for workers to overlap on claims and result
 * writes, which is the window where a missing fence would show up.
 */
const COMMANDS = 100;
const WORKERS = 8;
const TRANSPORT_DELAY_MS = 5;

/**
 * Thresholds.
 *
 * The theoretical floor is 100 * 5 ms / 8 workers = 63 ms of transport time.
 * The 15 s budget is deliberately loose: the point of this file is exactly-once
 * and fence correctness, while the wall clock only catches a pathological
 * serialisation (for example a worker holding one connection for the whole
 * batch). A healthy local run stays well under a second.
 */
const TOTAL_BUDGET_MS = 15_000;

function sendCommand(index: number, ctx: { staffId: string; workItemId: string; conversationId: string }): SendCommand {
  return {
    commandType: 'reply',
    idempotencyKey: `load-send-${index}`,
    actorId: ctx.staffId,
    workItemId: ctx.workItemId,
    conversationId: ctx.conversationId,
    content: { text: `load send ${index}` },
    deadlineSeconds: 3600,
  };
}

function delayedTransport(calls: { chatId: string; text: string }[]): TelegramTransport {
  return {
    async sendMessage(input) {
      // Yield first so concurrently claimed jobs overlap their provider calls.
      await sleep(TRANSPORT_DELAY_MS);
      calls.push({ chatId: input.chatId, text: input.text });
      return { outcome: 'sent', providerMessageId: `provider-${input.text}` };
    },
  };
}

async function count(db: Db, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.query<{ c: number }>(sql, params);
  return Number(rows[0]?.c ?? 0);
}

test(
  'send load: 100 queued sends with 8 workers are dispatched exactly once',
  { timeout: 120_000 },
  async (t) => {
    const { db, schema, close } = await createTestDb();
    try {
      const ctx = await seedSendContext(db);
      const acceptCtx = { companyId: ctx.companyId, connectionId: ctx.connectionId, bindingEpoch: ctx.bindingEpoch };
      const workerCtx = { companyId: ctx.companyId, connectionId: ctx.connectionId };

      // Enqueue outside the measured section: this file measures dispatch, not
      // acceptance. Acceptance is covered by telegram-send.test.ts.
      const operationIds = new Set<string>();
      for (let index = 0; index < COMMANDS; index += 1) {
        const accepted = await acceptSendCommand(db, acceptCtx, sendCommand(index, ctx));
        assert.equal(accepted.duplicate, false);
        operationIds.add(accepted.operationId);
      }
      assert.equal(operationIds.size, COMMANDS);

      const calls: { chatId: string; text: string }[] = [];
      const transport = delayedTransport(calls);
      const totals: WorkerResult = { claimed: 0, sent: 0, failed: 0, unknown: 0, rateLimited: 0 };
      const latencies: number[] = [];

      const activeJobs = () =>
        count(
          db,
          `SELECT count(*)::int AS c FROM outbox_jobs
            WHERE company_id=$1 AND job_kind=$2 AND state IN ('pending','leased')`,
          [ctx.companyId, SEND_JOB_KIND],
        );

      const started = nowMs();
      const drain = async (workerIndex: number): Promise<void> => {
        const options: WorkerOptions = {
          ...workerCtx,
          owner: `load-worker-${workerIndex}`,
          leaseMs: 30_000,
          transport,
        };
        while (true) {
          const requestStarted = nowMs();
          const result = await runSendWorker(db, options);
          latencies.push(nowMs() - requestStarted);
          totals.claimed += result.claimed;
          totals.sent += result.sent;
          totals.failed += result.failed;
          totals.unknown += result.unknown;
          totals.rateLimited += result.rateLimited;

          if (result.claimed > 0) continue;
          // A concurrent worker may hold the last pending row with SKIP LOCKED;
          // only stop when no active job remains at all.
          if ((await activeJobs()) === 0) return;
          if (nowMs() - started > TOTAL_BUDGET_MS) throw new Error('send queue did not drain within budget');
          await sleep(2);
        }
      };

      await Promise.all(Array.from({ length: WORKERS }, (_, index) => drain(index)));
      const totalMs = nowMs() - started;

      const summary = summarize(latencies, totalMs);
      t.diagnostic(
        formatSummary(`send 100 jobs / ${WORKERS} workers / ${TRANSPORT_DELAY_MS}ms transport`, summary),
      );

      assert.equal(totals.claimed, COMMANDS, 'every job was claimed');
      assert.equal(totals.sent, COMMANDS, 'every job reported sent');
      assert.equal(totals.failed, 0);
      assert.equal(totals.unknown, 0);
      assert.equal(totals.rateLimited, 0);

      // Exactly one provider call per logical command, no duplicates.
      assert.equal(calls.length, COMMANDS, 'the provider saw exactly one call per command');
      assert.equal(new Set(calls.map((call) => call.text)).size, COMMANDS, 'no command was sent twice');

      // Operation state and provider identity.
      assert.equal(
        await count(db, `SELECT count(*)::int AS c FROM send_operations WHERE company_id=$1 AND state='sent'`, [
          ctx.companyId,
        ]),
        COMMANDS,
      );
      assert.equal(
        await count(
          db,
          `SELECT count(DISTINCT provider_message_id)::int AS c FROM send_operations WHERE company_id=$1`,
          [ctx.companyId],
        ),
        COMMANDS,
        'each operation received its own provider message id',
      );

      // Exactly one attempt per operation.
      assert.equal(
        await count(db, `SELECT count(*)::int AS c FROM send_attempts WHERE company_id=$1`, [ctx.companyId]),
        COMMANDS,
      );
      assert.equal(
        await count(
          db,
          `SELECT count(*)::int AS c FROM (
             SELECT operation_id FROM send_attempts WHERE company_id=$1
              GROUP BY operation_id HAVING count(*) > 1
           ) dup`,
          [ctx.companyId],
        ),
        0,
        'no operation was attempted more than once',
      );
      assert.equal(
        await count(
          db,
          `SELECT count(*)::int AS c FROM send_attempts
            WHERE company_id=$1 AND (state <> 'sent' OR attempt_no <> 1)`,
          [ctx.companyId],
        ),
        0,
      );

      // Fence invariant: one claim per job, and every attempt is stamped with
      // the fence its worker held. A concurrent double-claim would show up as
      // fence > 1 or as a dispatch_fence that does not match the job.
      assert.equal(
        await count(
          db,
          `SELECT count(*)::int AS c FROM outbox_jobs
            WHERE company_id=$1 AND job_kind=$2 AND state <> 'completed'`,
          [ctx.companyId, SEND_JOB_KIND],
        ),
        0,
        'every job completed',
      );
      assert.equal(
        await count(
          db,
          `SELECT count(*)::int AS c FROM outbox_jobs
            WHERE company_id=$1 AND job_kind=$2 AND (fence <> 1 OR attempt_count <> 1)`,
          [ctx.companyId, SEND_JOB_KIND],
        ),
        0,
        'each job was claimed exactly once',
      );
      assert.equal(
        await count(
          db,
          `SELECT count(*)::int AS c FROM send_attempts a
             JOIN outbox_jobs j
               ON j.company_id=a.company_id AND j.job_kind=$2 AND j.payload->>'operationId'=a.operation_id
            WHERE a.company_id=$1 AND a.dispatch_fence <> j.fence`,
          [ctx.companyId, SEND_JOB_KIND],
        ),
        0,
        'attempt evidence carries the fence of the claim that produced it',
      );
      assert.equal(
        await count(
          db,
          `SELECT count(*)::int AS c FROM outbox_jobs
            WHERE company_id=$1 AND job_kind=$2 AND (lease_owner IS NOT NULL OR lease_until IS NOT NULL)`,
          [ctx.companyId, SEND_JOB_KIND],
        ),
        0,
        'no lease is left dangling after the drain',
      );

      assert.ok(totalMs <= TOTAL_BUDGET_MS, `total ${totalMs.toFixed(1)}ms exceeds ${TOTAL_BUDGET_MS}ms`);
    } finally {
      await close();
    }
  },
);
