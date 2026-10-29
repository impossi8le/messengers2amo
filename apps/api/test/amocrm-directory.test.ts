import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { seedCompany,seedConnection } from './helpers/seed.ts';
import { CrmDirectory } from '../src/integrations/amocrm/directory.ts';
import type { CrmDirectorySnapshot } from '../src/integrations/amocrm/directory-client.ts';
import { authorizeCrmChannelSend } from '../src/integrations/amocrm/directory-access.ts';
import { buildTestApp,cookieFromResponse } from './helpers/app.ts';
import { createTokenCipher } from '../src/integrations/amocrm/crypto.ts';
import { registerChannel } from '../src/integrations/amocrm/store.ts';
import { signedWebhook } from './helpers/amocrm.ts';
import { drainAmocrmReplies } from '../src/integrations/amocrm/replies.ts';
import { runSendWorker } from '../src/telegram/send.ts';

function snapshot():CrmDirectorySnapshot {
  return {roles:[{id:'10',name:'CRM sales'}],users:['1','2','3'].map((id)=>({
    id,name:id==='3'?'Synthetic quality':'Same synthetic name',isActive:true,isAdmin:id==='2',
    roleId:'10',roleName:'CRM sales',groupId:null,groupName:null,amojoId:`amojo-${id}`,
  }))};
}
async function fixture() {
  const ctx=await createTestDb();const {db,schema}=ctx;
  await seedCompany(db,{companyId:'c1',workshops:['w1'],staff:[{id:'admin',role:'admin',password:'test-password'},
    {id:'reader',role:'read',password:'test-password'}]});
  await seedCompany(db,{companyId:'c2',staff:[]});
  await seedConnection(db,{companyId:'c1',id:'conn1',state:'active',workshopId:'w1',ownerId:'admin'});
  await db.query("UPDATE connections SET send_enabled=true,ingress_enabled=true");
  await db.query("UPDATE crm_accounts SET state='active'");
  await db.query("INSERT INTO crm_accounts(company_id,id,state) VALUES ('c2','foreign','active')");
  await db.query("INSERT INTO channel_policies(company_id,connection_id,crm_projection_enabled,private_import_enabled,group_default) VALUES ('c1','conn1',true,true,'deny')");
  await db.query("INSERT INTO conversations(company_id,id,connection_id,binding_epoch,external_chat_id,chat_kind) VALUES ('c1','conv1','conn1',0,'12345','private')");
  await db.query("INSERT INTO work_items(company_id,id,conversation_id,state) VALUES ('c1','wi1','conv1','queued')");
  await db.query("INSERT INTO crm_bindings(company_id,id,account_id,conversation_id,state,contact_id,chat_id) VALUES ('c1','bind1','acc_conn1','conv1','bound','77','chat1')");
  let next=snapshot();let failure=false;
  const client={load:async()=>{if(failure)throw new Error('synthetic-provider-failure');return structuredClone(next);}};
  const directory=new CrmDirectory({db,schema,client});
  const refresh=()=>directory.refresh({companyId:'c1',accountId:'acc_conn1',actorId:'admin'});
  const save=(grants:Array<{crmUserId:string;role:'manager'|'supervisor'|'quality'}>)=>directory.readAccess('c1','conn1').then((access)=>directory.saveAccess({
    companyId:'c1',connectionId:'conn1',accountId:'acc_conn1',actorId:'admin',expectedVersion:access.version,grants,
  }));
  const allow=(id:string)=>authorizeCrmChannelSend(db,schema,{companyId:'c1',connectionId:'conn1',conversationId:'conv1',senderId:`amojo-${id}`,
    resolveOwner:async()=> (await db.query("SELECT crm_owner_ref FROM crm_contact_owners WHERE company_id='c1' AND conversation_id='conv1'")).rows[0]?.crm_owner_ref??null});
  return {...ctx,client,directory,refresh,save,allow,setSnapshot:(value:CrmDirectorySnapshot)=>{next=value;},fail:()=>{failure=true;}};
}

test('directory import preserves distinct CRM identities and never creates local passwords or admin grants',async()=>{
  const c=await fixture();try{
    const first=await c.refresh();assert.equal(first.users.length,3);assert.equal(first.roles.length,1);
    const ids=first.users.map((u)=>u.staffId);assert.equal(new Set(ids).size,3);
    await c.refresh();assert.deepEqual((await c.directory.read('c1','acc_conn1')).users.map((u)=>u.staffId),ids);
    assert.equal((await c.db.query("SELECT count(*)::int AS n FROM staff_access WHERE staff_id LIKE 'crm_%'")).rows[0].n,0);
    assert.equal((await c.db.query("SELECT count(*)::int AS n FROM staff_credentials WHERE staff_id LIKE 'crm_%'")).rows[0].n,0);
    assert.equal((await c.db.query('SELECT count(*)::int AS n FROM staff_crm_refs')).rows[0].n,3);
    const serialized=JSON.stringify(first);assert.ok(!serialized.includes('amojo-1')&&!serialized.includes('credential'));
    await assert.rejects(()=>c.directory.read('c1','foreign'),/NOT_FOUND/);
  }finally{await c.close();}
});

