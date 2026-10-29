import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTelegramCommandTransport,
  type TelegramCommand,
} from '../src/telegram/command-transport.ts';
import type { FetchLike } from '../src/telegram/transport.ts';

const API_BASE = 'https://tg.test';
const BOT_TOKEN = '123456:bot-token';
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

type Call = { url: string; init: RequestInit };

function recordingFetch(handler: (call: Call) => Promise<Response>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = { url: String(url), init: init ?? {} };
      calls.push(call);
      return handler(call);
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function makeTransport(recorder: { fetch: FetchLike }) {
  return createTelegramCommandTransport({
    fetch: recorder.fetch,
    apiBase: API_BASE,
    botToken: BOT_TOKEN,
    timeoutMs: 1_000,
  });
}

async function blobBytes(entry: unknown): Promise<Uint8Array> {
  if (entry instanceof Blob) return new Uint8Array(await entry.arrayBuffer());
  return new TextEncoder().encode(String(entry));
}

function oversizedResponse(): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        const chunk = new Uint8Array(1024).fill(65);
        for (let i = 0; i < 70; i++) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

test('send_text posts sendMessage and returns provider message id', async () => {
  const recorder = recordingFetch(async () =>
    jsonResponse({ ok: true, result: { message_id: 777, chat: { id: 42 } } }),
  );
  const transport = makeTransport(recorder);

  const result = await transport.execute({ commandType: 'send_text', chatId: '42', text: 'hello' });

  assert.deepEqual(result, { outcome: 'sent', providerMessageId: '777' });
  assert.equal(recorder.calls.length, 1);
  const call = recorder.calls[0]!;
  assert.equal(call.url, `${API_BASE}/bot${BOT_TOKEN}/sendMessage`);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.redirect, 'error');
  assert.ok(call.init.signal instanceof AbortSignal);
  assert.equal((call.init.headers as Record<string, string>)['content-type'], 'application/json');
  const body = JSON.parse(String(call.init.body));
  assert.equal(body.chat_id, '42');
  assert.equal(body.text, 'hello');
  assert.equal(body.reply_parameters, undefined);
});

test('quoted text disallows missing target (allow_sending_without_reply is false)', async () => {
  const recorder = recordingFetch(async () =>
    jsonResponse({ ok: true, result: { message_id: 888, chat: { id: 42 } } }),
  );
  const transport = makeTransport(recorder);

  await transport.execute({ commandType: 'send_text', chatId: '42', text: 'reply', replyToMessageId: '100' });

  const body = JSON.parse(String(recorder.calls[0]!.init.body));
  assert.deepEqual(body.reply_parameters, { message_id: 100, allow_sending_without_reply: false });
});

test('send_media uses multipart with original bytes and correct method for voice', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const recorder = recordingFetch(async () =>
    jsonResponse({ ok: true, result: { message_id: 101, chat: { id: 42 } } }),
  );
  const transport = makeTransport(recorder);

  const result = await transport.execute({
    commandType: 'send_media',
    chatId: '42',
    mediaType: 'voice',
    file: { bytes, fileName: 'voice.ogg', mimeType: 'audio/ogg' },
  });

  assert.deepEqual(result, { outcome: 'sent', providerMessageId: '101' });
  const call = recorder.calls[0]!;
  assert.equal(call.url, `${API_BASE}/bot${BOT_TOKEN}/sendVoice`);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.redirect, 'error');
  assert.ok(call.init.body instanceof FormData);
  const form = call.init.body as FormData;
  assert.equal(form.get('chat_id'), '42');
  const file = form.get('voice');
  assert.ok(file instanceof Blob);
  assert.deepEqual(await blobBytes(file!), bytes);
});

test('send_media sanitizes file name and preserves original bytes for document', async () => {
  const bytes = new Uint8Array([9, 8, 7]);
  const recorder = recordingFetch(async () =>
    jsonResponse({ ok: true, result: { message_id: 202, chat: { id: 42 } } }),
  );
  const transport = makeTransport(recorder);

  await transport.execute({
    commandType: 'send_media',
    chatId: '42',
    mediaType: 'document',
    file: { bytes, fileName: '../path/evil.exe', mimeType: 'application/octet-stream' },
    caption: 'doc',
  });

  const call = recorder.calls[0]!;
  assert.equal(call.url, `${API_BASE}/bot${BOT_TOKEN}/sendDocument`);
  const form = call.init.body as FormData;
  const file = form.get('document');
  assert.ok(file instanceof File);
  assert.ok(!(file as File).name.includes('/'));
  assert.deepEqual(await blobBytes(file!), bytes);
  assert.equal(form.get('caption'), 'doc');
});

