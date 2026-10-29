import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeFetch } from './helpers/amocrm.ts';
import { AmocrmApiError } from '../src/integrations/amocrm/client.ts';
import { createAmocrmWorkflowClient } from '../src/integrations/amocrm/workflow-client.ts';

const DOMAIN = 'p14lenrem.amocrm.ru';

type TokenCall = { companyId: string; accountId: string };

function makeClient(fetchImpl: typeof fetch, tokenCalls: TokenCall[] = []) {
  return createAmocrmWorkflowClient({
    accountDomain: DOMAIN,
    getAccessToken: async (input) => {
      tokenCalls.push({ companyId: input.companyId, accountId: input.accountId });
      return `token-${input.companyId}-${input.accountId}`;
    },
    fetch: fetchImpl,
  });
}

const bound = {
  companyId: 'c1',
  accountId: 'acc1',
  conversationId: 'conv1',
  contactId: '42',
};

test('readResponsible reads the contact and its lead from the account API', async () => {
  const fetchImpl = createFakeFetch((call) => {
    if (call.url === `https://${DOMAIN}/api/v4/contacts/42`) {
      return { status: 200, body: { id: 42, responsible_user_id: 7 } };
    }
    if (call.url === `https://${DOMAIN}/api/v4/leads/9`) {
      return { status: 200, body: { id: 9, responsible_user_id: 8 } };
    }
    return { status: 404, body: {} };
  });
  const tokenCalls: TokenCall[] = [];
  const client = makeClient(fetchImpl, tokenCalls);

  const observed = await client.readResponsible({ ...bound, leadId: '9' });

  assert.deepEqual(observed, {
    contactOwnerRef: '7',
    lead: { id: '9', responsibleUserId: '8' },
  });
  assert.deepEqual(
    fetchImpl.calls.map((call) => `${call.method} ${call.url}`),
    [`GET https://${DOMAIN}/api/v4/contacts/42`, `GET https://${DOMAIN}/api/v4/leads/9`],
  );
  assert.equal(fetchImpl.calls[0]!.headers.authorization, 'Bearer token-c1-acc1');
  assert.deepEqual(tokenCalls[0], { companyId: 'c1', accountId: 'acc1' });
});

test('readResponsible skips the lead read when no lead is bound', async () => {
  const fetchImpl = createFakeFetch(() => ({ status: 200, body: { id: 42, responsible_user_id: 7 } }));
  const client = makeClient(fetchImpl);

  const observed = await client.readResponsible({ ...bound, leadId: null });

  assert.deepEqual(observed, { contactOwnerRef: '7', lead: null });
  assert.equal(fetchImpl.calls.length, 1);
});

test('a contact without a responsible user yields a null owner ref', async () => {
  const fetchImpl = createFakeFetch(() => ({ status: 200, body: { id: 42, responsible_user_id: null } }));
  const client = makeClient(fetchImpl);

  const observed = await client.readResponsible({ ...bound, leadId: null });

  assert.deepEqual(observed, { contactOwnerRef: null, lead: null });
});

test('a missing lead is reported as null instead of failing the sync', async () => {
  const fetchImpl = createFakeFetch((call) =>
    call.url.endsWith('/api/v4/contacts/42')
      ? { status: 200, body: { id: 42, responsible_user_id: 7 } }
      : { status: 404, body: { detail: 'not found' } },
  );
  const client = makeClient(fetchImpl);

  const observed = await client.readResponsible({ ...bound, leadId: '404' });

  assert.deepEqual(observed, { contactOwnerRef: '7', lead: null });
});

test('setContactOwner patches the contact responsible user', async () => {
  const fetchImpl = createFakeFetch(() => ({ status: 200, body: { _embedded: { contacts: [{ id: 42 }] } } }));
  const client = makeClient(fetchImpl);

  await client.setContactOwner({ ...bound, ownerRef: '7' });

  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0]!;
  assert.equal(call.method, 'PATCH');
  assert.equal(call.url, `https://${DOMAIN}/api/v4/contacts`);
  assert.equal(call.headers.authorization, 'Bearer token-c1-acc1');
  assert.deepEqual(JSON.parse(call.body ?? ''), [{ id: 42, responsible_user_id: 7 }]);
});

test('a non-numeric owner ref is rejected before any network call', async () => {
  const fetchImpl = createFakeFetch(() => ({ status: 200, body: {} }));
  const client = makeClient(fetchImpl);

  for (const ownerRef of ['abc', '', '0', '-3', '1.5', ' 7', '7abc']) {
    await assert.rejects(
      () => client.setContactOwner({ ...bound, ownerRef }),
      (error: unknown) => error instanceof AmocrmApiError && error.code === 'invalid_owner_ref',
      `ownerRef ${JSON.stringify(ownerRef)} must be rejected`,
    );
  }
  assert.equal(fetchImpl.calls.length, 0, 'validation happens before the request');
});

test('upstream authorization and server failures surface as AmocrmApiError', async () => {
  for (const status of [401, 500]) {
    const readFetch = createFakeFetch(() => ({ status, body: {} }));
    await assert.rejects(
      () => makeClient(readFetch).readResponsible({ ...bound, leadId: null }),
      (error: unknown) => error instanceof AmocrmApiError && error.status === status,
      `read ${status}`,
    );
    assert.equal(readFetch.calls.length, 1);
  }

  const writeFetch = createFakeFetch(() => ({ status: 500, body: {} }));
  await assert.rejects(
    () => makeClient(writeFetch).setContactOwner({ ...bound, ownerRef: '7' }),
    (error: unknown) => error instanceof AmocrmApiError && error.status === 500,
  );
  assert.equal(writeFetch.calls.length, 1);
});
