import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {runMigrations} from '../src/migrate.mjs';
import {domainMigrations} from '../src/domain-migrations.mjs';
if(process.env.DB_TEST_ALLOW!=='1')throw Error('DB_TEST_OPT_IN_REQUIRED');
let target;try{target=new URL(process.env.DB_TEST_URL);}catch{throw Error('DB_TEST_TARGET_INVALID');}
if(!['postgres:','postgresql:'].includes(target.protocol)||!['127.0.0.1','localhost','[::1]'].includes(target.hostname)||target.pathname!=='/wazzup_test'||target.username!=='wazzup_test'||target.search||target.hash)throw Error('DB_TEST_TARGET_INVALID');
const pool=new pg.Pool({connectionString:target.href,max:4,connectionTimeoutMillis:5000,query_timeout:10000,statement_timeout:10000});
const identity=await pool.query("SELECT current_database() AS db,current_user AS role,current_setting('server_version_num')::integer AS version");
assert.equal(identity.rows[0].db,'wazzup_test');assert.equal(identity.rows[0].role,'wazzup_test');assert.ok(identity.rows[0].version>=180000&&identity.rows[0].version<190000);
test.after(async()=>pool.end());
const requiredTables=['companies','departments','staff','staff_memberships','connections','connection_identities','conversations','messages','message_versions','work_items','attention_obligations','reply_snapshots','reply_snapshot_items','send_operations','send_attempts','send_coverage','inbox_events','outbox_jobs','audit_events','crm_accounts','crm_bindings','crm_create_intents','media_assets','consents','workshops','connection_routes','channel_permissions','channel_policies','channel_group_rules','crm_sources','attachments','attachment_lead_links','archive_handoff_jobs','conversation_leads','cleanup_policies','crm_entity_tombstones'];
async function area(action){const schema='domain_probe_'+randomBytes(8).toString('hex');assert.match(schema,/^domain_probe_[a-f0-9]{16}$/);await pool.query('CREATE SCHEMA "'+schema+'"');try{await runMigrations({pool,schema,migrations:await domainMigrations(schema)});await action(schema);}finally{await pool.query('DROP SCHEMA "'+schema+'" CASCADE');}}

