import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createTestApp, type TestApp } from './helpers/app.ts';
import { seedConnection, countRows } from './helpers/channel-fixtures.ts';

const WA_SECRET = 'wa-app-secret';
const WA_VERIFY = 'wa-verify-token';
const MAX_SECRET = 'max-webhook-secret';
const VK_SECRET = 'vk-callback-secret';
const VK_CONFIRMATION = 'vk-confirmation-code';

const whatsappConfig = () => ({
  whatsapp: {
    appSecret: WA_SECRET,
    accessToken: 'wa-access-token',
    phoneNumberId: 'phone-1',
    verifyToken: WA_VERIFY,
    apiBase: 'https://graph.example.test',
  },
});

const maxConfig = () => ({
  max: { accessToken: 'max-access-token', webhookSecret: MAX_SECRET, apiBase: 'https://max.example.test' },
});

const vkConfig = () => ({
  vk: {
    groupId: 123,
    accessToken: 'vk-access-token',
    secret: VK_SECRET,
    confirmationCode: VK_CONFIRMATION,
    apiBase: 'https://vk.example.test',
  },
});

function sign(body: string, secret = WA_SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

function whatsappBody(id: string, text = 'hello'): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '100', phone_number_id: 'phone-1' },
              messages: [
                { from: '79000000000', id, timestamp: '1700000000', type: 'text', text: { body: text } },
              ],
            },
          },
        ],
      },
    ],
  });
}

function maxBody(mid: string, text = 'hello'): string {
  return JSON.stringify({
    update_type: 'message_created',
    timestamp: 1700000000,
    message: {
      timestamp: 1700000000,
      body: { mid, text },
      recipient: { chat_id: 42, chat_type: 'dialog' },
    },
  });
}

function vkBody(eventId: string, text = 'hello', secret = VK_SECRET): string {
  return JSON.stringify({
    type: 'message_new',
    event_id: eventId,
    secret,
    object: {
      message: { id: 77, peer_id: 42, out: 0, date: 1700000000, text },
    },
  });
}

function post(t: TestApp, url: string, payload: string, headers: Record<string, string> = {}) {
  return t.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload,
  });
}

async function inboxCount(t: TestApp): Promise<number> {
  return countRows(t.db, t.schema, 'inbox_events');
}

async function inboxKeys(t: TestApp): Promise<string[]> {
  const { rows } = await t.db.query<{ key: string }>(
    `SELECT provider_event_key AS key FROM "${t.schema}".inbox_events ORDER BY provider_event_key`,
  );
  return rows.map((row) => row.key);
}

test('whatsapp: a valid signed event is stored in the inbox', async () => {
  const t = await createTestApp(whatsappConfig());
  try {
    await seedConnection(t.db, t.schema, { connectionId: 'conn-wa', channelMode: 'whatsapp_cloud' });
    const body = whatsappBody('wamid.1');
    const response = await post(t, '/webhooks/whatsapp/conn-wa', body, { 'x-hub-signature-256': sign(body) });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().duplicate, false);
    assert.equal(await inboxCount(t), 1);
    assert.deepEqual(await inboxKeys(t), ['wa:phone-1:wamid.1']);
  } finally {
    await t.close();
  }
});

test('whatsapp: wrong or missing signature is rejected before storage', async () => {
  const t = await createTestApp(whatsappConfig());
  try {
    await seedConnection(t.db, t.schema, { connectionId: 'conn-wa', channelMode: 'whatsapp_cloud' });
    const body = whatsappBody('wamid.2');
    const wrong = await post(t, '/webhooks/whatsapp/conn-wa', body, { 'x-hub-signature-256': sign(body, 'nope') });
    assert.equal(wrong.statusCode, 401);
    const missing = await post(t, '/webhooks/whatsapp/conn-wa', body);
    assert.equal(missing.statusCode, 401);
    assert.equal(await inboxCount(t), 0);
  } finally {
    await t.close();
  }
});

test('whatsapp: duplicate delivery is ACKed without a duplicate row; changed payload conflicts', async () => {
  const t = await createTestApp(whatsappConfig());
  try {
    await seedConnection(t.db, t.schema, { connectionId: 'conn-wa', channelMode: 'whatsapp_cloud' });
    const body = whatsappBody('wamid.3', 'first');
    const first = await post(t, '/webhooks/whatsapp/conn-wa', body, { 'x-hub-signature-256': sign(body) });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().duplicate, false);

    const duplicate = await post(t, '/webhooks/whatsapp/conn-wa', body, { 'x-hub-signature-256': sign(body) });
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.json().duplicate, true);
    assert.equal(await inboxCount(t), 1);

    const changed = whatsappBody('wamid.3', 'tampered');
    const conflict = await post(t, '/webhooks/whatsapp/conn-wa', changed, { 'x-hub-signature-256': sign(changed) });
    assert.equal(conflict.statusCode, 409);
    assert.equal(await inboxCount(t), 1);
  } finally {
    await t.close();
  }
});

test('whatsapp: foreign and unknown connection ids are indistinguishable 404s', async () => {
  const t = await createTestApp(whatsappConfig());
  try {
    await seedConnection(t.db, t.schema, { connectionId: 'conn-wa', channelMode: 'whatsapp_cloud' });
    await seedConnection(t.db, t.schema, { connectionId: 'conn-max', channelMode: 'max_bot' });
    const body = whatsappBody('wamid.4');
    const headers = { 'x-hub-signature-256': sign(body) };
    const foreign = await post(t, '/webhooks/whatsapp/conn-max', body, headers);
    const unknown = await post(t, '/webhooks/whatsapp/missing-conn', body, headers);
    assert.equal(foreign.statusCode, 404);
    assert.equal(unknown.statusCode, 404);
    assert.deepEqual(foreign.json(), unknown.json());
    assert.equal(await inboxCount(t), 0);
  } finally {
    await t.close();
  }
});

