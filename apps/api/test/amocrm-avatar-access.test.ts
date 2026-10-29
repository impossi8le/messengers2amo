import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { Db } from '../src/platform/db.ts';
import { crmAvatarUrl, registerCrmAvatarRoutes } from '../src/media/crm-avatar-access.ts';

const secret = 'synthetic-avatar-url-signing-key';
const baseUrl = 'https://app.test';
const token = '123:synthetic-token';
const conversationId = '11111111-1111-4111-8111-111111111111';
const companyId = 'c1';
const accountId = 'acc_1';
const bindingEpoch = 0;
const userId = 42;

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function createMockDb(row?: { connection_id: string; credential_ref: string | null; external_chat_id: string }): Db {
  return {
    query: async <T>(_sql: string, _params: unknown[]) => ({ rows: (row ? [row as T] : []) as T[] }),
  } as unknown as Db;
}

function createFetch() {
  return async (url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const href = String(url);
    if (href.includes('/getUserProfilePhotos')) {
      return new Response(JSON.stringify({
        ok: true,
        result: { total_count: 1, photos: [[{ file_id: 'photo-file-id', file_size: jpeg.length, width: 100, height: 100 }]] },
      }));
    }
    if (href.includes('/getFile')) {
      return new Response(JSON.stringify({
        ok: true,
        result: { file_id: 'photo-file-id', file_path: 'photos/file.jpg', file_size: jpeg.length },
      }));
    }
    return new Response(jpeg);
  };
}

function scope() {
  return { companyId, accountId, conversationId, bindingEpoch };
}

function resolveBotToken(): string | null {
  return token;
}

test('valid capability returns JPEG with security headers', async () => {
  const app = Fastify();
  const db = createMockDb({ connection_id: 'conn', credential_ref: 'ref', external_chat_id: String(userId) });
  registerCrmAvatarRoutes(app, { db, schema: 'public', secret, resolveBotToken, fetch: createFetch() });
  try {
    const url = crmAvatarUrl({ ...scope(), baseUrl, secret });
    const response = await app.inject({ method: 'GET', url: new URL(url).pathname + new URL(url).search });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.rawPayload, jpeg);
    assert.equal(response.headers['content-type'], 'image/jpeg');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.ok(!url.includes(token));
    assert.ok(!url.includes('bot'));
  } finally {
    await app.close();
  }
});

test('invalid signature returns 404 without provider fetch', async () => {
  const app = Fastify();
  let fetched = false;
  const db = createMockDb({ connection_id: 'conn', credential_ref: 'ref', external_chat_id: String(userId) });
  registerCrmAvatarRoutes(app, {
    db,
    schema: 'public',
    secret,
    resolveBotToken,
    fetch: async () => { fetched = true; throw new Error('should not fetch'); },
  });
  try {
    const url = new URL(crmAvatarUrl({ ...scope(), baseUrl, secret }));
    url.searchParams.set('signature', '0'.repeat(64));
    const response = await app.inject({ method: 'GET', url: url.pathname + url.search });
    assert.equal(response.statusCode, 404);
    assert.equal(response.body, JSON.stringify({ code: 'NOT_FOUND' }));
    assert.equal(fetched, false);
  } finally {
    await app.close();
  }
});

test('revoked or mismatched scope returns 404 without provider fetch', async () => {
  const app = Fastify();
  let fetched = false;
  const db = createMockDb(undefined);
  registerCrmAvatarRoutes(app, {
    db,
    schema: 'public',
    secret,
    resolveBotToken,
    fetch: async () => { fetched = true; throw new Error('should not fetch'); },
  });
  try {
    const url = crmAvatarUrl({ ...scope(), baseUrl, secret });
    const response = await app.inject({ method: 'GET', url: new URL(url).pathname + new URL(url).search });
    assert.equal(response.statusCode, 404);
    assert.equal(fetched, false);
  } finally {
    await app.close();
  }
});

test('binding epoch mismatch returns 404', async () => {
  const app = Fastify();
  let fetched = false;
  const db = createMockDb({ connection_id: 'conn', credential_ref: 'ref', external_chat_id: String(userId) });
  registerCrmAvatarRoutes(app, {
    db,
    schema: 'public',
    secret,
    resolveBotToken,
    fetch: async () => { fetched = true; throw new Error('should not fetch'); },
  });
  try {
    const url = new URL(crmAvatarUrl({ ...scope(), baseUrl, secret }));
    url.searchParams.set('bindingEpoch', '99');
    const response = await app.inject({ method: 'GET', url: url.pathname + url.search });
    assert.equal(response.statusCode, 404);
    assert.equal(fetched, false);
  } finally {
    await app.close();
  }
});