test('failed refresh preserves the complete old directory; a full later snapshot deactivates missing users and grants',async()=>{
  const c=await fixture();try{
    await c.refresh();await c.save([{crmUserId:'2',role:'supervisor'}]);
    const reduced=snapshot();reduced.users=reduced.users.filter((u)=>u.id!=='2');c.setSnapshot(reduced);await c.refresh();
    assert.equal((await c.allow('2')).allowed,false);
    assert.equal((await c.db.query("SELECT can_send FROM channel_permissions p JOIN crm_directory_users u ON u.company_id=p.company_id AND u.staff_id=p.staff_id WHERE u.crm_user_ref='2'")).rows[0].can_send,false);
    const before=await c.directory.read('c1','acc_conn1');c.fail();await assert.rejects(c.refresh,/synthetic-provider-failure/);
    const after=await c.directory.read('c1','acc_conn1');assert.deepEqual(after.users,before.users);assert.equal(after.version,before.version);
    assert.equal(after.errorCode,'directory_refresh_failed');
  }finally{await c.close();}
});

test('channel roles deny unknown identities and quality sends; manager needs the CRM owner, supervisor can reply across owners',async()=>{
  const c=await fixture();try{
    await c.refresh();await c.save([{crmUserId:'1',role:'manager'},{crmUserId:'2',role:'supervisor'},{crmUserId:'3',role:'quality'}]);
    assert.equal((await c.allow('unknown')).allowed,false);assert.equal((await c.allow('1')).allowed,false);
    assert.equal((await c.allow('2')).allowed,true);assert.equal((await c.allow('3')).allowed,false);
    await c.db.query("INSERT INTO crm_contact_owners(company_id,conversation_id,crm_owner_ref,version,observed_at) VALUES ('c1','conv1','1',1,now())");
    assert.equal((await c.allow('1')).allowed,true);
    await c.db.query("UPDATE crm_contact_owners SET crm_owner_ref='2'");assert.equal((await c.allow('1')).allowed,false);
    await assert.rejects(()=>c.directory.saveAccess({companyId:'c1',connectionId:'conn1',accountId:'acc_conn1',actorId:'admin',expectedVersion:0,grants:[]}),/VERSION_CONFLICT/);
    await c.save([]);assert.equal((await c.allow('2')).allowed,false);
  }finally{await c.close();}
});

test('native reply uses imported actor and a revocation after acceptance stops the provider call',async()=>{
  const c=await fixture();const cipher=createTokenCipher('synthetic-directory-secret');
  const app=await buildTestApp({db:c.db,schema:c.schema,amocrm:{cipher,directoryClient:c.client}});
  try{
    await c.refresh();await c.save([{crmUserId:'2',role:'supervisor'},{crmUserId:'3',role:'quality'}]);
    await registerChannel(c.db,c.schema,{companyId:'c1',accountId:'acc_conn1',scopeId:'scope1',channelCode:'test',secretEnc:cipher.encrypt('channel-secret'),connectionId:'conn1',bindingEpoch:0,amojoAccountId:'crm1'});
    const webhook=async(id:string,sender:string)=>{
      const body=JSON.stringify({account_id:'crm1',time:1793020000,message:{conversation:{id:'chat1',client_id:'conv1'},sender:{id:sender},message:{id,type:'text',text:'Synthetic reply'}}});
      return app.inject({method:'POST',url:'/webhooks/amocrm/scope1',headers:{'content-type':'application/json','x-signature':signedWebhook('channel-secret',body)},payload:body});
    };
    assert.equal((await webhook('quality-reply','amojo-3')).statusCode,200);
    assert.equal((await drainAmocrmReplies(c.db,{schema:c.schema,outboundEnabled:true})).review,1);
    assert.equal((await webhook('allowed-reply','amojo-2')).statusCode,200);
    assert.equal((await drainAmocrmReplies(c.db,{schema:c.schema,outboundEnabled:true})).queued,1);
    const actor=(await c.db.query('SELECT actor_id FROM send_operations')).rows[0].actor_id;
    assert.equal(actor,(await c.directory.read('c1','acc_conn1')).users.find((u)=>u.id==='2')!.staffId);
    await c.save([]);let calls=0;
    const result=await runSendWorker(c.db,{companyId:'c1',connectionId:'conn1',owner:'test-worker',leaseMs:60000,schema:c.schema,transport:{sendMessage:async()=>{calls++;return {outcome:'sent',providerMessageId:'must-not-send'};}}});
    assert.equal(calls,0);assert.equal(result.failed,1);
    assert.equal((await c.db.query('SELECT state FROM send_operations')).rows[0].state,'failed');
  }finally{await app.close();await c.close();}
});

