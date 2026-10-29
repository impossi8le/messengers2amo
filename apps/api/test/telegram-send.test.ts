import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { seedSendContext } from './helpers/telegram.ts';
import {
  acceptSendCommand,
  IdempotencyConflictError,
  runSendWorker,
  type SendCommand,
} from '../src/telegram/send.ts';
import type { TransportOutcome, TelegramTransport } from '../src/telegram/transport.ts';
import type { Db } from '../src/platform/db.ts';

function one<T>(rows: T[]): T {
  const row = rows[0];
  assert.ok(row, 'expected at least one row');
  return row;
}


type SendCtx = Awaited<ReturnType<typeof seedSendContext>>;

function command(overrides: Partial<SendCommand> = {}): SendCommand {
  return {
    commandType: 'reply',
    idempotencyKey: 'idem-1',
    actorId: 'staff-1',
    workItemId: 'work-1',
    conversationId: 'conv-1',
    content: { text: 'hello customer' },
    deadlineSeconds: 3600,
    ...overrides,
  };
}

function fakeTransport(outcome: TransportOutcome, calls: { chatId: string; text: string }[] = []): TelegramTransport {
  return {
    sendMessage: async (input) => {
      calls.push({ chatId: input.chatId, text: input.text });
      return outcome;
    },
  };
}

async function workerOptions(ctx: SendCtx, transport: TelegramTransport, owner = 'worker-a') {
  return { companyId: ctx.companyId, connectionId: ctx.connectionId, owner, leaseMs: 30_000, transport };
}

async function operationRows(db: Db): Promise<{ state: string; provider_message_id: string | null; c: number }[]> {
  const { rows } = await db.query<{ state: string; provider_message_id: string | null; c: number }>(
    `SELECT o.state, o.provider_message_id, (SELECT count(*)::int FROM send_attempts a WHERE a.operation_id = o.id) AS c
       FROM send_operations o ORDER BY o.created_at`,
  );
  return rows;
}

test('accepting the same idempotent command twice creates one operation and one job', async () => {
  const { db, close } = await createTestDb();
  try {
    const ctx = await seedSendContext(db);
    const first = await acceptSendCommand(db, ctx, command());
    const second = await acceptSendCommand(db, ctx, command());
    assert.equal(first.operationId, second.operationId);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);

    const ops = await db.query<{ c: number }>('SELECT count(*)::int AS c FROM send_operations');
    assert.equal(one(ops.rows).c, 1);
    const jobs = await db.query<{ c: number }>('SELECT count(*)::int AS c FROM outbox_jobs');
    assert.equal(one(jobs.rows).c, 1);
  } finally {
    await close();
  }
});

test('the same idempotency key with changed content is rejected and never overwrites', async () => {
  const { db, close } = await createTestDb();
  try {
    const ctx = await seedSendContext(db);
    const original = await acceptSendCommand(db, ctx, command());
    await assert.rejects(
      acceptSendCommand(db, ctx, command({ content: { text: 'different text' } })),
      (error: unknown) => error instanceof IdempotencyConflictError,
    );
    const { rows } = await db.query<{ content: { text: string }; payload_fingerprint: string }>(
      'SELECT content, payload_fingerprint FROM send_operations',
    );
    assert.equal(rows.length, 1);
    assert.equal(one(rows).content.text, 'hello customer');
    assert.equal(one(rows).payload_fingerprint.length, 64);
    assert.equal(original.operationId.length > 0, true);
  } finally {
    await close();
  }
});

test('a confirmed send marks the operation sent with one attempt and one provider call', async () => {
  const { db, close } = await createTestDb();
  try {
    const ctx = await seedSendContext(db);
    const accepted = await acceptSendCommand(db, ctx, command());
    const calls: { chatId: string; text: string }[] = [];
    const result = await runSendWorker(db, await workerOptions(ctx, fakeTransport({ outcome: 'sent', providerMessageId: '555' }, calls)));

    assert.equal(result.sent, 1);
    assert.equal(calls.length, 1);
    assert.equal(one(calls).chatId, ctx.externalChatId);
    const ops = await operationRows(db);
    assert.deepEqual(ops, [{ state: 'sent', provider_message_id: '555', c: 1 }]);
    const job = await db.query<{ state: string }>('SELECT state FROM outbox_jobs');
    assert.equal(one(job.rows).state, 'completed');
    const acceptedOp = await db.query<{ id: string }>('SELECT id FROM send_operations');
    assert.equal(one(acceptedOp.rows).id, accepted.operationId);
  } finally {
    await close();
  }
});

