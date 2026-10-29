import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTestDb, TEST_DATABASE_URL } from './helpers/db.ts';
import { seedSendContext } from './helpers/telegram.ts';
import { acceptSendCommand, SEND_JOB_KIND } from '../src/telegram/send.ts';
import type { Db } from '../src/platform/db.ts';

/**
 * Regression for the outbound gateway of the worker process.
 *
 * `OUTBOUND_ENABLED=false` is the normal state of a deployment that is being
 * observed before the gateway is opened, and it is the state the CRM-only live
 * test runs in. While the gateway is closed the worker must keep projecting
 * into the CRM and must keep scheduling the media archive, but it must not
 * claim a Telegram outbox job and it must not reach a provider: a job left in
 * `pending` is harmless, a message delivered to a customer is not.
 *
 * The worker is a separate process, so the test drives the real entry point
 * (`src/worker.ts`) as a child instead of calling an internal function. The
 * child runs against an isolated synthetic schema and reaches the provider
 * through a local fake provider (`helpers/worker-fake-provider.mjs`), so no
 * request ever leaves the machine.
 */

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKER_ENTRY = join(APP_ROOT, 'src', 'worker.ts');
const FAKE_PROVIDER_PRELOAD = join(APP_ROOT, 'test', 'helpers', 'worker-fake-provider.mjs');

/** The worker needs a session secret even though it serves no HTTP traffic. */
const SESSION_SECRET = 'worker-outbound-gate-test-secret-0123456789';

/**
 * The child polls on a timer. A short interval keeps the test fast without
 * making it depend on a fixed sleep: the assertions below wait for the state
 * they expect and fail on a deadline instead.
 */
const WORKER_INTERVAL_MS = '50';
const WORKER_LEASE_MS = '5000';

/** How long a child may take to reach the expected state before the test fails. */
const DEADLINE_MS = 20_000;
const POLL_INTERVAL_MS = 25;

type JobRow = { state: string; fence: string; attempt_count: string };
type ProviderCall = { url: string; method: string; body: string };

/**
 * The child's database URL. `send.ts` addresses `outbox_jobs` and
 * `send_operations` unqualified, so the schema has to be selected through the
 * connection's search path rather than through `DB_SCHEMA` alone.
 *
 * `TEST_DATABASE_URL` comes from the environment (the helper falls back to the
 * project's local test database). Its value is never printed or copied into an
 * assertion message.
 */