test('non-numeric or non-positive external chat id returns 404', async () => {
  const app = Fastify();
  let fetched = false;
  const db = createMockDb({ connection_id: 'conn', credential_ref: 'ref', external_chat_id: 'not-a-number' });
  registerCrmAvatarRoutes(app, {
    db,
    schema: 'public',
    secret,
    resolveBotToken,
    fetch: async () => { fetched = true; throw new Error('should not fetch'); },
  });
  try {
    const url = crmAvatarUrl({ ...scope(), baseUrl, secret });
    const response = await app.inject({ method: 'GET', url: new URL(url).pathname + new URL(url).search });
    assert.equal(response.statusCode, 404);
    assert.equal(fetched, false);
  } finally {
    await app.close();
  }
});

test('limits concurrent avatar downloads to two in-flight requests', async () => {
  const app = Fastify();
  const db = createMockDb({ connection_id: 'conn', credential_ref: 'ref', external_chat_id: String(userId) });
  const releases: (() => void)[] = [];
  registerCrmAvatarRoutes(app, {
    db,
    schema: 'public',
    secret,
    resolveBotToken,
    fetch: async (url) => {
      const href = String(url);
      if (href.includes('/getUserProfilePhotos')) {
        return new Response(JSON.stringify({
          ok: true,
          result: { total_count: 1, photos: [[{ file_id: 'photo-file-id', file_size: jpeg.length, width: 100, height: 100 }]] },
        }));
      }
      if (href.includes('/getFile')) {
        return new Response(JSON.stringify({
          ok: true,
          result: { file_id: 'photo-file-id', file_path: 'photos/file.jpg', file_size: jpeg.length },
        }));
      }
      return new Promise<Response>((resolve) => {
        releases.push(() => resolve(new Response(jpeg)));
      });
    },
  });
  try {
    const url = new URL(crmAvatarUrl({ ...scope(), baseUrl, secret }));
    const path = url.pathname + url.search;
    const pending = [app.inject({ method: 'GET', url: path }), app.inject({ method: 'GET', url: path }), app.inject({ method: 'GET', url: path })];
    // Allow event loop to settle so the first two requests reach the download and block.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(releases.length, 2);
    releases[0]!();
    releases[1]!();
    const responses = await Promise.all(pending);
    const codes = responses.map((r) => r.statusCode).sort();
    assert.deepEqual(codes, [200, 200, 429]);
    const rateLimited = responses.find((r) => r.statusCode === 429)!;
    assert.equal(rateLimited.headers['retry-after'], '1');
  } finally {
    await app.close();
  }
});

test('missing profile photo returns 404', async () => {
  const app = Fastify();
  const db = createMockDb({ connection_id: 'conn', credential_ref: 'ref', external_chat_id: String(userId) });
  registerCrmAvatarRoutes(app, {
    db,
    schema: 'public',
    secret,
    resolveBotToken,
    fetch: async (url) => {
      if (String(url).includes('/getUserProfilePhotos')) {
        return new Response(JSON.stringify({ ok: true, result: { total_count: 0, photos: [] } }));
      }
      throw new Error('unexpected fetch');
    },
  });
  try {
    const url = crmAvatarUrl({ ...scope(), baseUrl, secret });
    const response = await app.inject({ method: 'GET', url: new URL(url).pathname + new URL(url).search });
    assert.equal(response.statusCode, 404);
    assert.equal(response.body, JSON.stringify({ code: 'NOT_FOUND' }));
  } finally {
    await app.close();
  }
});

test('upstream provider failure returns 503 without secret data', async () => {
  const app = Fastify();
  const db = createMockDb({ connection_id: 'conn', credential_ref: 'ref', external_chat_id: String(userId) });
  registerCrmAvatarRoutes(app, {
    db,
    schema: 'public',
    secret,
    resolveBotToken,
    fetch: async () => { throw new Error(`https://api.telegram.org/bot${token}/getFile`); },
  });
  try {
    const url = crmAvatarUrl({ ...scope(), baseUrl, secret });
    const response = await app.inject({ method: 'GET', url: new URL(url).pathname + new URL(url).search });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body, JSON.stringify({ code: 'UPSTREAM_UNAVAILABLE', retryable: true }));
    assert.ok(!response.body.includes(token));
  } finally {
    await app.close();
  }
});

test('crmAvatarUrl rejects non-https or non-root base URLs', () => {
  assert.throws(() => crmAvatarUrl({ ...scope(), baseUrl: 'http://app.test', secret }), /crm_media_base_url_invalid/);
  assert.throws(() => crmAvatarUrl({ ...scope(), baseUrl: 'https://app.test/path', secret }), /crm_media_base_url_invalid/);
  assert.throws(() => crmAvatarUrl({ ...scope(), baseUrl: null, secret }), /crm_media_base_url_missing/);
});