test('a sent reply is recorded in the conversation history as an outbound message', async () => {
  const { db, close } = await createTestDb();
  try {
    const ctx = await seedSendContext(db);
    await acceptSendCommand(db, ctx, command());
    const result = await runSendWorker(
      db,
      await workerOptions(ctx, fakeTransport({ outcome: 'sent', providerMessageId: '777' })),
    );
    assert.equal(result.sent, 1);

    // The operator wrote this reply and the provider accepted it, so the dialog
    // history must show it next to the client's messages.
    const { rows } = await db.query<{ id: string; direction: string; conversation_id: string }>(
      `SELECT id, direction, conversation_id FROM messages WHERE provider_message_id = '777'`,
    );
    const message = one(rows);
    assert.equal(message.direction, 'out');
    assert.equal(message.conversation_id, 'conv-1');

    const versions = await db.query<{ content: unknown }>(
      `SELECT content FROM message_versions WHERE message_id = $1`,
      [message.id],
    );
    assert.deepEqual(one(versions.rows).content, { kind: 'text', text: 'hello customer' });
  } finally {
    await close();
  }
});

test('timeout produces unknown, blocks blind retry and survives restart', async () => {
  const { db, close } = await createTestDb();
  try {
    const ctx = await seedSendContext(db);
    await acceptSendCommand(db, ctx, command());
    const calls: { chatId: string; text: string }[] = [];
    const transport = fakeTransport({ outcome: 'unknown', reason: 'timeout' }, calls);

    await runSendWorker(db, await workerOptions(ctx, transport));
    const ops = await operationRows(db);
    assert.equal(one(ops).state, 'unknown');
    assert.equal(calls.length, 1);

    // Restart: a new worker pass must not resend an unknown operation.
    const restarted = await runSendWorker(db, await workerOptions(ctx, transport, 'worker-b'));
    assert.equal(restarted.claimed, 0);
    assert.equal(calls.length, 1);
    assert.equal(one(await operationRows(db)).state, 'unknown');

    // Re-submitting the same command returns the existing unknown operation.
    const resubmitted = await acceptSendCommand(db, ctx, command());
    assert.equal(resubmitted.duplicate, true);
    assert.equal(resubmitted.state, 'unknown');
    assert.equal(calls.length, 1);
  } finally {
    await close();
  }
});

test('confirmed 429 schedules a bounded retry; 5xx and network stay unknown', async () => {
  const { db, close } = await createTestDb();
  try {
    const ctx = await seedSendContext(db);
    await acceptSendCommand(db, ctx, command());

    const limited = await runSendWorker(
      db,
      await workerOptions(ctx, fakeTransport({ outcome: 'rate_limited', retryAfterSeconds: 5 })),
    );
    assert.equal(limited.rateLimited, 1);
    let op = one(await operationRows(db));
    assert.equal(op.state, 'queued');
    const job = await db.query<{ state: string; attempt_count: number; available_at: string }>(
      'SELECT state, attempt_count, available_at FROM outbox_jobs',
    );
    assert.equal(one(job.rows).state, 'pending');
    assert.equal(one(job.rows).attempt_count, 1);
    assert.ok(new Date(one(job.rows).available_at).getTime() > Date.now());

    const early = await runSendWorker(db, await workerOptions(ctx, fakeTransport({ outcome: 'sent', providerMessageId: '1' })));
    assert.equal(early.claimed, 0, 'retry must respect retry_after');

    await db.query("UPDATE outbox_jobs SET available_at = now() - interval '1 second'");
    const second = await runSendWorker(
      db,
      await workerOptions(ctx, fakeTransport({ outcome: 'unknown', reason: 'http_5xx' })),
    );
    assert.equal(second.unknown, 1);
    op = one(await operationRows(db));
    assert.equal(op.state, 'unknown');
    const finalJob = await db.query<{ state: string }>('SELECT state FROM outbox_jobs');
    assert.equal(one(finalJob.rows).state, 'unknown');
  } finally {
    await close();
  }
});

