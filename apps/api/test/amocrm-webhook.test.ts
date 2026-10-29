import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { createFakeFetch, insertChannel, seedAmocrm, signedWebhook } from './helpers/amocrm.ts';
import { buildApp } from '../src/app.ts';
import type { Config } from '../src/platform/config.ts';
import type { Db } from '../src/platform/db.ts';
import { createTokenCipher } from '../src/integrations/amocrm/crypto.ts';

function testConfig(): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    databaseUrl: 'postgres://unused',
    sessionSecret: 's'.repeat(40),
    sessionTtlSeconds: 3600,
    secureCookies: true,
    trustedProxy: false,
    adminBootstrapToken: null,
    s3: null,
    amocrm: null,
    telegram: null,
    outboundEnabled: false,
  metricsToken: null,
  };
}

function messagePayload(accountId = 'amojo-1', messageId = 'msg-1') {
  return {
    account_id: accountId,
    time: 1_700_000_000,
    message: {
      id: messageId,
      chat_id: 'amo-chat-1',
      type: 'text',
      text: 'hello',
      date: 1_700_000_000,
      direction: 'in',
    },
  };
}

async function setup(options: { scopeId?: string; chatKind?: 'private' | 'group' } = {}) {
  const { db, schema, close } = await createTestDb();
  const cipher = createTokenCipher('webhook-test-key');
  const seed = await seedAmocrm(db, schema, { chatKind: options.chatKind ?? 'private', scopeId: options.scopeId });
  await insertChannel(db, schema, seed, cipher.encrypt(seed.channelSecret));
  const app = await buildApp({
    config: testConfig(),
    db,
    amocrm: { cipher, schema, fetch: createFakeFetch(() => ({ status: 200, body: {} })) },
  });
  return { db, schema, close, app, seed, cipher };
}

