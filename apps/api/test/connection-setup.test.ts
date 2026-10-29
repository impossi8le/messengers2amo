import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { buildTestApp, cookieFromResponse } from './helpers/app.ts';
import { seedCompany, seedConnection } from './helpers/seed.ts';
import { createTokenCipher } from '../src/integrations/amocrm/crypto.ts';
import { decryptTelegramCredentials } from '../src/connections/telegram-setup.ts';
import { createFakeFetch } from './helpers/amocrm.ts';

const token = '123456:example_test_bot_token';
const cipher = createTokenCipher('test-channel-key-material');
const body = {
  idempotencyKey: 'setup-1',
  botToken: token,
  displayName: 'Тестовый бот',
  workshopId: 'w1',
  funnelId: '1',
  sourceId: 'src_existing',
};

async function fixture(validToken = true) {
  const testDb = await createTestDb();
  const { db, schema } = testDb;
  await seedCompany(db, {
    companyId: 'c1',
    workshops: ['w1'],
    staff: [{ id: 'admin', password: 'test-password', role: 'admin' }],
  });
  await seedConnection(db, { companyId: 'c1', id: 'existing', workshopId: 'w1', ownerId: 'admin' });
  await db.query("UPDATE crm_accounts SET state='active'");
  const http = createFakeFetch(() =>
    validToken
      ? {
          status: 200,
          body: {
            ok: true,
            result: { id: 123456, is_bot: true, username: 'example_bot', first_name: 'Example' },
          },
        }
      : { status: 401, body: { ok: false, description: `bad token ${token}` } },
  );
  const app = await buildTestApp({
    db,
    schema,
    amocrm: {
      cipher,
      fetch: http,
      pipelines: {
        list: async () => [
          {
            id: '1',
            name: 'Продажи',
            stages: [
              { id: '10', name: 'Новый', isFinal: false },
              { id: '142', name: 'Закрыт', isFinal: true },
            ],
          },
        ],
        invalidate: () => {},
      },
    },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v2/auth/login',
    payload: { companyId: 'c1', staffId: 'admin', password: 'test-password' },
  });
  assert.equal(login.statusCode, 200, login.body);
  return {
    ...testDb,
    app,
    http,
    cookie: cookieFromResponse(login),
    close: async () => {
      await app.close();
      await testDb.close();
    },
  };
}

test('validated bot setup stores scoped encrypted credentials and an inactive route; retries replay', async () => {
  const { app, db, http, cookie, close } = await fixture();
  try {
    const call = () =>
      app.inject({
        method: 'POST',
        url: '/api/v2/operator/connections/setup-telegram',
        headers: { cookie },
        payload: body,
      });
    const response = await call();
    assert.equal(response.statusCode, 202, response.body);
    assert.equal(response.json().displayName, 'Тестовый бот');
    assert.equal(response.json().state, 'setup');
    assert.equal(response.json().sendEnabled, false);
    assert.ok(!response.body.includes(token));
    const connectionId = response.json().id as string;
    const saved = await db.query('SELECT credential_ref FROM connections WHERE id=$1', [connectionId]);
    const credentials = decryptTelegramCredentials(cipher, saved.rows[0].credential_ref, {
      companyId: 'c1',
      connectionId,
    });
    assert.equal(credentials.botToken, token);
    assert.ok(credentials.webhookSecret.length >= 32);
    const route = await db.query('SELECT * FROM connection_routes WHERE connection_id=$1', [connectionId]);
    assert.equal(route.rows[0].status_id, null);
    assert.equal(route.rows[0].funnel_id, '1');
    const policy = await db.query(
      'SELECT crm_projection_enabled FROM channel_policies WHERE connection_id=$1',
      [connectionId],
    );
    assert.equal(policy.rows[0].crm_projection_enabled, false);
    const replay = await call();
    assert.equal(replay.json().id, connectionId);
    assert.equal(http.calls.length, 1, 'idempotent replay needs no new provider call');
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/connections/setup-telegram',
      headers: { cookie },
      payload: { ...body, displayName: 'Changed' },
    });
    assert.equal(conflict.statusCode, 409);
    const webhook = await app.inject({
      method: 'POST',
      url: `/webhooks/telegram/${connectionId}`,
      headers: { 'x-telegram-bot-api-secret-token': 'wrong' },
      payload: { update_id: 1 },
    });
    assert.equal(webhook.statusCode, 401, 'the global server secret cannot authenticate the new bot');
  } finally {
    await close();
  }
});

test('failed provider verification creates no channel, credential, route or command', async () => {
  const { app, db, cookie, close } = await fixture(false);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/connections/setup-telegram',
      headers: { cookie },
      payload: body,
    });
    assert.equal(response.statusCode, 503);
    assert.ok(!response.body.includes(token));
    const count = await db.query(
      'SELECT (SELECT count(*)::int FROM connections) AS connections,(SELECT count(*)::int FROM connection_commands) AS commands',
    );
    assert.equal(count.rows[0].connections, 1);
    assert.equal(count.rows[0].commands, 0);
  } finally {
    await close();
  }
});

test('setup rejects a final stage before provider verification or writes', async () => {
  const { app, db, http, cookie, close } = await fixture();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/connections/setup-telegram',
      headers: { cookie },
      payload: { ...body, statusId: '142' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(http.calls.length, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM connections')).rows[0].n, 1);
  } finally {
    await close();
  }
});
