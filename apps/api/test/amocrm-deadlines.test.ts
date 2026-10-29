import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { createFakeFetch, seedAmocrm } from './helpers/amocrm.ts';
import { createTokenCipher } from '../src/integrations/amocrm/crypto.ts';
import { AmocrmClient, AmocrmApiError } from '../src/integrations/amocrm/client.ts';
import { createOAuth, OAuthError } from '../src/integrations/amocrm/oauth.ts';

const DOMAIN = 'p14lenrem.amocrm.ru';
const REDIRECT = 'https://messengers.example.test/oauth/amocrm/callback';

/** A fetch that never answers on its own: it only settles when the signal aborts. */
function stallingFetch(): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const impl = (async (_input: unknown, init?: RequestInit) => {
    calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // a missing signal means the caller can hang forever
      if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls: () => calls };
}

/** Headers arrive at once, the body never finishes. */
function stallingBodyFetch(): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"_embedded":'));
        signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), {
          once: true,
        });
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

function clientWith(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new AmocrmClient({
    accountDomain: DOMAIN,
    getAccessToken: async () => 'token',
    fetch: fetchImpl,
    channelSecret: 'secret',
    timeoutMs: 150,
    ...extra,
  });
}

test('a stalled amoCRM request is aborted at the deadline instead of holding a worker', { timeout: 8_000 }, async () => {
  const stalled = stallingFetch();
  const client = clientWith(stalled.fetch);
  const started = Date.now();
  await assert.rejects(
    () => client.request('/api/v4/contacts'),
    (error: unknown) => error instanceof AmocrmApiError && error.code === 'timeout',
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3_000, `the call must end near the deadline, took ${elapsed}ms`);
  assert.equal(stalled.calls(), 1);
});

test('a stalled response body is also bounded by the deadline', { timeout: 8_000 }, async () => {
  const client = clientWith(stallingBodyFetch());
  await assert.rejects(
    () => client.request('/api/v4/contacts'),
    (error: unknown) => error instanceof AmocrmApiError && error.code === 'timeout',
  );
});

test('pagination and chats calls carry the same deadline', { timeout: 8_000 }, async () => {
  const stalledPagination = stallingFetch();
  await assert.rejects(
    () => clientWith(stalledPagination.fetch).paginate('/api/v4/contacts'),
    (error: unknown) => error instanceof AmocrmApiError && error.code === 'timeout',
  );

  const stalledChats = stallingFetch();
  await assert.rejects(
    () => clientWith(stalledChats.fetch).chats('scope', '/chats', { method: 'POST', body: {} }),
    (error: unknown) => error instanceof AmocrmApiError && error.code === 'timeout',
  );
});

test('an oversized response is refused instead of being buffered', async () => {
  const huge = 'x'.repeat(4096);
  const fetchImpl = createFakeFetch(() => ({ status: 200, body: { _embedded: { contacts: [huge] } } }));
  const client = clientWith(fetchImpl, { maxResponseBytes: 512 });
  await assert.rejects(
    () => client.request('/api/v4/contacts'),
    (error: unknown) => error instanceof AmocrmApiError && error.code === 'response_too_large',
  );
});

function oauthDeps(db: Parameters<typeof seedAmocrm>[0], schema: string, fetchImpl: typeof fetch) {
  return {
    db,
    schema,
    fetch: fetchImpl,
    timeoutMs: 150,
    cipher: createTokenCipher('unit-test-key-material'),
    config: {
      clientId: 'client-id-test',
      clientSecret: 'client-secret-test',
      redirectUri: REDIRECT,
      accountDomain: DOMAIN,
    },
  };
}

test('the token exchange is bounded by a deadline', { timeout: 8_000 }, async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await seedAmocrm(db, schema);
    const stalled = stallingFetch();
    const oauth = createOAuth(oauthDeps(db, schema, stalled.fetch));
    const { state } = await oauth.authorizationUrl({ companyId: 'c1', accountId: 'acc1' });
    await assert.rejects(
      () => oauth.complete({ companyId: 'c1', code: 'code', state }),
      (error: unknown) => error instanceof OAuthError && error.code === 'token_endpoint_timeout',
    );
  } finally {
    await close();
  }
});

test('a refresh in flight does not hold the account row lock or a transaction', { timeout: 8_000 }, async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await seedAmocrm(db, schema);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = createFakeFetch(async (call) => {
      if (JSON.parse(call.body ?? '{}').grant_type === 'authorization_code') {
        return { status: 200, body: { token_type: 'Bearer', expires_in: 60, access_token: 'a1', refresh_token: 'r1' } };
      }
      // Hold the refresh request open while another connection writes the row.
      await gate;
      return { status: 200, body: { token_type: 'Bearer', expires_in: 60, access_token: 'a2', refresh_token: 'r2' } };
    });
    const oauth = createOAuth(oauthDeps(db, schema, fetchImpl));
    const { state } = await oauth.authorizationUrl({ companyId: 'c1', accountId: 'acc1' });
    await oauth.complete({ companyId: 'c1', code: 'code', state });

    const pending = oauth.refresh({ companyId: 'c1', accountId: 'acc1', force: true });
    // Give the refresh time to reach the network call.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const writer = await db.connect();
    try {
      await writer.query(`SET statement_timeout = '1500ms'`);
      const update = await writer.query(
        `UPDATE "${schema}".crm_accounts SET state = state WHERE company_id='c1' AND id='acc1'`,
      );
      assert.equal(update.rowCount, 1, 'another writer must not be blocked by the refresh');
    } finally {
      writer.release();
    }

    release();
    const tokens = await pending;
    assert.equal(tokens.accessToken, 'a2');
  } finally {
    await close();
  }
});