test('429 retries stop at the bounded attempt limit', async () => {
  const { db, close } = await createTestDb();
  try {
    const ctx = await seedSendContext(db);
    await acceptSendCommand(db, ctx, command());
    const transport = fakeTransport({ outcome: 'rate_limited', retryAfterSeconds: 0 });

    for (let i = 0; i < 4; i += 1) {
      await runSendWorker(db, await workerOptions(ctx, transport));
      await db.query("UPDATE outbox_jobs SET available_at = now() - interval '1 second' WHERE state = 'pending'");
    }
    const job = await db.query<{ state: string; attempt_count: number }>('SELECT state, attempt_count FROM outbox_jobs');
    assert.equal(one(job.rows).state, 'failed');
    assert.ok(one(job.rows).attempt_count <= 3);
    const op = one(await operationRows(db));
    assert.equal(op.state, 'failed');
  } finally {
    await close();
  }
});

test('a confirmed rejection is failed and never retried', async () => {
  const { db, close } = await createTestDb();
  try {
    const ctx = await seedSendContext(db);
    await acceptSendCommand(db, ctx, command());
    const calls: { chatId: string; text: string }[] = [];
    await runSendWorker(db, await workerOptions(ctx, fakeTransport({ outcome: 'failed', code: 'provider_400' }, calls)));
    assert.equal(calls.length, 1);
    assert.equal(one(await operationRows(db)).state, 'failed');
    const second = await runSendWorker(db, await workerOptions(ctx, fakeTransport({ outcome: 'sent', providerMessageId: '9' }, calls)));
    assert.equal(second.claimed, 0);
    assert.equal(calls.length, 1);
  } finally {
    await close();
  }
});

test('provider outage keeps the queue consistent and does not crash the worker', async () => {
  const { db, close } = await createTestDb();
  try {
    const ctx = await seedSendContext(db);
    await acceptSendCommand(db, ctx, command({ idempotencyKey: 'idem-outage' }));
    const transport: TelegramTransport = {
      sendMessage: async () => {
        throw new Error('provider unreachable');
      },
    };
    const result = await runSendWorker(db, await workerOptions(ctx, transport));
    assert.equal(result.unknown, 1);
    assert.equal(one(await operationRows(db)).state, 'unknown');
    const job = await db.query<{ state: string }>('SELECT state FROM outbox_jobs');
    assert.equal(one(job.rows).state, 'unknown');
  } finally {
    await close();
  }
});

test('concurrent workers claim one job and one logical send', async () => {
  const { db, close } = await createTestDb();
  try {
    const ctx = await seedSendContext(db);
    await acceptSendCommand(db, ctx, command());
    const calls: { chatId: string; text: string }[] = [];
    const transport = fakeTransport({ outcome: 'sent', providerMessageId: '321' }, calls);
    const [a, b] = await Promise.all([
      runSendWorker(db, await workerOptions(ctx, transport, 'worker-a')),
      runSendWorker(db, await workerOptions(ctx, transport, 'worker-b')),
    ]);
    assert.equal(a.claimed + b.claimed, 1);
    assert.equal(calls.length, 1);
    const ops = await operationRows(db);
    assert.equal(ops.length, 1);
    assert.equal(one(ops).c, 1);
  } finally {
    await close();
  }
});

