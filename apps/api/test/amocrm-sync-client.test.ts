// HTTP implementation of the CRM projection contract (spec: channel routing, step 1).
//
// These tests pin the wire contract only. They prove which request is sent and how
// the answer is read; they do not prove that amoCRM accepts the payload. The REST
// v4 shapes below are the documented ones; the Chats API payload still needs a live
// check against the test account before it can be called verified.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeFetch } from './helpers/amocrm.ts';
import { AmocrmApiError } from '../src/integrations/amocrm/client.ts';
import { createAmocrmSyncClient } from '../src/integrations/amocrm/sync-client.ts';

const DOMAIN = 'p14lenrem.amocrm.ru';
const API = `https://${DOMAIN}`;
const CHATS = 'https://amojo.amocrm.ru';

type TokenCall = { companyId: string; accountId: string };

function makeClient(fetchImpl: typeof fetch, tokenCalls: TokenCall[] = [], extra: Record<string, unknown> = {}) {
  return createAmocrmSyncClient({
    accountDomain: DOMAIN,
    getAccessToken: async (input) => {
      tokenCalls.push({ companyId: input.companyId, accountId: input.accountId });
      return `token-${input.companyId}-${input.accountId}`;
    },
    fetch: fetchImpl,
    ...extra,
  });
}

const account = { companyId: 'c1', accountId: 'acc1' };

test('Chats imports retain the Telegram display identity instead of replacing it with a generic client',async()=>{
  const fetchImpl=createFakeFetch(()=>({status:200,body:{new_message:{msgid:'amo-profile-message'}}}));
  const client=makeClient(fetchImpl,[],{getChatScope:async()=>({scopeId:'scope-1',channelSecret:'secret-1'})});
  await client.importMessage({...account,conversationId:'conv1',messageId:'profile-1',text:'profile test',occurredAt:new Date('2026-10-29T10:00:00Z'),silent:true,
    senderName:'Егор',senderUsername:'egor_test',senderAvatarUrl:'https://messenger.example/api/v2/amocrm/avatars/conv1/content?signature=safe-grant'});
  const body=JSON.parse(fetchImpl.calls[0]!.body!);
  assert.deepEqual(body.payload.sender,{id:'peer:conv1',name:'Егор',profile_link:'https://t.me/egor_test',avatar:'https://messenger.example/api/v2/amocrm/avatars/conv1/content?signature=safe-grant'});
  assert.equal(body.payload.receiver,undefined,'a client message remains incoming');
});

test('Chats profile refuses credential-bearing provider avatar URLs before any HTTP request',async()=>{
  const fetchImpl=createFakeFetch(()=>({status:200,body:{new_message:{msgid:'never'}}}));
  const client=makeClient(fetchImpl,[],{getChatScope:async()=>({scopeId:'scope-1',channelSecret:'secret-1'})});
  for(const senderAvatarUrl of ['http://unsafe.test/avatar','https://user:password@example.test/a','https://api.telegram.org/file/bot123:test/photo.jpg'])
    await assert.rejects(client.importMessage({...account,conversationId:'conv1',messageId:'invalid',text:'profile test',occurredAt:new Date(),silent:true,senderAvatarUrl}),
      (e:unknown)=>e instanceof AmocrmApiError&&e.code==='invalid_sender_avatar');
  assert.equal(fetchImpl.calls.length,0);
});

