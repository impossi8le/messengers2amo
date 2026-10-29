import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { createFakeFetch, seedAmocrm } from './helpers/amocrm.ts';
import { createTokenCipher } from '../src/integrations/amocrm/crypto.ts';
import { createOAuth, AuthRevokedError, RateLimitError } from '../src/integrations/amocrm/oauth.ts';

const DOMAIN = 'p14lenrem.amocrm.ru';
const REDIRECT = 'https://messengers.example.test/oauth/amocrm/callback';

function oauthDeps(db: Parameters<typeof seedAmocrm>[0], schema: string, fetchImpl: typeof fetch, now?: () => number) {
  return {
    db,
    schema,
    fetch: fetchImpl,
    now,
    cipher: createTokenCipher('unit-test-key-material'),
    config: {
      clientId: 'client-id-test',
      clientSecret: 'client-secret-test',
      redirectUri: REDIRECT,
      accountDomain: DOMAIN,
    },
  };
}

function tokenPayload(access = 'access-1', refresh = 'refresh-1', expiresIn = 86_400) {
  return { token_type: 'Bearer', expires_in: expiresIn, access_token: access, refresh_token: refresh };
}

async function credentialRef(db: Parameters<typeof seedAmocrm>[0], schema: string, accountId = 'acc1'): Promise<string | null> {
  const { rows } = await db.query<{ credential_ref: string | null; state: string }>(
    `SELECT credential_ref, state FROM "${schema}".crm_accounts WHERE id=$1`,
    [accountId],
  );
  return rows[0]?.credential_ref ?? null;
}

test('authorization URL pins expected domain and registered redirect, and persists state', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await seedAmocrm(db, schema);
    const fetchImpl = createFakeFetch(() => ({ status: 500 }));
    const oauth = createOAuth(oauthDeps(db, schema, fetchImpl));
    const { url, state } = await oauth.authorizationUrl({ companyId: 'c1', accountId: 'acc1' });
    const parsed = new URL(url);
    // The consent page is on the shared www.amocrm.ru host; the account subdomain
    // answers /oauth2/authorize with 405. redirect_uri is registered in the
    // integration itself and must not be sent here.
    assert.equal(parsed.origin + parsed.pathname, 'https://www.amocrm.ru/oauth');
    assert.equal(parsed.host, 'www.amocrm.ru');
    assert.equal(parsed.pathname, '/oauth');
    assert.equal(parsed.searchParams.get('client_id'), 'client-id-test');
    assert.equal(parsed.searchParams.get('state'), state);
    // mode=post_message: amoCRM redirects inside the popup and our callback page
    // closes it, keeping the console in place. popup mode would break this flow.
    assert.equal(parsed.searchParams.get('mode'), 'post_message');
    assert.equal(parsed.searchParams.get('redirect_uri'), null);
    assert.equal(parsed.searchParams.get('response_type'), null);
    const { rows } = await db.query(`SELECT nonce, account_domain, redirect_uri FROM "${schema}".amocrm_oauth_states`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].account_domain, DOMAIN);
    assert.equal(rows[0].redirect_uri, REDIRECT);
    assert.equal(fetchImpl.calls.length, 0);
  } finally {
    await close();
  }
});