async function transaction(action){const client=await pool.connect();try{await client.query('BEGIN');await action(client);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
async function seed(schema){await transaction(client=>client.query(String.raw`
INSERT INTO $schema$.companies(id) VALUES ('company-a'),('company-b');
INSERT INTO $schema$.departments(company_id,id) VALUES ('company-a','dept-a'),('company-b','dept-b');
INSERT INTO $schema$.staff(company_id,id,capacity,active_count) VALUES ('company-a','staff-a',1,0),('company-b','staff-b',1,0);
INSERT INTO $schema$.staff_memberships(company_id,staff_id,department_id) VALUES ('company-a','staff-a','dept-a'),('company-b','staff-b','dept-b');
INSERT INTO $schema$.connections(company_id,id,channel_mode,binding_epoch,credentials_version,state,version,capabilities) VALUES ('company-a','conn-a','telegram_bot',1,1,'active',1,'{}'),('company-b','conn-b','telegram_bot',1,1,'active',1,'{}');
INSERT INTO $schema$.connection_identities(company_id,connection_id,binding_epoch) VALUES ('company-a','conn-a',1),('company-b','conn-b',1);
INSERT INTO $schema$.conversations(company_id,id,connection_id,binding_epoch,external_chat_id) VALUES ('company-a','conv-a','conn-a',1,'provider-chat'),('company-a','conv-a-2','conn-a',1,'provider-chat-2'),('company-b','conv-b','conn-b',1,'provider-chat');
INSERT INTO $schema$.messages(company_id,id,conversation_id,direction,provider_message_id,current_content_version) VALUES ('company-a','msg-a','conv-a','in','provider-message',1),('company-b','msg-b','conv-b','in','provider-message',1);
INSERT INTO $schema$.message_versions(company_id,message_id,content_version,content) VALUES ('company-a','msg-a',1,'{"kind":"text","text":"synthetic question"}'),('company-b','msg-b',1,'{"kind":"text","text":"other synthetic question"}');
INSERT INTO $schema$.work_items(company_id,id,conversation_id,department_id,owner_id,state,assignment_version) VALUES ('company-a','work-a','conv-a','dept-a','staff-a','assigned',1),('company-b','work-b','conv-b','dept-b','staff-b','assigned',1);
INSERT INTO $schema$.attention_obligations(company_id,id,work_item_id,conversation_id,message_id,content_version,attention_seq) VALUES ('company-a','ob-a','work-a','conv-a','msg-a',1,1),('company-b','ob-b','work-b','conv-b','msg-b',1,1);
INSERT INTO $schema$.reply_snapshots(company_id,id,work_item_id,conversation_id,binding_epoch,assignment_version,actor_id) VALUES ('company-a','snap-a','work-a','conv-a',1,1,'staff-a');
INSERT INTO $schema$.reply_snapshot_items(company_id,snapshot_id,work_item_id,conversation_id,obligation_id,content_version) VALUES ('company-a','snap-a','work-a','conv-a','ob-a',1);
INSERT INTO $schema$.send_operations(company_id,id,work_item_id,conversation_id,connection_id,binding_epoch,snapshot_id,actor_id,command_type,idempotency_key,payload_fingerprint,state,coverage,content,deadline) VALUES ('company-a','op-a','work-a','conv-a','conn-a',1,'snap-a','staff-a','reply','reply-key',repeat('a',64),'queued','unconfirmed','{"kind":"text","text":"synthetic answer"}','2099-01-01T00:00:00Z');
`.replaceAll('$schema$','"'+schema+'"')));}

// First real-PG RED is the catalog assertion: missing feature, not missing DB/setup.
test('domain migration creates the canonical scoped persistence boundary',async(t)=>area(async schema=>{
 const {rows}=await pool.query('SELECT tablename FROM pg_tables WHERE schemaname=$1',[schema]);
 assert.deepEqual(requiredTables.filter(name=>!rows.some(row=>row.tablename===name)),[],'domain tables must exist after migration');
 await seed(schema);const q='"'+schema+'".';
 const rejects=(sql,code)=>assert.rejects(pool.query(sql),e=>e.code===code);
 await t.test('company and connection scope reject cross-company conversations',async()=>{
  await rejects("INSERT INTO "+q+"conversations(company_id,id,connection_id,binding_epoch,external_chat_id) VALUES ('company-a','wrong-conv','conn-b',1,'x')",'23503');
 });
 await t.test('conversation and message recipients cannot be silently rewritten',async()=>{
  await rejects("UPDATE "+q+"conversations SET external_chat_id='different-recipient' WHERE company_id='company-a' AND id='conv-a'",'23514');
  await rejects("UPDATE "+q+"messages SET conversation_id='conv-a-2' WHERE company_id='company-a' AND id='msg-a'",'23514');
 });
 await t.test('provider message IDs deduplicate within a conversation, not across chats',async()=>{
  await rejects("INSERT INTO "+q+"messages(company_id,id,conversation_id,direction,provider_message_id,current_content_version) VALUES ('company-a','duplicate-msg','conv-a','in','provider-message',1)",'23505');
  await transaction(async c=>{await c.query("INSERT INTO "+q+"messages(company_id,id,conversation_id,direction,provider_message_id,current_content_version) VALUES ('company-a','another-chat-msg','conv-a-2','in','provider-message',1)");await c.query("INSERT INTO "+q+"message_versions(company_id,message_id,content_version,content) VALUES ('company-a','another-chat-msg',1,'{}')");});
 });
 await t.test('message versions and obligations preserve exact message/version/conversation',async()=>{
  await rejects("INSERT INTO "+q+"message_versions(company_id,message_id,content_version,content) VALUES ('company-a','msg-a',1,'{}')",'23505');
  await rejects("INSERT INTO "+q+"attention_obligations(company_id,id,work_item_id,conversation_id,message_id,content_version,attention_seq) VALUES ('company-a','invalid-version','work-a','conv-a','msg-a',2,2)",'23503');
  await rejects("INSERT INTO "+q+"attention_obligations(company_id,id,work_item_id,conversation_id,message_id,content_version,attention_seq) VALUES ('company-a','wrong-chat-ob','work-a','conv-a','another-chat-msg',1,2)",'23503');
 });
 await t.test('one active work item per conversation and scoped assignee/capacity bounds',async()=>{
  await rejects("INSERT INTO "+q+"work_items(company_id,id,conversation_id,state,assignment_version) VALUES ('company-a','duplicate-work','conv-a','queued',0)",'23505');
  await rejects("UPDATE "+q+"work_items SET owner_id='staff-b' WHERE company_id='company-a' AND id='work-a'",'23503');
  await rejects("UPDATE "+q+"staff SET active_count=2 WHERE company_id='company-a' AND id='staff-a'",'23514');
  await pool.query("INSERT INTO "+q+"work_items(company_id,id,conversation_id,state,assignment_version) VALUES ('company-a','resolved-history','conv-a','resolved',0)");
 });
 await t.test('snapshots cannot include an obligation from another company/work item',async()=>{
  await pool.query("INSERT INTO "+q+"reply_snapshots(company_id,id,work_item_id,conversation_id,binding_epoch,assignment_version,actor_id) VALUES ('company-a','scope-probe-unsealed','work-a','conv-a',1,1,'staff-a')");
  await pool.query("INSERT INTO "+q+"reply_snapshot_items(company_id,snapshot_id,work_item_id,conversation_id,obligation_id,content_version) VALUES ('company-a','scope-probe-unsealed','work-a','conv-a','ob-a',1)");
  await rejects("INSERT INTO "+q+"reply_snapshot_items(company_id,snapshot_id,work_item_id,conversation_id,obligation_id,content_version) VALUES ('company-a','scope-probe-unsealed','work-a','conv-a','ob-b',1)",'23503');
 });
 await t.test('send intent deduplication and state forbid confirmed coverage for queued/unknown',async()=>{
  await rejects("INSERT INTO "+q+"send_operations(company_id,id,work_item_id,conversation_id,connection_id,binding_epoch,snapshot_id,actor_id,command_type,idempotency_key,payload_fingerprint,state,coverage,content,deadline) SELECT company_id,'duplicate-op',work_item_id,conversation_id,connection_id,binding_epoch,snapshot_id,actor_id,command_type,idempotency_key,payload_fingerprint,state,coverage,content,deadline FROM "+q+"send_operations WHERE id='op-a'",'23505');
  await rejects("UPDATE "+q+"send_operations SET content='{\"kind\":\"text\",\"text\":\"changed intent\"}' WHERE company_id='company-a' AND id='op-a'",'23514');
  await rejects("UPDATE "+q+"send_operations SET coverage='confirmed' WHERE company_id='company-a' AND id='op-a'",'23514');
  await pool.query("UPDATE "+q+"send_operations SET state='unknown' WHERE company_id='company-a' AND id='op-a'");
  await rejects("UPDATE "+q+"send_operations SET coverage='confirmed' WHERE company_id='company-a' AND id='op-a'",'23514');
 });
 await t.test('coverage requires the exact obligation version and confirmed sent operation',async()=>{
  const insert="INSERT INTO "+q+"send_coverage(company_id,operation_id,work_item_id,conversation_id,operation_state,obligation_id,content_version) VALUES ('company-a','op-a','work-a','conv-a','sent','ob-a',1)";
  await rejects(insert,'23503');
  await pool.query("UPDATE "+q+"send_operations SET state='sent',coverage='confirmed' WHERE company_id='company-a' AND id='op-a'");
  await pool.query(insert);
 });
 await t.test('inbox provider keys deduplicate in connection epoch scope',async()=>{
  const add=(id,epoch)=>"INSERT INTO "+q+"inbox_events(company_id,id,connection_id,binding_epoch,provider_event_key,payload_major,kind,payload) VALUES ('company-a','"+id+"','conn-a',"+epoch+",'provider-update',2,'message.received','{}')";
  await pool.query(add('inbox-a',1));await rejects(add('inbox-duplicate',1),'23505');
  await pool.query("INSERT INTO "+q+"connection_identities(company_id,connection_id,binding_epoch) VALUES ('company-a','conn-a',2)");await pool.query(add('inbox-new-epoch',2));
  await rejects("INSERT INTO "+q+"inbox_events(company_id,id,connection_id,binding_epoch,payload_major,kind,payload) VALUES ('company-a','wrong-major','conn-a',1,99,'message.received','{}')",'23514');
 });
 await t.test('CRM unknown creation never needs invented external IDs',async()=>{
  await pool.query("INSERT INTO "+q+"crm_accounts(company_id,id) VALUES ('company-a','crm-a')");
  await pool.query("INSERT INTO "+q+"crm_bindings(company_id,id,account_id,conversation_id,state,contact_id,chat_id) VALUES ('company-a','binding-a','crm-a','conv-a','creation_unknown',NULL,NULL)");
  await rejects("UPDATE "+q+"crm_bindings SET state='bound' WHERE company_id='company-a' AND id='binding-a'",'23514');
 });
 await t.test('domain write audit and outbox roll back together on a real transaction',async()=>{
  const client=await pool.connect();try{await client.query('BEGIN');await client.query("INSERT INTO "+q+"messages(company_id,id,conversation_id,direction,provider_message_id,current_content_version) VALUES ('company-a','msg-rollback','conv-a','in','provider-rollback',1)");await client.query("INSERT INTO "+q+"message_versions(company_id,message_id,content_version,content) VALUES ('company-a','msg-rollback',1,'{}')");await client.query("INSERT INTO "+q+"audit_events(company_id,id,event_name,subject_id) VALUES ('company-a','audit-rollback','message.created','msg-a')");await client.query("INSERT INTO "+q+"outbox_jobs(company_id,id,job_kind,intent_key,payload) VALUES ('company-a','job-rollback','crm_projection','projection-key','{}')");await client.query('ROLLBACK');}finally{client.release();}
  assert.equal((await pool.query("SELECT count(*)::integer AS n FROM "+q+"messages WHERE id='msg-rollback'")).rows[0].n,0);assert.equal((await pool.query("SELECT count(*)::integer AS n FROM "+q+"audit_events WHERE id='audit-rollback'")).rows[0].n,0);assert.equal((await pool.query("SELECT count(*)::integer AS n FROM "+q+"outbox_jobs WHERE id='job-rollback'")).rows[0].n,0);
 });
 await t.test('business workshops remain separate from departments and routes bind the correct CRM source',async()=>{
  await pool.query("INSERT INTO "+q+"workshops(company_id,id,display_name) VALUES ('company-a','workshop-a','Synthetic workshop A'),('company-a','workshop-b','Synthetic workshop B')");
  await pool.query("INSERT INTO "+q+"crm_accounts(company_id,id) VALUES ('company-a','crm-a-2')");
  await pool.query("INSERT INTO "+q+"crm_sources(company_id,id,account_id,external_id,origin_code) VALUES ('company-a','source-a','crm-a','source-route-a','synthetic-channel'),('company-a','source-other-account','crm-a-2','source-route-b','synthetic-channel')");
  await pool.query("INSERT INTO "+q+"connection_routes(company_id,connection_id,workshop_id,crm_account_id,funnel_id,default_owner_id,technical_source_id,version) VALUES ('company-a','conn-a','workshop-a','crm-a','funnel-a','staff-a','source-a',1)");
  await rejects("UPDATE "+q+"connection_routes SET technical_source_id='source-other-account' WHERE company_id='company-a' AND connection_id='conn-a'",'23503');
  await rejects("UPDATE "+q+"crm_sources SET source_kind='marketing_attribution' WHERE company_id='company-a' AND id='source-a'",'23514');
  assert.equal((await pool.query("SELECT count(*)::integer AS n FROM "+q+"workshops WHERE company_id='company-a'")).rows[0].n,2);
  await rejects("UPDATE "+q+"connection_routes SET workshop_id='dept-a' WHERE company_id='company-a' AND connection_id='conn-a'",'23503');
 });
 await t.test('channel staff grants are scoped and default read/send permissions are denied',async()=>{
  const grant=await pool.query("INSERT INTO "+q+"channel_permissions(company_id,connection_id,staff_id) VALUES ('company-a','conn-a','staff-a') RETURNING can_read,can_send");
  assert.equal(grant.rows[0].can_read,false);assert.equal(grant.rows[0].can_send,false);
  await rejects("INSERT INTO "+q+"channel_permissions(company_id,connection_id,staff_id,can_read) VALUES ('company-a','conn-a','staff-b',true)",'23503');
 });
 await t.test('group import denies by default and immutable external ID wins over display names',async()=>{
  const allowed=async(kind,id)=>(await pool.query('SELECT '+q+'channel_crm_import_allowed($1,$2,$3,$4,$5) AS allowed',['company-a','conn-a',1,id,kind])).rows[0].allowed;
  assert.equal(await allowed('group','group-fixture'),false);
  await pool.query("INSERT INTO "+q+"channel_policies(company_id,connection_id,crm_projection_enabled) VALUES ('company-a','conn-a',true)");
  assert.equal(await allowed('group','group-fixture'),false);assert.equal(await allowed('unknown','group-fixture'),false);assert.equal(await allowed('private','private-fixture'),true);
  await pool.query("INSERT INTO "+q+"channel_group_rules(company_id,connection_id,binding_epoch,external_chat_id,decision,display_name) VALUES ('company-a','conn-a',1,'group-fixture','allow_crm','Original name')");
  assert.equal(await allowed('group','group-fixture'),true);
  await pool.query("UPDATE "+q+"channel_group_rules SET display_name='Renamed working group' WHERE company_id='company-a' AND external_chat_id='group-fixture'");
  assert.equal(await allowed('group','group-fixture'),true);assert.equal(await allowed('group','same-name-different-id'),false);
  await pool.query("UPDATE "+q+"channel_group_rules SET decision='exclude' WHERE company_id='company-a' AND external_chat_id='group-fixture'");assert.equal(await allowed('group','group-fixture'),false);
  await pool.query("UPDATE "+q+"channel_group_rules SET decision='archive_only' WHERE company_id='company-a' AND external_chat_id='group-fixture'");assert.equal(await allowed('group','group-fixture'),false);
  await rejects("UPDATE "+q+"channel_group_rules SET external_chat_id='different-id' WHERE company_id='company-a' AND external_chat_id='group-fixture'",'23514');
 });
 await t.test('attachment index preserves raw and CRM IDs, multilead links and archive pending facts',async()=>{
  await pool.query("INSERT INTO "+q+"attachments(company_id,id,message_id,conversation_id,connection_id,binding_epoch,external_chat_id,external_message_id,amo_chat_id,amo_message_id,contact_id,s3_key,original_name,mime_type,byte_size,sha256) VALUES ('company-a','attachment-a','msg-a','conv-a','conn-a',1,'provider-chat','provider-message','amo-chat-fixture','amo-message-fixture','contact-fixture','private/synthetic.pdf','synthetic.pdf','application/pdf',123,repeat('a',64))");
  const facts=(await pool.query("SELECT storage_state,archive_status FROM "+q+"attachments WHERE id='attachment-a'")).rows[0];assert.equal(facts.storage_state,'pending');assert.equal(facts.archive_status,'pending');
  await rejects("UPDATE "+q+"attachments SET archive_status='indexed' WHERE company_id='company-a' AND id='attachment-a'",'23514');
  await pool.query("INSERT INTO "+q+"attachment_lead_links(company_id,attachment_id,account_id,lead_id) VALUES ('company-a','attachment-a','crm-a','lead-1'),('company-a','attachment-a','crm-a','lead-2')");
  await pool.query("INSERT INTO "+q+"conversation_leads(company_id,id,account_id,conversation_id,lead_id) VALUES ('company-a','lead-link-1','crm-a','conv-a','lead-1'),('company-a','lead-link-2','crm-a','conv-a','lead-2')");
  const handoff=(await pool.query("INSERT INTO "+q+"archive_handoff_jobs(company_id,id,attachment_id,intent_key) VALUES ('company-a','handoff-a','attachment-a','archive-index-a') RETURNING delivery_enabled,state,contract_ref")).rows[0];assert.equal(handoff.delivery_enabled,false);assert.equal(handoff.state,'pending');assert.equal(handoff.contract_ref,null);
  await rejects("UPDATE "+q+"archive_handoff_jobs SET delivery_enabled=true WHERE company_id='company-a' AND id='handoff-a'",'23514');
 });
 await t.test('CRM delete/merge observations retain archive originals and automatic cleanup stays disabled',async()=>{
  await pool.query("INSERT INTO "+q+"cleanup_policies(company_id) VALUES ('company-a')");
  const policy=(await pool.query("SELECT crm_cleanup_enabled,messenger_cleanup_enabled,archive_cleanup_enabled FROM "+q+"cleanup_policies WHERE company_id='company-a'")).rows[0];assert.deepEqual(policy,{crm_cleanup_enabled:false,messenger_cleanup_enabled:false,archive_cleanup_enabled:false});
  for(const flag of ['crm_cleanup_enabled','messenger_cleanup_enabled','archive_cleanup_enabled'])await rejects('UPDATE '+q+'cleanup_policies SET '+flag+"=true WHERE company_id='company-a'",'23514');
  await pool.query("INSERT INTO "+q+"crm_entity_tombstones(company_id,account_id,entity_type,external_id) VALUES ('company-a','crm-a','contact','contact-fixture')");
  await pool.query("UPDATE "+q+"conversation_leads SET link_state='merged',merged_into_lead_id='lead-merged' WHERE company_id='company-a' AND id='lead-link-1'");
  assert.equal((await pool.query("SELECT count(*)::integer AS n FROM "+q+"attachments WHERE id='attachment-a'")).rows[0].n,1);
  assert.equal((await pool.query("SELECT count(*)::integer AS n FROM "+q+"attachment_lead_links WHERE attachment_id='attachment-a'")).rows[0].n,2);
  assert.equal((await pool.query("SELECT count(*)::integer AS n FROM "+q+"conversation_leads WHERE company_id='company-a'")).rows[0].n,2);
  assert.equal((await pool.query("SELECT count(*)::integer AS n FROM "+q+"messages WHERE id='msg-a'")).rows[0].n,1);
 });

}));

// Independent second-stage probes authored after baseline freeze, before any SQL fix.
// Each owns a fresh real-PG schema so prior subtest mutations cannot satisfy a negative.
async function negativeArea(action){return area(async schema=>{await seed(schema);await action('"'+schema+'".');});}
async function expectSqlError(sql,codes=['23503']){await assert.rejects(pool.query(sql),error=>codes.includes(error.code));}
async function alternativeFixtures(q){await transaction(client=>client.query(
 'INSERT INTO '+q+"staff(company_id,id,capacity) VALUES ('company-a','staff-a-next',1);"+
 'INSERT INTO '+q+"connections(company_id,id,channel_mode,binding_epoch,credentials_version,state,version,capabilities) VALUES ('company-a','conn-a-next','telegram_bot',1,1,'active',1,'{}');"+
 'INSERT INTO '+q+"connection_identities(company_id,connection_id,binding_epoch) VALUES ('company-a','conn-a-next',1),('company-a','conn-a',2);"+
 'INSERT INTO '+q+"messages(company_id,id,conversation_id,direction,provider_message_id,current_content_version) VALUES ('company-a','msg-a-next','conv-a-2','in','provider-next',1);"+
 'INSERT INTO '+q+"message_versions(company_id,message_id,content_version,content) VALUES ('company-a','msg-a-next',1,'{}'),('company-a','msg-a',2,'{}');"+
 'INSERT INTO '+q+"work_items(company_id,id,conversation_id,department_id,owner_id,state,assignment_version) VALUES ('company-a','work-a-next','conv-a-2','dept-a','staff-a-next','assigned',1);"+
 'INSERT INTO '+q+"attention_obligations(company_id,id,work_item_id,conversation_id,message_id,content_version,attention_seq) VALUES ('company-a','ob-a-next','work-a-next','conv-a-2','msg-a-next',1,1);"+
 'INSERT INTO '+q+"reply_snapshots(company_id,id,work_item_id,conversation_id,binding_epoch,assignment_version,actor_id) VALUES ('company-a','snap-a-next','work-a-next','conv-a-2',1,1,'staff-a-next');"+
 'INSERT INTO '+q+"reply_snapshot_items(company_id,snapshot_id,work_item_id,conversation_id,obligation_id,content_version) VALUES ('company-a','snap-a-next','work-a-next','conv-a-2','ob-a-next',1);"
));}
async function archiveFixtures(q){await pool.query(
 'INSERT INTO '+q+"crm_accounts(company_id,id) VALUES ('company-a','crm-a');"+
 'INSERT INTO '+q+"crm_bindings(company_id,id,account_id,conversation_id,state) VALUES ('company-a','binding-a','crm-a','conv-a','pending');"+
 'INSERT INTO '+q+"attachments(company_id,id,message_id,conversation_id,connection_id,binding_epoch,external_chat_id,external_message_id,s3_key,original_name,mime_type,byte_size,sha256) VALUES ('company-a','attachment-a','msg-a','conv-a','conn-a',1,'provider-chat','provider-message','private/synthetic.pdf','synthetic.pdf','application/pdf',123,repeat('a',64));"+
 'INSERT INTO '+q+"attachment_lead_links(company_id,attachment_id,account_id,lead_id) VALUES ('company-a','attachment-a','crm-a','lead-1'),('company-a','attachment-a','crm-a','lead-2');"+
 'INSERT INTO '+q+"conversation_leads(company_id,id,account_id,conversation_id,lead_id) VALUES ('company-a','link-1','crm-a','conv-a','lead-1'),('company-a','link-2','crm-a','conv-a','lead-2');"
);}

test('DBTEST-01 immutable identities and accepted intent reject otherwise valid alternative fields',async()=>negativeArea(async q=>{
 await alternativeFixtures(q);
 const probes=[
  ['conversations','conv-a',"external_chat_id='provider-new'"],
  ['conversations','conv-a',"connection_id='conn-a-next'"],
  ['conversations','conv-a',"binding_epoch=2"],
  ['messages','msg-a',"direction='out'"],
  ['messages','msg-a',"provider_message_id='provider-rewritten'"],
  ['send_operations','op-a',"payload_fingerprint=repeat('b',64)"],
  ['send_operations','op-a',"idempotency_key='new-command-key'"],
  ['send_operations','op-a',"command_type='manual_send'"],
  ['send_operations','op-a',"deadline='2098-01-01T00:00:00Z'"],
  ['send_operations','op-a',"actor_id='staff-a-next'"],
  ['send_operations','op-a',"snapshot_id='snap-a-next'"],
  ['send_operations','op-a',"work_item_id='work-a-next'"],
  ['send_operations','op-a',"conversation_id='conv-a-2'"],
  ['send_operations','op-a',"connection_id='conn-a-next'"],
  ['send_operations','op-a',"binding_epoch=2"]
 ];
 for(const [table,id,change] of probes){
  const where=" WHERE company_id='company-a' AND id='"+id+"'";
  const before=(await pool.query('SELECT * FROM '+q+table+where)).rows;
  await expectSqlError('UPDATE '+q+table+' SET '+change+where,['23514']);
  assert.deepEqual((await pool.query('SELECT * FROM '+q+table+where)).rows,before);
 }
}));

test('DBTEST-02 same-company cross-chat relationships reject new inserts independently of immutable updates',async()=>negativeArea(async q=>{
 await alternativeFixtures(q);
 const op=(id,work,conv,snapshot)=>'INSERT INTO '+q+"send_operations(company_id,id,work_item_id,conversation_id,connection_id,binding_epoch,snapshot_id,actor_id,command_type,idempotency_key,payload_fingerprint,state,coverage,content,deadline) VALUES ('company-a','"+id+"','"+work+"','"+conv+"','conn-a',1,'"+snapshot+"','staff-a','reply','"+id+"',repeat('a',64),'queued','unconfirmed','{}','2099-01-01T00:00:00Z')";
 await pool.query(op('valid-new-op','work-a','conv-a','snap-a'));
 await expectSqlError(op('wrong-snapshot','work-a','conv-a','snap-a-next'));
 await expectSqlError(op('wrong-work-conv','work-a','conv-a-2','snap-a'));
 await expectSqlError('INSERT INTO '+q+"attention_obligations(company_id,id,work_item_id,conversation_id,message_id,content_version,attention_seq) VALUES ('company-a','cross-work','work-a','conv-a-2','msg-a-next',1,2)");
 // Version 2 exists for msg-a but ob-a names version 1. Use a fresh, unaccepted
 // snapshot so an accepted-snapshot seal cannot mask this exact FK rejection.
 await pool.query('INSERT INTO '+q+"reply_snapshots(company_id,id,work_item_id,conversation_id,binding_epoch,assignment_version,actor_id) VALUES ('company-a','unsealed-version-probe','work-a','conv-a',1,1,'staff-a')");
 await pool.query('INSERT INTO '+q+"reply_snapshot_items(company_id,snapshot_id,work_item_id,conversation_id,obligation_id,content_version) VALUES ('company-a','unsealed-version-probe','work-a','conv-a','ob-a',1)");
 await expectSqlError('INSERT INTO '+q+"reply_snapshot_items(company_id,snapshot_id,work_item_id,conversation_id,obligation_id,content_version) VALUES ('company-a','unsealed-version-probe','work-a','conv-a','ob-a',2)");
}));

test('DBTEST-03 attachment provenance rejects contradictory existing message and recipient facts',async()=>negativeArea(async q=>{
 const insert=(id,message,conv,chat,external)=>'INSERT INTO '+q+"attachments(company_id,id,message_id,conversation_id,connection_id,binding_epoch,external_chat_id,external_message_id,original_name,mime_type,byte_size,sha256) VALUES ('company-a','"+id+"','"+message+"','"+conv+"','conn-a',1,'"+chat+"',"+(external===null?'NULL':"'"+external+"'")+",'synthetic.pdf','application/pdf',123,repeat('a',64))";
 await pool.query(insert('valid-provenance','msg-a','conv-a','provider-chat','provider-message'));
 await expectSqlError(insert('wrong-conversation','msg-a','conv-a-2','provider-chat-2','provider-message'),['23503','23514']);
 await expectSqlError(insert('wrong-external-chat','msg-a','conv-a','different-chat','provider-message'),['23503','23514']);
 // Unknown provider ID is a legitimate outbound state; do not demand fabricated IDs.
 await transaction(client=>client.query('INSERT INTO '+q+"messages(company_id,id,conversation_id,direction,provider_message_id,current_content_version) VALUES ('company-a','outbound-pending','conv-a','out',NULL,1); INSERT INTO "+q+"message_versions(company_id,message_id,content_version,content) VALUES ('company-a','outbound-pending',1,'{}')"));
 await pool.query(insert('unknown-provider-valid','outbound-pending','conv-a','provider-chat',null));
 await pool.query('UPDATE '+q+"messages SET provider_message_id='outbound-observed' WHERE company_id='company-a' AND id='outbound-pending'");
 await pool.query(insert('known-after-observation','outbound-pending','conv-a','provider-chat','outbound-observed'));
 await expectSqlError(insert('wrong-external-message','msg-a','conv-a','provider-chat','different-message'),['23503','23514']);
}));

test('DBTEST-04 indexed archive has a valid positive and independent required-fact negatives',async()=>negativeArea(async q=>{
 await archiveFixtures(q);
 const where=" WHERE company_id='company-a' AND id='attachment-a'";
 await pool.query('UPDATE '+q+"attachments SET storage_state='verified',archive_status='indexed',index_ack_ref='synthetic-ack'"+where);
 assert.equal((await pool.query('SELECT archive_status FROM '+q+'attachments'+where)).rows[0].archive_status,'indexed');
 for(const change of ["storage_state='pending'",'index_ack_ref=NULL','sha256=NULL','s3_key=NULL']){
  await expectSqlError('UPDATE '+q+'attachments SET '+change+where,['23514']);
  assert.equal((await pool.query('SELECT archive_status FROM '+q+'attachments'+where)).rows[0].archive_status,'indexed');
 }
 await pool.query('UPDATE '+q+"attachments SET archive_status='unknown',index_ack_ref=NULL"+where);
 const unknown=(await pool.query('SELECT storage_state,archive_status,index_ack_ref FROM '+q+'attachments'+where)).rows[0];
 assert.deepEqual(unknown,{storage_state:'verified',archive_status:'unknown',index_ack_ref:null});
}));

test('DBTEST-05 actual CRM deletes cannot cascade to originals or archive history',async()=>negativeArea(async q=>{
 await archiveFixtures(q);
 const snapshot=async()=>({messages:(await pool.query('SELECT * FROM '+q+'messages ORDER BY company_id,id')).rows,
  attachments:(await pool.query('SELECT * FROM '+q+'attachments ORDER BY company_id,id')).rows,
  attachmentLeads:(await pool.query('SELECT * FROM '+q+'attachment_lead_links ORDER BY company_id,lead_id')).rows,
  conversationLeads:(await pool.query('SELECT * FROM '+q+'conversation_leads ORDER BY company_id,id')).rows});
 const before=await snapshot();
 await pool.query('DELETE FROM '+q+"crm_bindings WHERE company_id='company-a' AND id='binding-a'");
 assert.deepEqual(await snapshot(),before);
 await expectSqlError('DELETE FROM '+q+"crm_accounts WHERE company_id='company-a' AND id='crm-a'",['23503']);
 assert.deepEqual(await snapshot(),before);
}));

test('DBTEST-06 group allowlist does not leak across epoch company or disabled policy',async()=>negativeArea(async q=>{
 await pool.query('INSERT INTO '+q+"connection_identities(company_id,connection_id,binding_epoch) VALUES ('company-a','conn-a',2); INSERT INTO "+q+"channel_policies(company_id,connection_id,crm_projection_enabled) VALUES ('company-a','conn-a',true); INSERT INTO "+q+"channel_group_rules(company_id,connection_id,binding_epoch,external_chat_id,decision) VALUES ('company-a','conn-a',1,'group-fixture','allow_crm')");
 const allowed=async(company,connection,epoch,kind)=>(await pool.query('SELECT '+q+'channel_crm_import_allowed($1,$2,$3,$4,$5) AS allowed',[company,connection,epoch,'group-fixture',kind])).rows[0].allowed;
 assert.equal(await allowed('company-a','conn-a',1,'group'),true);
 assert.equal(await allowed('company-a','conn-a',2,'group'),false);
 assert.equal(await allowed('company-b','conn-b',1,'group'),false);
 for(const kind of ['unknown','channel',null])assert.equal(await allowed('company-a','conn-a',1,kind),false);
 await pool.query('INSERT INTO '+q+"channel_group_rules(company_id,connection_id,binding_epoch,external_chat_id,decision) VALUES ('company-a','conn-a',2,'group-fixture','allow_crm')");
 assert.equal(await allowed('company-a','conn-a',2,'group'),true);
 await pool.query('UPDATE '+q+"channel_policies SET crm_projection_enabled=false WHERE company_id='company-a' AND connection_id='conn-a'");
 for(const kind of ['group','private'])assert.equal(await allowed('company-a','conn-a',1,kind),false);
}));

test('DBTEST-07 workshop route and ACL references reject cross-company pairs',async()=>negativeArea(async q=>{
 await pool.query('INSERT INTO '+q+"workshops(company_id,id) VALUES ('company-a','workshop-a'),('company-b','workshop-b'); INSERT INTO "+q+"crm_accounts(company_id,id) VALUES ('company-a','crm-a'); INSERT INTO "+q+"crm_sources(company_id,id,account_id,external_id,origin_code) VALUES ('company-a','source-a','crm-a','source-fixture','synthetic'); INSERT INTO "+q+"connection_routes(company_id,connection_id,workshop_id,crm_account_id,funnel_id,default_owner_id,technical_source_id,version) VALUES ('company-a','conn-a','workshop-a','crm-a','funnel','staff-a','source-a',1)");
 await expectSqlError('UPDATE '+q+"connection_routes SET default_owner_id='staff-b' WHERE company_id='company-a' AND connection_id='conn-a'");
 await expectSqlError('UPDATE '+q+"connection_routes SET workshop_id='workshop-b' WHERE company_id='company-a' AND connection_id='conn-a'");
 await pool.query('INSERT INTO '+q+"channel_permissions(company_id,connection_id,staff_id) VALUES ('company-a','conn-a','staff-a')");
 await expectSqlError('INSERT INTO '+q+"channel_permissions(company_id,connection_id,staff_id) VALUES ('company-a','conn-b','staff-a')");
 await pool.query('INSERT INTO '+q+"channel_policies(company_id,connection_id) VALUES ('company-a','conn-a')");
 await expectSqlError('INSERT INTO '+q+"channel_policies(company_id,connection_id) VALUES ('company-a','conn-b')");
}));

test('DBTEST-08 current identity is deferred while refresh and history stay independent',async()=>negativeArea(async q=>{
 await assert.rejects(transaction(client=>client.query('UPDATE '+q+"connections SET binding_epoch=99 WHERE company_id='company-a' AND id='conn-a'")),error=>error.code==='23503');
 await pool.query('UPDATE '+q+"connections SET credentials_version=2 WHERE company_id='company-a' AND id='conn-a'");
 assert.deepEqual((await pool.query('SELECT binding_epoch::integer,credentials_version::integer FROM '+q+"connections WHERE company_id='company-a' AND id='conn-a'")).rows[0],{binding_epoch:1,credentials_version:2});
 await pool.query('INSERT INTO '+q+"connection_identities(company_id,connection_id,binding_epoch) VALUES ('company-a','conn-a',2)");
 await pool.query('UPDATE '+q+"connections SET binding_epoch=2 WHERE company_id='company-a' AND id='conn-a'");
 assert.deepEqual((await pool.query('SELECT binding_epoch::integer,external_chat_id FROM '+q+"conversations WHERE company_id='company-a' AND id='conv-a'")).rows[0],{binding_epoch:1,external_chat_id:'provider-chat'});
}));

test('DBTEST-09 logical intent deduplication has positive independent scopes',async()=>negativeArea(async q=>{
 await archiveFixtures(q);
 const handoff=id=>'INSERT INTO '+q+"archive_handoff_jobs(company_id,id,attachment_id,intent_key) VALUES ('company-a','"+id+"','attachment-a','archive-index-a')";
 await pool.query(handoff('handoff-a'));await expectSqlError(handoff('handoff-duplicate'),['23505']);
 const outbox=(company,id,kind)=>'INSERT INTO '+q+"outbox_jobs(company_id,id,job_kind,intent_key,payload) VALUES ('"+company+"','"+id+"','"+kind+"','same-intent','{}')";
 await pool.query(outbox('company-a','outbox-a','crm_projection'));
 await expectSqlError(outbox('company-a','duplicate','crm_projection'),['23505']);
 await pool.query(outbox('company-a','other-kind','archive_projection'));
 await pool.query(outbox('company-b','other-company','crm_projection'));
 // Existing reply-key is intentionally reused under another command type/company.
 await pool.query('INSERT INTO '+q+"send_operations(company_id,id,work_item_id,conversation_id,connection_id,binding_epoch,snapshot_id,actor_id,command_type,idempotency_key,payload_fingerprint,state,coverage,content,deadline) SELECT company_id,'other-command',work_item_id,conversation_id,connection_id,binding_epoch,snapshot_id,actor_id,'manual_send',idempotency_key,payload_fingerprint,state,coverage,content,deadline FROM "+q+"send_operations WHERE company_id='company-a' AND id='op-a'");
 await pool.query('INSERT INTO '+q+"send_operations(company_id,id,work_item_id,conversation_id,connection_id,binding_epoch,actor_id,command_type,idempotency_key,payload_fingerprint,state,coverage,content,deadline) VALUES ('company-b','other-company-op','work-b','conv-b','conn-b',1,'staff-b','reply','reply-key',repeat('a',64),'queued','unconfirmed','{}','2099-01-01T00:00:00Z')");
 await expectSqlError('INSERT INTO '+q+"send_operations(company_id,id,work_item_id,conversation_id,connection_id,binding_epoch,snapshot_id,actor_id,command_type,idempotency_key,payload_fingerprint,state,coverage,content,deadline) SELECT company_id,'changed-fingerprint',work_item_id,conversation_id,connection_id,binding_epoch,snapshot_id,actor_id,command_type,idempotency_key,repeat('b',64),state,coverage,content,deadline FROM "+q+"send_operations WHERE company_id='company-a' AND id='op-a'",['23505']);
}));


test('DBTEST-10 accepted snapshot membership cannot be rewritten or removed',async t=>{
 await t.test('deleting a queued operation never thaws its previously accepted snapshot',async()=>negativeArea(async q=>{
  // No attempts or coverage exist: operation deletion itself is allowed by the baseline.
  await pool.query('DELETE FROM '+q+"send_operations WHERE company_id='company-a' AND id='op-a'");
  await expectSqlError('DELETE FROM '+q+"reply_snapshot_items WHERE company_id='company-a' AND snapshot_id='snap-a'",['23514']);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM '+q+"reply_snapshot_items WHERE company_id='company-a' AND snapshot_id='snap-a'")).rows[0].n,1);
 }));

 await t.test('reject adding a later real question to an already accepted snapshot',async()=>negativeArea(async q=>{
  await pool.query('INSERT INTO '+q+"message_versions(company_id,message_id,content_version,content) VALUES ('company-a','msg-a',2,'{}'); INSERT INTO "+q+"attention_obligations(company_id,id,work_item_id,conversation_id,message_id,content_version,attention_seq) VALUES ('company-a','ob-later','work-a','conv-a','msg-a',2,2)");
  await expectSqlError('INSERT INTO '+q+"reply_snapshot_items(company_id,snapshot_id,work_item_id,conversation_id,obligation_id,content_version) VALUES ('company-a','snap-a','work-a','conv-a','ob-later',2)",['23514']);
  assert.deepEqual((await pool.query('SELECT obligation_id FROM '+q+"reply_snapshot_items WHERE company_id='company-a' AND snapshot_id='snap-a' ORDER BY obligation_id")).rows,[{obligation_id:'ob-a'}]);
 }));

 await t.test('reject replacing a member with another real obligation in the same work item',async()=>negativeArea(async q=>{
  await pool.query('INSERT INTO '+q+"message_versions(company_id,message_id,content_version,content) VALUES ('company-a','msg-a',2,'{}'); INSERT INTO "+q+"attention_obligations(company_id,id,work_item_id,conversation_id,message_id,content_version,attention_seq) VALUES ('company-a','ob-a-second','work-a','conv-a','msg-a',2,2)");
  // op-a already references snap-a. Replacement target is valid and in the same work item.
  await expectSqlError('UPDATE '+q+"reply_snapshot_items SET obligation_id='ob-a-second',content_version=2 WHERE company_id='company-a' AND snapshot_id='snap-a'",['23514']);
  assert.deepEqual((await pool.query('SELECT obligation_id,content_version::integer FROM '+q+"reply_snapshot_items WHERE company_id='company-a' AND snapshot_id='snap-a'")).rows,[{obligation_id:'ob-a',content_version:1}]);
 }));
 await t.test('reject deleting the selected member after operation acceptance',async()=>negativeArea(async q=>{
  await expectSqlError('DELETE FROM '+q+"reply_snapshot_items WHERE company_id='company-a' AND snapshot_id='snap-a'",['23514']);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM '+q+"reply_snapshot_items WHERE company_id='company-a' AND snapshot_id='snap-a'")).rows[0].n,1);
 }));
});

test('DBTEST-11 original CRM link identities retain history while merge target is separate',async t=>{
 for(const table of ['conversation_leads','attachment_lead_links'])for(const field of ['lead_id','account_id'])await t.test(table+' rejects '+field+' rewrite',async()=>negativeArea(async q=>{
  await archiveFixtures(q);
  await pool.query('INSERT INTO '+q+"crm_accounts(company_id,id) VALUES ('company-a','crm-a-next')");
  const where=" WHERE company_id='company-a' AND lead_id='lead-1'";
  const before=(await pool.query('SELECT * FROM '+q+table+where)).rows;
  const value=field==='lead_id'?'different-original-lead':'crm-a-next';
  await expectSqlError('UPDATE '+q+table+' SET '+field+"='"+value+"'"+where,['23514']);
  assert.deepEqual((await pool.query('SELECT * FROM '+q+table+where)).rows,before);
  await pool.query('UPDATE '+q+table+" SET link_state='merged',merged_into_lead_id='replacement-lead'"+where);
  const merged=(await pool.query('SELECT lead_id,account_id,merged_into_lead_id FROM '+q+table+where)).rows[0];
  assert.deepEqual(merged,{lead_id:'lead-1',account_id:'crm-a',merged_into_lead_id:'replacement-lead'});
 }));
});

test('DBTEST-12 known connection identity cannot be replaced inside the same historical epoch',async()=>negativeArea(async q=>{
 const where=" WHERE company_id='company-a' AND connection_id='conn-a' AND binding_epoch=1";
 // A first discovery may fill an unknown identity. Rebinding needs a new epoch.
 await pool.query('UPDATE '+q+"connection_identities SET external_identity_ref='synthetic-account-one'"+where);
 await expectSqlError('UPDATE '+q+"connection_identities SET external_identity_ref='synthetic-account-two'"+where,['23514']);
 assert.equal((await pool.query('SELECT external_identity_ref FROM '+q+'connection_identities'+where)).rows[0].external_identity_ref,'synthetic-account-one');
 await pool.query('INSERT INTO '+q+"connection_identities(company_id,connection_id,binding_epoch,external_identity_ref) VALUES ('company-a','conn-a',2,'synthetic-account-two')");
}));


// The operation is intentionally left uncommitted while the other client mutates
// membership. Ordering comes from actual backend wait dependencies, never sleeps.
for(const isolation of ['READ COMMITTED','REPEATABLE READ'])test('DBTEST-13 snapshot acceptance serializes membership under '+isolation,async()=>negativeArea(async q=>{
 await pool.query('INSERT INTO '+q+"reply_snapshots(company_id,id,work_item_id,conversation_id,binding_epoch,assignment_version,actor_id) VALUES ('company-a','race-snapshot','work-a','conv-a',1,1,'staff-a'); INSERT INTO "+q+"reply_snapshot_items(company_id,snapshot_id,work_item_id,conversation_id,obligation_id,content_version) VALUES ('company-a','race-snapshot','work-a','conv-a','ob-a',1)");
 const accepting=await pool.connect();const member=await pool.connect();
 let mutation;let outcome;let observedBlocking=false;
 try{
  const acceptPid=(await accepting.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const memberPid=(await member.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await member.query('BEGIN ISOLATION LEVEL '+isolation);
  // Establish the RR snapshot before acceptance can update/seal the header.
  await member.query('SELECT id FROM '+q+"reply_snapshots WHERE company_id='company-a' AND id='race-snapshot'");
  await accepting.query('BEGIN');
  await accepting.query('INSERT INTO '+q+"send_operations(company_id,id,work_item_id,conversation_id,connection_id,binding_epoch,snapshot_id,actor_id,command_type,idempotency_key,payload_fingerprint,state,coverage,content,deadline) SELECT company_id,'race-operation',work_item_id,conversation_id,connection_id,binding_epoch,'race-snapshot',actor_id,command_type,'race-operation-key',payload_fingerprint,state,coverage,content,deadline FROM "+q+"send_operations WHERE company_id='company-a' AND id='op-a'");
  mutation=member.query('DELETE FROM '+q+"reply_snapshot_items WHERE company_id='company-a' AND snapshot_id='race-snapshot'").then(
   result=>(outcome={ok:true,rowCount:result.rowCount}),error=>(outcome={ok:false,code:error.code}));
  const deadline=Date.now()+5000;
  while(!outcome){
   const blockers=(await pool.query('SELECT pg_blocking_pids($1) AS pids',[memberPid])).rows[0].pids;
   if(blockers.includes(acceptPid)){observedBlocking=true;break;}
   assert.ok(Date.now()<deadline,'membership query neither settled nor blocked on accepting backend');
  }
  await accepting.query('COMMIT');
  const result=await mutation;
  assert.equal(observedBlocking,true,'membership mutation must wait for in-flight snapshot acceptance');
  assert.equal(result.ok,false,'accepted snapshot mutation must be rejected after acceptance commits');
  assert.equal(result.code,isolation==='READ COMMITTED'?'23514':'40001');
  await member.query('ROLLBACK');
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM '+q+"reply_snapshot_items WHERE company_id='company-a' AND snapshot_id='race-snapshot'")).rows[0].n,1);
 }finally{
  // Release the accepting lock first even when an assertion fails; never strand the waiter.
  await accepting.query('ROLLBACK');
  if(mutation)await mutation;
  await member.query('ROLLBACK');accepting.release();member.release();
 }
}));


test('DBTEST-14 original unknown attachment can be reconciled once without replacement',async()=>negativeArea(async q=>{
 await transaction(client=>client.query('INSERT INTO '+q+"messages(company_id,id,conversation_id,direction,provider_message_id,current_content_version) VALUES ('company-a','pending-original','conv-a','out',NULL,1); INSERT INTO "+q+"message_versions(company_id,message_id,content_version,content) VALUES ('company-a','pending-original',1,'{}')"));
 await pool.query('INSERT INTO '+q+"attachments(company_id,id,message_id,conversation_id,connection_id,binding_epoch,external_chat_id,external_message_id,original_name,mime_type,byte_size) VALUES ('company-a','original-unknown','pending-original','conv-a','conn-a',1,'provider-chat',NULL,'synthetic.pdf','application/pdf',123)");
 await pool.query('UPDATE '+q+"messages SET provider_message_id='observed-original-id' WHERE company_id='company-a' AND id='pending-original'");
 const where=" WHERE company_id='company-a' AND id='original-unknown'";
 await expectSqlError('UPDATE '+q+"attachments SET external_message_id='contradictory-id'"+where,['23503','23514']);
 await pool.query('UPDATE '+q+"attachments SET external_message_id='observed-original-id'"+where);
 // Same-value reconciliation retry is a no-op, not a second attachment.
 await pool.query('UPDATE '+q+"attachments SET external_message_id='observed-original-id'"+where);
 for(const value of ["'rewritten-known-id'",'NULL'])await expectSqlError('UPDATE '+q+'attachments SET external_message_id='+value+where,['23514']);
 assert.deepEqual((await pool.query('SELECT id,external_message_id FROM '+q+"attachments WHERE company_id='company-a' AND message_id='pending-original'")).rows,[{id:'original-unknown',external_message_id:'observed-original-id'}]);
}));

test('DBTEST-15 accepted empty snapshot cannot be deleted and recreated to remove its seal',async()=>negativeArea(async q=>{
 const insertHeader='INSERT INTO '+q+"reply_snapshots(company_id,id,work_item_id,conversation_id,binding_epoch,assignment_version,actor_id) VALUES ('company-a','accepted-empty','work-a','conv-a',1,1,'staff-a')";
 await pool.query(insertHeader);
 await pool.query('INSERT INTO '+q+"send_operations(company_id,id,work_item_id,conversation_id,connection_id,binding_epoch,snapshot_id,actor_id,command_type,idempotency_key,payload_fingerprint,state,coverage,content,deadline) SELECT company_id,'empty-operation',work_item_id,conversation_id,connection_id,binding_epoch,'accepted-empty',actor_id,command_type,'empty-operation-key',payload_fingerprint,state,coverage,content,deadline FROM "+q+"send_operations WHERE company_id='company-a' AND id='op-a'");
 await pool.query('DELETE FROM '+q+"send_operations WHERE company_id='company-a' AND id='empty-operation'");
 await expectSqlError('DELETE FROM '+q+"reply_snapshots WHERE company_id='company-a' AND id='accepted-empty'",['23514']);
 assert.equal((await pool.query('SELECT count(*)::integer AS n FROM '+q+"reply_snapshots WHERE company_id='company-a' AND id='accepted-empty'")).rows[0].n,1);
 await expectSqlError(insertHeader,['23505']);
}));