test('REST-only capture posts an unassigned Unsorted request in the explicit pipeline without Chats API', async () => {
  const fetchImpl = createFakeFetch(() => ({ status: 200, body: {
    _embedded: { unsorted: [{ uid: 'unsorted-uid', _embedded: { leads: [{ id: 901 }] } }] },
  } }));
  const client = makeClient(fetchImpl);
  const input = { ...account, conversationId: 'conv1', intentKey: 'lead:conv1',
    pipelineId: '10007030', contactId: '77', name: 'Telegram: test', destination: 'unsorted' as const };
  assert.deepEqual(await client.createLead(input), { id: '901' });
  await client.createLead(input);
  assert.equal(fetchImpl.calls[0]!.url, `${API}/api/v4/leads/unsorted/forms`);
  const [body] = JSON.parse(fetchImpl.calls[0]!.body!);
  const [retry] = JSON.parse(fetchImpl.calls[1]!.body!);
  assert.equal(body.source_uid, retry.source_uid);
  assert.equal(body.pipeline_id, 10007030);
  assert.deepEqual(body._embedded.contacts, [{ id: 77 }]);
  assert.deepEqual(body._embedded.leads, [{ name: 'Telegram: test' }]);
  assert.equal(body.responsible_user_id, undefined);
  assert.equal(body.metadata.ip, undefined, 'we do not invent the Telegram sender IP');
  assert.ok(fetchImpl.calls.every(call => !call.url.includes('amojo')));
});

test('REST-only capture refuses malformed success and invalid routing', async () => {
  const fetchImpl = createFakeFetch(() => ({ status: 200, body: { _embedded: { unsorted: [] } } }));
  const client = makeClient(fetchImpl);
  const input = { ...account, conversationId: 'conv1', intentKey: 'lead:conv1', destination: 'unsorted' as const };
  await assert.rejects(client.createLead(input), (e: unknown) => e instanceof AmocrmApiError && e.code === 'invalid_unsorted_route');
  assert.equal(fetchImpl.calls.length, 0);
  await assert.rejects(client.createLead({ ...input, pipelineId: '10007030' }),
    (e: unknown) => e instanceof AmocrmApiError && e.code === 'invalid_unsorted_response');
});

test('linkChat binds the actual Chats UUID to the contact and verifies the returned association', async () => {
  const fetchImpl = createFakeFetch(() => ({ status: 200, body: { _embedded: { chats: [{ contact_id: 77, chat_id: 'chat-uuid' }] } } }));
  await makeClient(fetchImpl).linkChat({ ...account, contactId: '77', chatId: 'chat-uuid' });
  assert.equal(fetchImpl.calls[0]!.url, `${API}/api/v4/contacts/chats`);
  assert.deepEqual(JSON.parse(fetchImpl.calls[0]!.body!), [{ contact_id: 77, chat_id: 'chat-uuid' }]);
});

test('importMessage uses the signed native Chats API and leaves a new request in Unsorted', async () => {
  const fetchImpl = createFakeFetch(() => ({ status: 200, body: { new_message: { msgid: 'amo-msg' } } }));
  const client = makeClient(fetchImpl, [], { getChatScope: async () => ({ scopeId: 'scope-1', channelSecret: 'secret-1' }) });
  const result = await client.importMessage({ ...account, conversationId: 'conv1', messageId: 'stable-msg', text: 'Example', occurredAt: new Date('2026-10-26T12:00:00Z'), silent: false, sourceId: 'source-1' });
  assert.equal(result.messageId, 'amo-msg');
  const call = fetchImpl.calls[0]!;
  assert.equal(call.url, `${CHATS}/v2/origin/custom/scope-1`);
  assert.ok(call.headers['x-signature']);
  const body = JSON.parse(call.body!);
  assert.equal(body.event_type, 'new_message');
  assert.equal(body.payload.msgid, 'stable-msg');
  assert.equal(body.payload.conversation_id, 'conv1');
  assert.equal(body.payload.silent, false);
  assert.deepEqual(body.payload.source, { external_id: 'source-1' });
  assert.equal(body.payload.responsible_user_id, undefined);
  assert.equal(body.payload.receiver, undefined);
});

