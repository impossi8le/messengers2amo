import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, TEST_DATABASE_URL } from './helpers/db.ts';
import { seedConnection, telegramUpdate } from './helpers/telegram.ts';
import { buildApp } from '../src/app.ts';
import type { Config } from '../src/platform/config.ts';
import type { Db } from '../src/platform/db.ts';

function one<T>(rows: T[]): T {
  const row = rows[0];
  assert.ok(row, 'expected at least one row');
  return row;
}


const WEBHOOK_SECRET = 'hook-secret-value';

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    databaseUrl: TEST_DATABASE_URL,
    sessionSecret: 's'.repeat(40),
    sessionTtlSeconds: 3600,
    secureCookies: false,
    trustedProxy: false,
    adminBootstrapToken: null,
    s3: null,
    amocrm: null,
    telegram: { botToken: '123456:bot-token', webhookSecret: WEBHOOK_SECRET, apiBase: 'https://tg.test' },
    metricsToken: null,
    outboundEnabled: true,
    ...overrides,
  };
}

function postUpdate(app: Awaited<ReturnType<typeof buildApp>>, update: unknown, secret: string | null = WEBHOOK_SECRET) {
  return app.inject({
    method: 'POST',
    url: '/webhooks/telegram/conn-1',
    headers: secret === null ? {} : { 'x-telegram-bot-api-secret-token': secret },
    payload: update as object,
  });
}

async function countEvents(db: Db): Promise<number> {
  const { rows } = await db.query<{ c: number }>('SELECT count(*)::int AS c FROM inbox_events');
  return one(rows).c;
}

test('webhook stores a valid Telegram update durably before ACK', async () => {
  const { db, close } = await createTestDb();
  try {
    await seedConnection(db);
    const app = await buildApp({ config: testConfig(), db });
    try {
      const response = await postUpdate(app, telegramUpdate(1001));
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { ok: true, duplicate: false });

      const { rows } = await db.query<{
        provider_event_key: string;
        payload_major: number;
        kind: string;
        state: string;
        connection_id: string;
        binding_epoch: string;
        payload: Record<string, unknown>;
      }>('SELECT provider_event_key, payload_major, kind, state, connection_id, binding_epoch, payload FROM inbox_events');
      assert.equal(rows.length, 1);
      assert.equal(one(rows).provider_event_key, 'tg:update:1001');
      assert.equal(one(rows).payload_major, 2);
      assert.equal(one(rows).kind, 'message');
      assert.equal(one(rows).state, 'pending');
      assert.equal(one(rows).connection_id, 'conn-1');
      assert.equal(Number(one(rows).binding_epoch), 1);
      assert.equal((one(rows).payload as { update_id: number }).update_id, 1001);
    } finally {
      await app.close();
    }
  } finally {
    await close();
  }
});

test('webhook rejects a wrong or missing secret without storing anything', async () => {
  const { db, close } = await createTestDb();
  try {
    await seedConnection(db);
    const app = await buildApp({ config: testConfig(), db });
    try {
      const wrong = await postUpdate(app, telegramUpdate(2001), 'not-the-secret');
      assert.equal(wrong.statusCode, 401);
      const missing = await postUpdate(app, telegramUpdate(2002), null);
      assert.equal(missing.statusCode, 401);
      assert.equal(await countEvents(db), 0);
    } finally {
      await app.close();
    }
  } finally {
    await close();
  }
});