async function inboxCount(db: Db, schema: string): Promise<number> {
  const { rows } = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM "${schema}".inbox_events`);
  return rows[0]!.c;
}

test('valid signed webhook is durably stored before the 200 acknowledgement', async () => {
  const { db, schema, close, app, seed } = await setup();
  try {
    const raw = JSON.stringify(messagePayload());
    const response = await app.inject({
      method: 'POST',
      url: `/webhooks/amocrm/${seed.scopeId}`,
      headers: { 'content-type': 'application/json', 'x-signature': signedWebhook(seed.channelSecret, raw) },
      payload: raw,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'accepted' });
    const count = await inboxCount(db, schema);
    assert.equal(count, 1, 'event must be committed before ACK');
    const { rows } = await db.query<{ state: string; kind: string; provider_event_key: string; connection_id: string }>(
      `SELECT state, kind, provider_event_key, connection_id FROM "${schema}".inbox_events`,
    );
    assert.equal(rows[0]!.state, 'pending');
    assert.equal(rows[0]!.kind, 'chats.message');
    assert.equal(rows[0]!.connection_id, seed.connectionId);
    assert.ok(rows[0]!.provider_event_key.includes('msg-1'));
  } finally {
    await app.close();
    await close();
  }
});

test('vendor outer whitespace trimming verifies without allowing changes inside JSON', async () => {
  const { db, schema, close, app, seed } = await setup();
  try {
    const raw = JSON.stringify(messagePayload());
    const headers = { 'content-type': 'application/json', 'x-signature': signedWebhook(seed.channelSecret, raw) };
    const accepted = await app.inject({method:'POST',url:`/webhooks/amocrm/${seed.scopeId}`,headers,payload:`\r\n ${raw}\t\r\n`});
    assert.equal(accepted.statusCode, 200);
    assert.equal(await inboxCount(db, schema), 1);
    const changed = await app.inject({method:'POST',url:`/webhooks/amocrm/${seed.scopeId}`,headers,
      payload:`\n${raw.replace('hello','changed')}\n`});
    assert.equal(changed.statusCode, 401);
    assert.equal(await inboxCount(db, schema), 1);
  } finally { await app.close(); await close(); }
});

test('a bad signature is rejected before parsing and never reaches the inbox', async () => {
  const { db, schema, close, app, seed } = await setup();
  try {
    const raw = JSON.stringify(messagePayload());
    const response = await app.inject({
      method: 'POST',
      url: `/webhooks/amocrm/${seed.scopeId}`,
      headers: { 'content-type': 'application/json', 'x-signature': 'a'.repeat(40) },
      payload: raw,
    });
    assert.equal(response.statusCode, 401);
    assert.equal(await inboxCount(db, schema), 0);
    const missing = await app.inject({
      method: 'POST',
      url: `/webhooks/amocrm/${seed.scopeId}`,
      headers: { 'content-type': 'application/json' },
      payload: raw,
    });
    assert.equal(missing.statusCode, 401);
    assert.equal(await inboxCount(db, schema), 0);
  } finally {
    await app.close();
    await close();
  }
});

test('signature covers raw bytes, so re-serialized JSON does not verify', async () => {
  const { db, schema, close, app, seed } = await setup();
  try {
    const signedRaw = '{"account_id":"amojo-1", "message":{"id":"msg-1","chat_id":"amo-chat-1"}}';
    const reserialized = JSON.stringify(JSON.parse(signedRaw));
    assert.notEqual(reserialized, signedRaw);
    const response = await app.inject({
      method: 'POST',
      url: `/webhooks/amocrm/${seed.scopeId}`,
      headers: { 'content-type': 'application/json', 'x-signature': signedWebhook(seed.channelSecret, signedRaw) },
      payload: reserialized,
    });
    assert.equal(response.statusCode, 401);
    assert.equal(await inboxCount(db, schema), 0);

    const exact = await app.inject({
      method: 'POST',
      url: `/webhooks/amocrm/${seed.scopeId}`,
      headers: { 'content-type': 'application/json', 'x-signature': signedWebhook(seed.channelSecret, signedRaw) },
      payload: signedRaw,
    });
    assert.equal(exact.statusCode, 200);
    assert.equal(await inboxCount(db, schema), 1);
  } finally {
    await app.close();
    await close();
  }
});

test('unknown scope and foreign account are rejected without inbox writes', async () => {
  const { db, schema, close, app, seed } = await setup();
  try {
    const raw = JSON.stringify(messagePayload());
    const unknown = await app.inject({
      method: 'POST',
      url: '/webhooks/amocrm/scope-of-another-company',
      headers: { 'content-type': 'application/json', 'x-signature': signedWebhook(seed.channelSecret, raw) },
      payload: raw,
    });
    assert.equal(unknown.statusCode, 401);
    assert.deepEqual(unknown.json(), { error: 'invalid_signature' });
    assert.equal(await inboxCount(db, schema), 0);

    const foreignBody = JSON.stringify(messagePayload('amojo-of-another-company'));
    const foreign = await app.inject({
      method: 'POST',
      url: `/webhooks/amocrm/${seed.scopeId}`,
      headers: { 'content-type': 'application/json', 'x-signature': signedWebhook(seed.channelSecret, foreignBody) },
      payload: foreignBody,
    });
    assert.equal(foreign.statusCode, 403);
    assert.equal(await inboxCount(db, schema), 0);
  } finally {
    await app.close();
    await close();
  }
});

test('unknown, disabled and badly signed scopes are indistinguishable', async () => {
  const { db, schema, close, app, seed } = await setup();
  try {
    const raw = JSON.stringify(messagePayload());
    const headers = { 'content-type': 'application/json' };

    const unknown = await app.inject({
      method: 'POST',
      url: '/webhooks/amocrm/scope-that-does-not-exist',
      headers: { ...headers, 'x-signature': signedWebhook(seed.channelSecret, raw) },
      payload: raw,
    });
    const badSignature = await app.inject({
      method: 'POST',
      url: `/webhooks/amocrm/${seed.scopeId}`,
      headers: { ...headers, 'x-signature': 'b'.repeat(40) },
      payload: raw,
    });
    const missingSignature = await app.inject({
      method: 'POST',
      url: `/webhooks/amocrm/${seed.scopeId}`,
      headers,
      payload: raw,
    });
    // A disabled connection must not reveal itself through a different response either.
    await db.query(`UPDATE "${schema}".amocrm_channels SET state='disabled' WHERE scope_id=$1`, [seed.scopeId]);
    const disabled = await app.inject({
      method: 'POST',
      url: `/webhooks/amocrm/${seed.scopeId}`,
      headers: { ...headers, 'x-signature': signedWebhook(seed.channelSecret, raw) },
      payload: raw,
    });

    for (const [name, response] of [
      ['unknown scope', unknown],
      ['bad signature', badSignature],
      ['missing signature', missingSignature],
      ['disabled scope', disabled],
    ] as const) {
      assert.equal(response.statusCode, 401, `${name} must answer 401`);
      assert.deepEqual(response.json(), { error: 'invalid_signature' }, `${name} must have the same body`);
    }
    assert.equal(await inboxCount(db, schema), 0);
  } finally {
    await app.close();
    await close();
  }
});

test('duplicate delivery is acknowledged but stored once', async () => {
  const { db, schema, close, app, seed } = await setup();
  try {
    const raw = JSON.stringify(messagePayload());
    const headers = { 'content-type': 'application/json', 'x-signature': signedWebhook(seed.channelSecret, raw) };
    const first = await app.inject({ method: 'POST', url: `/webhooks/amocrm/${seed.scopeId}`, headers, payload: raw });
    const second = await app.inject({ method: 'POST', url: `/webhooks/amocrm/${seed.scopeId}`, headers, payload: raw });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.deepEqual(second.json(), { status: 'duplicate' });
    assert.equal(await inboxCount(db, schema), 1);
  } finally {
    await app.close();
    await close();
  }
});

test('malformed JSON with a valid signature is refused, not stored', async () => {
  const { db, schema, close, app, seed } = await setup();
  try {
    const raw = '{"account_id":"amojo-1",';
    const response = await app.inject({
      method: 'POST',
      url: `/webhooks/amocrm/${seed.scopeId}`,
      headers: { 'content-type': 'application/json', 'x-signature': signedWebhook(seed.channelSecret, raw) },
      payload: raw,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(await inboxCount(db, schema), 0);
  } finally {
    await app.close();
    await close();
  }
});

test('no acknowledgement is sent when the durable write fails', async () => {
  const { db, schema, close, seed, cipher } = await (async () => {
    const created = await createTestDb();
    const c = createTokenCipher('webhook-test-key');
    const s = await seedAmocrm(created.db, created.schema, { chatKind: 'private' });
    await insertChannel(created.db, created.schema, s, c.encrypt(s.channelSecret));
    return { ...created, seed: s, cipher: c };
  })();
  const failingDb = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return async (sql: unknown, params?: unknown[]) => {
          if (typeof sql === 'string' && /INSERT INTO .*inbox_events/.test(sql)) {
            throw new Error('storage unavailable');
          }
          return (target as Db).query(sql as string, params as never);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Db;
  const app = await buildApp({
    config: testConfig(),
    db: failingDb,
    amocrm: { cipher, schema, fetch: createFakeFetch(() => ({ status: 200, body: {} })) },
  });
  try {
    const raw = JSON.stringify(messagePayload());
    const response = await app.inject({
      method: 'POST',
      url: `/webhooks/amocrm/${seed.scopeId}`,
      headers: { 'content-type': 'application/json', 'x-signature': signedWebhook(seed.channelSecret, raw) },
      payload: raw,
    });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: 'storage_unavailable' });
    assert.equal(await inboxCount(db, schema), 0);
  } finally {
    await app.close();
    await close();
  }
});
