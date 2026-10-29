import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createTestDb } from './helpers/db.ts';
import { seedConnection, seedProjectionRoute, countRows, fakeFetch } from './helpers/channel-fixtures.ts';
import { createWhatsAppCloudAdapter } from '../src/channels/whatsapp-cloud.ts';
import { ingestWebhook } from '../src/channels/inbox.ts';
import { CapabilityNotAllowedError, WebhookVerificationError } from '../src/channels/errors.ts';

const APP_SECRET = 'test-app-secret';

function sign(body: string, secret = APP_SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

function messagePayload(overrides: { from?: string; id?: string; text?: string; type?: string; extra?: object } = {}) {
  return {
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
              contacts: [{ profile: { name: 'customer' }, wa_id: overrides.from ?? '79000000000' }],
              messages: [
                {
                  from: overrides.from ?? '79000000000',
                  id: overrides.id ?? 'wamid.1',
                  timestamp: '1700000000',
                  type: overrides.type ?? 'text',
                  ...(overrides.type === undefined || overrides.type === 'text'
                    ? { text: { body: overrides.text ?? 'hello' } }
                    : {}),
                  ...(overrides.extra ?? {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function statusPayload(id: string, status: string) {
  return {
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
              statuses: [{ id, status, timestamp: '1700000001', recipient_id: '79000000000' }],
            },
          },
        ],
      },
    ],
  };
}

function adapter(overrides: { fetch?: typeof fetch; mediaResolver?: (mediaId: string) => Promise<{ link: string } | null> } = {}) {
  return createWhatsAppCloudAdapter({
    appSecret: APP_SECRET,
    accessToken: 'test-token',
    phoneNumberId: 'phone-1',
    apiBase: 'https://graph.example.test',
    fetch: overrides.fetch,
    mediaResolver: overrides.mediaResolver,
  });
}

test('whatsapp_cloud: rejects a webhook with an invalid X-Hub-Signature-256', () => {
  const body = JSON.stringify(messagePayload());
  const a = adapter();
  const bad = a.verifyInbound({ body: Buffer.from(body), headers: { 'x-hub-signature-256': sign(body, 'wrong-secret') } });
  assert.equal(bad.ok, false);
  assert.equal(bad.ok === false && bad.reason, 'signature_invalid');

  const missing = a.verifyInbound({ body: Buffer.from(body), headers: {} });
  assert.equal(missing.ok, false);

  const good = a.verifyInbound({ body: Buffer.from(body), headers: { 'x-hub-signature-256': sign(body) } });
  assert.equal(good.ok, true);
});

test('whatsapp_cloud: an empty app secret cannot validate a forged HMAC', () => {
  const body = JSON.stringify(messagePayload({ id: 'wamid.forged' }));
  for (const appSecret of ['', '   ']) {
    const a = createWhatsAppCloudAdapter({
      appSecret,
      accessToken: 'test-token',
      phoneNumberId: 'phone-1',
      apiBase: 'https://graph.example.test',
    });
    // Exactly the forgery an attacker can produce when the key is empty.
    const forged = 'sha256=' + createHmac('sha256', '').update(body, 'utf8').digest('hex');
    const result = a.verifyInbound({ body: Buffer.from(body), headers: { 'x-hub-signature-256': forged } });
    assert.equal(result.ok, false, 'an empty key must never be used for verification');
    assert.throws(
      () => a.parseInbound({ body: Buffer.from(body), headers: { 'x-hub-signature-256': forged } }),
      (error: unknown) => error instanceof WebhookVerificationError,
    );
  }
});

test('whatsapp_cloud: signature is computed over raw bytes, not re-serialized JSON', () => {
  const body = JSON.stringify(messagePayload(), null, 2);
  const a = adapter();
  const raw = a.verifyInbound({ body: Buffer.from(body, 'utf8'), headers: { 'x-hub-signature-256': sign(body) } });
  assert.equal(raw.ok, true);
  const repacked = a.verifyInbound({
    body: Buffer.from(JSON.stringify(JSON.parse(body)), 'utf8'),
    headers: { 'x-hub-signature-256': sign(body) },
  });
  assert.equal(repacked.ok, false);
});

test('whatsapp_cloud: parses an inbound text message into a normalized event', () => {
  const body = JSON.stringify(messagePayload({ id: 'wamid.abc', text: 'привет' }));
  const a = adapter();
  const parsed = a.parseInbound({ body: Buffer.from(body), headers: { 'x-hub-signature-256': sign(body) } });
  assert.equal(parsed.events.length, 1);
  const event = parsed.events[0];
  assert.ok(event);
  assert.equal(event.kind, 'message.received');
  assert.equal(event.externalChatId, '79000000000');
  assert.equal(event.chatKind, 'private');
  assert.equal(event.providerMessageId, 'wamid.abc');
  assert.deepEqual(event.content, { kind: 'text', text: 'привет' });
  assert.match(event.providerEventKey ?? '', /wamid\.abc/);
});

test('whatsapp_cloud: unsupported inbound type is normalized as unsupported, not dropped', () => {
  const body = JSON.stringify(messagePayload({ type: 'sticker', extra: { sticker: { id: 's1' } } }));
  const parsed = adapter().parseInbound({ body: Buffer.from(body), headers: { 'x-hub-signature-256': sign(body) } });
  assert.equal(parsed.events.length, 1);
  const first = parsed.events[0];
  assert.ok(first && first.kind === 'message.received');
  assert.deepEqual(first.content, { kind: 'unsupported', providerType: 'sticker' });
});

test('whatsapp_cloud: duplicate webhook does not duplicate conversation history', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fixture = await seedConnection(db, schema, { channelMode: 'whatsapp_cloud' });
    await seedProjectionRoute(db,schema,fixture);
    const body = JSON.stringify(messagePayload({ id: 'wamid.dup' }));
    const raw = { body: Buffer.from(body), headers: { 'x-hub-signature-256': sign(body) } };

    const first = await ingestWebhook({ db, schema, adapter: adapter(), connection: fixture, raw });
    assert.equal(first.accepted, 1);
    assert.equal(first.duplicates, 0);

    const second = await ingestWebhook({ db, schema, adapter: adapter(), connection: fixture, raw });
    assert.equal(second.accepted, 0);
    assert.equal(second.duplicates, 1);

    assert.equal(await countRows(db, schema, 'messages'), 1);
    assert.equal(await countRows(db, schema, 'conversations'), 1);
    assert.equal(await countRows(db, schema, 'inbox_events'), 1);
    assert.equal(await countRows(db, schema, 'outbox_jobs'), 1, 'one CRM projection job, not two');
  } finally {
    await close();
  }
});