test('importMessage rejects malformed success instead of marking an invisible message delivered', async () => {
  const fetchImpl = createFakeFetch(() => ({ status: 200, body: {} }));
  const client = makeClient(fetchImpl, [], { getChatScope: async () => ({ scopeId: 'scope-1', channelSecret: 'secret-1' }) });
  await assert.rejects(() => client.importMessage({ ...account, conversationId: 'conv1', messageId: 'stable-msg', text: 'Example', occurredAt: new Date(), silent: true }), (error: unknown) => error instanceof AmocrmApiError && error.code === 'invalid_message_response');
});

test('importMessage sends private attachments with caption and documented metadata, including media without text', async () => {
  for (const type of ['file','picture','video','voice','audio'] as const) {
    const fetchImpl = createFakeFetch(() => ({status:200,body:{new_message:{msgid:'amo-media'}}}));
    const client = makeClient(fetchImpl,[],{getChatScope:async()=>({scopeId:'scope-1',channelSecret:'secret-1'})});
    await client.importMessage({...account,conversationId:'conv1',messageId:'stable-media',text:type==='file'?'Caption':'',
      occurredAt:new Date(),silent:false,attachment:{type,url:'https://private.example/test?temporary=grant',fileName:'test.bin',sizeBytes:4}});
    const message=JSON.parse(fetchImpl.calls[0]!.body!).payload.message;
    assert.deepEqual(message,{type,text:type==='file'?'Caption':'',media:'https://private.example/test?temporary=grant',file_name:'test.bin',file_size:4});
    assert.ok(fetchImpl.calls[0]!.headers['x-signature']);
  }
});

test('importMessage refuses non-HTTPS grants and invalid attachment sizes before any HTTP call', async () => {
  const fetchImpl=createFakeFetch(()=>({status:200,body:{}}));
  const client=makeClient(fetchImpl,[],{getChatScope:async()=>({scopeId:'s',channelSecret:'secret'})});
  for(const url of ['memory://private','http://files.example/a','https://user:password@files.example/a']) {
    await assert.rejects(()=>client.importMessage({...account,conversationId:'conv1',messageId:'m',text:'caption',occurredAt:new Date(),silent:false,
      attachment:{type:'file',url,fileName:'a.txt',sizeBytes:4}}),/invalid_message_attachment/);
  }
  assert.equal(fetchImpl.calls.length,0);
});

test('findContacts searches the account by phone and maps the contacts it returns', async () => {
  const fetchImpl = createFakeFetch(() => ({
    status: 200,
    body: { _embedded: { contacts: [{ id: 42, name: 'Анна' }] } },
  }));
  const tokenCalls: TokenCall[] = [];

  const found = await makeClient(fetchImpl, tokenCalls).findContacts({
    ...account,
    phone: '+79991234567',
    email: null,
  });

  assert.deepEqual(found, [{ id: '42', name: 'Анна' }]);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0]!.method, 'GET');
  assert.equal(fetchImpl.calls[0]!.url, `${API}/api/v4/contacts?query=%2B79991234567`);
  assert.equal(fetchImpl.calls[0]!.headers.authorization, 'Bearer token-c1-acc1');
  assert.deepEqual(tokenCalls, [{ companyId: 'c1', accountId: 'acc1' }]);
});

test('findContacts falls back to the email when the message carries no phone', async () => {
  const fetchImpl = createFakeFetch(() => ({ status: 200, body: { _embedded: { contacts: [] } } }));

  const found = await makeClient(fetchImpl).findContacts({
    ...account,
    phone: null,
    email: 'anna@example.com',
  });

  assert.deepEqual(found, []);
  assert.equal(fetchImpl.calls[0]!.url, `${API}/api/v4/contacts?query=anna%40example.com`);
});

test('findContacts refuses to search without any identifier instead of creating a duplicate contact', async () => {
  const fetchImpl = createFakeFetch(() => ({ status: 200, body: {} }));

  await assert.rejects(
    () => makeClient(fetchImpl).findContacts({ ...account, phone: null, email: null }),
    (error: unknown) => error instanceof AmocrmApiError && error.code === 'contact_query_missing',
  );
  assert.equal(fetchImpl.calls.length, 0, 'the search is refused before any network call');
});

