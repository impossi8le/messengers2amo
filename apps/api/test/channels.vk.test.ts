import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { seedConnection, seedProjectionRoute, allowGroup, countRows, fakeFetch } from './helpers/channel-fixtures.ts';
import { createVkAdapter } from '../src/channels/vk.ts';
import { ingestWebhook } from '../src/channels/inbox.ts';
import { CapabilityNotAllowedError, WebhookVerificationError } from '../src/channels/errors.ts';

const SECRET = 'vk-shared-secret';
const CONFIRMATION = 'confirmation-token-value';

function adapter(overrides: { fetch?: typeof fetch } = {}) {
  return createVkAdapter({
    groupId: 2000000001,
    accessToken: 'test-vk-token',
    secret: SECRET,
    confirmationCode: CONFIRMATION,
    apiVersion: '5.199',
    apiBase: 'https://api.vk.example.test',
    fetch: overrides.fetch,
  });
}

function messageNew(overrides: { eventId?: string; peerId?: number; text?: string; messageId?: number } = {}) {
  return {
    type: 'message_new',
    group_id: 2000000001,
    event_id: overrides.eventId ?? 'evt-1',
    v: '5.199',
    secret: SECRET,
    object: {
      message: {
        id: overrides.messageId ?? 501,
        date: 1_700_000_000,
        peer_id: overrides.peerId ?? 42,
        from_id: 42,
        text: overrides.text ?? 'привет',
        out: 0,
        conversation_message_id: 7,
        attachments: [],
      },
      client_info: { button_actions: [], keyboard: false, inline_keyboard: false },
    },
  };
}

test('vk: answers the confirmation handshake with the configured code', () => {
  const raw = { body: Buffer.from(JSON.stringify({ type: 'confirmation', group_id: 2000000001 })), headers: {} };
  const parsed = adapter().parseInbound(raw);
  assert.deepEqual(parsed.handshake, { type: 'confirmation', response: CONFIRMATION });
  assert.equal(parsed.events.length, 0);
});

test('vk: rejects events with a wrong or missing secret', () => {
  const wrong = { ...messageNew(), secret: 'nope' };
  assert.throws(
    () => adapter().parseInbound({ body: Buffer.from(JSON.stringify(wrong)), headers: {} }),
    (error: unknown) => error instanceof WebhookVerificationError,
  );
  const missing = { ...messageNew() } as Record<string, unknown>;
  delete missing.secret;
  assert.throws(
    () => adapter().parseInbound({ body: Buffer.from(JSON.stringify(missing)), headers: {} }),
    (error: unknown) => error instanceof WebhookVerificationError,
  );
});

test('vk: parses message_new into a private or group event', () => {
  const direct = adapter().parseInbound({ body: Buffer.from(JSON.stringify(messageNew())), headers: {} });
  assert.equal(direct.events.length, 1);
  assert.equal(direct.events[0]?.kind, 'message.received');
  assert.equal(direct.events[0]?.chatKind, 'private');
  assert.equal(direct.events[0]?.externalChatId, '42');
  assert.equal(direct.events[0]?.providerMessageId, '501');
  assert.deepEqual(direct.events[0]?.content, { kind: 'text', text: 'привет' });
  assert.equal(direct.events[0]?.providerEventKey, 'vk:2000000001:evt-1');

  const group = adapter().parseInbound({
    body: Buffer.from(JSON.stringify(messageNew({ peerId: 2000000123, eventId: 'evt-2' }))),
    headers: {},
  });
  assert.equal(group.events[0]?.chatKind, 'group');
});

test('vk: a repeated callback does not duplicate history (event_id dedupe)', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fixture = await seedConnection(db, schema, { channelMode: 'vk_community' });
    const raw = { body: Buffer.from(JSON.stringify(messageNew({ eventId: 'evt-dup' }))), headers: {} };
    const first = await ingestWebhook({ db, schema, adapter: adapter(), connection: fixture, raw });
    const second = await ingestWebhook({ db, schema, adapter: adapter(), connection: fixture, raw });
    assert.equal(first.accepted, 1);
    assert.equal(second.duplicates, 1);
    assert.equal(await countRows(db, schema, 'messages'), 1);
    assert.equal(await countRows(db, schema, 'inbox_events'), 1);
  } finally {
    await close();
  }
});