test('code exchange stores only encrypted tokens and activates the account', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await seedAmocrm(db, schema);
    const fetchImpl = createFakeFetch(() => ({ status: 200, body: tokenPayload('access-secret-value', 'refresh-secret-value') }));
    const oauth = createOAuth(oauthDeps(db, schema, fetchImpl));
    const { state } = await oauth.authorizationUrl({ companyId: 'c1', accountId: 'acc1' });
    const result = await oauth.complete({ companyId: 'c1', code: 'auth-code', state });

    assert.equal(result.accountId, 'acc1');
    assert.equal(fetchImpl.calls.length, 1);
    const call = fetchImpl.calls[0]!;
    assert.equal(call.method, 'POST');
    assert.equal(call.url, `https://${DOMAIN}/oauth2/access_token`);
    const body = JSON.parse(call.body!);
    assert.equal(body.grant_type, 'authorization_code');
    assert.equal(body.code, 'auth-code');
    assert.equal(body.redirect_uri, REDIRECT);
    assert.equal(body.client_secret, 'client-secret-test');

    const stored = await credentialRef(db, schema);
    assert.ok(stored);
    assert.ok(!stored.includes('access-secret-value'), 'access token must not be stored in clear');
    assert.ok(!stored.includes('refresh-secret-value'), 'refresh token must not be stored in clear');
    const decrypted = JSON.parse(createTokenCipher('unit-test-key-material').decrypt(stored));
    assert.equal(decrypted.accessToken, 'access-secret-value');
    assert.equal(decrypted.refreshToken, 'refresh-secret-value');
    const { rows } = await db.query<{ state: string }>(`SELECT state FROM "${schema}".crm_accounts WHERE id='acc1'`);
    assert.equal(rows[0]?.state, 'active');
  } finally {
    await close();
  }
});

test('a state issued by one tenant completes into that tenant, not the configured one', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await seedAmocrm(db, schema);
    const fetchImpl = createFakeFetch(() => ({ status: 200, body: tokenPayload('tenant-access', 'tenant-refresh') }));
    const oauth = createOAuth(oauthDeps(db, schema, fetchImpl));
    // The console session belongs to another tenant than the one this process is
    // configured for. The callback carries no session, so it must bind the
    // exchange to the company stored on the state row.
    const { state } = await oauth.authorizationUrl({ companyId: 'tenant-a', accountId: 'acc1' });
    const result = await oauth.complete({ code: 'auth-code', state });

    assert.equal(result.accountId, 'acc1');
    const { rows } = await db.query<{ company_id: string; state: string; credential_ref: string | null }>(
      `SELECT company_id, state, credential_ref FROM "${schema}".crm_accounts WHERE id='acc1'`,
    );
    const issued = rows.find((row) => row.company_id === 'tenant-a');
    assert.ok(issued, 'credentials must be written for the tenant that issued the state');
    assert.equal(issued!.state, 'active');
    assert.ok(issued!.credential_ref);
    const audit = await db.query<{ company_id: string }>(
      `SELECT company_id FROM "${schema}".amocrm_oauth_audit WHERE event='authorized'`,
    );
    assert.deepEqual(
      audit.rows.map((row) => row.company_id),
      ['tenant-a'],
    );
  } finally {
    await close();
  }
});

test('an explicitly named company that did not issue the state is rejected', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await seedAmocrm(db, schema);
    const fetchImpl = createFakeFetch(() => ({ status: 200, body: tokenPayload() }));
    const oauth = createOAuth(oauthDeps(db, schema, fetchImpl));
    const { state } = await oauth.authorizationUrl({ companyId: 'tenant-a', accountId: 'acc1' });
    await assert.rejects(
      () => oauth.complete({ companyId: 'c1', code: 'auth-code', state }),
      (error: { code?: string }) => error.code === 'invalid_oauth_state',
    );
    assert.equal(fetchImpl.calls.length, 0, 'a rejected state must not reach the token endpoint');
    // The assertion must not burn the state: the tenant that issued it still finishes.
    const result = await oauth.complete({ code: 'auth-code', state });
    assert.equal(result.accountId, 'acc1');
  } finally {
    await close();
  }
});

test('OAuth state is single-use and replay is rejected', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await seedAmocrm(db, schema);
    const fetchImpl = createFakeFetch(() => ({ status: 200, body: tokenPayload() }));
    const oauth = createOAuth(oauthDeps(db, schema, fetchImpl));
    const { state } = await oauth.authorizationUrl({ companyId: 'c1', accountId: 'acc1' });
    await oauth.complete({ companyId: 'c1', code: 'code-1', state });
    await assert.rejects(
      () => oauth.complete({ companyId: 'c1', code: 'code-1', state }),
      /invalid_oauth_state/,
    );
    assert.equal(fetchImpl.calls.length, 1);
  } finally {
    await close();
  }
});

