import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { buildTestApp } from './helpers/app.ts';
import { createTokenCipher } from '../src/integrations/amocrm/crypto.ts';
import type { OAuthService } from '../src/integrations/amocrm/oauth.ts';

const SETUP = 'setup-token-value-1234567890';
const CIPHER_KEY = 'k'.repeat(64);

function stubOAuth(overrides: Partial<OAuthService> = {}): OAuthService {
  return {
    authorizationUrl: async () => ({ url: 'https://www.amocrm.ru/oauth?client_id=x&state=s', state: 's' }),
    complete: async () => ({ accountId: 'acc', tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: 0, tokenType: 'Bearer', accountDomain: 'p14lenrem.amocrm.ru' } }),
    refresh: async () => ({ accessToken: 'a', refreshToken: 'r', expiresAt: 0, tokenType: 'Bearer', accountDomain: 'p14lenrem.amocrm.ru' }),
    accessToken: async () => 'a',
    revoke: async () => undefined,
    ...overrides,
  };
}

test('authorize rejects an anonymous request without the setup token', async () => {
  const { db, close } = await createTestDb();
  const app = await buildTestApp({
    db,
    config: {},
    amocrm: { cipher: createTokenCipher(CIPHER_KEY), oauth: stubOAuth(), setupToken: SETUP, companyId: 'c1' },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v2/integrations/amocrm/oauth/authorize' });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    await close();
  }
});

test('authorize rejects a wrong setup token', async () => {
  const { db, close } = await createTestDb();
  const app = await buildTestApp({
    db,
    config: {},
    amocrm: { cipher: createTokenCipher(CIPHER_KEY), oauth: stubOAuth(), setupToken: SETUP, companyId: 'c1' },
  });
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v2/integrations/amocrm/oauth/authorize?setup=wrong-token-value-123456789',
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    await close();
  }
});

