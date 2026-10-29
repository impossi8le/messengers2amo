import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {runMigrations} from '../src/migrate.mjs';

// Opt-in real PostgreSQL only: never target a developer/production database.
if(process.env.DB_TEST_ALLOW!=='1')throw Error('DB_TEST_OPT_IN_REQUIRED');
let target;try{target=new URL(process.env.DB_TEST_URL);}catch{throw Error('DB_TEST_TARGET_INVALID');}
if(!['postgres:','postgresql:'].includes(target.protocol)||!['127.0.0.1','localhost','[::1]'].includes(target.hostname)||target.pathname!=='/wazzup_test'||target.username!=='wazzup_test'||target.search||target.hash)throw Error('DB_TEST_TARGET_INVALID');
const pool=new pg.Pool({connectionString:target.href,max:8,connectionTimeoutMillis:5000,query_timeout:10000,statement_timeout:10000});
const identity=await pool.query("SELECT current_database() AS db,current_user AS role,current_setting('server_version_num')::integer AS version");
assert.equal(identity.rows[0].db,'wazzup_test');assert.equal(identity.rows[0].role,'wazzup_test');
assert.ok(identity.rows[0].version>=180000&&identity.rows[0].version<190000);
test.after(async()=>pool.end());

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// The lock is taken before the ledger DDL, so a visible ledger proves the
// holder still owns the lock (it is only released after the whole run).
async function waitForLedger(schema){
 const deadline=Date.now()+5000;
 while(Date.now()<deadline){
  const {rows}=await pool.query('SELECT 1 FROM pg_tables WHERE schemaname=$1 AND tablename=$2',[schema,'schema_migrations']);
  if(rows.length>0)return;
  await sleep(10);
 }
 throw Error('timed out waiting for the first migration to acquire its lock');
}
async function createSchema(){
 const schema='lock_probe_'+randomBytes(8).toString('hex');
 assert.match(schema,/^lock_probe_[a-f0-9]{16}$/);
 await pool.query('CREATE SCHEMA "'+schema+'"');
 return schema;
}
async function dropSchema(schema){await pool.query('DROP SCHEMA "'+schema+'" CASCADE');}

test('concurrent migrations of different schemas do not contend for one lock',async()=>{
 const first=await createSchema();
 const second=await createSchema();
 try{
  const slow=[{version:1,name:'slow',sql:'SELECT pg_sleep(2)'}];
  const fast=[{version:1,name:'fast',sql:'SELECT 1'}];
  const slowRun=runMigrations({pool,schema:first,migrations:slow});
  await waitForLedger(first);
  // Different schema must migrate while the first schema still holds its lock.
  assert.deepEqual(await runMigrations({pool,schema:second,migrations:fast}),{applied:[1]});
  assert.deepEqual(await slowRun,{applied:[1]});
 }finally{await dropSchema(first);await dropSchema(second);}
});

test('concurrent migrations of the same schema remain mutually exclusive',async()=>{
 const schema=await createSchema();
 try{
  const migrations=[{version:1,name:'slow',sql:'SELECT pg_sleep(2)'}];
  const first=runMigrations({pool,schema,migrations});
  await waitForLedger(schema);
  await assert.rejects(runMigrations({pool,schema,migrations}),error=>error.code==='MIGRATION_LOCK_BUSY');
  assert.deepEqual(await first,{applied:[1]});
  // Once the holder releases the same key, the schema is migratable again.
  assert.deepEqual(await runMigrations({pool,schema,migrations}),{applied:[]});
 }finally{await dropSchema(schema);}
});
