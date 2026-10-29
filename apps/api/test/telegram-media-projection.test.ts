import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, TEST_DATABASE_URL } from './helpers/db.ts';
import { createPool } from '../src/platform/db.ts';
import { seedCompany, seedConnection } from './helpers/seed.ts';
import { recordTelegramUpdate } from '../src/telegram/inbox.ts';
import { drainTelegramInbox } from '../src/telegram/processor.ts';
import { createTelegramMediaProjection,createTelegramMediaHandlers,TELEGRAM_MEDIA_JOB_KIND } from '../src/telegram/media-projection.ts';
import { InMemoryObjectStorage } from '../src/media/storage.ts';
import { AmocrmSync, OutboundQueue, type AmocrmSyncClient } from '../src/integrations/amocrm/sync.ts';
import { createProjectionDispatcher } from '../src/integrations/amocrm/projection.ts';
import { buildApp } from '../src/app.ts';
import { testConfig } from './helpers/app.ts';
import { createAmocrmSyncClient } from '../src/integrations/amocrm/sync-client.ts';
import { crmMediaUrl } from '../src/media/crm-access.ts';

class FakePrivateStorage extends InMemoryObjectStorage {
  issuedGrantCount=0;
  async presignGet(key:string,ttl:number) {
    assert.equal(ttl,3600);
    return {key,method:'GET' as const,url:`https://private-files.example/${encodeURIComponent(key)}?grant=${++this.issuedGrantCount}`,
      expiresAt:new Date(Date.now()+ttl*1000).toISOString()};
  }
}

async function fixture(options:{size?:number;mime?:string;bytes?:string;project?:boolean;fileName?:string}={}) {
  const context=await createTestDb();
  const {db,schema}=context;
  await seedCompany(db,{companyId:'c1',workshops:['w1'],staff:[{id:'admin',role:'admin',password:'test-password'}]});
  await seedConnection(db,{companyId:'c1',id:'conn1',state:'active',workshopId:'w1',ownerId:'admin'});
  // An unrelated active account sorts first; it must never capture this route's job.
  await db.query("INSERT INTO crm_accounts(company_id,id,state) VALUES ('c1','aaa-unrelated','active')");
  await db.query("UPDATE connections SET ingress_enabled=true");
  await db.query("UPDATE crm_accounts SET state='active'");
  await db.query("UPDATE connection_routes SET alert_staff_id='admin'");
  await db.query("INSERT INTO channel_policies(company_id,connection_id,crm_projection_enabled,private_import_enabled,group_default) VALUES ('c1','conn1',$1,true,'deny')",[options.project??true]);
  await recordTelegramUpdate(db,{companyId:'c1',connectionId:'conn1',bindingEpoch:0},{update_id:1,message:{message_id:55,
    chat:{id:12345,type:'private'},date:1793020000,caption:'Caption',
    document:{file_id:'file-1',file_name:options.fileName??'test.txt',mime_type:options.mime??'text/plain',file_size:options.size??4}}});
  await drainTelegramInbox(db,{schema});
  const job=(await db.query("SELECT payload FROM outbox_jobs WHERE job_kind='amocrm.projection'")).rows[0]?.payload;
  if (options.project!==false) assert.equal(job.accountId,'acc_conn1');
  const storage=new FakePrivateStorage();
  let downloads=0;
  const handlers=createTelegramMediaHandlers({db,schema,storage,sessionSecret:'synthetic-secret',resolveBotToken:()=> '123:synthetic-token',
    crmMediaBaseUrl:'https://messengers.example',
    fetch:async()=>++downloads%2===1?new Response(JSON.stringify({ok:true,result:{file_id:'file-1',file_path:'documents/file.txt',file_size:options.bytes?.length??4}})):new Response(options.bytes??'safe')});
  return {...context,job,storage,prepare:handlers.prepareMessage,archive:handlers.archiveMessage,downloads:()=>downloads};
}