function databaseUrlForSchema(schema: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

async function readJob(db: Db): Promise<{ state: string; fence: number; attempt_count: number }> {
  const { rows } = await db.query<JobRow>(
    `SELECT state, fence, attempt_count FROM outbox_jobs WHERE job_kind = $1 ORDER BY created_at LIMIT 1`,
    [SEND_JOB_KIND],
  );
  const row = rows[0];
  assert.ok(row, 'the send job must exist');
  return {
    state: row.state,
    fence: Number(row.fence),
    attempt_count: Number(row.attempt_count),
  };
}

async function countRows(db: Db, sql: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(sql);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Polls `read` until `predicate` holds. The worker is asynchronous, so the
 * test waits for the state it expects instead of sleeping for a fixed time.
 */
async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  describe: string,
): Promise<T> {
  const deadline = Date.now() + DEADLINE_MS;
  let last = await read();
  while (!predicate(last)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${describe}: ${JSON.stringify(last)}`);
    }
    await delay(POLL_INTERVAL_MS);
    last = await read();
  }
  return last;
}

async function readProviderCalls(logPath: string): Promise<ProviderCall[]> {
  let raw: string;
  try {
    raw = await readFile(logPath, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return [];
    throw error;
  }
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ProviderCall);
}

type ChildHandle = {
  output: () => string;
  /** Resolves once the worker reported that it started, rejects if it died. */
  ready: Promise<void>;
  stop: () => Promise<void>;
};

/**
 * Starts the real worker entry point in its own process. The fake provider is
 * preloaded so that `globalThis.fetch` never performs a real request.
 */
async function startWorker(options: {
  schema: string;
  outboundEnabled: boolean;
  logPath: string;
  /** Configures amoCRM so the worker builds its CRM projection queue. */
  withCrm?: boolean;
}): Promise<ChildHandle> {
  const amocrm = options.withCrm
    ? {
        AMOCRM_CLIENT_ID: 'synthetic-client-id',
        AMOCRM_CLIENT_SECRET: 'synthetic-client-secret',
        AMOCRM_REDIRECT_URI: 'https://messengers.example/oauth',
        AMOCRM_ACCOUNT_DOMAIN: 'synthetic.amocrm.ru',
        AMOCRM_TOKEN_KEY: 'synthetic-token-key-0123456789abcdef',
      }
    : {};
  const child = spawn(
    process.execPath,
    // `--import` takes a module specifier: an absolute Windows path is not a
    // valid ESM URL, so the preload is passed as a file URL.
    ['--import', pathToFileURL(FAKE_PROVIDER_PRELOAD).href, WORKER_ENTRY],
    {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrlForSchema(options.schema),
        DB_SCHEMA: options.schema,
        SESSION_SECRET,
        OUTBOUND_ENABLED: options.outboundEnabled ? 'true' : 'false',
        // An enabled gateway needs an explicit mode; `all` sends every
        // connection, which is what the open-gateway half of this test needs.
        OUTBOUND_MODE: 'all',
        WORKER_ID: `test-worker-${options.outboundEnabled ? 'on' : 'off'}`,
        WORKER_INTERVAL_MS,
        WORKER_LEASE_MS,
        // A Telegram channel is configured, so the send pass has a connection
        // to work with. Only the outbound gate decides whether it runs.
        TELEGRAM_BOT_TOKEN: '123456:fake-bot-token',
        TELEGRAM_API_BASE: 'https://telegram.invalid',
        // The fake provider answers every Telegram call locally.
        WORKER_FAKE_PROVIDER_LOG: options.logPath,
        WORKER_FAKE_PROVIDER_MODE: 'sent',
        ...amocrm,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });

  const exited = once(child, 'exit').then(() => undefined);

  /**
   * The worker announces itself with `worker.started`. Waiting for that line
   * keeps the test honest: without it a child that failed to boot would make
   * every assertion pass for the wrong reason.
   */
  const ready = (async () => {
    const deadline = Date.now() + DEADLINE_MS;
    while (Date.now() < deadline) {
      if (output.includes('"event":"worker.started"')) return;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`the worker child exited before starting:\n${output}`);
      }
      await delay(POLL_INTERVAL_MS);
    }
    throw new Error(`the worker child did not start in time:\n${output}`);
  })();

  return {
    output: () => output,
    ready,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      // The worker closes its pool on SIGTERM and exits; the deadline keeps a
      // stuck child from hanging the suite.
      const result = await Promise.race([
        exited.then(() => 'exited' as const),
        delay(5_000).then(() => 'timeout' as const),
      ]);
      if (result === 'timeout') {
        child.kill('SIGKILL');
        await exited;
      }
    },
  };
}

test(
  'a closed outbound gateway leaves the send job pending while an open one claims it',
  { timeout: 120_000 },
  async () => {
    const { db, schema, close } = await createTestDb();
    const workDir = await mkdtemp(join(tmpdir(), 'worker-outbound-gate-'));
    const logPath = join(workDir, 'provider-calls.log');
    let worker: ChildHandle | null = null;
    try {
      const ctx = await seedSendContext(db);
      const accepted = await acceptSendCommand(db, ctx, {
        commandType: 'reply',
        idempotencyKey: 'worker-outbound-gate-1',
        actorId: ctx.staffId,
        workItemId: ctx.workItemId,
        conversationId: ctx.conversationId,
        content: { text: 'hello customer' },
        deadlineSeconds: 3600,
      });
      assert.equal(accepted.duplicate, false);

      // --- The gateway is closed -------------------------------------------------
      worker = await startWorker({ schema, outboundEnabled: false, logPath });
      await worker.ready;
      // Give the worker several ticks to misbehave if it were going to.
      await delay(1_500);

      const gated = await readJob(db);
      assert.equal(gated.state, 'pending', 'the job must not be claimed while the gateway is closed');
      assert.equal(gated.fence, 0, 'a closed gateway must not take a fence');
      assert.equal(gated.attempt_count, 0, 'a closed gateway must not count an attempt');
      assert.equal(
        await countRows(db, 'SELECT count(*)::int AS n FROM send_attempts'),
        0,
        'no send attempt may be recorded while the gateway is closed',
      );
      assert.equal(
        await countRows(db, `SELECT count(*)::int AS n FROM send_operations WHERE state <> 'accepted'`),
        0,
        'the operation must stay accepted while the gateway is closed',
      );
      assert.deepEqual(
        await readProviderCalls(logPath),
        [],
        'the provider must not be called while the gateway is closed',
      );
      // The gate itself, not only its effect: the send pass has to report that
      // it stayed off, so an operator can tell a closed gateway from a queue
      // that happens to be empty.
      assert.ok(
        worker.output().includes('"event":"worker.outbound_disabled"'),
        'the worker must report that the send pass stayed off',
      );

      await worker.stop();
      worker = null;

      // --- The gateway is open ---------------------------------------------------
      worker = await startWorker({ schema, outboundEnabled: true, logPath });
      await worker.ready;
      const claimed = await waitFor(
        async () => readJob(db),
        (job) => job.fence > 0,
        'the worker to claim the send job with the gateway open',
      );
      assert.ok(claimed.fence > 0, 'the open gateway must take a fence on the job');

      // The fake provider is local: the call is recorded instead of leaving the machine.
      const calls = await waitFor(
        async () => readProviderCalls(logPath),
        (recorded) => recorded.length > 0,
        'the fake provider to record the send',
      );
      assert.equal(calls.length, 1, 'the open gateway sends the job exactly once');
      assert.match(calls[0]!.url, /\/bot[^/]+\/sendMessage$/);
      assert.equal(calls[0]!.method, 'POST');
      assert.equal(
        await countRows(db, 'SELECT count(*)::int AS n FROM send_attempts'),
        1,
        'the open gateway records exactly one attempt',
      );
    } finally {
      if (worker) await worker.stop();
      await close();
      await rm(workDir, { recursive: true, force: true });
    }
  },
);

test(
  'a closed outbound gateway still runs the CRM projection pass',
  { timeout: 120_000 },
  async () => {
    const { db, schema, close } = await createTestDb();
    const workDir = await mkdtemp(join(tmpdir(), 'worker-outbound-projection-'));
    const logPath = join(workDir, 'provider-calls.log');
    let worker: ChildHandle | null = null;
    try {
      await seedSendContext(db);
      // A projection job of the kind the inbound path writes.
      await db.query(
        `INSERT INTO outbox_jobs (company_id, id, job_kind, intent_key, payload, state, available_at)
         VALUES ('c1', 'job_projection_1', 'amocrm.projection', 'inbox:projection-1',
                 '{"op":"message","companyId":"c1","accountId":"acc1","conversationId":"conv-1",
                   "providerMessageId":"pm-1","direction":"in","text":"hello"}'::jsonb,
                 'pending', now())`,
      );

      worker = await startWorker({ schema, outboundEnabled: false, logPath, withCrm: true });
      await worker.ready;

      // The queue leases a job before dispatching it, so a claimed projection
      // job proves the CRM pass ran while the send pass stayed off.
      const projection = await waitFor(
        async () => {
          const { rows } = await db.query<{ state: string; fence: string }>(
            `SELECT state, fence FROM outbox_jobs WHERE job_kind = 'amocrm.projection' LIMIT 1`,
          );
          return rows[0] ?? { state: 'missing', fence: '0' };
        },
        (job) => Number(job.fence) > 0,
        'the CRM projection pass to claim its job while the gateway is closed',
      );
      assert.ok(
        Number(projection.fence) > 0,
        'the CRM projection pass must still run while the gateway is closed',
      );
      assert.ok(
        worker.output().includes('"event":"worker.outbound_disabled"'),
        'the send pass stayed off while the CRM projection pass ran',
      );
    } finally {
      if (worker) await worker.stop();
      await close();
      await rm(workDir, { recursive: true, force: true });
    }
  },
);
