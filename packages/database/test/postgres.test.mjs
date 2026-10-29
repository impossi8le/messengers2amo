import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {runMigrations} from '../src/migrate.mjs';

// Explicit test-only opt-in; no skip on absent database or wrong environment.
if(process.env.DB_TEST_ALLOW!=='1')throw Error('DB_TEST_OPT_IN_REQUIRED');
let target;
try{target=new URL(process.env.DB_TEST_URL);}catch{throw Error('DB_TEST_TARGET_INVALID');}
if(!['postgres:','postgresql:'].includes(target.protocol)||!['127.0.0.1','localhost','[::1]'].includes(target.hostname)||target.pathname!=='/wazzup_test'||target.username!=='wazzup_test'||target.search||target.hash)throw Error('DB_TEST_TARGET_INVALID');
const pool=new pg.Pool({connectionString:target.href,max:4,connectionTimeoutMillis:5000,query_timeout:10000,statement_timeout:10000});
const initial=await pool.query("SELECT current_database() AS db,current_user AS role,current_setting('server_version_num')::integer AS version");
assert.equal(initial.rows[0].db,'wazzup_test');assert.equal(initial.rows[0].role,'wazzup_test');assert.ok(initial.rows[0].version>=180000&&initial.rows[0].version<190000,'PostgreSQL 18 required');
test.after(async()=>{await pool.end();});
async function inSchema(action){
 const schema='test_runner_'+randomBytes(8).toString('hex');
 assert.match(schema,/^test_runner_[a-f0-9]{16}$/);
 await pool.query('CREATE SCHEMA "'+schema+'"');
 try{await action(schema);}finally{await pool.query('DROP SCHEMA "'+schema+'" CASCADE');}
}
const migration=schema=>({version:1,name:'create_probe',sql:'CREATE TABLE "'+schema+'".probe(id integer PRIMARY KEY, value text NOT NULL); INSERT INTO "'+schema+'".probe VALUES (1,$value$synthetic$value$)'});
test('real PG18 applies once and refuses changed/missing applied history',async()=>inSchema(async schema=>{
 const m=migration(schema);
 assert.deepEqual((await runMigrations({pool,schema,migrations:[m]})).applied,[1]);
 assert.deepEqual((await runMigrations({pool,schema,migrations:[m]})).applied,[]);
 assert.equal((await pool.query('SELECT count(*)::integer AS n FROM "'+schema+'".probe')).rows[0].n,1);
 await assert.rejects(runMigrations({pool,schema,migrations:[{...m,sql:m.sql+';'}]}),{code:'MIGRATION_HISTORY_MISMATCH'});
 await assert.rejects(runMigrations({pool,schema,migrations:[]}),{code:'MIGRATION_HISTORY_MISMATCH'});
}));
test('real PG18 rolls back failing transactional DDL and its ledger entry',async()=>inSchema(async schema=>{
 const m={version:1,name:'fail_after_ddl',sql:'CREATE TABLE "'+schema+'".rolled_back(id integer); SELECT 1/0'};
 await assert.rejects(runMigrations({pool,schema,migrations:[m]}),{code:'MIGRATION_FAILED'});
 assert.equal((await pool.query('SELECT to_regclass($1) AS relation',[schema+'.rolled_back'])).rows[0].relation,null);
 assert.equal((await pool.query('SELECT count(*)::integer AS n FROM "'+schema+'".schema_migrations')).rows[0].n,0);
 assert.deepEqual((await runMigrations({pool,schema,migrations:[migration(schema)]})).applied,[1]);
}));
test('two real PG18 runners contend deterministically and never apply twice',{timeout:20000},async()=>inSchema(async schema=>{
 const gate='704422809372';
 const blocker=await pool.connect();
 await blocker.query('SELECT pg_advisory_lock($1::bigint)',[gate]);
 const m=migration(schema);m.sql='SELECT pg_advisory_xact_lock('+gate+'::bigint); '+m.sql;
 let signal;
 const started=new Promise(resolve=>{signal=resolve;});
 const firstPool={async connect(){const real=await pool.connect();return {query(sql,params){if(sql===m.sql)signal();return real.query(sql,params);},release(error){real.release(error);}};}};
 let first;
 try{
  first=runMigrations({pool:firstPool,schema,migrations:[m]});
  await Promise.race([started,first.then(()=>{throw Error('MIGRATION_BARRIER_NOT_REACHED');})]);
  await assert.rejects(runMigrations({pool,schema,migrations:[m]}),{code:'MIGRATION_LOCK_BUSY'});
 }finally{
  try{await blocker.query('SELECT pg_advisory_unlock($1::bigint)',[gate]);}finally{blocker.release();}
  if(first)await first;
 }
 assert.deepEqual((await runMigrations({pool,schema,migrations:[m]})).applied,[]);
 assert.equal((await pool.query('SELECT count(*)::integer AS n FROM "'+schema+'".schema_migrations')).rows[0].n,1);
 assert.equal((await pool.query('SELECT count(*)::integer AS n FROM "'+schema+'".probe')).rows[0].n,1);
}));