test('CRM media remains downloadable after a restart and delayed opening, with metadata and scoped revocation',async()=>{
  const ctx=await fixture({fileName:"Счёт O'Reilly(42)*.txt"});
  const logs:string[]=[];
  const build=()=>buildApp({db:ctx.db,config:testConfig({sessionSecret:'synthetic-secret'}),
    media:{schema:ctx.schema,storage:ctx.storage},operator:{schema:ctx.schema},
    now:()=>Date.now()+2*24*3600_000,logSink:(line)=>logs.push(line)});
  let app=await build();
  try {
    const input={...ctx.job,occurredAt:new Date(ctx.job.occurredAt)};
    const prepared=await ctx.prepare(input);
    const url=new URL(prepared.attachment!.url);
    assert.equal(url.origin,'https://messengers.example','CRM gets the stable application URL, not an expiring object URL');
    const path=url.pathname+url.search;
    await app.close();
    app=await build();
    const content=await app.inject({method:'GET',url:path});
    assert.equal(content.statusCode,200);
    assert.equal(content.body,'safe');
    assert.equal(content.headers['content-type'],'text/plain');
    assert.equal(content.headers['content-disposition'],"attachment; filename*=UTF-8''%D0%A1%D1%87%D1%91%D1%82%20O%27Reilly%2842%29%2A.txt");
    assert.equal(content.headers['cache-control'],'private, no-store');
    assert.equal(content.headers['x-content-type-options'],'nosniff');
    const head=await app.inject({method:'HEAD',url:path});
    assert.equal(head.statusCode,200);
    assert.equal(head.body,'');
    assert.equal(head.headers['content-length'],'4');
    for (const [key,value] of [['companyId','other-company'],['accountId','aaa-unrelated'],['signature','0'.repeat(64)]]) {
      const changed=new URL(url);
      changed.searchParams.set(key!,value!);
      assert.equal((await app.inject({method:'GET',url:changed.pathname+changed.search})).statusCode,404);
    }
    assert.equal((await app.inject({method:'GET',url:url.pathname})).statusCode,404);
    const retry=await ctx.prepare(input);
    assert.equal(retry.attachment!.url,prepared.attachment!.url);
    assert.equal(ctx.downloads(),2);
    assert.equal(ctx.storage.issuedGrantCount,0,'private S3 grants are never given to CRM');
    await ctx.db.query("UPDATE crm_accounts SET state='disabled' WHERE id='acc_conn1'");
    assert.equal((await app.inject({method:'GET',url:path})).statusCode,404);
    await ctx.db.query("UPDATE crm_accounts SET state='active' WHERE id='acc_conn1'");
    await ctx.db.query("UPDATE connections SET state='paused'");
    assert.equal((await app.inject({method:'GET',url:path})).statusCode,404);
    await ctx.db.query("UPDATE connections SET state='active'");
    await ctx.db.query("UPDATE attachments SET group_archive_only=true");
    assert.equal((await app.inject({method:'GET',url:path})).statusCode,404);
    await ctx.db.query("UPDATE attachments SET group_archive_only=false");
    await ctx.db.query("INSERT INTO crm_sources(company_id,account_id,id,external_id,origin_code) VALUES ('c1','aaa-unrelated','other-source','other-source','synthetic')");
    await ctx.db.query("UPDATE connection_routes SET crm_account_id='aaa-unrelated',technical_source_id='other-source'");
    assert.equal((await app.inject({method:'GET',url:path})).statusCode,404);
    await ctx.db.query("UPDATE connection_routes SET crm_account_id='acc_conn1',technical_source_id='src_conn1'");
    await ctx.db.query("INSERT INTO connection_identities(company_id,connection_id,binding_epoch) VALUES ('c1','conn1',1)");
    await ctx.db.query("UPDATE connections SET binding_epoch=1");
    assert.equal((await app.inject({method:'GET',url:path})).statusCode,404);
    await ctx.db.query("UPDATE connections SET binding_epoch=0");
    const key=(await ctx.db.query('SELECT s3_key FROM attachments')).rows[0].s3_key;
    await ctx.storage.put(key,Buffer.from('evil'),'text/plain');
    assert.equal((await app.inject({method:'GET',url:path})).statusCode,503,'corrupt bytes are never returned');
    await ctx.storage.put(key,Buffer.from('safe'),'text/plain');
    await ctx.db.query('UPDATE channel_policies SET crm_projection_enabled=false');
    assert.equal((await app.inject({method:'GET',url:path})).statusCode,404);
    const output=logs.join('\n');
    assert.ok(!output.includes(url.searchParams.get('signature')!) && !output.includes('Счёт') && !output.includes('synthetic-token'));
  } finally {await app.close();await ctx.close();}
});

