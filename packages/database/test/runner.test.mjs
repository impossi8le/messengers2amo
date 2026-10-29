import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runMigrations,MigrationError} from '../src/migrate.mjs';

// Protocol double only. These tests do not establish PostgreSQL semantics.
function fixture({ledger=[],failSql=null,lock=true,rollbackFails=false,unlockFails=false,lockFails=false,commitFails=false,releaseFails=false,failError=Error('CANARY_DB_SECRET')}={}) {
 const calls=[]; let pending=null; let released=false; let discarded=false;
 const client={async query(sql,params=[]) {calls.push({sql,params});
  if(sql.includes('pg_try_advisory_lock')&&lockFails)throw Error('CANARY_LOCK_SECRET');
  if(sql.includes('pg_try_advisory_lock')) return {rows:[{locked:lock}]};
  if(sql.includes('pg_advisory_unlock')) {if(unlockFails)throw Error('CANARY_DB_SECRET'); return {rows:[{unlocked:true}]};}
  if(sql.startsWith('SELECT version')) return {rows:structuredClone(ledger)};
  if(sql==='BEGIN'){pending=[];return {rows:[]};}
  if(sql==='COMMIT'){ledger.push(...pending);pending=null;if(commitFails)throw Error('CANARY_COMMIT_SECRET');return {rows:[]};}
  if(sql==='ROLLBACK'){if(rollbackFails)throw Error('CANARY_DB_SECRET');pending=null;return {rows:[]};}
  if(sql===failSql)throw failError;
  if(sql.startsWith('INSERT INTO')) {pending.push({version:params[0],name:params[1],checksum:params[2]});return {rows:[]};}
  return {rows:[]};
 },release(error){released=true;discarded=Boolean(error);if(releaseFails)throw Error('CANARY_RELEASE_SECRET');}};
 return {pool:{async connect(){return client;}},calls,ledger,get released(){return released;},get discarded(){return discarded;}};
}
const one={version:1,name:'first',sql:'CREATE TABLE first_table(id integer)'};
test('applies a migration and ledger in one transaction on the locked client',async()=>{
 const f=fixture(); const result=await runMigrations({pool:f.pool,migrations:[one]});
 assert.deepEqual(result.applied,[1]); assert.equal(f.ledger.length,1); assert.match(f.ledger[0].checksum,/^[a-f0-9]{64}$/);
 const q=f.calls.map(x=>x.sql); assert.ok(q.findIndex(s=>s.includes('pg_try_advisory_lock'))<q.indexOf('BEGIN'));
 assert.ok(q.indexOf('BEGIN')<q.indexOf(one.sql)); assert.ok(q.indexOf(one.sql)<q.findIndex(s=>s.startsWith('INSERT INTO')));
 assert.ok(q.findIndex(s=>s.startsWith('INSERT INTO'))<q.indexOf('COMMIT')); assert.ok(q.at(-1).includes('pg_advisory_unlock')); assert.equal(f.released,true);
});
test('reapplying matching history is a no-op',async()=>{const f=fixture();await runMigrations({pool:f.pool,migrations:[one]});f.calls.length=0;assert.deepEqual((await runMigrations({pool:f.pool,migrations:[one]})).applied,[]);assert.ok(!f.calls.some(x=>x.sql==='BEGIN'));assert.equal(f.ledger.length,1);});
// fb0a12b changed the formula from raw bytes to CRLF-normalised text. Databases
// migrated before it hold the raw hash and must upgrade instead of failing.
test('ledger written with the pre-fb0a12b raw-byte formula still upgrades',async()=>{
 const crlf={version:1,name:'first',sql:'CREATE TABLE first_table(id integer)\r\n'};
 const rawHash=createHash('sha256').update(crlf.sql,'utf8').digest('hex');
 const normalisedHash=createHash('sha256').update(crlf.sql.replace(/\r\n/g,'\n'),'utf8').digest('hex');
 assert.notEqual(rawHash,normalisedHash,'fixture must distinguish the two formulas');
 const f=fixture({ledger:[{version:1,name:'first',checksum:rawHash}]});
 assert.deepEqual(await runMigrations({pool:f.pool,migrations:[crlf]}),{applied:[]});
 assert.ok(!f.calls.some(x=>x.sql==='BEGIN'),'a legacy row must not re-run its migration');
});
test('legacy acceptance does not weaken the immutability check',async()=>{
 const crlf={version:1,name:'first',sql:'CREATE TABLE first_table(id integer)\r\n'};
 const rawHash=createHash('sha256').update(crlf.sql,'utf8').digest('hex');
 const f=fixture({ledger:[{version:1,name:'first',checksum:rawHash}]});
 await assert.rejects(runMigrations({pool:f.pool,migrations:[{...crlf,sql:crlf.sql+';'}]}),{code:'MIGRATION_HISTORY_MISMATCH'});
});
test('changed applied bytes are rejected before any new migration',async()=>{const f=fixture();await runMigrations({pool:f.pool,migrations:[one]});f.calls.length=0;await assert.rejects(runMigrations({pool:f.pool,migrations:[{...one,sql:one.sql+';'}]}),{code:'MIGRATION_HISTORY_MISMATCH'});assert.ok(!f.calls.some(x=>x.sql==='BEGIN'));});
test('missing applied migration is refused instead of silently dropping history',async()=>{const f=fixture();await runMigrations({pool:f.pool,migrations:[one]});await assert.rejects(runMigrations({pool:f.pool,migrations:[]}),{code:'MIGRATION_HISTORY_MISMATCH'});});
test('SQL failure rolls back without registering success or leaking driver text',async()=>{const f=fixture({failSql:one.sql});await assert.rejects(runMigrations({pool:f.pool,migrations:[one]}),e=>e.code==='MIGRATION_FAILED'&&!JSON.stringify(e).includes('CANARY')&&!e.message.includes('CANARY'));assert.equal(f.ledger.length,0);assert.ok(f.calls.some(x=>x.sql==='ROLLBACK'));assert.ok(!f.calls.some(x=>x.sql==='COMMIT'));assert.equal(f.released,true);});
test('busy session lock performs no DDL and releases without unlocking another owner',async()=>{const f=fixture({lock:false});await assert.rejects(runMigrations({pool:f.pool,migrations:[one]}),{code:'MIGRATION_LOCK_BUSY'});assert.equal(f.calls.length,1);assert.equal(f.released,true);});
test('failed rollback discards the client rather than returning uncertain transaction to pool',async()=>{const f=fixture({failSql:one.sql,rollbackFails:true});await assert.rejects(runMigrations({pool:f.pool,migrations:[one]}),{code:'MIGRATION_ROLLBACK_FAILED'});assert.equal(f.discarded,true);});
test('failed unlock discards the session and cannot report normal success',async()=>{const f=fixture({unlockFails:true});await assert.rejects(runMigrations({pool:f.pool,migrations:[one]}),{code:'MIGRATION_UNLOCK_FAILED'});assert.equal(f.discarded,true);});
test('unsafe schema and unordered/duplicate versions fail before connecting',async()=>{let connects=0;const pool={async connect(){connects++;throw Error('must not connect');}};for(const args of [{schema:'public;DROP DATABASE x',migrations:[one]},{migrations:[one,one]},{migrations:[{...one,version:2},one]}])await assert.rejects(runMigrations({pool,...args}),{code:'MIGRATION_INPUT_INVALID'});assert.equal(connects,0);});