test('whatsapp_cloud: the projection job is the kind the worker actually claims', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fixture = await seedConnection(db, schema, { channelMode: 'whatsapp_cloud' });
    await seedProjectionRoute(db,schema,fixture);
    await db.query(`INSERT INTO "${schema}".crm_accounts(company_id,id,state) VALUES ('c1','aaa-unrelated','active')`);
    const body = JSON.stringify(messagePayload({ id: 'wamid.job' }));
    const raw = { body: Buffer.from(body), headers: { 'x-hub-signature-256': sign(body) } };

    await ingestWebhook({ db, schema, adapter: adapter(), connection: fixture, raw });

    const { rows } = await db.query<{ job_kind: string; payload: Record<string, unknown> }>(
      `SELECT job_kind, payload FROM "${schema}".outbox_jobs`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.job_kind, 'amocrm.projection', 'the worker ignores any other kind');
    assert.equal(rows[0]!.payload.op, 'message');
    assert.equal(rows[0]!.payload.companyId, fixture.companyId);
    assert.equal(rows[0]!.payload.accountId, 'acc1');
    assert.equal(rows[0]!.payload.direction, 'in');
    assert.equal(rows[0]!.payload.providerMessageId, 'wamid.job');
  } finally {
    await close();
  }
});

test('whatsapp_cloud: without an active CRM account the message is archived but not queued', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fixture = await seedConnection(db, schema, { channelMode: 'whatsapp_cloud', crmAccountId: null });
    const body = JSON.stringify(messagePayload({ id: 'wamid.no-account' }));
    const raw = { body: Buffer.from(body), headers: { 'x-hub-signature-256': sign(body) } };

    const result = await ingestWebhook({ db, schema, adapter: adapter(), connection: fixture, raw });

    assert.equal(result.accepted, 1);
    assert.equal(result.crmProjections, 0, 'a job with nowhere to go would only burn its retries');
    assert.equal(await countRows(db, schema, 'messages'), 1);
    assert.equal(await countRows(db, schema, 'outbox_jobs'), 0);
  } finally {
    await close();
  }
});

test('whatsapp_cloud: out-of-order statuses never downgrade read to delivered', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fixture = await seedConnection(db, schema, { channelMode: 'whatsapp_cloud' });
    const messageBody = JSON.stringify(messagePayload({ id: 'wamid.status' }));
    await ingestWebhook({
      db,
      schema,
      adapter: adapter(),
      connection: fixture,
      raw: { body: Buffer.from(messageBody), headers: { 'x-hub-signature-256': sign(messageBody) } },
    });

    const readBody = JSON.stringify(statusPayload('wamid.status', 'read'));
    const deliveredBody = JSON.stringify(statusPayload('wamid.status', 'delivered'));

    const read = await ingestWebhook({
      db,
      schema,
      adapter: adapter(),
      connection: fixture,
      raw: { body: Buffer.from(readBody), headers: { 'x-hub-signature-256': sign(readBody) } },
    });
    assert.equal(read.effectiveStatuses[0]?.status, 'read');

    const late = await ingestWebhook({
      db,
      schema,
      adapter: adapter(),
      connection: fixture,
      raw: { body: Buffer.from(deliveredBody), headers: { 'x-hub-signature-256': sign(deliveredBody) } },
    });
    assert.equal(late.effectiveStatuses[0]?.status, 'read', 'late delivered must not downgrade read');

    const repeat = await ingestWebhook({
      db,
      schema,
      adapter: adapter(),
      connection: fixture,
      raw: { body: Buffer.from(deliveredBody), headers: { 'x-hub-signature-256': sign(deliveredBody) } },
    });
    assert.equal(repeat.duplicates, 1, 'same status evidence key is idempotent');
    assert.equal(await countRows(db, schema, 'provider_receipt_evidence'), 2);
  } finally {
    await close();
  }
});

