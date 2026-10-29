import test from 'node:test';
import assert from 'node:assert/strict';
import {runBackupRehearsal} from '../src/backup-rehearsal.mjs';
const containerId='a'.repeat(64),nonce='0123456789abcdef';
const snapshot={ledger:[{version:1,name:'synthetic_backup',checksum:'a'.repeat(64)}],rows:[{id:1,value:'synthetic-1'},{id:2,value:'synthetic-2'}],constraints:['CHECK ((length(value) > 0))','PRIMARY KEY (id)']};
function fixture({changed=false,wrongTarget=false,failDump=false}={}){
 const calls=[];let inspect=0;
 const execute=async(file,args)=>{calls.push({file,args});
  if(args.includes('pg_dump')&&failDump)throw Error('CANARY_COMMAND_SECRET');
  const sql=args.at(-1);
  if(typeof sql==='string'&&sql.includes('current_database()'))return JSON.stringify({db:wrongTarget?'other':'wazzup_test',role:'wazzup_test',version:180000});
  if(typeof sql==='string'&&sql.includes("json_build_object('ledger'")){inspect++;return JSON.stringify(changed&&inspect===2?{...snapshot,rows:[]}:snapshot);}
  return '';
 };
 return {calls,execute};
}
test('backup rehearsal validates CI opt-in and container/name before invoking any process',async()=>{for(const args of [{allowCI:false,containerId,nonce},{allowCI:true,containerId:'--privileged',nonce},{allowCI:true,containerId,nonce:'bad;DROP'}]){const f=fixture();await assert.rejects(runBackupRehearsal({...args,execute:f.execute}),{code:'DB_BACKUP_TARGET_INVALID'});assert.equal(f.calls.length,0);}});
test('backup uses argv commands and restores/verifies synthetic rows ledger and constraints',async()=>{const f=fixture();const result=await runBackupRehearsal({allowCI:true,containerId,nonce,execute:f.execute});assert.deepEqual(result,{restored:true,rows:2,migrations:1,constraints:2});assert.ok(f.calls.every(c=>c.file==='docker'&&Array.isArray(c.args)&&c.args[0]==='exec'&&c.args[1]===containerId));const dump=f.calls.findIndex(c=>c.args.includes('pg_dump'));const restore=f.calls.findIndex(c=>c.args.includes('pg_restore'));const drop=f.calls.findIndex(c=>c.args.at(-1).startsWith('DROP SCHEMA'));assert.ok(dump>=0&&drop>dump&&restore>drop);assert.ok(f.calls[dump].args.includes('--format=custom'));assert.ok(f.calls[restore].args.includes('--exit-on-error'));});
test('restore mismatch refuses success',async()=>{const f=fixture({changed:true});await assert.rejects(runBackupRehearsal({allowCI:true,containerId,nonce,execute:f.execute}),{code:'DB_BACKUP_VERIFY_FAILED'});});
test('wrong database identity causes no schema creation or dump',async()=>{const f=fixture({wrongTarget:true});await assert.rejects(runBackupRehearsal({allowCI:true,containerId,nonce,execute:f.execute}),{code:'DB_BACKUP_TARGET_INVALID'});assert.equal(f.calls.length,1);});
test('dump command failures do not leak command errors or attempt restore',async()=>{const f=fixture({failDump:true});await assert.rejects(runBackupRehearsal({allowCI:true,containerId,nonce,execute:f.execute}),e=>e.code==='DB_BACKUP_COMMAND_FAILED'&&!e.message.includes('CANARY'));assert.ok(!f.calls.some(c=>c.args.includes('pg_restore')));assert.ok(f.calls.some(c=>c.args.at(-1).startsWith('DROP SCHEMA IF EXISTS')));});
test('invalid JSON from inspection is sanitized',async()=>{await assert.rejects(runBackupRehearsal({allowCI:true,containerId,nonce,execute:async()=> 'CANARY_INVALID_JSON'}),e=>e.code==='DB_BACKUP_VERIFY_FAILED'&&!e.message.includes('CANARY'));});

test('identity inspection requests JSON from psql instead of parsing a tabular row as JSON',async()=>{const f=fixture();await runBackupRehearsal({allowCI:true,containerId,nonce,execute:f.execute});assert.match(f.calls[0].args.at(-1),/^SELECT json_build_object\('db'/);});
