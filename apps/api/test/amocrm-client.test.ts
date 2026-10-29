import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createFakeFetch } from './helpers/amocrm.ts';
import {
  AmocrmClient,
  AmocrmApiError,
  AuthRequiredError,
  fetchPipelines,
} from '../src/integrations/amocrm/client.ts';
import { RateLimitError } from '../src/integrations/amocrm/oauth.ts';

const DOMAIN = 'p14lenrem.amocrm.ru';
const SECRET = 'test-channel-secret';

function makeClient(fetchImpl: typeof fetch, extra: { now?: () => number } = {}) {
  return new AmocrmClient({
    accountDomain: DOMAIN,
    getAccessToken: async () => 'access-token-value',
    fetch: fetchImpl,
    channelSecret: SECRET,
    now: extra.now,
  });
}

test('account lookup requests amojoy id with the bearer token', async () => {
  const fetchImpl = createFakeFetch(() => ({ status: 200, body: { id: 123456, amojo_id: 'amojo-77', name: 'Test' } }));
  const client = makeClient(fetchImpl);
  const account = await client.getAccount({ withAmojoId: true });
  assert.equal(account.id, 123456);
  assert.equal(account.amojo_id, 'amojo-77');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0]!.url, `https://${DOMAIN}/api/v4/account?with=amojo_id`);
  assert.equal(fetchImpl.calls[0]!.headers.authorization, 'Bearer access-token-value');
});

test('chats requests are signed with the shared protocol primitive over the exact bytes', async () => {
  const fetchImpl = createFakeFetch(() => ({ status: 200, body: { ok: true } }));
  const fixed = Date.UTC(2026, 9, 21, 12, 0, 0);
  const client = makeClient(fetchImpl, { now: () => fixed });
  const payload = { chat_id: 'amo-chat-1', text: 'hello' };
  await client.chats('scope-test', '/chats', { method: 'POST', body: payload });

  const call = fetchImpl.calls[0]!;
  const body = call.body!;
  assert.deepEqual(JSON.parse(body), payload);
  assert.equal(call.url, 'https://amojo.amocrm.ru/v2/origin/custom/scope-test/chats');
  const checksum = createHash('md5').update(body, 'utf8').digest('hex');
  const date = call.headers.date!;
  assert.equal(date, new Date(fixed).toUTCString());
  const canonical = ['POST', checksum, 'application/json', date, '/v2/origin/custom/scope-test/chats'].join('\n');
  const expected = createHmac('sha1', SECRET).update(canonical, 'utf8').digest('hex');
  assert.equal(call.headers['content-md5'], checksum);
  assert.equal(call.headers['x-signature'], expected);
  assert.equal(call.headers['content-type'], 'application/json');
});

test('rate limiting is surfaced explicitly with a single request', async () => {
  const fetchImpl = createFakeFetch(() => ({ status: 429, headers: { 'retry-after': '3' }, body: { detail: 'slow' } }));
  const client = makeClient(fetchImpl);
  await assert.rejects(
    () => client.request('/api/v4/contacts'),
    (error: unknown) => error instanceof RateLimitError && error.retryAfterMs === 3000,
  );
  assert.equal(fetchImpl.calls.length, 1, 'no hidden retry loop');
});

test('an authorization break is explicit and is not retried', async () => {
  const fetchImpl = createFakeFetch(() => ({ status: 401, body: {} }));
  const client = makeClient(fetchImpl);
  await assert.rejects(() => client.request('/api/v4/contacts'), (error: unknown) => error instanceof AuthRequiredError);
  assert.equal(fetchImpl.calls.length, 1);
});

test('pagination follows the next link on the account host', async () => {
  const fetchImpl = createFakeFetch((call) => {
    if (call.url.includes('page=2')) {
      return { status: 200, body: { _embedded: { contacts: [{ id: 2 }] } } };
    }
    return {
      status: 200,
      body: {
        _embedded: { contacts: [{ id: 1 }] },
        _links: { next: { href: `https://${DOMAIN}/api/v4/contacts?page=2` } },
      },
    };
  });
  const client = makeClient(fetchImpl);
  const contacts = await client.paginate<{ id: number }>('/api/v4/contacts');
  assert.deepEqual(contacts, [{ id: 1 }, { id: 2 }]);
  assert.equal(fetchImpl.calls.length, 2);
});

test('a next link pointing to another host is rejected', async () => {
  const fetchImpl = createFakeFetch(() => ({
    status: 200,
    body: { _embedded: { contacts: [] }, _links: { next: { href: 'https://evil.example.com/api/v4/contacts?page=2' } } },
  }));
  const client = makeClient(fetchImpl);
  await assert.rejects(
    () => client.paginate('/api/v4/contacts'),
    (error: unknown) => error instanceof AmocrmApiError && error.code === 'pagination_host_mismatch',
  );
  assert.equal(fetchImpl.calls.length, 1);
});

test('fetchPipelines lists funnels and marks the stages that are final', async () => {
  const fetchImpl = createFakeFetch(() => ({
    status: 200,
    body: {
      _embedded: {
        pipelines: [
          {
            id: 1,
            name: 'Продажи',
            _embedded: {
              statuses: [
                { id: 10, name: 'Новый', type: 0 },
                { id: 142, name: 'Успешно', type: 1 },
                { id: 143, name: 'Закрыто', type: 2 },
              ],
            },
          },
        ],
      },
    },
  }));

  const pipelines = await fetchPipelines(makeClient(fetchImpl));

  assert.deepEqual(pipelines, [
    {
      id: '1',
      name: 'Продажи',
      stages: [
        { id: '10', name: 'Новый', isFinal: false },
        { id: '142', name: 'Успешно', isFinal: true },
        { id: '143', name: 'Закрыто', isFinal: true },
      ],
    },
  ]);
  assert.equal(fetchImpl.calls[0]!.url, `https://${DOMAIN}/api/v4/leads/pipelines`);
});

test('an unreadable pipelines answer is an upstream defect, not an empty funnel list', async () => {
  const fetchImpl = createFakeFetch(() => ({ status: 200, body: { _embedded: {} } }));

  await assert.rejects(
    () => fetchPipelines(makeClient(fetchImpl)),
    (error: unknown) => error instanceof AmocrmApiError && error.code === 'invalid_pipelines_response',
  );
});
