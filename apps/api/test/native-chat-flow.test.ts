import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { seedCompany, seedConnection } from './helpers/seed.ts';
import { buildTestApp } from './helpers/app.ts';
import { recordTelegramUpdate } from '../src/telegram/inbox.ts';
import { drainTelegramInbox } from '../src/telegram/processor.ts';
import { AmocrmSync, OutboundQueue, type AmocrmSyncClient } from '../src/integrations/amocrm/sync.ts';
import { createProjectionDispatcher } from '../src/integrations/amocrm/projection.ts';
import { registerChannel } from '../src/integrations/amocrm/store.ts';
import { createTokenCipher } from '../src/integrations/amocrm/crypto.ts';
import { drainAmocrmReplies } from '../src/integrations/amocrm/replies.ts';
import { runSendWorker } from '../src/telegram/send.ts';
import { signedWebhook } from './helpers/amocrm.ts';
import { createOutboundMediaResolver } from '../src/integrations/amocrm/outbound-media.ts';
import type { TelegramTransport } from '../src/telegram/transport.ts';

async function fixture() {
  const testDb = await createTestDb();
  const { db, schema } = testDb;
  await seedCompany(db, {
    companyId: 'c1',
    workshops: ['w1'],
    staff: [{ id: 'gateway-admin', role: 'admin', password: 'test-password' }],
  });
  await seedConnection(db, {
    companyId: 'c1',
    id: 'conn1',
    state: 'active',
    workshopId: 'w1',
    ownerId: 'gateway-admin',
  });
  await db.query('UPDATE connections SET ingress_enabled=true,send_enabled=true');
  await db.query("UPDATE crm_accounts SET state='active'");
  await db.query("UPDATE connection_routes SET alert_staff_id='gateway-admin'");
  await db.query(
    "INSERT INTO channel_policies(company_id,connection_id,crm_projection_enabled,private_import_enabled,group_default) VALUES ('c1','conn1',true,true,'deny')",
  );
  const cipher = createTokenCipher('synthetic-native-flow-key');
  await registerChannel(db, schema, {
    companyId: 'c1',
    accountId: 'acc_conn1',
    scopeId: 'scope1',
    channelCode: 'test',
    secretEnc: cipher.encrypt('channel-secret'),
    connectionId: 'conn1',
    bindingEpoch: 0,
    amojoAccountId: 'amojo1',
  });
  const scope = { companyId: 'c1', connectionId: 'conn1', bindingEpoch: 0 };
  const update = {
    update_id: 1,
    message: {
      message_id: 55,
      date: 1793020000,
      chat: { id: 12345, type: 'private' },
      from: { id: 12345, is_bot: false, first_name: 'Synthetic' },
      text: 'Synthetic inbound',
    },
  };
  await recordTelegramUpdate(db, scope, update);
  await drainTelegramInbox(db, { schema });
  const conversation = (await db.query('SELECT id FROM conversations')).rows[0].id as string;
  let imported = 0;
  const client: AmocrmSyncClient = {
    findContacts: async () => [],
    findOpenLeads: async () => [],
    createContact: async () => ({ id: '77' }),
    createChat: async () => ({ chatId: 'chat-uuid' }),
    createLead: async () => {
      throw new Error('new request must use Unsorted');
    },
    linkChat: async () => {},
    importMessage: async () => {
      imported++;
      return { messageId: 'imported-message' };
    },
  };
  const sync = new AmocrmSync({ db, schema, client });
  let failure: unknown;
  const dispatch = createProjectionDispatcher({ sync });
  const queue = new OutboundQueue({
    db,
    schema,
    dispatch: async (payload) => {
      try {
        return await dispatch(payload);
      } catch (error) {
        failure = error;
        throw error;
      }
    },
  });
  if ((await queue.runOnce()).completed !== 1) {
    await testDb.close();
    throw failure ?? new Error('projection_not_claimed');
  }
  assert.equal(imported, 1);
  const app = await buildTestApp({ db, schema, amocrm: { cipher, schema } });
  const webhook = async (id: string, extra: Record<string, unknown> = {}) => {
    const payload = {
      account_id: 'amojo1',
      time: 1793020010,
      message: {
        conversation: { id: 'chat-uuid', client_id: conversation },
        sender: { id: 'crm-manager-id' },
        message: { id, type: 'text', text: 'Synthetic reply', ...extra },
      },
    };
    const raw = JSON.stringify(payload);
    return app.inject({
      method: 'POST',
      url: '/webhooks/amocrm/scope1',
      headers: { 'content-type': 'application/json', 'x-signature': signedWebhook('channel-secret', raw) },
      payload: raw,
    });
  };
  return {
    ...testDb,
    scope,
    update,
    conversation,
    app,
    webhook,
    close: async () => {
      await app.close();
      await testDb.close();
    },
  };
}