test('edit_text, edit_caption, delete, reaction and typing return applied on success', async () => {
  const cases: { command: TelegramCommand; urlSuffix: string; resultBody: unknown }[] = [
    {
      command: { commandType: 'edit_text', chatId: '42', messageId: '10', text: 'edited' },
      urlSuffix: 'editMessageText',
      resultBody: { ok: true, result: { message_id: 10, chat: { id: 42 }, text: 'edited' } },
    },
    {
      command: { commandType: 'edit_caption', chatId: '42', messageId: '11', caption: 'new caption' },
      urlSuffix: 'editMessageCaption',
      resultBody: { ok: true, result: { message_id: 11, chat: { id: 42 }, caption: 'new caption' } },
    },
    {
      command: { commandType: 'delete', chatId: '42', messageId: '12' },
      urlSuffix: 'deleteMessage',
      resultBody: { ok: true, result: true },
    },
    {
      command: { commandType: 'reaction', chatId: '42', messageId: '13', emoji: '👍' },
      urlSuffix: 'setMessageReaction',
      resultBody: { ok: true, result: true },
    },
    {
      command: { commandType: 'typing', chatId: '42' },
      urlSuffix: 'sendChatAction',
      resultBody: { ok: true, result: true },
    },
  ];

  for (const { command, urlSuffix, resultBody } of cases) {
    const recorder = recordingFetch(async () => jsonResponse(resultBody));
    const transport = makeTransport(recorder);
    const result = await transport.execute(command);
    assert.deepEqual(result, { outcome: 'applied' });
    assert.equal(recorder.calls.length, 1);
    assert.ok(recorder.calls[0]!.url.endsWith(`/${urlSuffix}`));
  }
});

test('reaction null sends empty reaction list', async () => {
  const recorder = recordingFetch(async () => jsonResponse({ ok: true, result: true }));
  const transport = makeTransport(recorder);

  await transport.execute({ commandType: 'reaction', chatId: '42', messageId: '7', emoji: null });

  const body = JSON.parse(String(recorder.calls[0]!.init.body));
  assert.deepEqual(body.reaction, []);
});

test('invalid sizes and message IDs never reach the provider', async () => {
  const recorder = recordingFetch(async () => jsonResponse({ ok: true, result: { message_id: 1 } }));
  const transport = makeTransport(recorder);

  const tooLongText = 'x'.repeat(4097);
  const tooLongCaption = 'x'.repeat(1025);
  const tooBigMedia = new Uint8Array(MAX_MEDIA_BYTES + 1);

  const outcomes: { command: TelegramCommand; expectedCode: string }[] = [
    { command: { commandType: 'send_text', chatId: '42', text: tooLongText }, expectedCode: 'text_too_long' },
    { command: { commandType: 'edit_text', chatId: '42', messageId: '0', text: 'x' }, expectedCode: 'invalid_message_id' },
    { command: { commandType: 'delete', chatId: '42', messageId: '-1' }, expectedCode: 'invalid_message_id' },
    { command: { commandType: 'reaction', chatId: '42', messageId: 'abc', emoji: '👍' }, expectedCode: 'invalid_message_id' },
    {
      command: {
        commandType: 'send_media',
        chatId: '42',
        mediaType: 'document',
        file: { bytes: tooBigMedia, fileName: 'big.bin', mimeType: 'application/octet-stream' },
      },
      expectedCode: 'media_too_large',
    },
    {
      command: {
        commandType: 'send_media',
        chatId: '42',
        mediaType: 'sticker',
        file: { bytes: new Uint8Array([1]), fileName: 's.webp', mimeType: 'image/webp' },
        caption: 'not allowed',
      },
      expectedCode: 'caption_not_allowed',
    },
    {
      command: {
        commandType: 'send_media',
        chatId: '42',
        mediaType: 'photo',
        file: { bytes: new Uint8Array([1]), fileName: 'p.jpg', mimeType: 'image/jpeg' },
        caption: tooLongCaption,
      },
      expectedCode: 'caption_too_long',
    },
  ];

  for (const { command, expectedCode } of outcomes) {
    const result = await transport.execute(command);
    assert.equal(result.outcome, 'failed');
    assert.equal((result as Extract<typeof result, { outcome: 'failed' }>).code, expectedCode);
  }
  assert.equal(recorder.calls.length, 0);
});