test('foreign account domain and unregistered redirect are rejected before any network call', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await seedAmocrm(db, schema);
    const fetchImpl = createFakeFetch(() => ({ status: 200, body: tokenPayload() }));
    const oauth = createOAuth(oauthDeps(db, schema, fetchImpl));
    const { state } = await oauth.authorizationUrl({ companyId: 'c1', accountId: 'acc1' });
    await assert.rejects(
      () => oauth.complete({ companyId: 'c1', code: 'c', state, accountDomain: 'evil.example.com' }),
      /unexpected_account_domain/,
    );
    await assert.rejects(
      () => oauth.complete({ companyId: 'c1', code: 'c', state, redirectUri: 'https://evil.example/cb' }),
      /unexpected_redirect_uri/,
    );
    assert.equal(fetchImpl.calls.length, 0);
  } finally {
    await close();
  }
});

test('parallel refresh exchanges the refresh token exactly once and keeps the newest pair', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await seedAmocrm(db, schema);
    let issued = 0;
    const fetchImpl = createFakeFetch(async (call) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (JSON.parse(call.body ?? '{}').grant_type === 'authorization_code') {
        return { status: 200, body: tokenPayload('access-1', 'refresh-1', 60) };
      }
      issued += 1;
      return { status: 200, body: tokenPayload(`access-${issued + 1}`, `refresh-${issued + 1}`, 60) };
    });
    const oauth = createOAuth(oauthDeps(db, schema, fetchImpl));
    const { state } = await oauth.authorizationUrl({ companyId: 'c1', accountId: 'acc1' });
    await oauth.complete({ companyId: 'c1', code: 'code', state });
    assert.equal(fetchImpl.calls.length, 1);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => oauth.refresh({ companyId: 'c1', accountId: 'acc1', force: true })),
    );
    assert.equal(fetchImpl.calls.length, 2, 'only one refresh request may reach amoCRM');
    const refreshCalls = fetchImpl.calls.filter((call) => JSON.parse(call.body ?? '{}').grant_type === 'refresh_token');
    assert.equal(refreshCalls.length, 1);
    assert.equal(JSON.parse(refreshCalls[0]!.body!).refresh_token, 'refresh-1');
    const tokens = results.map((result) => result.accessToken);
    assert.deepEqual(new Set(tokens).size, 1);
    const decrypted = JSON.parse(createTokenCipher('unit-test-key-material').decrypt((await credentialRef(db, schema))!));
    assert.equal(decrypted.refreshToken, 'refresh-2');
  } finally {
    await close();
  }
});

test('revoked access stops workers, is recorded once, and reconnect restores the account', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await seedAmocrm(db, schema);
    const events: string[] = [];
    const fetchImpl = createFakeFetch((call) => {
      if (JSON.parse(call.body ?? '{}').grant_type === 'refresh_token') {
        return { status: 400, body: { error: 'invalid_grant', error_description: 'revoked' } };
      }
      return { status: 200, body: tokenPayload() };
    });
    const oauth = createOAuth({
      ...oauthDeps(db, schema, fetchImpl),
      notify: (event: string) => events.push(event),
    });
    const { state } = await oauth.authorizationUrl({ companyId: 'c1', accountId: 'acc1' });
    await oauth.complete({ companyId: 'c1', code: 'code', state });
    await assert.rejects(
      () => oauth.refresh({ companyId: 'c1', accountId: 'acc1', force: true }),
      (error: unknown) => error instanceof AuthRevokedError,
    );
    const callsAfterRevoke = fetchImpl.calls.length;
    await assert.rejects(
      () => oauth.refresh({ companyId: 'c1', accountId: 'acc1', force: true }),
      (error: unknown) => error instanceof AuthRevokedError,
    );
    assert.equal(fetchImpl.calls.length, callsAfterRevoke, 'revoked account must not hit the network again');
    const { rows } = await db.query<{ state: string }>(`SELECT state FROM "${schema}".crm_accounts WHERE id='acc1'`);
    assert.equal(rows[0]?.state, 'revoked');
    assert.deepEqual(events, ['amocrm.auth_revoked']);

    const reconnect = await oauth.authorizationUrl({ companyId: 'c1', accountId: 'acc1' });
    await oauth.complete({ companyId: 'c1', code: 'code-2', state: reconnect.state });
    const after = await db.query<{ state: string }>(`SELECT state FROM "${schema}".crm_accounts WHERE id='acc1'`);
    assert.equal(after.rows[0]?.state, 'active');
  } finally {
    await close();
  }
});

