import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {runMigrations} from '../src/migrate.mjs';
import {domainMigrations} from '../src/domain-migrations.mjs';

// Deliberately opt-in: this suite must never target a developer/production database.
if(process.env.DB_TEST_ALLOW!=='1')throw Error('DB_TEST_OPT_IN_REQUIRED');
let target;try{target=new URL(process.env.DB_TEST_URL);}catch{throw Error('DB_TEST_TARGET_INVALID');}
if(!['postgres:','postgresql:'].includes(target.protocol)||!['127.0.0.1','localhost','[::1]'].includes(target.hostname)||target.pathname!=='/wazzup_test'||target.username!=='wazzup_test'||target.search||target.hash)throw Error('DB_TEST_TARGET_INVALID');
const pool=new pg.Pool({connectionString:target.href,max:4,connectionTimeoutMillis:5000,query_timeout:10000,statement_timeout:10000});
const identity=await pool.query("SELECT current_database() AS db,current_user AS role,current_setting('server_version_num')::integer AS version");
assert.equal(identity.rows[0].db,'wazzup_test');assert.equal(identity.rows[0].role,'wazzup_test');
assert.ok(identity.rows[0].version>=180000&&identity.rows[0].version<190000);
test.after(async()=>pool.end());

async function area(action){
 const schema='receipt_probe_'+randomBytes(8).toString('hex');
 assert.match(schema,/^receipt_probe_[a-f0-9]{16}$/);
 await pool.query('CREATE SCHEMA "'+schema+'"');
 try{await runMigrations({pool,schema,migrations:await domainMigrations(schema)});await action(schema);}
 finally{await pool.query('DROP SCHEMA "'+schema+'" CASCADE');}
}
async function seed(q){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query(`INSERT INTO ${q}companies(id) VALUES ('a'),('b');
INSERT INTO ${q}staff(company_id,id) VALUES ('a','actor');
INSERT INTO ${q}connections(company_id,id,channel_mode,binding_epoch,credentials_version,state,version,capabilities) VALUES ('a','conn','telegram_bot',1,1,'active',1,'{}'),('a','other','telegram_bot',1,1,'active',1,'{}'),('b','conn','telegram_bot',1,1,'active',1,'{}');
INSERT INTO ${q}connection_identities(company_id,connection_id,binding_epoch) VALUES ('a','conn',1),('a','conn',2),('a','other',1),('b','conn',1);`);
  for(const [company,conversation,connection,epoch] of [['a','chat','conn',1],['a','chat-other','other',1],['a','chat-epoch','conn',2],['a','chat-ambiguous','conn',1],['b','chat','conn',1]]){
   await client.query(`INSERT INTO ${q}conversations(company_id,id,connection_id,binding_epoch,external_chat_id) VALUES ($1,$2,$3,$4,$5)`,[company,conversation,connection,epoch,conversation==='chat-ambiguous'?'external-other':'external-chat']);
   await client.query(`INSERT INTO ${q}messages(company_id,id,conversation_id,direction,provider_message_id,current_content_version) VALUES ($1,$2,$3,'out','provider-reply',1)`,[company,'reply-'+conversation,conversation]);
   await client.query(`INSERT INTO ${q}message_versions(company_id,message_id,content_version,content) VALUES ($1,$2,1,'{}')`,[company,'reply-'+conversation]);
  }
  await client.query(`INSERT INTO ${q}messages(company_id,id,conversation_id,direction,provider_message_id,current_content_version) VALUES ('a','question','chat','in','provider-question',1);
INSERT INTO ${q}message_versions(company_id,message_id,content_version,content) VALUES ('a','question',1,'{}');
INSERT INTO ${q}work_items(company_id,id,conversation_id,state,assignment_version) VALUES ('a','work','chat','queued',0);
INSERT INTO ${q}attention_obligations(company_id,id,work_item_id,conversation_id,message_id,content_version,attention_seq) VALUES ('a','attention','work','chat','question',1,1);
INSERT INTO ${q}send_operations(company_id,id,work_item_id,conversation_id,connection_id,binding_epoch,actor_id,command_type,idempotency_key,payload_fingerprint,state,coverage,content,deadline,provider_message_id) VALUES ('a','operation','work','chat','conn',1,'actor','reply','synthetic-key',repeat('a',64),'unknown','unconfirmed','{}','2099-01-01T00:00:00Z','provider-reply');
INSERT INTO ${q}send_operations(company_id,id,work_item_id,conversation_id,connection_id,binding_epoch,actor_id,command_type,idempotency_key,payload_fingerprint,state,coverage,content,deadline,provider_message_id) VALUES ('a','other-operation','work','chat','conn',1,'actor','reply','other-synthetic-key',repeat('b',64),'unknown','unconfirmed','{}','2099-01-01T00:00:00Z','provider-reply');
INSERT INTO ${q}send_attempts(company_id,id,operation_id,attempt_no,dispatch_fence,state,provider_message_id) VALUES ('a','attempt','operation',1,1,'unknown','provider-reply'),('a','other-attempt','other-operation',1,1,'unknown','provider-reply');`);
  await client.query(`INSERT INTO ${q}send_operations(company_id,id,work_item_id,conversation_id,connection_id,binding_epoch,actor_id,command_type,idempotency_key,payload_fingerprint,state,coverage,content,deadline,provider_message_id) SELECT company_id,'op-null-provider',work_item_id,conversation_id,connection_id,binding_epoch,actor_id,command_type,'null-provider-key',payload_fingerprint,state,coverage,content,deadline,NULL FROM ${q}send_operations WHERE id='operation';
INSERT INTO ${q}send_attempts(company_id,id,operation_id,attempt_no,dispatch_fence,state,provider_message_id) VALUES ('a','attempt-op-null-provider','op-null-provider',1,1,'unknown','provider-reply'),('a','attempt-null-provider','operation',2,2,'unknown',NULL);`);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

test('003 preserves immutable provider receipts and proven scoped links',async(t)=>area(async schema=>{
 // Genuine first RED: catalog assertion, before fixture SQL touches missing relations.
 const names=(await pool.query('SELECT tablename FROM pg_tables WHERE schemaname=$1',[schema])).rows.map(r=>r.tablename);
 assert.deepEqual(['provider_receipt_evidence','provider_receipt_links'].filter(name=>!names.includes(name)),[], '003 must provide receipt evidence and reconciliation links');
 const q='"'+schema+'".';await seed(q);
 const reject=(promise,codes=['23514','23503'])=>assert.rejects(promise,error=>codes.includes(error.code));
 const receipt=async(id,{company='a',connection='conn',epoch=1,chat='external-chat',provider='provider-reply',kind='message.delivery_observed',status='delivered',key=id,observed='2026-10-20T10:01:00Z',occurred='2026-10-20T09:59:00Z',received='2026-10-20T10:05:00Z',eventKey='provider-event'}={})=>pool.query(`INSERT INTO ${q}provider_receipt_evidence(company_id,id,connection_id,binding_epoch,external_chat_id,provider_message_id,kind,status,evidence_key,provider_event_key,occurred_at,received_at,observed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[company,id,connection,epoch,chat,provider,kind,status,key,eventKey,occurred,received,observed]);
 const link=(evidence,{company='a',conversation='chat',message='reply-chat',operation=null,attempt=null}={})=>pool.query(`INSERT INTO ${q}provider_receipt_links(company_id,evidence_id,conversation_id,message_id,operation_id,attempt_id) VALUES ($1,$2,$3,$4,$5,$6)`,[company,evidence,conversation,message,operation,attempt]);

 await t.test('early unmatched receipt is retained without fabricated internal IDs',async()=>{
  await receipt('early',{provider:'not-known-yet'});
  assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${q}provider_receipt_evidence WHERE id='early'`)).rows[0].n,1);
  assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${q}provider_receipt_links`)).rows[0].n,0);
  await reject(link('early'));
  const c=await pool.connect();try{await c.query('BEGIN');await c.query(`INSERT INTO ${q}messages(company_id,id,conversation_id,direction,provider_message_id,current_content_version) VALUES ('a','late-reply','chat','out','not-known-yet',1)`);await c.query(`INSERT INTO ${q}message_versions(company_id,message_id,content_version,content) VALUES ('a','late-reply',1,'{}')`);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  await link('early',{message:'late-reply'});
  const times=(await pool.query(`SELECT occurred_at,observed_at,received_at FROM ${q}provider_receipt_evidence WHERE id='early'`)).rows[0];
  assert.deepEqual(Object.fromEntries(Object.entries(times).map(([key,value])=>[key,value.toISOString()])),{occurred_at:'2026-10-20T09:59:00.000Z',observed_at:'2026-10-20T10:01:00.000Z',received_at:'2026-10-20T10:05:00.000Z'});
  assert.equal((await pool.query(`SELECT provider_message_id FROM ${q}provider_receipt_evidence WHERE id='early'`)).rows[0].provider_message_id,'not-known-yet');
 });
 await t.test('dedup scope includes company connection epoch and event kind',async()=>{
  await receipt('scope',{key:'same-key'});
  await reject(receipt('duplicate',{key:'same-key'}),['23505']);
  await receipt('read-same-key',{key:'same-key',kind:'message.read_observed',status:'read'});
  await receipt('other-company',{company:'b',key:'same-key'});
  await receipt('other-connection',{connection:'other',key:'same-key'});
  await receipt('other-epoch',{epoch:2,key:'same-key'});
  await receipt('another-evidence-same-provider-event',{key:'other-key'});
 });
 await t.test('read delivered and failed facts survive out of order independently',async()=>{
  await receipt('read-first',{kind:'message.read_observed',status:'read',observed:'2026-10-20T10:03:00Z'});
  await receipt('delivered-late',{observed:'2026-10-20T10:01:00Z'});
  await receipt('failed-late',{status:'failed',observed:'2026-10-20T10:02:00Z'});
  const facts=(await pool.query(`SELECT status FROM ${q}provider_receipt_evidence WHERE id=ANY($1) ORDER BY observed_at`,[['read-first','delivered-late','failed-late']])).rows.map(r=>r.status);
  assert.deepEqual(facts,['delivered','failed','read']);
  await reject(receipt('bad-kind-status',{kind:'message.read_observed',status:'failed'}),['23514']);
 });
 await t.test('proven links reject wrong company connection epoch chat and provider message',async()=>{
  await reject(link('scope',{company:'b'}));
  await reject(link('scope',{conversation:'chat-other',message:'reply-chat-other'}));
  await reject(link('scope',{conversation:'chat-epoch',message:'reply-chat-epoch'}));
  await reject(link('scope',{message:'question'}));
  await reject(link('scope',{conversation:'chat-ambiguous',message:'reply-chat-ambiguous'}));
  await receipt('wrong-chat',{chat:'another-external-chat'});await reject(link('wrong-chat'));
  await receipt('no-chat',{chat:null});await reject(link('no-chat'));
  await reject(link('no-chat',{conversation:'chat-ambiguous',message:'reply-chat-ambiguous'}));
  assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${q}provider_receipt_links WHERE evidence_id='no-chat'`)).rows[0].n,0);
  await link('scope');
  await reject(link('scope'),['23505']);
 });
 await t.test('operation and attempt are nullable but a named operation requires its exact attempt',async()=>{
  await receipt('with-operation');
  await reject(link('with-operation',{operation:'operation'}),['23514']);
  await reject(link('with-operation',{operation:'operation',attempt:'absent-attempt'}));
  await reject(link('with-operation',{operation:'operation',attempt:'other-attempt'}));
  await reject(link('other-connection',{conversation:'chat-other',message:'reply-chat-other',operation:'operation',attempt:'attempt'}));
  await reject(link('with-operation',{operation:'op-null-provider',attempt:'attempt-op-null-provider'}));
  await reject(link('with-operation',{operation:'operation',attempt:'attempt-null-provider'}));
  await reject(link('with-operation',{attempt:'attempt-null-provider'}));
  await link('with-operation',{operation:'operation',attempt:'attempt'});
  await receipt('attempt-only');await link('attempt-only',{attempt:'attempt'});
  await receipt('wrong-provider-operation',{provider:'not-known-yet'});
  await reject(link('wrong-provider-operation',{message:'late-reply',operation:'operation',attempt:'attempt'}));
 });

 await t.test('wire identifiers enforce nonempty max128 at evidence and normalized link boundaries',async()=>{
  for(const value of ['', 'x'.repeat(129)]){
   await reject(receipt('bad-provider-'+value.length,{provider:value}),['23514']);
   await reject(receipt('bad-key-'+value.length,{key:value}),['23514']);
  }
  await receipt('max-provider',{provider:'p'.repeat(128),key:'k'.repeat(128)});
  // Parent entities intentionally permit longer IDs. Build valid FK targets so
  // an absent link CHECK cannot hide behind a missing-parent FK rejection.
  const boundary=async(label,fields)=>{
   const conversation=fields.conversation||'conversation-'+label;
   const message=fields.message||'message-'+label;
   const operation=fields.operation||'operation-'+label;
   const attempt=fields.attempt||'attempt-'+label;
   const client=await pool.connect();
   try{
    await client.query('BEGIN');
    await client.query('INSERT INTO '+q+'conversations(company_id,id,connection_id,binding_epoch,external_chat_id) VALUES ($1,$2,$3,1,$4)',['a',conversation,'conn',label]);
    await client.query('INSERT INTO '+q+'messages(company_id,id,conversation_id,direction,provider_message_id,current_content_version) VALUES ($1,$2,$3,$4,$5,1)',['a',message,conversation,'out','provider-'+label]);
    await client.query('INSERT INTO '+q+'message_versions(company_id,message_id,content_version,content) VALUES ($1,$2,1,$3)',['a',message,'{}']);
    await client.query('INSERT INTO '+q+'work_items(company_id,id,conversation_id,state,assignment_version) VALUES ($1,$2,$3,$4,0)',['a','work-'+label,conversation,'queued']);
    await client.query('INSERT INTO '+q+'send_operations(company_id,id,work_item_id,conversation_id,connection_id,binding_epoch,actor_id,command_type,idempotency_key,payload_fingerprint,state,coverage,content,deadline,provider_message_id) VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,$12,$13,$14)',['a',operation,'work-'+label,conversation,'conn','actor','reply','key-'+label,'a'.repeat(64),'unknown','unconfirmed','{}','2099-01-01T00:00:00Z','provider-'+label]);
    await client.query('INSERT INTO '+q+'send_attempts(company_id,id,operation_id,attempt_no,dispatch_fence,state,provider_message_id) VALUES ($1,$2,$3,1,1,$4,$5)',['a',attempt,operation,'unknown','provider-'+label]);
    await client.query('COMMIT');
   }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
   await receipt(label,{chat:label,provider:'provider-'+label});
   return {conversation,message,operation,attempt};
  };
  await link('max-identifiers',await boundary('max-identifiers',{conversation:'c'.repeat(128),message:'m'.repeat(128),operation:'o'.repeat(128),attempt:'t'.repeat(128)}));
  for(const [field,char] of [['conversation','c'],['message','m'],['operation','o'],['attempt','t']]){
   const label='long-'+field;
   await reject(link(label,await boundary(label,{[field]:char.repeat(129)})),['23514']);
   await receipt('empty-'+field);
   await reject(link('empty-'+field,{[field]:''}),['23514']);
  }
 });
 await t.test('history and reconciliation links cannot be updated or deleted',async()=>{
  await reject(pool.query(`UPDATE ${q}provider_receipt_evidence SET status='failed' WHERE company_id='a' AND id='scope'`),['23514']);
  await reject(pool.query(`DELETE FROM ${q}provider_receipt_evidence WHERE company_id='a' AND id='scope'`),['23514']);
  await reject(pool.query(`UPDATE ${q}provider_receipt_links SET operation_id='operation',attempt_id='attempt' WHERE company_id='a' AND evidence_id='scope'`),['23514']);
  await reject(pool.query(`DELETE FROM ${q}provider_receipt_links WHERE company_id='a' AND evidence_id='scope'`),['23514']);
 });

 // Separate proof-stability regression: INSERT-time checks alone do not keep
 // historical proof true when an operation/attempt can subsequently drift.
 const proofRows=async()=>({
  operations:(await pool.query('SELECT company_id,id,provider_message_id FROM '+q+"send_operations WHERE company_id='a' AND id IN ('operation','other-operation') ORDER BY id")).rows,
  attempts:(await pool.query('SELECT company_id,id,operation_id,provider_message_id FROM '+q+"send_attempts WHERE company_id='a' AND id='attempt'")).rows,
  links:(await pool.query('SELECT company_id,evidence_id,conversation_id,message_id,operation_id,attempt_id FROM '+q+"provider_receipt_links WHERE company_id='a' AND evidence_id='with-operation'")).rows
 });
 for(const [name,sql,businessError] of [
  ['known operation provider ID cannot be rewritten',"UPDATE "+q+"send_operations SET provider_message_id='different-provider' WHERE company_id='a' AND id='operation'",'immutable_provider_message_id'],
  ['known operation provider ID cannot be cleared',"UPDATE "+q+"send_operations SET provider_message_id=NULL WHERE company_id='a' AND id='operation'",'immutable_provider_message_id'],
  ['known attempt provider ID cannot be rewritten',"UPDATE "+q+"send_attempts SET provider_message_id='different-provider' WHERE company_id='a' AND id='attempt'",'immutable_provider_message_id'],
  ['known attempt provider ID cannot be cleared',"UPDATE "+q+"send_attempts SET provider_message_id=NULL WHERE company_id='a' AND id='attempt'",'immutable_provider_message_id'],
  ['attempt cannot move to an existing alternative operation',"UPDATE "+q+"send_attempts SET operation_id='other-operation',attempt_no=99 WHERE company_id='a' AND id='attempt'",'immutable_identity']
 ]){
  await t.test(name,async()=>{
   const before=await proofRows();
   assert.equal(before.links.length,1,'fixture must already contain proven operation/attempt link');
   const client=await pool.connect();
   try{await client.query('BEGIN');await assert.rejects(client.query(sql),error=>error.code==='23514'&&error.message===businessError);}
   finally{await client.query('ROLLBACK');client.release();}
   assert.deepEqual(await proofRows(),before,'failed mutation must preserve proof and parent rows');
  });
 }
 await t.test('same-value identity retries remain legal without changing proof',async()=>{
  const before=await proofRows();
  assert.equal((await pool.query("UPDATE "+q+"send_operations SET provider_message_id='provider-reply' WHERE company_id='a' AND id='operation'")).rowCount,1);
  assert.equal((await pool.query("UPDATE "+q+"send_attempts SET provider_message_id='provider-reply',operation_id='operation' WHERE company_id='a' AND id='attempt'")).rowCount,1);
  assert.deepEqual(await proofRows(),before);
 });
 await t.test('NULL provider IDs may become known before a proven link',async()=>{
  assert.equal((await pool.query("SELECT provider_message_id FROM "+q+"send_operations WHERE company_id='a' AND id='op-null-provider'")).rows[0].provider_message_id,null);
  assert.equal((await pool.query("SELECT provider_message_id FROM "+q+"send_attempts WHERE company_id='a' AND id='attempt-null-provider'")).rows[0].provider_message_id,null);
  assert.equal((await pool.query("UPDATE "+q+"send_operations SET provider_message_id='provider-reply' WHERE company_id='a' AND id='op-null-provider'")).rowCount,1);
  assert.equal((await pool.query("UPDATE "+q+"send_attempts SET provider_message_id='provider-reply' WHERE company_id='a' AND id='attempt-null-provider'")).rowCount,1);
  await receipt('late-known-operation');await link('late-known-operation',{operation:'op-null-provider',attempt:'attempt-op-null-provider'});
  await receipt('late-known-attempt');await link('late-known-attempt',{operation:'operation',attempt:'attempt-null-provider'});
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM '+q+'provider_receipt_links WHERE evidence_id=ANY($1)',[['late-known-operation','late-known-attempt']])).rows[0].n,2);
 });
 await t.test('receipt storage never automatically resolves unknown send or covers obligations',async()=>{
  const operation=(await pool.query(`SELECT state,coverage FROM ${q}send_operations WHERE company_id='a' AND id='operation'`)).rows[0];
  assert.deepEqual(operation,{state:'unknown',coverage:'unconfirmed'});
  assert.equal((await pool.query(`SELECT state FROM ${q}attention_obligations WHERE company_id='a' AND id='attention'`)).rows[0].state,'open');
  assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${q}send_coverage`)).rows[0].n,0);
 });
}));
