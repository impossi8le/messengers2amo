import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { seedConnection, fakeFetch } from './helpers/channel-fixtures.ts';
import { createMaxAdapter } from '../src/channels/max.ts';
import { enqueueSend, dispatchSend, type OutboxJobRow } from '../src/channels/outbox.ts';
import { CapabilityNotAllowedError } from '../src/channels/errors.ts';

const SECRET = 'max-secret-value';

function maxAdapter(fetchImpl: typeof fetch) {
  return createMaxAdapter({
    accessToken: 'token',
    webhookSecret: SECRET,
    apiBase: 'https://platform-api2.example.test',
    fetch: fetchImpl,
  });
}

async function readJob(db: Awaited<ReturnType<typeof createTestDb>>['db'], schema: string, id: string) {
  const { rows } = await db.query<OutboxJobRow>(
    `SELECT id, state, attempt_count, available_at, payload FROM "${schema}".outbox_jobs WHERE id = $1`,
    [id],
  );
  return rows[0];
}

test('outbox: the same intent key enqueues one job', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fixture = await seedConnection(db, schema, { channelMode: 'max_bot' });
    const payload = { connectionId: fixture.connectionId, externalChatId: '42', content: { kind: 'text' as const, text: 'hi' } };
    const first = await enqueueSend(db, { schema,  companyId: fixture.companyId, intentKey: 'idem-1', payload });
    const second = await enqueueSend(db, { schema,  companyId: fixture.companyId, intentKey: 'idem-1', payload });
    assert.equal(first.jobId, second.jobId);
    assert.equal(second.created, false);
  } finally {
    await close();
  }
});

test('outbox: confirmed API success completes the job but produces no delivery evidence', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fixture = await seedConnection(db, schema, { channelMode: 'max_bot' });
    const { jobId } = await enqueueSend(db, { schema, 
      companyId: fixture.companyId,
      intentKey: 'idem-sent',
      payload: { connectionId: fixture.connectionId, externalChatId: '42', content: { kind: 'text', text: 'hi' } },
    });
    const { fetch, calls } = fakeFetch(() => ({ json: { message: { body: { mid: 'mid.out' } } } }));
    const result = await dispatchSend({ db, schema, adapter: maxAdapter(fetch), jobId });
    assert.equal(result.outcome?.status, 'sent');
    assert.equal(calls.length, 1);
    const job = await readJob(db, schema, jobId);
    assert.equal(job?.state, 'completed');
    const { rows } = await db.query(`SELECT * FROM "${schema}".provider_receipt_evidence`);
    assert.equal(rows.length, 0, 'HTTP success must not fabricate delivered/read evidence');
  } finally {
    await close();
  }
});

test('outbox: 429 keeps the job pending with backoff and does not complete it', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fixture = await seedConnection(db, schema, { channelMode: 'max_bot' });
    const { jobId } = await enqueueSend(db, { schema, 
      companyId: fixture.companyId,
      intentKey: 'idem-429',
      payload: { connectionId: fixture.connectionId, externalChatId: '42', content: { kind: 'text', text: 'hi' } },
    });
    const { fetch } = fakeFetch(() => ({ status: 429, json: { code: 'too_many_requests' } }));
    const result = await dispatchSend({ db, schema, adapter: maxAdapter(fetch), jobId });
    assert.equal(result.outcome?.status, 'failed');
    assert.equal(result.retryScheduled, true);
    const job = await readJob(db, schema, jobId);
    assert.equal(job?.state, 'pending');
    assert.equal(job?.attempt_count, 1);
    assert.ok(job && new Date(job.available_at).getTime() > Date.now(), 'backoff is in the future');
  } finally {
    await close();
  }
});

test('outbox: timeout marks unknown and never retries blindly', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fixture = await seedConnection(db, schema, { channelMode: 'max_bot' });
    const { jobId } = await enqueueSend(db, { schema, 
      companyId: fixture.companyId,
      intentKey: 'idem-unknown',
      payload: { connectionId: fixture.connectionId, externalChatId: '42', content: { kind: 'text', text: 'hi' } },
    });
    const { fetch, calls } = fakeFetch(() => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      return { throwError: error };
    });
    const result = await dispatchSend({ db, schema, adapter: maxAdapter(fetch), jobId });
    assert.equal(result.outcome?.status, 'unknown');
    assert.equal(result.retryScheduled, false);
    const job = await readJob(db, schema, jobId);
    assert.equal(job?.state, 'unknown');
    assert.equal(calls.length, 1);
  } finally {
    await close();
  }
});

test('outbox: a job already completed is not dispatched twice', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fixture = await seedConnection(db, schema, { channelMode: 'max_bot' });
    const { jobId } = await enqueueSend(db, { schema, 
      companyId: fixture.companyId,
      intentKey: 'idem-once',
      payload: { connectionId: fixture.connectionId, externalChatId: '42', content: { kind: 'text', text: 'hi' } },
    });
    const { fetch, calls } = fakeFetch(() => ({ json: { message: { body: { mid: 'm' } } } }));
    const adapter = maxAdapter(fetch);
    await dispatchSend({ db, schema, adapter, jobId });
    const second = await dispatchSend({ db, schema, adapter, jobId });
    assert.equal(second.skipped, true);
    assert.equal(calls.length, 1);
  } finally {
    await close();
  }
});

test('outbox: forbidden capability fails the job with a clear error, no HTTP attempt', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fixture = await seedConnection(db, schema, { channelMode: 'max_bot' });
    const { jobId } = await enqueueSend(db, { schema, 
      companyId: fixture.companyId,
      intentKey: 'idem-media',
      payload: {
        connectionId: fixture.connectionId,
        externalChatId: '42',
        content: { kind: 'attachment', mediaId: 'm1', caption: '' },
      },
    });
    const { fetch, calls } = fakeFetch(() => ({ json: {} }));
    await assert.rejects(
      async () => dispatchSend({ db, schema, adapter: maxAdapter(fetch), jobId }),
      (error: unknown) => error instanceof CapabilityNotAllowedError,
    );
    assert.equal(calls.length, 0);
    const job = await readJob(db, schema, jobId);
    assert.equal(job?.state, 'failed');
  } finally {
    await close();
  }
});