test('findOpenLeads keeps only deals in a working stage of the account', async () => {
  const fetchImpl = createFakeFetch((call) => {
    if (call.url===`${API}/api/v4/contacts/42?with=leads`) return {status:200,body:{id:42,_embedded:{leads:[{id:900},{id:901},{id:902},{id:903}]}}};
    if (call.url === `${API}/api/v4/leads/pipelines`) {
      return {
        status: 200,
        body: {
          _embedded: {
            pipelines: [
              {
                id: 1,
                _embedded: {
                  statuses: [
                    { id: 100, type: 0 },
                    { id: 142, type: 1 },
                    { id: 143, type: 2 },
                  ],
                },
              },
            ],
          },
        },
      };
    }
    const leads = [
            { id: 900, status_id: 100, updated_at: 1790000000 },
            { id: 901, status_id: 142, updated_at: 1790000100 },
            { id: 902, status_id: 100, updated_at: 1780000000 },
            { id: 903, status_id: 999, updated_at: 1790000200 },
    ];
    return {status:200,body:leads.find((lead)=>call.url===`${API}/api/v4/leads/${lead.id}`)};
  });

  const leads = await makeClient(fetchImpl).findOpenLeads({ ...account, contactId: '42' });

  assert.deepEqual(leads, [
    { id: '900', updatedAt: new Date(1790000000 * 1000).toISOString() },
    { id: '902', updatedAt: new Date(1780000000 * 1000).toISOString() },
  ]);
  assert.equal(fetchImpl.calls.length, 6);
  assert.equal(
    fetchImpl.calls[0]!.url,
    `${API}/api/v4/contacts/42?with=leads`,
    'only leads actually related to this contact may be reused',
  );
});

test('createContact posts a contact with the phone as a PHONE custom field', async () => {
  const fetchImpl = createFakeFetch(() => ({
    status: 200,
    body: { _embedded: { contacts: [{ id: 77 }] } },
  }));

  const created = await makeClient(fetchImpl).createContact({
    ...account,
    conversationId: 'conv1',
    intentKey: 'contact:conv1',
    name: 'Анна',
    phone: '+79991234567',
    email: null,
  });

  assert.deepEqual(created, { id: '77' });
  const call = fetchImpl.calls[0]!;
  assert.equal(call.method, 'POST');
  assert.equal(call.url, `${API}/api/v4/contacts`);
  assert.deepEqual(JSON.parse(call.body ?? ''), [
    {
      name: 'Анна',
      custom_fields_values: [{ field_code: 'PHONE', values: [{ value: '+79991234567', enum_code: 'WORK' }] }],
    },
  ]);
});

test('createContact uses the phone as the name when the profile has no name', async () => {
  const fetchImpl = createFakeFetch(() => ({ status: 200, body: { _embedded: { contacts: [{ id: 77 }] } } }));

  await makeClient(fetchImpl).createContact({
    ...account,
    conversationId: 'conv1',
    intentKey: 'contact:conv1',
    phone: '+79991234567',
  });

  const body = JSON.parse(fetchImpl.calls[0]!.body ?? '');
  assert.equal(body[0].name, '+79991234567');
});

