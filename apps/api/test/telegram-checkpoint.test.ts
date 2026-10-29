import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { seedConnection, telegramUpdate } from './helpers/telegram.ts';
import { recordTelegramUpdate, readTelegramCheckpoint } from '../src/telegram/inbox.ts';
import { acquirePollLease, commitPollBatch, LeaseLostError } from '../src/telegram/poll.ts';
import type { Db } from '../src/platform/db.ts';

function one<T>(rows: T[]): T {
  const row = rows[0];
  assert.ok(row, 'expected at least one row');
  return row;
}


function failingDb(db: Db): Db {
  const failOnInbox = (run: (text: string, values?: unknown[]) => Promise<unknown>) => {
    return async (text: string, values?: unknown[]) => {
      if (typeof text === 'string' && text.includes('inbox_events')) throw new Error('storage_unavailable');
      return run(text, values);
    };
  };
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'connect') {
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(clientTarget, clientProp, clientReceiver) {
              if (clientProp === 'query') return failOnInbox((text, values) => clientTarget.query(text, values));
              const value = Reflect.get(clientTarget, clientProp, clientReceiver);
              return typeof value === 'function' ? value.bind(clientTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Db;
}

test('checkpoint advances only after the inbox commit and survives a restart', async () => {
  const { db, close } = await createTestDb();
  try {
    const scope = await seedConnection(db);
    assert.equal(await readTelegramCheckpoint(db, scope), 0);

    await recordTelegramUpdate(db, scope, telegramUpdate(100));
    assert.equal(await readTelegramCheckpoint(db, scope), 100);

    await assert.rejects(recordTelegramUpdate(failingDb(db), scope, telegramUpdate(101)));
    assert.equal(await readTelegramCheckpoint(db, scope), 100);

    // A fresh request path (simulated restart) re-delivers the same update.
    const redelivered = await recordTelegramUpdate(db, scope, telegramUpdate(100));
    assert.equal(redelivered.duplicate, true);
    assert.equal(await readTelegramCheckpoint(db, scope), 100);
    const { rows } = await db.query<{ c: number }>('SELECT count(*)::int AS c FROM inbox_events');
    assert.equal(one(rows).c, 1);
  } finally {
    await close();
  }
});

test('checkpoint never moves backwards on out-of-order delivery', async () => {
  const { db, close } = await createTestDb();
  try {
    const scope = await seedConnection(db);
    await recordTelegramUpdate(db, scope, telegramUpdate(205));
    await recordTelegramUpdate(db, scope, telegramUpdate(203));
    assert.equal(await readTelegramCheckpoint(db, scope), 205);
  } finally {
    await close();
  }
});

test('poll lease is exclusive and a stale owner cannot commit', async () => {
  const { db, close } = await createTestDb();
  try {
    const scope = await seedConnection(db);
    const first = await acquirePollLease(db, scope, { owner: 'poller-a', ttlMs: 60_000 });
    assert.ok(first);
    assert.equal(first.fence, 1);

    const second = await acquirePollLease(db, scope, { owner: 'poller-b', ttlMs: 60_000 });
    assert.equal(second, null);

    // Expire the current lease without waiting for wall-clock time.
    await db.query(
      `UPDATE connections
          SET health = jsonb_set(health, '{telegram_poll,until}', to_jsonb((now() - interval '1 second')::text))
        WHERE company_id = $1 AND id = $2`,
      [scope.companyId, scope.connectionId],
    );
    const takeover = await acquirePollLease(db, scope, { owner: 'poller-b', ttlMs: 60_000 });
    assert.ok(takeover);
    assert.equal(takeover.fence, first.fence + 1);

    await assert.rejects(
      commitPollBatch(db, scope, first, [telegramUpdate(900)]),
      (error: unknown) => error instanceof LeaseLostError,
    );
    const { rows } = await db.query<{ c: number }>('SELECT count(*)::int AS c FROM inbox_events');
    assert.equal(one(rows).c, 0);

    const committed = await commitPollBatch(db, scope, takeover, [telegramUpdate(901), telegramUpdate(900)]);
    assert.equal(committed.stored, 2);
    assert.equal(committed.checkpoint, 901);
  } finally {
    await close();
  }
});

test('poll batch deduplicates updates and rejects changed payloads atomically', async () => {
  const { db, close } = await createTestDb();
  try {
    const scope = await seedConnection(db);
    const lease = await acquirePollLease(db, scope, { owner: 'poller-a', ttlMs: 60_000 });
    assert.ok(lease);

    const first = await commitPollBatch(db, scope, lease, [telegramUpdate(300, 'first')]);
    assert.equal(first.stored, 1);
    const again = await commitPollBatch(db, scope, lease, [telegramUpdate(300, 'first')]);
    assert.equal(again.stored, 0);
    assert.equal(again.duplicates, 1);

    await assert.rejects(commitPollBatch(db, scope, lease, [telegramUpdate(301, 'ok'), telegramUpdate(300, 'changed')]));
    const { rows } = await db.query<{ c: number }>('SELECT count(*)::int AS c FROM inbox_events');
    assert.equal(one(rows).c, 1);
    assert.equal(await readTelegramCheckpoint(db, scope), 300);
  } finally {
    await close();
  }
});
