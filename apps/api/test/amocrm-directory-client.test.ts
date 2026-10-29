import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeFetch } from './helpers/amocrm.ts';
import { AmocrmApiError, AuthRequiredError } from '../src/integrations/amocrm/client.ts';
import { RateLimitError } from '../src/integrations/amocrm/oauth.ts';
import { createCrmDirectoryClient } from '../src/integrations/amocrm/directory-client.ts';

const DOMAIN = 'tenant.amocrm.ru';
const INPUT = { companyId: 'company-7', accountId: 'account-9' };

function user(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `User ${id}`,
    email: `user-${id}@example.test`,
    phone: '+1-555-0100',
    access_token: 'must-not-escape',
    amojo_id: 'amojo-user-17',
    rights: {
      is_active: true,
      is_admin: false,
      role_id: 8,
      group_id: 4,
      secret: 'private-rights',
    },
    _embedded: { roles: [{ id: 8, name: 'Support' }], groups: [{ id: 4, name: 'West' }] },
    ...overrides,
  };
}

function options(fetchImpl: typeof fetch, getAccessToken = async (_scope: typeof INPUT) => 'scoped-token') {
  return {
    accountDomain: DOMAIN,
    getAccessToken,
    fetch: fetchImpl,
  };
}

test('loads normalized users and roles with a tenant-scoped token and fixed GET paths', async () => {
  const fetchImpl = createFakeFetch((call) =>
    new URL(call.url).pathname === '/api/v4/users'
      ? { status: 200, body: { _embedded: { users: [user(17)] } } }
      : { status: 200, body: { _embedded: { roles: [{ id: 8, name: 'Support' }] } } },
  );
  const scopes: typeof INPUT[] = [];
  const client = createCrmDirectoryClient(
    options(fetchImpl, async (scope) => {
      scopes.push(scope);
      return 'scoped-token';
    }),
  );

  const snapshot = await client.load(INPUT);

  assert.deepEqual(snapshot, {
    users: [
      {
        id: '17',
        name: 'User 17',
        isActive: true,
        isAdmin: false,
        groupId: '4',
        groupName: 'West',
        roleId: '8',
        roleName: 'Support',
        amojoId: 'amojo-user-17',
      },
    ],
    roles: [{ id: '8', name: 'Support' }],
  });
  assert.equal(JSON.stringify(snapshot).includes('example.test'), false);
  assert.equal(JSON.stringify(snapshot).includes('must-not-escape'), false);
  assert.equal(JSON.stringify(snapshot).includes('private-rights'), false);
  assert.deepEqual(scopes, [INPUT, INPUT]);
  assert.equal(fetchImpl.calls.length, 2);
  assert.deepEqual(
    fetchImpl.calls.map(({ url, method, headers }) => ({
      url: new URL(url).pathname + new URL(url).search,
      method,
      authorization: headers.authorization,
    })),
    [
      {
        url: '/api/v4/users?with=role,group,amojo_id&page=1&limit=250',
        method: 'GET',
        authorization: 'Bearer scoped-token',
      },
      {
        url: '/api/v4/roles?page=1&limit=250',
        method: 'GET',
        authorization: 'Bearer scoped-token',
      },
    ],
  );
});

test('traverses pages without following supplied next hrefs', async () => {
  const fetchImpl = createFakeFetch((call) => {
    const url = new URL(call.url);
    const page = Number(url.searchParams.get('page'));
    if (url.pathname === '/api/v4/users') {
      return page === 1
        ? {
            status: 200,
            body: {
              _embedded: { users: [user(1)] },
              _links: { next: { href: 'https://attacker.invalid/steal-token' } },
            },
          }
        : { status: 200, body: { _embedded: { users: [user(2)] } } };
    }
    return page === 1
      ? { status: 200, body: { _embedded: { roles: [{ id: 8, name: 'Support' }] }, _page_count: 2 } }
      : { status: 200, body: { _embedded: { roles: [{ id: 9, name: 'Sales' }] }, _page_count: 2 } };
  });
  const client = createCrmDirectoryClient(options(fetchImpl));

  const snapshot = await client.load(INPUT);

  assert.deepEqual(snapshot.users.map(({ id }) => id), ['1', '2']);
  assert.deepEqual(snapshot.roles.map(({ id }) => id), ['8', '9']);
  assert.equal(fetchImpl.calls.length, 4);
  assert.equal(fetchImpl.calls.some(({ url }) => url.includes('attacker.invalid')), false);
  assert.deepEqual(
    fetchImpl.calls.map(({ url }) => [new URL(url).pathname, new URL(url).searchParams.get('page')]),
    [
      ['/api/v4/users', '1'],
      ['/api/v4/users', '2'],
      ['/api/v4/roles', '1'],
      ['/api/v4/roles', '2'],
    ],
  );
});

test('rejects JSON null instead of treating a malformed success as an empty directory', async () => {
  const fetchImpl = createFakeFetch((call) =>
    new URL(call.url).pathname === '/api/v4/users'
      ? { status: 200, body: null }
      : { status: 200, body: null },
  );
  await assert.rejects(() => createCrmDirectoryClient(options(fetchImpl)).load(INPUT),
    (error: unknown) => error instanceof AmocrmApiError && error.code === 'directory_invalid_response');
});