test('whatsapp_cloud: sends text and reports sent, never delivered/read', async () => {
  const { fetch, calls } = fakeFetch(() => ({
    json: { messaging_product: 'whatsapp', messages: [{ id: 'wamid.out' }] },
  }));
  const outcome = await adapter({ fetch }).send({
    externalChatId: '79000000000',
    idempotencyKey: 'idem-1',
    content: { kind: 'text', text: 'ответ' },
  });
  assert.equal(outcome.status, 'sent');
  assert.equal(outcome.status === 'sent' && outcome.providerMessageId, 'wamid.out');
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.url ?? '', /\/phone-1\/messages$/);
  assert.equal(calls[0]?.headers.authorization, 'Bearer test-token');
  const sent = JSON.parse(calls[0]?.body ?? '{}');
  assert.equal(sent.type, 'text');
  assert.equal(sent.text.body, 'ответ');
  assert.equal(sent.to, '79000000000');
});

test('whatsapp_cloud: 429 is a retryable failure, not a silent success', async () => {
  const { fetch } = fakeFetch(() => ({
    status: 429,
    json: { error: { code: 130429, message: 'throughput limit', type: 'OAuthException' } },
  }));
  const outcome = await adapter({ fetch }).send({
    externalChatId: '79000000000',
    idempotencyKey: 'idem-429',
    content: { kind: 'text', text: 'x' },
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.status === 'failed' && outcome.retryable, true);
  assert.equal(outcome.status === 'failed' && outcome.errorCode, 'RATE_LIMITED');
});

test('whatsapp_cloud: transport timeout becomes unknown, never retried blindly', async () => {
  const { fetch } = fakeFetch(() => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    return { throwError: error };
  });
  const outcome = await adapter({ fetch }).send({
    externalChatId: '79000000000',
    idempotencyKey: 'idem-timeout',
    content: { kind: 'text', text: 'x' },
  });
  assert.equal(outcome.status, 'unknown');
});

test('whatsapp_cloud: a definite 4xx rejection is failed and not retryable', async () => {
  const { fetch } = fakeFetch(() => ({
    status: 400,
    json: { error: { code: 100, message: 'invalid parameter' } },
  }));
  const outcome = await adapter({ fetch }).send({
    externalChatId: '79000000000',
    idempotencyKey: 'idem-400',
    content: { kind: 'text', text: 'x' },
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.status === 'failed' && outcome.retryable, false);
});

test('whatsapp_cloud: media send is refused with a clear error when media is unconfirmed', async () => {
  const a = adapter();
  assert.equal(a.capabilities().mediaReply, 'unknown');
  await assert.rejects(
    async () =>
      a.send({
        externalChatId: '79000000000',
        idempotencyKey: 'idem-media',
        content: { kind: 'attachment', mediaId: 'media-1', caption: '' },
      }),
    (error: unknown) => error instanceof CapabilityNotAllowedError && /mediaReply/.test(error.message),
  );
});

test('whatsapp_cloud: media send works once a resolver is configured and capabilities say so', async () => {
  const { fetch, calls } = fakeFetch(() => ({ json: { messages: [{ id: 'wamid.media' }] } }));
  const a = adapter({ fetch, mediaResolver: async () => ({ link: 'https://media.example.test/x.jpg' }) });
  assert.equal(a.capabilities().mediaReply, 'supported');
  const outcome = await a.send({
    externalChatId: '79000000000',
    idempotencyKey: 'idem-media-2',
    content: { kind: 'attachment', mediaId: 'media-1', caption: 'фото' },
  });
  assert.equal(outcome.status, 'sent');
  const sent = JSON.parse(calls[0]?.body ?? '{}');
  assert.equal(sent.type, 'image');
  assert.equal(sent.image.link, 'https://media.example.test/x.jpg');
  assert.equal(sent.image.caption, 'фото');
});

test('whatsapp_cloud: capabilities stay honest about unverified features', () => {
  const capabilities = adapter().capabilities();
  assert.equal(capabilities.textReply, 'supported');
  assert.equal(capabilities.deliveryReceipts, 'supported', 'Cloud API documents delivered webhooks');
  assert.equal(capabilities.readReceipts, 'supported', 'Cloud API documents read webhooks');
  assert.equal(capabilities.messageEditing, 'unknown');
  assert.equal(capabilities.messageDeletion, 'unknown');
});
