/**
 * Local fake Telegram provider for the worker child process.
 *
 * The worker reaches a provider only through `globalThis.fetch`, so replacing
 * that one global before the worker module is loaded is enough to make every
 * provider call local: the request is recorded in a file and answered from the
 * test process' own memory. No socket is opened, no DNS name is resolved and no
 * packet leaves the machine, so the test can assert "the provider was called"
 * without ever touching a real provider.
 *
 * The preload is loaded with `node --import`, which runs before the entry
 * point, so the worker reads the stub instead of the real implementation.
 *
 * Usage:
 *   node --import ./test/helpers/worker-fake-provider.mjs src/worker.ts
 *
 * Environment:
 *   WORKER_FAKE_PROVIDER_LOG  path of the file the recorded calls are appended to
 *   WORKER_FAKE_PROVIDER_MODE `sent` (default) | `fail`
 */

import { appendFileSync } from 'node:fs';

const logPath = process.env.WORKER_FAKE_PROVIDER_LOG;
const mode = process.env.WORKER_FAKE_PROVIDER_MODE ?? 'sent';

/**
 * Only Telegram Bot API endpoints are answered. Any other URL means the test
 * setup asked for something unexpected, so it is recorded and rejected instead
 * of being served silently.
 */
function isTelegramSend(url) {
  return /\/bot[^/]+\/sendMessage$/.test(url);
}

function record(entry) {
  if (!logPath) return;
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
  const method = init?.method ?? 'GET';
  const body = typeof init?.body === 'string' ? init.body : '';

  record({ url, method, body, at: new Date().toISOString() });

  if (!isTelegramSend(url)) {
    return new Response(JSON.stringify({ ok: false, error_code: 404, description: 'fake provider: unknown endpoint' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (mode === 'fail') {
    return new Response(JSON.stringify({ ok: false, error_code: 400, description: 'fake provider: rejected' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  let chatId = 0;
  try {
    const parsed = JSON.parse(body);
    chatId = parsed.chat_id ?? 0;
  } catch {
    chatId = 0;
  }

  return new Response(
    JSON.stringify({
      ok: true,
      result: { message_id: 900001, chat: { id: chatId }, text: 'fake provider reply' },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};