test('rejects a missing advertised page instead of accepting a partial directory', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return calls === 1
      ? new Response(JSON.stringify({_embedded:{users:[user(1)]},_page_count:2}),{status:200})
      : new Response(null,{status:204});
  }) as typeof fetch;
  await assert.rejects(() => createCrmDirectoryClient(options(fetchImpl)).load(INPUT),
    (error: unknown) => error instanceof AmocrmApiError && error.code === 'directory_invalid_response');
  assert.equal(calls,2);
});

test('treats HTTP 204 as an empty terminal page', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const snapshot = await createCrmDirectoryClient(options(fetchImpl)).load(INPUT);
  assert.deepEqual(snapshot, { users: [], roles: [] });
  assert.equal(calls.length, 2);
});

test('rejects malformed successful responses without including response content', async () => {
  const fetchImpl = createFakeFetch((call) =>
    new URL(call.url).pathname === '/api/v4/users'
      ? { status: 200, body: { email: 'sensitive@example.test', _embedded: { users: [user(0)] } } }
      : { status: 200, body: { _embedded: { roles: [] } } },
  );
  await assert.rejects(
    () => createCrmDirectoryClient(options(fetchImpl)).load(INPUT),
    (error: unknown) =>
      error instanceof AmocrmApiError &&
      error.code === 'directory_invalid_response' &&
      !error.message.includes('sensitive@example.test'),
  );
});

test('maps malformed JSON success responses to the static directory error', async () => {
  const fetchImpl = (async () =>
    new Response('{', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  await assert.rejects(
    () => createCrmDirectoryClient(options(fetchImpl)).load(INPUT),
    (error: unknown) => error instanceof AmocrmApiError && error.code === 'directory_invalid_response',
  );
});

test('rejects duplicate IDs across pages', async () => {
  const fetchImpl = createFakeFetch((call) => {
    const url = new URL(call.url);
    if (url.pathname === '/api/v4/users') {
      return Number(url.searchParams.get('page')) === 1
        ? { status: 200, body: { _embedded: { users: [user(11)] }, _links: { next: {} } } }
        : { status: 200, body: { _embedded: { users: [user(11)] } } };
    }
    return { status: 200, body: { _embedded: { roles: [] } } };
  });
  await assert.rejects(
    () => createCrmDirectoryClient(options(fetchImpl)).load(INPUT),
    (error: unknown) => error instanceof AmocrmApiError && error.code === 'directory_invalid_response',
  );
  assert.equal(fetchImpl.calls.length, 2);
});

test('fails when another page is required beyond the 20-page bound', async () => {
  const fetchImpl = createFakeFetch((call) =>
    new URL(call.url).pathname === '/api/v4/users'
      ? { status: 200, body: { _embedded: { users: [] }, _page_count: 21 } }
      : { status: 200, body: { _embedded: { roles: [] } } },
  );
  await assert.rejects(
    () => createCrmDirectoryClient(options(fetchImpl)).load(INPUT),
    (error: unknown) => error instanceof AmocrmApiError && error.code === 'directory_page_limit_exceeded',
  );
  assert.equal(fetchImpl.calls.length, 20);
});

test('propagates authorization and rate-limit errors', async (t) => {
  for (const status of [401, 403, 429]) {
    await t.test(`HTTP ${status}`, async () => {
      const fetchImpl = createFakeFetch(() => ({ status, body: { secret: 'not-for-errors' } }));
      await assert.rejects(
        () => createCrmDirectoryClient(options(fetchImpl)).load(INPUT),
        (error: unknown) => {
          if (status === 401) return error instanceof AuthRequiredError;
          if (status === 429) return error instanceof RateLimitError;
          return error instanceof AmocrmApiError && error.code === 'http_403' && !error.message.includes('secret');
        },
      );
      assert.equal(fetchImpl.calls.length, 1);
    });
  }
});

test('validates role references and nullable amojo IDs', async () => {
  const badUsers = [
    user(1, { name: '  ' }),
    user(2, { rights: { is_active: 1, is_admin: false, role_id: null, group_id: null } }),
    user(3, { amojo_id: 'x'.repeat(129) }),
    user(4, { rights: { is_active: true, is_admin: false, role_id: 8, group_id: 4 }, _embedded: { roles: [{ id: 9, name: 'Mismatch' }], groups: [{ id: 4, name: 'West' }] } }),
  ];
  for (const badUser of badUsers) {
    const fetchImpl = createFakeFetch((call) =>
      new URL(call.url).pathname === '/api/v4/users'
        ? { status: 200, body: { _embedded: { users: [badUser] } } }
        : { status: 200, body: { _embedded: { roles: [] } } },
    );
    await assert.rejects(
      () => createCrmDirectoryClient(options(fetchImpl)).load(INPUT),
      (error: unknown) => error instanceof AmocrmApiError && error.code === 'directory_invalid_response',
    );
  }
});