test('CRM download concurrency and storage errors release their slots for retry',async()=>{
  const ctx=await fixture();
  const app=await buildApp({db:ctx.db,config:testConfig({sessionSecret:'synthetic-secret'}),
    media:{schema:ctx.schema,storage:ctx.storage},operator:{schema:ctx.schema},logSink:()=>{}});
  let release!:()=>void;
  const blocked=new Promise<void>((resolve)=>{release=resolve;});
  let twoReads!:()=>void;
  const started=new Promise<void>((resolve)=>{twoReads=resolve;});
  try {
    const prepared=await ctx.prepare({...ctx.job,occurredAt:new Date(ctx.job.occurredAt)});
    const url=new URL(prepared.attachment!.url);
    const path=url.pathname+url.search;
    const originalGet=ctx.storage.get.bind(ctx.storage);
    let reads=0;
    ctx.storage.get=async(...args)=>{if(++reads===2)twoReads();await blocked;return originalGet(...args);};
    const first=app.inject({method:'GET',url:path}).then((response)=>response);
    const second=app.inject({method:'GET',url:path}).then((response)=>response);
    await started;
    assert.equal((await app.inject({method:'GET',url:path})).statusCode,429);
    release();
    assert.deepEqual((await Promise.all([first,second])).map((r)=>r.statusCode),[200,200]);
    ctx.storage.get=async()=>{throw new Error('https://storage.example/private?signature=secret');};
    const failure=await app.inject({method:'GET',url:path});
    assert.equal(failure.statusCode,503);
    assert.deepEqual(failure.json(),{code:'UPSTREAM_UNAVAILABLE',retryable:true});
    ctx.storage.get=originalGet;
    assert.equal((await app.inject({method:'GET',url:path})).statusCode,200);
  } finally {release();await app.close();await ctx.close();}
});

test('stable CRM media links require an explicit HTTPS origin',()=>{
  const scope={secret:'test',companyId:'c',accountId:'a',attachmentId:`att_${'a'.repeat(32)}`};
  for(const baseUrl of [undefined,'','http://files.example','https://user:password@files.example',
    'https://files.example/subpath','https://files.example/?query=1','https://files.example/#fragment']) {
    assert.throws(()=>crmMediaUrl({...scope,baseUrl}),/crm_media_base_url_/);
  }
  const link=crmMediaUrl({...scope,baseUrl:'https://files.example'});
  assert.notEqual(link,crmMediaUrl({...scope,secret:'rotated',baseUrl:'https://files.example'}));
});