test('rate limited refresh surfaces 429 explicitly and does not rotate stored tokens', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await seedAmocrm(db, schema);
    let limited = false;
    const fetchImpl = createFakeFetch(() => {
      if (limited) return { status: 429, headers: { 'retry-after': '7' }, body: { detail: 'slow down' } };
      return { status: 200, body: tokenPayload('access-1', 'refresh-1', 60) };
    });
    const oauth = createOAuth(oauthDeps(db, schema, fetchImpl));
    const { state } = await oauth.authorizationUrl({ companyId: 'c1', accountId: 'acc1' });
    await oauth.complete({ companyId: 'c1', code: 'code', state });
    const before = await credentialRef(db, schema);
    limited = true;
    await assert.rejects(
      () => oauth.refresh({ companyId: 'c1', accountId: 'acc1', force: true }),
      (error: unknown) => error instanceof RateLimitError && error.retryAfterMs === 7000,
    );
    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(await credentialRef(db, schema), before);
    const { rows } = await db.query<{ state: string }>(`SELECT state FROM "${schema}".crm_accounts WHERE id='acc1'`);
    assert.equal(rows[0]?.state, 'active');
  } finally {
    await close();
  }
});

test('malformed token responses are rejected without corrupting stored credentials', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await seedAmocrm(db, schema);
    let phase = 0;
    const fetchImpl = createFakeFetch(() => {
      phase += 1;
      return phase === 1
        ? { status: 200, body: tokenPayload('access-1', 'refresh-1', 60) }
        : { status: 200, body: { token_type: 'Bearer', expires_in: 60 } };
    });
    const oauth = createOAuth(oauthDeps(db, schema, fetchImpl));
    const { state } = await oauth.authorizationUrl({ companyId: 'c1', accountId: 'acc1' });
    await oauth.complete({ companyId: 'c1', code: 'code', state });
    const before = await credentialRef(db, schema);
    await assert.rejects(
      () => oauth.refresh({ companyId: 'c1', accountId: 'acc1', force: true }),
      /invalid_token_response/,
    );
    assert.equal(await credentialRef(db, schema), before);
  } finally {
    await close();
  }
});

test('an explicit administrative revoke blocks token use without further network calls', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await seedAmocrm(db, schema);
    const events: string[] = [];
    const fetchImpl = createFakeFetch(() => ({ status: 200, body: tokenPayload('access-1', 'refresh-1', 3600) }));
    const oauth = createOAuth({
      ...oauthDeps(db, schema, fetchImpl),
      notify: (event: string) => events.push(event),
    });
    const { state } = await oauth.authorizationUrl({ companyId: 'c1', accountId: 'acc1' });
    await oauth.complete({ companyId: 'c1', code: 'code', state });
    const callsBefore = fetchImpl.calls.length;
    await oauth.revoke({ companyId: 'c1', accountId: 'acc1', reason: 'admin_disabled' });
    await assert.rejects(
      () => oauth.accessToken({ companyId: 'c1', accountId: 'acc1' }),
      (error: unknown) => error instanceof AuthRevokedError,
    );
    assert.equal(fetchImpl.calls.length, callsBefore);
    assert.deepEqual(events, ['amocrm.auth_revoked']);
    const { rows } = await db.query<{ state: string }>(`SELECT state FROM "${schema}".crm_accounts WHERE id='acc1'`);
    assert.equal(rows[0]?.state, 'revoked');
  } finally {
    await close();
  }
});