test('createContact refuses a contact with neither name nor phone', async () => {
  const fetchImpl = createFakeFetch(() => ({ status: 200, body: {} }));

  await assert.rejects(
    () => makeClient(fetchImpl).createContact({ ...account, conversationId: 'conv1', intentKey: 'contact:conv1' }),
    (error: unknown) => error instanceof AmocrmApiError && error.code === 'contact_identity_missing',
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('createLead posts the configured pipeline and stage and links the contact', async () => {
  const fetchImpl = createFakeFetch(() => ({ status: 200, body: { _embedded: { leads: [{ id: 9001 }] } } }));

  const created = await makeClient(fetchImpl).createLead({
    ...account,
    conversationId: 'conv1',
    intentKey: 'lead:conv1',
    contactId: '77',
    pipelineId: '555',
    statusId: '666',
    name: 'Анна',
  });

  assert.deepEqual(created, { id: '9001' });
  const call = fetchImpl.calls[0]!;
  assert.equal(call.method, 'POST');
  assert.equal(call.url, `${API}/api/v4/leads`);
  assert.deepEqual(JSON.parse(call.body ?? ''), [
    {
      name: 'Анна',
      pipeline_id: 555,
      status_id: 666,
      _embedded: { contacts: [{ id: 77 }] },
    },
  ]);
});

test('createLead omits the pipeline and stage when the channel binds neither', async () => {
  const fetchImpl = createFakeFetch(() => ({ status: 200, body: { _embedded: { leads: [{ id: 9001 }] } } }));

  await makeClient(fetchImpl).createLead({
    ...account,
    conversationId: 'conv1',
    intentKey: 'lead:conv1',
    contactId: '77',
  });

  const body = JSON.parse(fetchImpl.calls[0]!.body ?? '');
  assert.deepEqual(Object.keys(body[0]).sort(), ['_embedded', 'name'].sort());
});

test('createChat calls the signed Chats API of the configured scope', async () => {
  const fetchImpl = createFakeFetch(() => ({ status: 200, body: { id: 'chat-xyz' } }));

  const created = await makeClient(fetchImpl, [], {
    chatsBase: CHATS,
    getChatScope: async () => ({ scopeId: 'scope-1', channelSecret: 'secret-1' }),
  }).createChat({
    ...account,
    conversationId: 'conv1',
    intentKey: 'chat:conv1',
    externalChatId: 'tg-555',
    chatName: 'Анна',
  });

  assert.deepEqual(created, { chatId: 'chat-xyz' });
  const call = fetchImpl.calls[0]!;
  assert.equal(call.method, 'POST');
  assert.equal(call.url, `${CHATS}/v2/origin/custom/scope-1/chats`);
  assert.ok(call.headers['x-signature'], 'the request must be signed');
  assert.deepEqual(JSON.parse(call.body ?? ''), {
    conversation_id: 'conv1',
    user: { id: 'peer:conv1', name: 'Анна' },
  });
});

test('createChat refuses when the account has no registered chat channel', async () => {
  const fetchImpl = createFakeFetch(() => ({ status: 200, body: {} }));

  await assert.rejects(
    () =>
      makeClient(fetchImpl, [], { getChatScope: async () => null }).createChat({
        ...account,
        conversationId: 'conv1',
        intentKey: 'chat:conv1',
        externalChatId: 'tg-555',
        chatName: 'Анна',
      }),
    (error: unknown) => error instanceof AmocrmApiError && error.code === 'chat_scope_missing',
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('upstream authorization and server failures surface as AmocrmApiError, never as success', async () => {
  for (const status of [401, 500]) {
    const fetchImpl = createFakeFetch(() => ({ status, body: {} }));
    await assert.rejects(
      () => makeClient(fetchImpl).findContacts({ ...account, phone: '+79991234567' }),
      (error: unknown) => error instanceof AmocrmApiError && error.status === status,
      `status ${status}`,
    );
    assert.equal(fetchImpl.calls.length, 1);
  }
});

test('a create answer without an entity id is an upstream defect, not a silent no-op', async () => {
  const fetchImpl = createFakeFetch(() => ({ status: 200, body: { _embedded: { contacts: [] } } }));

  await assert.rejects(
    () =>
      makeClient(fetchImpl).createContact({
        ...account,
        conversationId: 'conv1',
        intentKey: 'contact:conv1',
        phone: '+79991234567',
      }),
    (error: unknown) => error instanceof AmocrmApiError && error.code === 'invalid_contact_response',
  );
});