test('Telegram → native CRM projection → signed v2 reply → original Telegram chat, without duplicates', async () => {
  const { db, schema, scope, update, webhook, close } = await fixture();
  try {
    await recordTelegramUpdate(db, scope, update);
    await drainTelegramInbox(db, { schema });
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM outbox_jobs WHERE job_kind='amocrm.projection'"))
        .rows[0].n,
      1,
    );
    assert.equal((await webhook('crm-reply-1')).statusCode, 200);
    assert.equal((await webhook('crm-reply-1')).statusCode, 200);
    assert.equal(
      (await drainTelegramInbox(db, { schema })).processed,
      0,
      'Telegram drain must not consume CRM events',
    );
    assert.equal((await drainAmocrmReplies(db, { schema, outboundEnabled: false })).queued, 0);
    assert.equal((await drainAmocrmReplies(db, { schema, outboundEnabled: true })).queued, 1);
    assert.equal((await drainAmocrmReplies(db, { schema, outboundEnabled: true })).queued, 0);
    const calls: Array<{ chatId: string; text: string }> = [];
    const result = await runSendWorker(db, {
      ...scope,
      schema,
      owner: 'synthetic-worker',
      leaseMs: 30000,
      transport: {
        sendMessage: async (input) => {
          calls.push(input);
          return { outcome: 'sent', providerMessageId: 'telegram-sent-1' };
        },
      },
    });
    assert.equal(result.sent, 1);
    assert.deepEqual(calls, [{ chatId: '12345', text: 'Synthetic reply' }]);
    assert.equal(
      (
        await runSendWorker(db, {
          ...scope,
          schema,
          owner: 'synthetic-worker',
          leaseMs: 30000,
          transport: {
            sendMessage: async () => {
              throw new Error('must not resend');
            },
          },
        })
      ).claimed,
      0,
    );
  } finally {
    await close();
  }
});

test('an imported message echo never becomes a messenger send', async () => {
  const { db, schema, webhook, close } = await fixture();
  try {
    await webhook('imported-message');
    const result = await drainAmocrmReplies(db, { schema, outboundEnabled: true });
    assert.equal(result.queued, 0);
    assert.equal(result.review, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM send_operations')).rows[0].n, 0);
  } finally {
    await close();
  }
});

test('pilot reply drain leaves an old reply and another conversation pending',async()=>{
 const {db,schema,scope,conversation,webhook,close}=await fixture();
 try{
  await webhook('old-reply');
  await db.query("UPDATE inbox_events SET received_at='2020-01-01' WHERE kind='chats.message'");
  await webhook('fresh-reply');
  const outboundPolicy={mode:'pilot' as const,...scope,conversationId:conversation,activatedAfter:'2024-01-01T00:00:00.000Z'};
  assert.equal((await drainAmocrmReplies(db,{schema,outboundEnabled:false,outboundPolicy})).processed,0);
  assert.equal((await drainAmocrmReplies(db,{schema,outboundEnabled:true,outboundPolicy:{...outboundPolicy,conversationId:'another'}})).processed,0);
  const result=await drainAmocrmReplies(db,{schema,outboundEnabled:true,outboundPolicy});
  assert.equal(result.queued,1);
  const pending=(await db.query("SELECT provider_event_key FROM inbox_events WHERE kind='chats.message' AND state='pending'")).rows;
  assert.deepEqual(pending,[{provider_event_key:'chats.message:old-reply'}]);
 }finally{await close();}
});

test('an unsupported native attachment is quarantined for review, without sending its caption as text', async () => {
  const { db, schema, webhook, close } = await fixture();
  try {
    await webhook('media-reply', { type: 'file', media: 'https://example.test/file.pdf' });
    const result = await drainAmocrmReplies(db, { schema, outboundEnabled: true });
    assert.equal(result.review, 1);
    assert.equal(result.queued, 0);
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM inbox_events WHERE state='quarantined'")).rows[0].n,
      1,
    );
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM channel_alerts WHERE kind='manual_review'")).rows[0].n,
      1,
    );
    assert.equal((await db.query('SELECT count(*)::int AS n FROM send_operations')).rows[0].n, 0);
  } finally {
    await close();
  }
});