test('whatsapp: an unconfigured channel answers 503 without breaking the route', async () => {
  const t = await createTestApp();
  try {
    await seedConnection(t.db, t.schema, { connectionId: 'conn-wa', channelMode: 'whatsapp_cloud' });
    const body = whatsappBody('wamid.5');
    const response = await post(t, '/webhooks/whatsapp/conn-wa', body, { 'x-hub-signature-256': sign(body) });
    assert.equal(response.statusCode, 503);
    assert.equal(await inboxCount(t), 0);
  } finally {
    await t.close();
  }
});

test('whatsapp: Meta GET subscription handshake echoes the challenge', async () => {
  const t = await createTestApp(whatsappConfig());
  try {
    await seedConnection(t.db, t.schema, { connectionId: 'conn-wa', channelMode: 'whatsapp_cloud' });
    const ok = await t.app.inject({
      method: 'GET',
      url: '/webhooks/whatsapp/conn-wa?hub.mode=subscribe&hub.verify_token=' + WA_VERIFY + '&hub.challenge=abc123',
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body, 'abc123');

    const bad = await t.app.inject({
      method: 'GET',
      url: '/webhooks/whatsapp/conn-wa?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123',
    });
    assert.equal(bad.statusCode, 403);
  } finally {
    await t.close();
  }
});

test('max: a valid event is stored and a wrong secret is rejected', async () => {
  const t = await createTestApp(maxConfig());
  try {
    await seedConnection(t.db, t.schema, { connectionId: 'conn-max', channelMode: 'max_bot' });
    const body = maxBody('mid-1');
    const ok = await post(t, '/webhooks/max/conn-max', body, { 'x-max-bot-api-secret': MAX_SECRET });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().duplicate, false);
    assert.deepEqual(await inboxKeys(t), ['max:mid-1']);

    const wrong = await post(t, '/webhooks/max/conn-max', maxBody('mid-2'), { 'x-max-bot-api-secret': 'wrong' });
    assert.equal(wrong.statusCode, 401);
    assert.equal(await inboxCount(t), 1);
  } finally {
    await t.close();
  }
});

test('max: an event cannot be applied to a WhatsApp connection', async () => {
  const t = await createTestApp(maxConfig());
  try {
    await seedConnection(t.db, t.schema, { connectionId: 'conn-wa', channelMode: 'whatsapp_cloud' });
    const response = await post(t, '/webhooks/max/conn-wa', maxBody('mid-3'), {
      'x-max-bot-api-secret': MAX_SECRET,
    });
    assert.equal(response.statusCode, 404);
    assert.equal(await inboxCount(t), 0);
  } finally {
    await t.close();
  }
});

test('max: duplicate delivery is ACKed without a duplicate row', async () => {
  const t = await createTestApp(maxConfig());
  try {
    await seedConnection(t.db, t.schema, { connectionId: 'conn-max', channelMode: 'max_bot' });
    const body = maxBody('mid-dup', 'once');
    const first = await post(t, '/webhooks/max/conn-max', body, { 'x-max-bot-api-secret': MAX_SECRET });
    const second = await post(t, '/webhooks/max/conn-max', body, { 'x-max-bot-api-secret': MAX_SECRET });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().duplicate, true);
    assert.equal(await inboxCount(t), 1);
  } finally {
    await t.close();
  }
});

test('vk: a valid event is stored and a wrong secret is rejected', async () => {
  const t = await createTestApp(vkConfig());
  try {
    await seedConnection(t.db, t.schema, { connectionId: 'conn-vk', channelMode: 'vk_community' });
    const ok = await post(t, '/webhooks/vk/conn-vk', vkBody('evt-1'));
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(await inboxKeys(t), ['vk:123:evt-1']);

    const wrong = await post(t, '/webhooks/vk/conn-vk', vkBody('evt-2', 'x', 'wrong'));
    assert.equal(wrong.statusCode, 401);
    assert.equal(await inboxCount(t), 1);
  } finally {
    await t.close();
  }
});

test('vk: GET confirmation returns the configured code; a non-confirmation request is refused', async () => {
  const t = await createTestApp(vkConfig());
  try {
    await seedConnection(t.db, t.schema, { connectionId: 'conn-vk', channelMode: 'vk_community' });
    const ok = await t.app.inject({ method: 'GET', url: '/webhooks/vk/conn-vk?type=confirmation' });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body, VK_CONFIRMATION);

    const refused = await t.app.inject({ method: 'GET', url: '/webhooks/vk/conn-vk?type=message_new' });
    assert.equal(refused.statusCode, 403);
  } finally {
    await t.close();
  }
});

test('vk: an event cannot be applied to a WhatsApp connection', async () => {
  const t = await createTestApp(vkConfig());
  try {
    await seedConnection(t.db, t.schema, { connectionId: 'conn-wa', channelMode: 'whatsapp_cloud' });
    const response = await post(t, '/webhooks/vk/conn-wa', vkBody('evt-3'));
    assert.equal(response.statusCode, 404);
    assert.equal(await inboxCount(t), 0);
  } finally {
    await t.close();
  }
});