test('inbox replay and transient download failure recover to one native Chats attachment',async()=>{
  const ctx=await fixture({fileName:'Квитанция.txt'});
  const workerUrl=new URL(TEST_DATABASE_URL);
  workerUrl.searchParams.set('options',`-c search_path=${ctx.schema}`);
  const workerDb=createPool(workerUrl.toString(),{max:2,connectionTimeoutMillis:5000});
  const logs:string[]=[];
  const app=await buildApp({db:ctx.db,config:testConfig({sessionSecret:'synthetic-secret'}),
    media:{schema:ctx.schema,storage:ctx.storage},operator:{schema:ctx.schema},logSink:(line)=>logs.push(line)});
  try {
    const replay=await recordTelegramUpdate(ctx.db,{companyId:'c1',connectionId:'conn1',bindingEpoch:0},
      {update_id:2,message:{message_id:55,chat:{id:12345,type:'private'},document:{file_id:'file-1'}}});
    assert.ok(replay);
    await drainTelegramInbox(ctx.db,{schema:ctx.schema});
    assert.equal((await ctx.db.query('SELECT count(*)::int AS n FROM messages')).rows[0].n,1);
    assert.equal((await ctx.db.query("SELECT count(*)::int AS n FROM outbox_jobs WHERE job_kind='amocrm.projection'")).rows[0].n,1);
    let requests=0;
    const handlers=createTelegramMediaHandlers({db:ctx.db,schema:ctx.schema,storage:ctx.storage,
      sessionSecret:'synthetic-secret',crmMediaBaseUrl:'https://messengers.example',resolveBotToken:()=> '123:synthetic-token',
      fetch:async()=>{
        requests++;
        if(requests===1) throw new Error('https://api.telegram.org/bot123:synthetic-token/getFile');
        return requests===2?new Response(JSON.stringify({ok:true,result:{file_id:'file-1',file_path:'documents/file.txt'}})):new Response('safe');
      }});
    let imports=0;
    const wire=createAmocrmSyncClient({accountDomain:'synthetic.amocrm.ru',getAccessToken:async()=> 'unused',
      getChatScope:async()=>({scopeId:'scope',channelSecret:'synthetic-channel-secret'}),
      fetch:async(_url,init)=>{
        imports++;
        const payload=JSON.parse(String(init?.body)).payload;
        assert.equal(payload.message.type,'file');
        assert.equal(payload.message.text,'Caption');
        assert.equal(payload.message.file_name,'Квитанция.txt');
        assert.equal(payload.message.file_size,4);
        const media=new URL(payload.message.media);
        const response=await app.inject({method:'GET',url:media.pathname+media.search});
        assert.equal(response.statusCode,200);
        assert.equal(response.body,'safe');
        return new Response(JSON.stringify({new_message:{msgid:'amo1'}}));
      }});
    const client:AmocrmSyncClient={findContacts:async()=>[],findOpenLeads:async()=>[],createContact:async()=>({id:'77'}),
      createChat:async()=>({chatId:'chat-uuid'}),linkChat:async()=>{},createLead:async()=>({id:'42'}),importMessage:wire.importMessage};
    const dispatch=createProjectionDispatcher({sync:new AmocrmSync({db:workerDb,schema:ctx.schema,client}),prepareMessage:handlers.prepareMessage});
    await assert.rejects(()=>dispatch(ctx.job),/telegram_media_unavailable/);
    assert.equal(imports,0);
    assert.equal((await ctx.db.query('SELECT count(*)::int AS n FROM attachments')).rows[0].n,0,'temporary failures do not create terminal placeholders');
    await dispatch(ctx.job);
    await dispatch(ctx.job);
    assert.equal(requests,3,'retry fetches once and then reuses archived bytes');
    assert.equal(imports,1);
    assert.equal((await ctx.db.query('SELECT count(*)::int AS n FROM attachments')).rows[0].n,1);
    assert.equal((await ctx.db.query('SELECT count(*)::int AS n FROM amocrm_message_links')).rows[0].n,1);
    assert.ok(!logs.join('\n').includes('synthetic-token'));
  } finally {await workerDb.end();await app.close();await ctx.close();}
});

test('archives before CRM import, preserves caption, reuses capability on retry and never persists signed URLs',async()=>{
  const ctx=await fixture();
  const url=new URL(TEST_DATABASE_URL);
  url.searchParams.set('options',`-c search_path=${ctx.schema}`);
  const workerDb=createPool(url.toString(),{max:2,connectionTimeoutMillis:1000});
  try {
    const calls:Parameters<AmocrmSyncClient['importMessage']>[0][]=[];
    const client:AmocrmSyncClient={findContacts:async()=>[],findOpenLeads:async()=>[],createContact:async()=>({id:'77'}),
      createChat:async()=>({chatId:'chat-uuid'}),linkChat:async()=>{},createLead:async()=>{throw new Error('must use Unsorted');},
      importMessage:async(input)=>{calls.push(input);if(calls.length===1)throw new Error('lost_response');return {messageId:'amo1'};}};
    const dispatch=createProjectionDispatcher({sync:new AmocrmSync({db:workerDb,schema:ctx.schema,client}),prepareMessage:ctx.prepare});
    await assert.rejects(()=>dispatch(ctx.job),/lost_response/);
    await dispatch(ctx.job);
    assert.equal(ctx.downloads(),2,'getFile plus download only once');
    assert.equal(calls.length,2);
    assert.equal(calls[0]!.messageId,calls[1]!.messageId);
    assert.equal(calls[0]!.attachment!.url,calls[1]!.attachment!.url);
    assert.equal(calls[1]!.text,'Caption');
    assert.equal(calls[1]!.silent,false);
    assert.equal(calls[1]!.attachment!.type,'file');
    assert.equal(calls[1]!.attachment!.sizeBytes,4);
    const rows=(await ctx.db.query("SELECT a.storage_state,m.state FROM attachments a JOIN media_assets m ON m.storage_key=a.s3_key AND m.company_id=a.company_id")).rows;
    assert.deepEqual(rows,[{storage_state:'verified',state:'ready'}]);
    assert.equal((await ctx.db.query('SELECT count(*)::int AS n FROM archive_handoff_jobs')).rows[0].n,1);
    const durable=JSON.stringify((await ctx.db.query('SELECT payload FROM outbox_jobs')).rows)+JSON.stringify((await ctx.db.query('SELECT content FROM message_versions')).rows);
    assert.ok(!durable.includes('signature=') && !durable.includes('synthetic-token') && !durable.includes('api.telegram.org'));
    await dispatch(ctx.job);
    assert.equal(calls.length,2,'message link deduplicates repeat import');
  } finally {await workerDb.end();await ctx.close();}
});

