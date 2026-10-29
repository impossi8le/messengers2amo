import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {runMigrations} from '../src/migrate.mjs';
import {domainMigrations} from '../src/domain-migrations.mjs';

// Synthetic PG18 only: never read .env or echo the connection URL.
if(process.env.DB_TEST_ALLOW!=='1')throw Error('DB_TEST_OPT_IN_REQUIRED');
let target;try{target=new URL(process.env.DB_TEST_URL);}catch{throw Error('DB_TEST_TARGET_INVALID');}
if(!['postgres:','postgresql:'].includes(target.protocol)||!['127.0.0.1','localhost','[::1]'].includes(target.hostname)||target.pathname!=='/wazzup_test'||target.username!=='wazzup_test'||target.search||target.hash)throw Error('DB_TEST_TARGET_INVALID');
const pool=new pg.Pool({connectionString:target.href,max:4,connectionTimeoutMillis:5000,query_timeout:10000,statement_timeout:10000});
const identity=await pool.query("SELECT current_database() AS db,current_user AS role,current_setting('server_version_num')::integer AS version");
assert.equal(identity.rows[0].db,'wazzup_test');assert.equal(identity.rows[0].role,'wazzup_test');
assert.ok(identity.rows[0].version>=180000&&identity.rows[0].version<190000);
test.after(async()=>pool.end());
const CORE_SHA256='672f18654bee568f54f5720f6078baab65b3a2cd4ee3480250e7e5eba2e60558';
const digest=value=>createHash('sha256').update(Buffer.from(value).toString('utf8').replace(/\r\n/g,'\n'),'utf8').digest('hex');