test('an expired lease fences the old worker out of the result write', async () => {
  const { db, close } = await createTestDb();
  try {
    const ctx = await seedSendContext(db);
    await acceptSendCommand(db, ctx, command());

    let observedFence = 0;
    const transport: TelegramTransport = {
      sendMessage: async () => {
        // Another worker takes over while this send is in flight.
        const takeover = await db.query<{ fence: string }>(
          `UPDATE outbox_jobs
              SET lease_owner = 'worker-b', lease_until = now() + interval '30 seconds',
                  fence = fence + 1, state = 'leased'
            WHERE company_id = $1 AND state = 'leased'
            RETURNING fence`,
          [ctx.companyId],
        );
        observedFence = Number(one(takeover.rows).fence);
        return { outcome: 'sent', providerMessageId: '888' };
      },
    };

    await runSendWorker(db, await workerOptions(ctx, transport, 'worker-a'));
    assert.ok(observedFence > 1);
    const op = one(await operationRows(db));
    assert.equal(op.state, 'dispatching', 'fenced worker must not confirm the operation');
    const attempt = await db.query<{ state: string; provider_message_id: string | null }>(
      'SELECT state, provider_message_id FROM send_attempts',
    );
    assert.equal(one(attempt.rows).state, 'sent', 'external result is preserved as attempt evidence');
    assert.equal(one(attempt.rows).provider_message_id, '888');
    const job = await db.query<{ state: string; lease_owner: string }>('SELECT state, lease_owner FROM outbox_jobs');
    assert.equal(one(job.rows).lease_owner, 'worker-b');
  } finally {
    await close();
  }
});

test('a job abandoned by a dead worker is reclaimed after its lease expires and sent once', async () => {
  const { db, close } = await createTestDb();
  try {
    const ctx = await seedSendContext(db);
    await acceptSendCommand(db, ctx, command());

    // The first worker committed claimJob and died before it started a dispatch:
    // the job is leased, the operation is still queued and no attempt exists.
    await db.query(
      `UPDATE outbox_jobs
          SET state = 'leased', lease_owner = 'dead-worker',
              lease_until = now() - interval '5 seconds',
              fence = fence + 1, attempt_count = attempt_count + 1`,
    );

    const calls: { chatId: string; text: string }[] = [];
    const result = await runSendWorker(
      db,
      await workerOptions(ctx, fakeTransport({ outcome: 'sent', providerMessageId: '777' }, calls), 'worker-b'),
    );

    assert.equal(result.claimed, 1, 'an expired lease must be reclaimed');
    assert.equal(result.sent, 1);
    assert.equal(calls.length, 1);
    const op = one(await operationRows(db));
    assert.equal(op.state, 'sent');
    assert.equal(op.provider_message_id, '777');
    const job = await db.query<{ state: string; lease_owner: string | null }>(
      'SELECT state, lease_owner FROM outbox_jobs',
    );
    assert.equal(one(job.rows).state, 'completed');
    assert.equal(one(job.rows).lease_owner, null);
  } finally {
    await close();
  }
});