test('authorize redirects to amoCRM when the setup token matches', async () => {
  const { db, close } = await createTestDb();
  const app = await buildTestApp({
    db,
    config: {},
    amocrm: { cipher: createTokenCipher(CIPHER_KEY), oauth: stubOAuth(), setupToken: SETUP, companyId: 'c1' },
  });
  try {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v2/integrations/amocrm/oauth/authorize?setup=${SETUP}`,
    });
    assert.equal(response.statusCode, 302);
    assert.match(String(response.headers.location), /^https:\/\/www\.amocrm\.ru\/oauth\?/);
  } finally {
    await app.close();
    await close();
  }
});

test('callback without code or state is rejected and never calls the exchange', async () => {
  const { db, close } = await createTestDb();
  let called = false;
  const app = await buildTestApp({
    db,
    config: {},
    amocrm: {
      cipher: createTokenCipher(CIPHER_KEY),
      oauth: stubOAuth({ complete: async () => { called = true; throw new Error('must not run'); } }),
      setupToken: SETUP,
      companyId: 'c1',
    },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v2/integrations/amocrm/oauth/callback' });
    assert.equal(response.statusCode, 400);
    assert.equal(called, false);
    assert.match(String(response.headers['content-type']), /text\/html/);
  } finally {
    await app.close();
    await close();
  }
});

test('callback exchanges the code and reports success without leaking tokens', async () => {
  const { db, close } = await createTestDb();
  let seenCode = '';
  const app = await buildTestApp({
    db,
    config: {},
    amocrm: {
      cipher: createTokenCipher(CIPHER_KEY),
      oauth: stubOAuth({ complete: async (input) => { seenCode = input.code; return { accountId: 'acc', tokens: { accessToken: 'SECRET_ACCESS', refreshToken: 'SECRET_REFRESH', expiresAt: 0, tokenType: 'Bearer', accountDomain: 'p14lenrem.amocrm.ru' } }; } }),
      setupToken: SETUP,
      companyId: 'c1',
    },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v2/integrations/amocrm/oauth/callback?code=abc123&state=st1' });
    assert.equal(response.statusCode, 200);
    assert.equal(seenCode, 'abc123');
    assert.doesNotMatch(response.body, /SECRET_ACCESS|SECRET_REFRESH/);
  } finally {
    await app.close();
    await close();
  }
});

test('callback failure returns an error page without the raw reason', async () => {
  const { db, close } = await createTestDb();
  const app = await buildTestApp({
    db,
    config: {},
    amocrm: {
      cipher: createTokenCipher(CIPHER_KEY),
      oauth: stubOAuth({ complete: async () => { throw new Error('invalid_state'); } }),
      setupToken: SETUP,
      companyId: 'c1',
    },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v2/integrations/amocrm/oauth/callback?code=x&state=y' });
    assert.equal(response.statusCode, 400);
    assert.doesNotMatch(response.body, /invalid_state/);
  } finally {
    await app.close();
    await close();
  }
});

test('callback success page posts a result to the opener and closes the popup', async () => {
  const { db, close } = await createTestDb();
  const app = await buildTestApp({
    db,
    config: {},
    amocrm: {
      cipher: createTokenCipher(CIPHER_KEY),
      oauth: stubOAuth({ redirectUri: 'https://console.example.test/oauth/amocrm/callback' }),
      setupToken: SETUP,
      companyId: 'c1',
    },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v2/integrations/amocrm/oauth/callback?code=abc123&state=st1' });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-type']), /text\/html/);
    assert.match(response.body, /postMessage/);
    assert.match(response.body, /window\.close\(\)/);
    assert.match(response.body, /window\.opener/);
    assert.match(response.body, /"status":"ok"/);
    // The postMessage target origin comes from the configured redirect_uri.
    assert.match(response.body, /"https:\/\/console\.example\.test"/);
    assert.doesNotMatch(response.body, /www\.amocrm\.ru/);
    // Direct visits without an opener get a plain page with a way back.
    assert.match(response.body, /Вернуться в консоль/);
  } finally {
    await app.close();
    await close();
  }
});

test('callback error page posts an error status without leaking the raw reason', async () => {
  const { db, close } = await createTestDb();
  const app = await buildTestApp({
    db,
    config: {},
    amocrm: {
      cipher: createTokenCipher(CIPHER_KEY),
      oauth: stubOAuth({
        redirectUri: 'https://console.example.test/oauth/amocrm/callback',
        complete: async () => {
          throw new Error('invalid_oauth_state');
        },
      }),
      setupToken: SETUP,
      companyId: 'c1',
    },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v2/integrations/amocrm/oauth/callback?code=x&state=y' });
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /postMessage/);
    assert.match(response.body, /window\.close\(\)/);
    assert.match(response.body, /"status":"error"/);
    assert.doesNotMatch(response.body, /invalid_oauth_state/);
    assert.match(response.body, /Вернуться в консоль/);
  } finally {
    await app.close();
    await close();
  }
});

test('callback page survives a missing opener and a missing redirect_uri', async () => {
  const { db, close } = await createTestDb();
  const app = await buildTestApp({
    db,
    config: {},
    amocrm: { cipher: createTokenCipher(CIPHER_KEY), oauth: stubOAuth(), setupToken: SETUP, companyId: 'c1' },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v2/integrations/amocrm/oauth/callback?code=abc123&state=st1' });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /postMessage/);
    // Without a configured redirect_uri the script falls back to its own origin.
    assert.match(response.body, /window\.location\.origin/);
    assert.match(response.body, /Вернуться в консоль/);
  } finally {
    await app.close();
    await close();
  }
});

test('authorizationUrl bootstraps the tenant and CRM account for a first connection', async () => {
  const { db, schema, close } = await createTestDb();
  const { createOAuth } = await import('../src/integrations/amocrm/oauth.ts');
  try {
    const oauth = createOAuth({
      db,
      cipher: createTokenCipher(CIPHER_KEY),
      fetch: (async () => { throw new Error('no network'); }) as unknown as typeof fetch,
      schema,
      config: {
        clientId: 'cid',
        clientSecret: 'secret',
        redirectUri: 'https://example.test/cb',
        accountDomain: 'p14lenrem.amocrm.ru',
      },
    });
    const { url, state } = await oauth.authorizationUrl({ companyId: 'fresh', accountId: 'fresh' });
    assert.match(url, /^https:\/\/www\.amocrm\.ru\/oauth\?/);
    assert.ok(state.length >= 16);
    const accounts = await db.query(`SELECT count(*)::int AS c FROM "${schema}".crm_accounts WHERE company_id='fresh'`);
    assert.equal(accounts.rows[0].c, 1);
    const states = await db.query(`SELECT count(*)::int AS c FROM "${schema}".amocrm_oauth_states WHERE company_id='fresh'`);
    assert.equal(states.rows[0].c, 1);
  } finally {
    await close();
  }
});