test('native quotes resolve only confirmed ids in the same dialog and outgoing mappings keep their CRM identity',async()=>{
 const {db,schema,scope,webhook,close}=await fixture();try{
  await webhook('quoted-reply',{reply_to:{message:{id:'imported-message'}}});
  assert.equal((await drainAmocrmReplies(db,{schema,outboundEnabled:true})).queued,1);
  const calls:Array<{chatId:string;text:string;replyToMessageId?:string}>=[];
  const result=await runSendWorker(db,{...scope,schema,owner:'quote-test',leaseMs:30000,transport:{sendMessage:async(input)=>{calls.push(input);return {outcome:'sent',providerMessageId:'101'};}}});
  assert.equal(result.sent,1);assert.equal(calls[0]!.replyToMessageId,'55');
  const mapping=(await db.query("SELECT provider_message_id,actual_provider_message_id,message_id,operation_id FROM amocrm_message_links WHERE amo_message_id='quoted-reply'")).rows[0];
  assert.equal(mapping.provider_message_id,'crm:quoted-reply');assert.equal(mapping.actual_provider_message_id,'101');assert.ok(mapping.message_id&&mapping.operation_id);
  await webhook('reply-to-own',{reply_to:{message:{id:'quoted-reply'}}});
  assert.equal((await drainAmocrmReplies(db,{schema,outboundEnabled:true})).queued,1);
  assert.equal((await db.query("SELECT content->>'replyToMessageId' AS target FROM send_operations WHERE idempotency_key='amocrm:acc_conn1:reply-to-own'")).rows[0].target,'101');
  await webhook('missing-quote',{reply_to:{message:{id:'missing-or-foreign'}}});
  assert.equal((await drainAmocrmReplies(db,{schema,outboundEnabled:true})).review,1);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM send_operations WHERE idempotency_key='amocrm:acc_conn1:missing-quote'")).rows[0].n,0);
 }finally{await close();}
});

for (const type of ['picture','file'] as const) test(`native ${type} sends the original attachment once and persists attachment history`,async()=>{
  const c=await fixture();try{
    const bytes=type==='picture'?Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2]):Buffer.from('original document bytes');
    const name=type==='picture'?'Тест.png':'Тест.txt';let uploads=0,downloads=0,linked=false,sends=0,leadLookups=0;
    const resolver=createOutboundMediaResolver({db:c.db,schema:c.schema,
      getAccessToken:async()=>{throw Error('OAuth must not go to amojo attachment host');},
      resolveLead:async input=>{leadLookups++;assert.equal(input.contactId,'77');return '500';},
      fetch:async(url,init)=>{downloads++;assert.equal(url,'https://amojo.amocrm.ru/attachments/synthetic');assert.deepEqual(init?.headers,{});return new Response(bytes);},
      files:{upload:async input=>{uploads++;assert.deepEqual(input.bytes,new Uint8Array(bytes));assert.equal(input.fileName,name);return {uuid:'11111111-1111-4111-8111-111111111111'};},
        isLinked:async()=>linked,link:async input=>{assert.equal(input.leadId,'500');linked=true;}},
      reader:{download:async input=>{assert.equal(input.byteSize,bytes.length);return new Uint8Array(bytes);}}});
    const payload={type,text:'test caption',media:'https://amojo.amocrm.ru/attachments/synthetic',file_name:name,file_size:bytes.length};
    assert.equal((await c.webhook('native-media',payload)).statusCode,200);
    await c.webhook('native-media',payload);
    assert.equal((await drainAmocrmReplies(c.db,{schema:c.schema,outboundEnabled:true})).queued,1);
    const options={...c.scope,schema:c.schema,owner:'media-test',leaseMs:60000,resolveMedia:resolver,
      transport:{sendMessage:async()=>{throw Error('no caption-only send');},sendMedia:async (input:Parameters<NonNullable<TelegramTransport['sendMedia']>>[0])=>{
        sends++;assert.equal(input.chatId,'12345');assert.equal(input.mediaType,type==='picture'?'photo':'document');
        assert.equal(input.caption,'test caption');assert.equal(input.file.fileName,name);assert.deepEqual(input.file.bytes,new Uint8Array(bytes));
        return {outcome:'sent' as const,providerMessageId:'101'};}}};
    assert.equal((await runSendWorker(c.db,options)).sent,1);
    assert.equal((await runSendWorker(c.db,options)).claimed,0);
    assert.equal(sends,1);assert.equal(uploads,1);assert.equal(downloads,1);assert.equal(leadLookups,1);
    const stored=(await c.db.query("SELECT v.content FROM messages m JOIN message_versions v ON v.company_id=m.company_id AND v.message_id=m.id WHERE m.direction='out'")).rows[0].content;
    assert.equal(stored.kind,'attachment');assert.equal(stored.outboundMedia.fileName,name);assert.equal(stored.outboundMedia.sizeBytes,bytes.length);
    assert.equal(JSON.stringify(stored).includes('https://'),false);
    assert.equal((await c.db.query('SELECT state FROM amocrm_outbound_files')).rows[0].state,'linked');
    assert.equal((await c.db.query('SELECT lead_id FROM crm_bindings')).rows[0].lead_id,null,'lead discovery is read-only');
  }finally{await c.close();}
});