test('only company admins can refresh employees or edit roles; foreign accounts are inaccessible',async()=>{
  const c=await fixture();const app=await buildTestApp({db:c.db,schema:c.schema,amocrm:{cipher:createTokenCipher('synthetic-directory-route-key'),directoryClient:c.client}});
  try{
    const login=async(staffId:string)=>cookieFromResponse(await app.inject({method:'POST',url:'/api/v2/auth/login',payload:{companyId:'c1',staffId,password:'test-password'}}));
    const body={accountId:'acc_conn1'};
    assert.equal((await app.inject({method:'POST',url:'/api/v2/operator/amocrm/directory/refresh',payload:body})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/api/v2/operator/amocrm/directory/refresh',headers:{cookie:await login('reader')},payload:body})).statusCode,403);
    const cookie=await login('admin');
    assert.equal((await app.inject({method:'GET',url:'/api/v2/operator/amocrm/directory?accountId=foreign',headers:{cookie}})).statusCode,404);
    assert.equal((await app.inject({method:'POST',url:'/api/v2/operator/amocrm/directory/refresh',headers:{cookie},payload:body})).statusCode,200);
  }finally{await app.close();await c.close();}
});

test('temporary CRM owner failure preserves the native event for retry without queuing a send',async()=>{
  const c=await fixture();const cipher=createTokenCipher('synthetic-directory-retry');
  const app=await buildTestApp({db:c.db,schema:c.schema,amocrm:{cipher,directoryClient:c.client}});
  try{
    await c.refresh();await c.save([{crmUserId:'1',role:'manager'}]);
    await registerChannel(c.db,c.schema,{companyId:'c1',accountId:'acc_conn1',scopeId:'scope1',channelCode:'test',secretEnc:cipher.encrypt('channel-secret'),connectionId:'conn1',bindingEpoch:0,amojoAccountId:'crm1'});
    const body=JSON.stringify({account_id:'crm1',time:1793020000,message:{conversation:{id:'chat1',client_id:'conv1'},sender:{id:'amojo-1'},message:{id:'retry-reply',type:'text',text:'Synthetic retry'}}});
    assert.equal((await app.inject({method:'POST',url:'/webhooks/amocrm/scope1',headers:{'content-type':'application/json','x-signature':signedWebhook('channel-secret',body)},payload:body})).statusCode,200);
    await assert.rejects(()=>drainAmocrmReplies(c.db,{schema:c.schema,outboundEnabled:true,resolveOwner:async()=>{throw new Error('temporary upstream details');}}),/crm_owner_unavailable/);
    assert.equal((await c.db.query("SELECT state FROM inbox_events WHERE kind='chats.message'")).rows[0].state,'pending');
    assert.equal((await c.db.query('SELECT count(*)::int AS n FROM send_operations')).rows[0].n,0);
    assert.equal((await drainAmocrmReplies(c.db,{schema:c.schema,outboundEnabled:true,resolveOwner:async()=>'1'})).queued,1);
    assert.equal((await c.db.query('SELECT count(*)::int AS n FROM send_operations')).rows[0].n,1);
    let providerCalls=0;
    const worker={companyId:'c1',connectionId:'conn1',owner:'retry-worker',leaseMs:60000,schema:c.schema,
      transport:{sendMessage:async()=>{providerCalls++;return {outcome:'sent' as const,providerMessageId:'retry-sent'};}}};
    await assert.rejects(()=>runSendWorker(c.db,{...worker,resolveCrmOwner:async()=>{throw new Error('temporary upstream details');}}),/crm_owner_unavailable/);
    assert.equal(providerCalls,0);
    assert.equal((await c.db.query('SELECT count(*)::int AS n FROM send_attempts')).rows[0].n,0);
    await c.db.query("UPDATE outbox_jobs SET lease_until=now()-interval '1 second' WHERE state='leased'");
    assert.equal((await runSendWorker(c.db,{...worker,resolveCrmOwner:async()=>'1'})).sent,1);
    assert.equal(providerCalls,1);
  }finally{await app.close();await c.close();}
});

test('a slower old refresh cannot overwrite a newer completed snapshot',async()=>{
  const c=await fixture();try{
    let release!:(value:CrmDirectorySnapshot)=>void;let started!:()=>void;
    const ready=new Promise<void>((resolve)=>{started=resolve;});let calls=0;
    const fresh=snapshot();fresh.users[0]!.name='New snapshot';
    const directory=new CrmDirectory({db:c.db,schema:c.schema,client:{load:async()=>{calls++;if(calls===1){started();return new Promise((resolve)=>{release=resolve;});}return fresh;}}});
    const input={companyId:'c1',accountId:'acc_conn1',actorId:'admin'};
    const first=directory.refresh(input);await ready;await directory.refresh(input);release(snapshot());
    await assert.rejects(()=>first,/VERSION_CONFLICT/);
    assert.equal((await directory.read('c1','acc_conn1')).users.find((u)=>u.id==='1')!.name,'New snapshot');
  }finally{await c.close();}
});