// Immutability is about SQL content, not the checkout's line endings: the pin is
// the LF blob hash, while a Windows worktree may legitimately hold CRLF.
test('published 001 digest is independent of checkout line endings',async()=>{
 const raw=await readFile(new URL('../migrations/001-core.sql',import.meta.url),'utf8');
 const lf=raw.replace(/\r\n/g,'\n');
 const crlf=lf.replace(/\n/g,'\r\n');
 assert.notEqual(Buffer.byteLength(lf),Buffer.byteLength(crlf),'LF and CRLF variants must genuinely differ');
 assert.equal(digest(lf),digest(crlf),'CRLF checkout must hash like the LF blob');
 assert.equal(digest(crlf),CORE_SHA256,'normalized content must still match the published pin');
});
async function area(action){
 const schema='upgrade_probe_'+randomBytes(8).toString('hex');assert.match(schema,/^upgrade_probe_[a-f0-9]{16}$/);
 await pool.query('CREATE SCHEMA "'+schema+'"');
 try{await action(schema);}finally{await pool.query('DROP SCHEMA "'+schema+'" CASCADE');}
}
async function seed001(q){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const sql=[
   "INSERT INTO "+q+"companies(id) VALUES ('upgrade-company');",
   "INSERT INTO "+q+"staff(company_id,id) VALUES ('upgrade-company','upgrade-actor');",
   "INSERT INTO "+q+"connections(company_id,id,channel_mode,binding_epoch,credentials_version,state,version,capabilities) VALUES ('upgrade-company','upgrade-connection','telegram_bot',1,1,'active',1,'{}');",
   "INSERT INTO "+q+"connection_identities(company_id,connection_id,binding_epoch,external_identity_ref) VALUES ('upgrade-company','upgrade-connection',1,'synthetic-identity');",
   "INSERT INTO "+q+"conversations(company_id,id,connection_id,binding_epoch,external_chat_id,chat_kind) VALUES ('upgrade-company','upgrade-conversation','upgrade-connection',1,'synthetic-chat','private');",
   "INSERT INTO "+q+"messages(company_id,id,conversation_id,direction,provider_message_id,current_content_version) VALUES ('upgrade-company','upgrade-message','upgrade-conversation','in','synthetic-question',1);",
   "INSERT INTO "+q+"message_versions(company_id,message_id,content_version,content) VALUES ('upgrade-company','upgrade-message',1,'{\"kind\":\"text\",\"text\":\"synthetic upgrade question\"}');",
   "INSERT INTO "+q+"work_items(company_id,id,conversation_id,state,assignment_version) VALUES ('upgrade-company','upgrade-work','upgrade-conversation','queued',0);",
   "INSERT INTO "+q+"attention_obligations(company_id,id,work_item_id,conversation_id,message_id,content_version,attention_seq) VALUES ('upgrade-company','upgrade-obligation','upgrade-work','upgrade-conversation','upgrade-message',1,1);",
   "INSERT INTO "+q+"reply_snapshots(company_id,id,work_item_id,conversation_id,binding_epoch,assignment_version,actor_id) VALUES ('upgrade-company','upgrade-snapshot','upgrade-work','upgrade-conversation',1,0,'upgrade-actor');",
   "INSERT INTO "+q+"reply_snapshot_items(company_id,snapshot_id,work_item_id,conversation_id,obligation_id,content_version) VALUES ('upgrade-company','upgrade-snapshot','upgrade-work','upgrade-conversation','upgrade-obligation',1);",
   "INSERT INTO "+q+"send_operations(company_id,id,work_item_id,conversation_id,connection_id,binding_epoch,snapshot_id,actor_id,command_type,idempotency_key,payload_fingerprint,state,coverage,content,deadline) VALUES ('upgrade-company','upgrade-operation','upgrade-work','upgrade-conversation','upgrade-connection',1,'upgrade-snapshot','upgrade-actor','reply','synthetic-upgrade-key',repeat('a',64),'accepted','unconfirmed','{\"kind\":\"text\",\"text\":\"synthetic accepted answer\"}','2099-01-01T00:00:00Z');",
   "INSERT INTO "+q+"attachments(company_id,id,message_id,conversation_id,connection_id,binding_epoch,external_chat_id,external_message_id,s3_key,original_name,mime_type,byte_size,sha256,storage_state,archive_status) VALUES ('upgrade-company','upgrade-attachment','upgrade-message','upgrade-conversation','upgrade-connection',1,'synthetic-chat','synthetic-question','private/synthetic-upgrade.pdf','synthetic-upgrade.pdf','application/pdf',123,repeat('b',64),'verified','pending');"
  ].join('\n');
  await client.query(sql);await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function history(q){
 const result={};
 for(const table of ['companies','staff','connections','connection_identities','conversations','messages','message_versions','work_items','attention_obligations','reply_snapshots','reply_snapshot_items','send_operations','attachments']){
  // Only the explicitly introduced seal is new; existing row data stays exact.
  const expression=table==='reply_snapshots'?"to_jsonb(t)-'sealed_at'":"to_jsonb(t)";
  result[table]=(await pool.query('SELECT '+expression+' AS row FROM '+q+'"'+table+'" t ORDER BY 1')).rows.map(r=>r.row);
 }
 return result;
}
async function ledger(q){return (await pool.query('SELECT version::integer AS version,name,checksum,applied_at FROM '+q+'schema_migrations ORDER BY version')).rows;}
async function snapshot(q){return (await pool.query('SELECT to_jsonb(s) AS snapshot FROM '+q+"reply_snapshots s WHERE company_id='upgrade-company' AND id='upgrade-snapshot'")).rows[0].snapshot;}

test('populated 001 upgrades without rewriting history and seals already accepted snapshots',async()=>area(async schema=>{
 const rawCore=await readFile(new URL('../migrations/001-core.sql',import.meta.url));
 assert.equal(digest(rawCore),CORE_SHA256,'published 001 bytes must remain immutable');
 const migrations=await domainMigrations(schema);
 const initial=migrations.filter(m=>m.version===1);assert.equal(initial.length,1);
 assert.deepEqual(await runMigrations({pool,schema,migrations:initial}),{applied:[1]});
 const q='"'+schema+'".';await seed001(q);
 const before=await history(q);const initialLedger=await ledger(q);
 assert.equal(initialLedger.length,1);assert.equal(initialLedger[0].version,1);
 assert.equal(initialLedger[0].checksum,digest(initial[0].sql));
 assert.equal(Object.hasOwn(await snapshot(q),'sealed_at'),false,'fixture must genuinely be a pre-hardening 001 snapshot');
 const upgraded=await runMigrations({pool,schema,migrations});
 const afterSnapshot=await snapshot(q);
 // Intentional 001-only RED: a normal assertion, not an undefined-column SQL error.
 assert.ok(Object.hasOwn(afterSnapshot,'sealed_at'),'upgrade must add snapshot seal metadata to an existing 001 row');
 assert.ok(typeof afterSnapshot.sealed_at==='string'&&Number.isFinite(Date.parse(afterSnapshot.sealed_at)),'upgrade must backfill a real seal for an already accepted operation');
 assert.deepEqual(await history(q),before,'upgrade must retain identities, content, snapshot membership, intent and archive originals');
 assert.deepEqual(upgraded,{applied:migrations.filter(m=>m.version>1).map(m=>m.version)});
 const afterLedger=await ledger(q);
 assert.deepEqual(afterLedger.map(({version,name,checksum})=>({version,name,checksum})),migrations.map(m=>({version:m.version,name:m.name,checksum:digest(m.sql)})),'ledger must contain exactly the current version/name/checksum sequence');
 assert.deepEqual(afterLedger[0],initialLedger[0],'upgrade must not rewrite original 001 ledger record');
 assert.deepEqual(await runMigrations({pool,schema,migrations}),{applied:[]},'rerunning all migrations must be a no-op');
 assert.deepEqual(await ledger(q),afterLedger,'no-op must retain every ledger record and applied timestamp');
 assert.deepEqual(await history(q),before,'no-op must not rewrite populated history');
 assert.equal((await snapshot(q)).sealed_at,afterSnapshot.sealed_at,'no-op must retain original backfilled seal');
}));
