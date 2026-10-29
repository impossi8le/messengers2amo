import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { seedConnection, countRows, fakeFetch } from './helpers/channel-fixtures.ts';
import { createMaxAdapter } from '../src/channels/max.ts';
import { ingestWebhook } from '../src/channels/inbox.ts';
import { CapabilityNotAllowedError, PayloadTooLargeError, WebhookVerificationError } from '../src/channels/errors.ts';

const SECRET = 'max-secret-value';

function messageUpdate(overrides: { mid?: string; text?: string; chatType?: string; chatId?: number; userId?: number } = {}) {
  return {
    update_type: 'message_created',
    timestamp: 1_700_000_000_000,
    message: {
      sender: { user_id: overrides.userId ?? 42, name: 'customer' },
      recipient: { chat_id: overrides.chatId ?? 42, chat_type: overrides.chatType ?? 'dialog' },
      timestamp: 1_700_000_000_000,
      body: {
        mid: overrides.mid ?? 'mid.1',
        seq: 1,
        text: overrides.text ?? 'здравствуйте',
        attachments: [],
      },
    },
  };
}

function adapter(overrides: { fetch?: typeof fetch; secret?: string | null } = {}) {
  return createMaxAdapter({
    accessToken: 'test-max-token',
    webhookSecret: overrides.secret === undefined ? SECRET : overrides.secret,
    apiBase: 'https://platform-api2.example.test',
    fetch: overrides.fetch,
  });
}

test('max: rejects a webhook with a wrong X-Max-Bot-Api-Secret', () => {
  const raw = {
    body: Buffer.from(JSON.stringify(messageUpdate())),
    headers: { 'x-max-bot-api-secret': 'wrong' },
  };
  const result = adapter().verifyInbound(raw);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'secret_invalid');
  const missing = adapter().verifyInbound({ body: raw.body, headers: {} });
  assert.equal(missing.ok, false);
  const good = adapter().verifyInbound({
    body: raw.body,
    headers: { 'x-max-bot-api-secret': SECRET },
  });
  assert.equal(good.ok, true);
});

test('max: a missing or empty webhook secret never verifies an inbound request', () => {
  const body = Buffer.from(JSON.stringify(messageUpdate({ mid: 'mid.forged' })));
  for (const secret of [undefined, null, '', '   ']) {
    const a = createMaxAdapter({
      accessToken: 'test-max-token',
      webhookSecret: secret,
      apiBase: 'https://platform-api2.example.test',
    });
    const result = a.verifyInbound({ body, headers: {} });
    assert.equal(result.ok, false, `secret ${JSON.stringify(secret)} must not verify anything`);
    assert.throws(
      () => a.parseInbound({ body, headers: {} }),
      (error: unknown) => error instanceof WebhookVerificationError,
      'a forged update must never be parsed when no secret is configured',
    );
  }
});

test('max: parses message_created for a dialog and a group chat', () => {
  const dialog = adapter().parseInbound({
    body: Buffer.from(JSON.stringify(messageUpdate({ mid: 'mid.d', text: 'hi' }))),
    headers: { 'x-max-bot-api-secret': SECRET },
  });
  assert.equal(dialog.events.length, 1);
  assert.equal(dialog.events[0]?.kind, 'message.received');
  assert.equal(dialog.events[0]?.chatKind, 'private');
  assert.deepEqual(dialog.events[0]?.content, { kind: 'text', text: 'hi' });
  assert.equal(dialog.events[0]?.externalChatId, '42');
  assert.match(dialog.events[0]?.providerEventKey ?? '', /mid\.d/);

  const group = adapter().parseInbound({
    body: Buffer.from(JSON.stringify(messageUpdate({ chatType: 'chat', chatId: -700, mid: 'mid.g' }))),
    headers: { 'x-max-bot-api-secret': SECRET },
  });
  assert.equal(group.events[0]?.chatKind, 'group');
});

test('max: unknown update types are ignored, not treated as messages', () => {
  const parsed = adapter().parseInbound({
    body: Buffer.from(JSON.stringify({ update_type: 'bot_started', timestamp: 1, user: { user_id: 1 } })),
    headers: { 'x-max-bot-api-secret': SECRET },
  });
  assert.equal(parsed.events.length, 0);
});

test('max: duplicate update is committed once', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fixture = await seedConnection(db, schema, { channelMode: 'max_bot' });
    const raw = {
      body: Buffer.from(JSON.stringify(messageUpdate({ mid: 'mid.dup' }))),
      headers: { 'x-max-bot-api-secret': SECRET },
    };
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

test('max: sends text with bearer token and reports only sent', async () => {
  const { fetch, calls } = fakeFetch(() => ({ json: { message: { body: { mid: 'mid.out' } } } }));
  const outcome = await adapter({ fetch }).send({
    externalChatId: '42',
    idempotencyKey: 'idem-max-1',
    content: { kind: 'text', text: 'ответ' },
  });
  assert.equal(outcome.status, 'sent');
  assert.equal(outcome.status === 'sent' && outcome.providerMessageId, 'mid.out');
  assert.equal(calls[0]?.headers.authorization, 'test-max-token');
  assert.match(calls[0]?.url ?? '', /chat_id=42/);
  assert.equal(JSON.parse(calls[0]?.body ?? '{}').text, 'ответ');
});

test('max: text over 4000 characters is refused before any HTTP call', async () => {
  const { fetch, calls } = fakeFetch(() => ({ json: {} }));
  await assert.rejects(
    async () =>
      adapter({ fetch }).send({
        externalChatId: '42',
        idempotencyKey: 'idem-max-long',
        content: { kind: 'text', text: 'x'.repeat(4001) },
      }),
    (error: unknown) => error instanceof PayloadTooLargeError,
  );
  assert.equal(calls.length, 0, 'no blind attempt after local validation');
});

test('max: 429 is retryable failure; timeout is unknown', async () => {
  const rateLimited = fakeFetch(() => ({ status: 429, json: { code: 'too_many_requests' } }));
  const first = await adapter({ fetch: rateLimited.fetch }).send({
    externalChatId: '42',
    idempotencyKey: 'idem-max-429',
    content: { kind: 'text', text: 'x' },
  });
  assert.equal(first.status, 'failed');
  assert.equal(first.status === 'failed' && first.retryable, true);

  const timeout = fakeFetch(() => {
    const error = new Error('timed out');
    error.name = 'TimeoutError';
    return { throwError: error };
  });
  const second = await adapter({ fetch: timeout.fetch }).send({
    externalChatId: '42',
    idempotencyKey: 'idem-max-timeout',
    content: { kind: 'text', text: 'x' },
  });
  assert.equal(second.status, 'unknown');
});

test('max: media send is refused because mediaReply is not confirmed', async () => {
  const a = adapter();
  assert.equal(a.capabilities().mediaReply, 'unknown');
  await assert.rejects(
    async () =>
      a.send({
        externalChatId: '42',
        idempotencyKey: 'idem-max-media',
        content: { kind: 'attachment', mediaId: 'm1', caption: '' },
      }),
    (error: unknown) => error instanceof CapabilityNotAllowedError,
  );
});

test('max: capabilities do not promise unverified receipts', () => {
  const capabilities = adapter().capabilities();
  assert.equal(capabilities.textReply, 'supported');
  assert.equal(capabilities.mediaReply, 'unknown');
  assert.equal(capabilities.readReceipts, 'unknown');
  assert.equal(capabilities.deliveryReceipts, 'unknown');
  assert.equal(capabilities.messageEditing, 'unknown');
  assert.equal(capabilities.messageDeletion, 'unknown');
});