test('429 confirmed becomes rate_limited; unconfirmed becomes failed', async () => {
  const confirmed = recordingFetch(async () =>
    jsonResponse({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 9 } }, 429),
  );
  const confirmedTransport = makeTransport(confirmed);
  const confirmedResult = await confirmedTransport.execute({ commandType: 'send_text', chatId: '42', text: 'hi' });
  assert.deepEqual(confirmedResult, { outcome: 'rate_limited', retryAfterSeconds: 9 });
  assert.equal(confirmed.calls.length, 1);

  const unconfirmed = recordingFetch(async () => jsonResponse({ ok: false, error_code: 429 }, 429));
  const unconfirmedTransport = makeTransport(unconfirmed);
  const unconfirmedResult = await unconfirmedTransport.execute({ commandType: 'send_text', chatId: '42', text: 'hi' });
  assert.equal(unconfirmedResult.outcome, 'failed');
  assert.equal(unconfirmed.calls.length, 1);
});

test('response body larger than 64 KiB is malformed without retry', async () => {
  const recorder = recordingFetch(async () => oversizedResponse());
  const transport = makeTransport(recorder);
  const result = await transport.execute({ commandType: 'send_text', chatId: '42', text: 'hi' });
  assert.deepEqual(result, { outcome: 'unknown', reason: 'malformed' });
  assert.equal(recorder.calls.length, 1);
});

test('5xx responses are unknown and never retried', async () => {
  for (const status of [500, 502, 503]) {
    const recorder = recordingFetch(async () => jsonResponse({ ok: false }, status));
    const transport = makeTransport(recorder);
    const result = await transport.execute({ commandType: 'send_text', chatId: '42', text: 'hi' });
    assert.deepEqual(result, { outcome: 'unknown', reason: 'http_5xx' });
    assert.equal(recorder.calls.length, 1);
  }
});

test('network failures are unknown because the request may have left the process', async () => {
  const recorder = recordingFetch(async () => {
    throw new Error('ECONNRESET');
  });
  const transport = makeTransport(recorder);
  const result = await transport.execute({ commandType: 'send_text', chatId: '42', text: 'hi' });
  assert.deepEqual(result, { outcome: 'unknown', reason: 'network' });
  assert.equal(recorder.calls.length, 1);
});

test('provider rejection returns a safe bounded code', async () => {
  const recorder = recordingFetch(async () =>
    jsonResponse({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 400),
  );
  const transport = makeTransport(recorder);
  const result = await transport.execute({ commandType: 'send_text', chatId: '42', text: 'hi' });
  assert.deepEqual(result, { outcome: 'failed', code: 'provider_400' });
  assert.equal(recorder.calls.length, 1);
});

test('timeout aborts the request, returns unknown and never retries', async () => {
  const recorder = recordingFetch((call) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = call.init.signal as AbortSignal;
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  });
  const transport = createTelegramCommandTransport({
    fetch: recorder.fetch,
    apiBase: API_BASE,
    botToken: BOT_TOKEN,
    timeoutMs: 20,
  });
  const result = await transport.execute({ commandType: 'send_text', chatId: '42', text: 'hi' });
  assert.deepEqual(result, { outcome: 'unknown', reason: 'timeout' });
  assert.equal(recorder.calls.length, 1);
});

test('transport refuses a non-HTTPS endpoint', () => {
  assert.throws(() =>
    createTelegramCommandTransport({
      fetch: (async () => jsonResponse({ ok: true })) as FetchLike,
      apiBase: 'http://tg.test',
      botToken: BOT_TOKEN,
      timeoutMs: 1_000,
    }),
  );
});