test('a reclaimed job whose attempt may have reached the network becomes unknown, never a blind resend', async () => {
  const { db, close } = await createTestDb();
  try {
    const ctx = await seedSendContext(db);
    await acceptSendCommand(db, ctx, command());
    const opId = one((await db.query<{ id: string }>('SELECT id FROM send_operations')).rows).id;

    // The dead worker claimed the job, began an attempt and died in flight.
    await db.query(
      `UPDATE outbox_jobs
          SET state = 'leased', lease_owner = 'dead-worker',
              lease_until = now() - interval '5 seconds',
              fence = fence + 1, attempt_count = attempt_count + 1`,
    );
    await db.query(
      `INSERT INTO send_attempts (company_id, id, operation_id, attempt_no, dispatch_fence, state)
       VALUES ($1,$2,$3,1,1,'dispatching')`,
      [ctx.companyId, 'attempt-dead', opId],
    );
    await db.query(
      "UPDATE send_operations SET state = 'dispatching', version = version + 1 WHERE company_id = $1 AND id = $2",
      [ctx.companyId, opId],
    );

    const calls: { chatId: string; text: string }[] = [];
    const result = await runSendWorker(
      db,
      await workerOptions(ctx, fakeTransport({ outcome: 'sent', providerMessageId: '999' }, calls), 'worker-b'),
    );

    assert.equal(result.claimed, 1, 'an expired lease must be reclaimed');
    assert.equal(result.unknown, 1);
    assert.equal(calls.length, 0, 'a possibly delivered send must not be repeated');
    const op = one(await operationRows(db));
    assert.equal(op.state, 'unknown');
    const job = await db.query<{ state: string; lease_owner: string | null }>(
      'SELECT state, lease_owner FROM outbox_jobs',
    );
    assert.equal(one(job.rows).state, 'unknown');
    assert.equal(one(job.rows).lease_owner, null);
    const attempt = await db.query<{ state: string }>('SELECT state FROM send_attempts');
    assert.equal(one(attempt.rows).state, 'unknown', 'orphaned dispatch is kept as unknown evidence');

    // A later worker pass must not resend the ambiguous operation.
    const restarted = await runSendWorker(
      db,
      await workerOptions(ctx, fakeTransport({ outcome: 'sent', providerMessageId: '1000' }, calls), 'worker-c'),
    );
    assert.equal(restarted.claimed, 0);
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test('an expired deadline fails the operation without calling the transport', async () => {
  const { db, close } = await createTestDb();
  try {
    const ctx = await seedSendContext(db);
    await acceptSendCommand(db, ctx, command({ deadlineSeconds: -5 }));

    const calls: { chatId: string; text: string }[] = [];
    const result = await runSendWorker(
      db,
      await workerOptions(ctx, fakeTransport({ outcome: 'sent', providerMessageId: '1' }, calls)),
    );

    assert.equal(result.claimed, 1);
    assert.equal(result.failed, 1);
    assert.equal(calls.length, 0, 'an expired command must not reach the provider');
    const op = one(await operationRows(db));
    assert.equal(op.state, 'failed');
    assert.equal(op.c, 1, 'attempt evidence is recorded');
    const job = await db.query<{ state: string; payload: Record<string, unknown> }>(
      'SELECT state, payload FROM outbox_jobs',
    );
    assert.equal(one(job.rows).state, 'failed');
    assert.equal(one(job.rows).payload.lastError, 'deadline_exceeded');
    const attempt = await db.query<{ state: string }>('SELECT state FROM send_attempts');
    assert.equal(one(attempt.rows).state, 'failed');

    // The expired operation is terminal: no later worker pass retries it.
    const restarted = await runSendWorker(
      db,
      await workerOptions(ctx, fakeTransport({ outcome: 'sent', providerMessageId: '2' }, calls), 'worker-b'),
    );
    assert.equal(restarted.claimed, 0);
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test('a deadline that expires during a 429 retry delay stops the resend', async () => {
  const { db, close } = await createTestDb();
  try {
    const ctx = await seedSendContext(db);
    await acceptSendCommand(db, ctx, command({ deadlineSeconds: 1 }));

    const calls: { chatId: string; text: string }[] = [];
    const limited = await runSendWorker(
      db,
      await workerOptions(ctx, fakeTransport({ outcome: 'rate_limited', retryAfterSeconds: 1 }, calls)),
    );
    assert.equal(limited.rateLimited, 1);
    assert.equal(calls.length, 1);

    // The retry becomes available only after the deadline has passed.
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const retried = await runSendWorker(
      db,
      await workerOptions(ctx, fakeTransport({ outcome: 'sent', providerMessageId: '9' }, calls), 'worker-b'),
    );
    assert.equal(retried.failed, 1);
    assert.equal(calls.length, 1, 'the expired retry must not reach the provider');
    assert.equal(one(await operationRows(db)).state, 'failed');
  } finally {
    await close();
  }
});

test('send_attempts record exactly one attempt per dispatch and never reuse numbers', async () => {
  const { db, close } = await createTestDb();
  try {
    const ctx = await seedSendContext(db);
    await acceptSendCommand(db, ctx, command());
    await runSendWorker(db, await workerOptions(ctx, fakeTransport({ outcome: 'rate_limited', retryAfterSeconds: 0 })));
    await db.query("UPDATE outbox_jobs SET available_at = now() - interval '1 second'");
    await runSendWorker(db, await workerOptions(ctx, fakeTransport({ outcome: 'sent', providerMessageId: '42' })));
    const attempts = await db.query<{ attempt_no: number; state: string }>(
      'SELECT attempt_no, state FROM send_attempts ORDER BY attempt_no',
    );
    assert.deepEqual(attempts.rows.map((r) => r.attempt_no), [1, 2]);
    assert.deepEqual(attempts.rows.map((r) => r.state), ['failed', 'sent']);
  } finally {
    await close();
  }
});