test('failed advisory-lock acknowledgement discards possibly locked session',async()=>{const f=fixture({lockFails:true});await assert.rejects(runMigrations({pool:f.pool,migrations:[one]}),{code:'MIGRATION_FAILED'});assert.equal(f.discarded,true);});
test('uncertain COMMIT never reports normal success, persisted ledger supports reconciliation',async()=>{const f=fixture({commitFails:true});await assert.rejects(runMigrations({pool:f.pool,migrations:[one]}),{code:'MIGRATION_COMMIT_UNKNOWN'});assert.equal(f.ledger.length,1);assert.ok(f.calls.some(x=>x.sql==='ROLLBACK'));});

test('release failure is sanitized and cannot mask an existing safe outcome',async()=>{for(const failSql of [null,one.sql]){const f=fixture({releaseFails:true,failSql});await assert.rejects(runMigrations({pool:f.pool,migrations:[one]}),e=>e.code===(failSql?'MIGRATION_FAILED':'MIGRATION_RELEASE_FAILED')&&!e.message.includes('CANARY'));}});
test('even a forged MigrationError from a dependency cannot forward its sensitive message',async()=>{const forged=new MigrationError('MIGRATION_FAILED');forged.message='CANARY_FORGED_SECRET';const f=fixture({failSql:one.sql,failError:forged});await assert.rejects(runMigrations({pool:f.pool,migrations:[one]}),e=>e.code==='MIGRATION_FAILED'&&!e.message.includes('CANARY'));});
test('public error constructor cannot embed arbitrary caller data as an error code',()=>{const e=new MigrationError('CANARY_EXTERNAL_MESSAGE');assert.equal(e.code,'MIGRATION_FAILED');assert.equal(e.message,'MIGRATION_FAILED');});