test('vk: group messages are denied by default and create no CRM projection job', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fixture = await seedConnection(db, schema, { channelMode: 'vk_community' });
    const raw = {
      body: Buffer.from(JSON.stringify(messageNew({ peerId: 2000000123, eventId: 'evt-group-deny' }))),
      headers: {},
    };
    const result = await ingestWebhook({ db, schema, adapter: adapter(), connection: fixture, raw });
    assert.equal(result.accepted, 1);
    assert.equal(result.crmProjections, 0);
    assert.equal(await countRows(db, schema, 'outbox_jobs'), 0);
    assert.equal(await countRows(db, schema, 'messages'), 1, 'message is archived, CRM effect is not');

    const { rows } = await db.query<{ chat_kind: string }>(
      `SELECT chat_kind FROM "${schema}".conversations`,
    );
    assert.equal(rows[0]?.chat_kind, 'group');
  } finally {
    await close();
  }
});

test('vk: an explicit allow_crm group rule permits the CRM projection job', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fixture = await seedConnection(db, schema, { channelMode: 'vk_community' });
    await seedProjectionRoute(db,schema,fixture);
    await allowGroup(db, schema, fixture, '2000000123', 'allow_crm');
    const raw = {
      body: Buffer.from(JSON.stringify(messageNew({ peerId: 2000000123, eventId: 'evt-group-allow' }))),
      headers: {},
    };
    const result = await ingestWebhook({ db, schema, adapter: adapter(), connection: fixture, raw });
    assert.equal(result.crmProjections, 1);
    assert.equal(await countRows(db, schema, 'outbox_jobs'), 1);
  } finally {
    await close();
  }
});

test('vk: sends with random_id derived from the idempotency key', async () => {
  const { fetch, calls } = fakeFetch(() => ({ json: { response: 777 } }));
  const outcome = await adapter({ fetch }).send({
    externalChatId: '42',
    idempotencyKey: 'idem-vk-1',
    content: { kind: 'text', text: 'ответ' },
  });
  assert.equal(outcome.status, 'sent');
  assert.equal(outcome.status === 'sent' && outcome.providerMessageId, '777');
  const body = JSON.parse(calls[0]?.body ?? '{}');
  assert.equal(body.peer_id, 42);
  assert.equal(body.message, 'ответ');
  assert.ok(Number.isInteger(body.random_id));
  assert.ok(body.random_id > 0);

  const repeat = fakeFetch(() => ({ json: { response: 777 } }));
  await adapter({ fetch: repeat.fetch }).send({
    externalChatId: '42',
    idempotencyKey: 'idem-vk-1',
    content: { kind: 'text', text: 'ответ' },
  });
  assert.equal(JSON.parse(repeat.calls[0]?.body ?? '{}').random_id, body.random_id, 'stable random_id makes retries idempotent');
});

test('vk: VK error payload becomes failed; rate limit error is retryable', async () => {
  const { fetch } = fakeFetch(() => ({ json: { error: { error_code: 6, error_msg: 'Too many requests per second' } } }));
  const outcome = await adapter({ fetch }).send({
    externalChatId: '42',
    idempotencyKey: 'idem-vk-6',
    content: { kind: 'text', text: 'x' },
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.status === 'failed' && outcome.retryable, true);

  const permanent = fakeFetch(() => ({ json: { error: { error_code: 901, error_msg: 'Cannot send messages to this user' } } }));
  const rejected = await adapter({ fetch: permanent.fetch }).send({
    externalChatId: '42',
    idempotencyKey: 'idem-vk-901',
    content: { kind: 'text', text: 'x' },
  });
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.status === 'failed' && rejected.retryable, false);
});

test('vk: media send is refused because mediaReply is unverified', async () => {
  await assert.rejects(
    async () =>
      adapter().send({
        externalChatId: '42',
        idempotencyKey: 'idem-vk-media',
        content: { kind: 'attachment', mediaId: 'm1', caption: '' },
      }),
    (error: unknown) => error instanceof CapabilityNotAllowedError,
  );
});

test('vk: capabilities stay honest', () => {
  const capabilities = adapter().capabilities();
  assert.equal(capabilities.textReply, 'supported');
  assert.equal(capabilities.mediaReply, 'unknown');
  assert.equal(capabilities.readReceipts, 'unknown');
  assert.equal(capabilities.deliveryReceipts, 'unknown');
});