test('webhook deduplicates the same event and rejects a changed payload', async () => {
  const { db, close } = await createTestDb();
  try {
    await seedConnection(db);
    const app = await buildApp({ config: testConfig(), db });
    try {
      const first = await postUpdate(app, telegramUpdate(3001, 'first'));
      assert.equal(first.statusCode, 200);
      assert.deepEqual(first.json(), { ok: true, duplicate: false });

      const duplicate = await postUpdate(app, telegramUpdate(3001, 'first'));
      assert.equal(duplicate.statusCode, 200);
      assert.deepEqual(duplicate.json(), { ok: true, duplicate: true });
      assert.equal(await countEvents(db), 1);

      const changed = await postUpdate(app, telegramUpdate(3001, 'tampered'));
      assert.equal(changed.statusCode, 409);
      const { rows } = await db.query<{ text: string }>(
        "SELECT payload->'message'->>'text' AS text FROM inbox_events",
      );
      assert.equal(one(rows).text, 'first');
      assert.equal(await countEvents(db), 1);
    } finally {
      await app.close();
    }
  } finally {
    await close();
  }
});

test('webhook keeps out-of-order updates and never overwrites an event', async () => {
  const { db, close } = await createTestDb();
  try {
    await seedConnection(db);
    const app = await buildApp({ config: testConfig(), db });
    try {
      assert.equal((await postUpdate(app, telegramUpdate(4105, 'later'))).statusCode, 200);
      assert.equal((await postUpdate(app, telegramUpdate(4103, 'earlier'))).statusCode, 200);
      const { rows } = await db.query<{ key: string }>(
        'SELECT provider_event_key AS key FROM inbox_events ORDER BY provider_event_key',
      );
      assert.deepEqual(rows.map((r) => r.key), ['tg:update:4103', 'tg:update:4105']);
    } finally {
      await app.close();
    }
  } finally {
    await close();
  }
});

test('webhook rejects malformed payloads and unknown connections', async () => {
  const { db, close } = await createTestDb();
  try {
    await seedConnection(db);
    const app = await buildApp({ config: testConfig(), db });
    try {
      const malformed = await postUpdate(app, { message: { text: 'no update id' } });
      assert.equal(malformed.statusCode, 400);
      const unknown = await app.inject({
        method: 'POST',
        url: '/webhooks/telegram/unknown-conn',
        headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
        payload: telegramUpdate(5001) as object,
      });
      assert.equal(unknown.statusCode, 404);
      assert.equal(await countEvents(db), 0);
    } finally {
      await app.close();
    }
  } finally {
    await close();
  }
});

test('webhook rejects a connection that is not a Telegram channel', async () => {
  const { db, close } = await createTestDb();
  try {
    await seedConnection(db, { connectionId: 'wa-1', channelMode: 'whatsapp_cloud' });
    const app = await buildApp({ config: testConfig(), db });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/telegram/wa-1',
        headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
        payload: telegramUpdate(8001) as object,
      });
      assert.equal(response.statusCode, 404);
      assert.equal(await countEvents(db), 0);
    } finally {
      await app.close();
    }
  } finally {
    await close();
  }
});

test('webhook returns no success ACK when durable storage fails', async () => {
  const { db, close } = await createTestDb();
  try {
    await seedConnection(db);
    const failOnInbox = (run: (text: string, values?: unknown[]) => Promise<unknown>) => {
      return async (text: string, values?: unknown[]) => {
        if (typeof text === 'string' && text.includes('inbox_events')) throw new Error('storage_unavailable');
        return run(text, values);
      };
    };
    const failing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'query') return failOnInbox((text, values) => target.query(text, values));
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
    const app = await buildApp({ config: testConfig(), db: failing });
    try {
      const response = await postUpdate(app, telegramUpdate(6001));
      assert.equal(response.statusCode, 500);
      assert.equal(await countEvents(db), 0);
    } finally {
      await app.close();
    }
  } finally {
    await close();
  }
});

test('webhook is unavailable when no Telegram secret is configured', async () => {
  const { db, close } = await createTestDb();
  try {
    await seedConnection(db);
    const app = await buildApp({ config: testConfig({ telegram: null }), db });
    try {
      const response = await postUpdate(app, telegramUpdate(7001));
      assert.equal(response.statusCode, 503);
      assert.equal(await countEvents(db), 0);
    } finally {
      await app.close();
    }
  } finally {
    await close();
  }
});
