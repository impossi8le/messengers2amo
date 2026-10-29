import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramTransport, type FetchLike } from '../src/telegram/transport.ts';

const API_BASE = 'https://tg.test';
const BOT_TOKEN = '123456:bot-token';

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

test('sends exactly one HTTPS sendMessage request and returns the provider id', async () => {
  const recorder = recordingFetch(async () =>
    jsonResponse({ ok: true, result: { message_id: 777, chat: { id: 42 } } }),
  );
  const transport = createTelegramTransport({
    fetch: recorder.fetch,
    apiBase: API_BASE,
    botToken: BOT_TOKEN,
    timeoutMs: 1_000,
  });

  const result = await transport.sendMessage({ chatId: '42', text: 'hello' });

  assert.deepEqual(result, { outcome: 'sent', providerMessageId: '777' });
  assert.equal(recorder.calls.length, 1);
  const call = recorder.calls[0];
  assert.ok(call, 'expected exactly one recorded request');
  assert.equal(call.url, `${API_BASE}/bot${BOT_TOKEN}/sendMessage`);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.redirect, 'error');
  assert.ok(call.init.signal instanceof AbortSignal);
  assert.equal((call.init.headers as Record<string, string>)['content-type'], 'application/json');
  const body = JSON.parse(String(call.init.body));
  assert.equal(body.chat_id, '42');
  assert.equal(body.text, 'hello');
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
  const transport = createTelegramTransport({
    fetch: recorder.fetch,
    apiBase: API_BASE,
    botToken: BOT_TOKEN,
    timeoutMs: 20,
  });

  const result = await transport.sendMessage({ chatId: '42', text: 'hello' });
  assert.deepEqual(result, { outcome: 'unknown', reason: 'timeout' });
  assert.equal(recorder.calls.length, 1);
});

test('5xx and malformed responses are unknown, not retried', async () => {
  for (const response of [jsonResponse({ ok: false }, 502), new Response('not json', { status: 200 })]) {
    const recorder = recordingFetch(async () => response.clone());
    const transport = createTelegramTransport({
      fetch: recorder.fetch,
      apiBase: API_BASE,
      botToken: BOT_TOKEN,
      timeoutMs: 1_000,
    });
    const result = await transport.sendMessage({ chatId: '42', text: 'hello' });
    assert.equal(result.outcome, 'unknown');
    assert.equal(recorder.calls.length, 1);
  }
});

test('network failures are unknown because the request may have left the process', async () => {
  const recorder = recordingFetch(async () => {
    throw new Error('ECONNRESET');
  });
  const transport = createTelegramTransport({
    fetch: recorder.fetch,
    apiBase: API_BASE,
    botToken: BOT_TOKEN,
    timeoutMs: 1_000,
  });
  const result = await transport.sendMessage({ chatId: '42', text: 'hello' });
  assert.deepEqual(result, { outcome: 'unknown', reason: 'network' });
  assert.equal(recorder.calls.length, 1);
});

test('429 with retry_after is a confirmed rate limit; 429 without it is failed', async () => {
  const limited = recordingFetch(async () =>
    jsonResponse({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } }, 429),
  );
  const limitedTransport = createTelegramTransport({
    fetch: limited.fetch,
    apiBase: API_BASE,
    botToken: BOT_TOKEN,
    timeoutMs: 1_000,
  });
  const limitedResult = await limitedTransport.sendMessage({ chatId: '42', text: 'hello' });
  assert.deepEqual(limitedResult, { outcome: 'rate_limited', retryAfterSeconds: 7 });
  assert.equal(limited.calls.length, 1);

  const unconfirmed = recordingFetch(async () => jsonResponse({ ok: false, error_code: 429 }, 429));
  const unconfirmedTransport = createTelegramTransport({
    fetch: unconfirmed.fetch,
    apiBase: API_BASE,
    botToken: BOT_TOKEN,
    timeoutMs: 1_000,
  });
  const unconfirmedResult = await unconfirmedTransport.sendMessage({ chatId: '42', text: 'hello' });
  assert.equal(unconfirmedResult.outcome, 'failed');
  assert.equal(unconfirmed.calls.length, 1);
});

test('confirmed provider rejection is failed with a bounded code', async () => {
  const recorder = recordingFetch(async () =>
    jsonResponse({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 400),
  );
  const transport = createTelegramTransport({
    fetch: recorder.fetch,
    apiBase: API_BASE,
    botToken: BOT_TOKEN,
    timeoutMs: 1_000,
  });
  const result = await transport.sendMessage({ chatId: '42', text: 'hello' });
  assert.deepEqual(result, { outcome: 'failed', code: 'provider_400' });
  assert.equal(recorder.calls.length, 1);
});

test('transport refuses a non-HTTPS endpoint', () => {
  assert.throws(() =>
    createTelegramTransport({
      fetch: (async () => jsonResponse({ ok: true })) as FetchLike,
      apiBase: 'http://tg.test',
      botToken: BOT_TOKEN,
      timeoutMs: 1_000,
    }),
  );
});