for(const revoke of ["UPDATE connections SET send_enabled=false","UPDATE connections SET crm_access_enabled=true"])test(`media rechecks current access after slow file preparation: ${revoke}`,async()=>{
  const c=await fixture();try{
    await c.webhook('revoked-media',{type:'file',media:'https://amojo.amocrm.ru/attachments/synthetic',file_name:'test.txt',file_size:4});
    assert.equal((await drainAmocrmReplies(c.db,{schema:c.schema,outboundEnabled:true})).queued,1);
    let calls=0;
    const result=await runSendWorker(c.db,{...c.scope,schema:c.schema,owner:'revocation',leaseMs:60000,
      resolveMedia:async()=>{await c.db.query(revoke);return {bytes:Buffer.from('test'),fileName:'test.txt',mimeType:'text/plain'};},
      transport:{sendMessage:async()=>{throw Error('no text');},sendMedia:async()=>{calls++;return {outcome:'sent',providerMessageId:'101'};}}});
    assert.equal(result.failed,1);assert.equal(calls,0);
  }finally{await c.close();}
});

test('an ambiguous Telegram attachment send is terminal and never blindly retried',async()=>{
  const c=await fixture();try{
    await c.webhook('uncertain-media',{type:'file',media:'https://amojo.amocrm.ru/attachments/synthetic',file_name:'test.txt',file_size:4});
    await drainAmocrmReplies(c.db,{schema:c.schema,outboundEnabled:true});
    let calls=0,prepares=0;
    const options={...c.scope,schema:c.schema,owner:'uncertain',leaseMs:60000,
      resolveMedia:async()=>{prepares++;return {bytes:Buffer.from('test'),fileName:'test.txt',mimeType:'text/plain'};},
      transport:{sendMessage:async()=>{throw Error('no text');},sendMedia:async()=>{calls++;return {outcome:'unknown' as const,reason:'timeout' as const};}}};
    assert.equal((await runSendWorker(c.db,options)).unknown,1);assert.equal((await runSendWorker(c.db,options)).claimed,0);
    assert.equal(calls,1);assert.equal(prepares,1);
  }finally{await c.close();}
});

test('an unconfirmed CRM byte upload is recorded without any Telegram delivery or blind reupload',async()=>{
  const c=await fixture();try{
    await c.db.query("UPDATE crm_bindings SET lead_id='500'");
    await c.webhook('failed-upload',{type:'file',media:'https://amojo.amocrm.ru/attachments/synthetic',file_name:'test.txt',file_size:4});
    await drainAmocrmReplies(c.db,{schema:c.schema,outboundEnabled:true});
    let uploads=0,sends=0;
    const resolver=createOutboundMediaResolver({db:c.db,schema:c.schema,getAccessToken:async()=>'',fetch:async()=>new Response('test'),
      files:{upload:async()=>{uploads++;throw Error('synthetic uncertain upload');},isLinked:async()=>false,link:async()=>{throw Error('no link');}},
      reader:{download:async()=>{throw Error('no read');}}});
    const result=await runSendWorker(c.db,{...c.scope,schema:c.schema,owner:'failed-upload',leaseMs:60000,resolveMedia:resolver,
      transport:{sendMessage:async()=>{throw Error('no text');},sendMedia:async()=>{sends++;return {outcome:'sent',providerMessageId:'101'};}}});
    assert.equal(result.failed,1);assert.equal(sends,0);assert.equal(uploads,1);
    assert.equal((await c.db.query('SELECT state FROM amocrm_outbound_files')).rows[0].state,'unknown');
    const op=(await c.db.query("UPDATE send_operations SET state='dispatching' RETURNING id")).rows[0].id;
    await assert.rejects(()=>resolver({companyId:'c1',conversationId:c.conversation,operationId:op,
      media:{type:'document',url:'https://amojo.amocrm.ru/attachments/synthetic',fileName:'test.txt',mimeType:'text/plain',sizeBytes:4}}),/outbound_media_upload_unknown/);
    assert.equal(uploads,1);
  }finally{await c.close();}
});