test('oversized and MIME-spoofed files leave placeholders and one review alert, never caption-only imports',async()=>{
  for(const options of [{size:21*1024*1024},{mime:'image/png',bytes:'fake'}]) {
    const ctx=await fixture(options);
    try {
      const prepare=()=>ctx.prepare({companyId:'c1',accountId:'acc_conn1',conversationId:ctx.job.conversationId,providerMessageId:'55',direction:'in',text:'Caption'});
      await assert.rejects(prepare,/crm_media_rejected/);
      await assert.rejects(prepare,/crm_media_rejected/);
      assert.equal((await ctx.db.query("SELECT count(*)::int AS n FROM attachments WHERE storage_state<>'verified'")).rows[0].n,1);
      assert.equal((await ctx.db.query('SELECT count(*)::int AS n FROM channel_alerts')).rows[0].n,1);
      if(options.size)assert.equal(ctx.downloads(),0);
    } finally {await ctx.close();}
  }
});

test('revoked import policy, mismatched account and unavailable private storage cannot download a file',async()=>{
  const ctx=await fixture();
  try {
    const input={companyId:'c1',accountId:'acc_conn1',conversationId:ctx.job.conversationId,providerMessageId:'55',direction:'in' as const};
    await assert.rejects(()=>ctx.prepare({...input,accountId:'other'}),/crm_media_message_missing/);
    const disabled=createTelegramMediaProjection({db:ctx.db,schema:ctx.schema,storage:null,sessionSecret:'test',resolveBotToken:()=>{throw new Error('must not resolve');}});
    await assert.rejects(()=>disabled(input),/crm_media_storage_unavailable/);
    await ctx.db.query('UPDATE channel_policies SET crm_projection_enabled=false');
    assert.equal((await ctx.prepare(input)).attachment,undefined);
    assert.equal(ctx.downloads(),0);
  } finally {await ctx.close();}
});

test('a separate durable job archives originals with CRM disabled, without minting a public grant or calling CRM',async()=>{
  const ctx=await fixture({project:false});
  try {
    await ctx.db.query("UPDATE crm_accounts SET state='disabled'");
    assert.equal(ctx.job,undefined);
    const jobs=(await ctx.db.query('SELECT job_kind,payload FROM outbox_jobs')).rows;
    assert.equal(jobs.length,1);
    assert.equal(jobs[0].job_kind,TELEGRAM_MEDIA_JOB_KIND);
    const queue=new OutboundQueue({db:ctx.db,schema:ctx.schema,jobKinds:[TELEGRAM_MEDIA_JOB_KIND],dispatch:ctx.archive});
    assert.equal((await queue.runOnce()).completed,1);
    assert.equal((await queue.runOnce()).attempted,0);
    await ctx.archive(jobs[0].payload);
    assert.equal(ctx.downloads(),2,'a replay reuses the private original');
    assert.equal(ctx.storage.issuedGrantCount,0,'archiving does not expose a download URL');
    assert.equal((await ctx.db.query("SELECT count(*)::int AS n FROM attachments WHERE storage_state='verified'")).rows[0].n,1);
    assert.equal((await ctx.db.query('SELECT count(*)::int AS n FROM crm_create_intents')).rows[0].n,0);
  } finally {await ctx.close();}
});
