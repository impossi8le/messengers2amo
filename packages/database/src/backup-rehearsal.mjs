import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';

const error=code=>Object.assign(new Error(code),{code});
const fixed=['--username=wazzup_test','--dbname=wazzup_test'];
function nativeExecute(file,args){
 try{return execFileSync(file,args,{encoding:'utf8',timeout:30000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});}
 catch{throw error('DB_BACKUP_COMMAND_FAILED');}
}

// This protocol owns only a synthetic schema in an explicitly selected ephemeral CI container.
export async function runBackupRehearsal({allowCI,containerId,nonce,execute=nativeExecute}={}){
 if(allowCI!==true||typeof containerId!=='string'||!/^[a-f0-9]{64}$/.test(containerId)||typeof nonce!=='string'||!/^[a-f0-9]{16}$/.test(nonce))throw error('DB_BACKUP_TARGET_INVALID');
 const schema='backup_probe_'+nonce,identifier='"'+schema+'"',archive='/tmp/'+schema+'.dump';
 const command=async(binary,args)=>{try{return await execute('docker',['exec',containerId,binary,...args]);}catch{throw error('DB_BACKUP_COMMAND_FAILED');}};
 const sql=query=>command('psql',['-X',...fixed,'--set=ON_ERROR_STOP=1','--no-align','--tuples-only','--command',query]);
 const inspect=async query=>{let output=await sql(query);try{return JSON.parse(output);}catch{throw error('DB_BACKUP_VERIFY_FAILED');}};
 const identity=await inspect("SELECT json_build_object('db',current_database(),'role',current_user,'version',current_setting('server_version_num')::integer)");
 if(!identity||identity.db!=='wazzup_test'||identity.role!=='wazzup_test'||identity.version<180000||identity.version>=190000)throw error('DB_BACKUP_TARGET_INVALID');
 let created=false,problem=null,before;
 try{
  await sql('BEGIN; CREATE SCHEMA '+identifier+'; CREATE TABLE '+identifier+'.schema_migrations(version bigint PRIMARY KEY,name text NOT NULL,checksum text NOT NULL,applied_at timestamptz NOT NULL); INSERT INTO '+identifier+".schema_migrations VALUES (1,'synthetic_backup',repeat('a',64),'2026-01-01T00:00:00Z'); CREATE TABLE "+identifier+'.probe(id integer PRIMARY KEY,value text NOT NULL CHECK (length(value)>0)); INSERT INTO '+identifier+".probe VALUES (1,'synthetic-1'),(2,'synthetic-2'); COMMIT");
  created=true;
  const readSnapshot="SELECT json_build_object('ledger',(SELECT json_agg(row_to_json(m) ORDER BY version) FROM "+identifier+".schema_migrations m),'rows',(SELECT json_agg(row_to_json(p) ORDER BY id) FROM "+identifier+".probe p),'constraints',(SELECT json_agg(pg_get_constraintdef(c.oid) ORDER BY pg_get_constraintdef(c.oid)) FROM pg_constraint c WHERE c.conrelid='"+identifier+".probe'::regclass))";
  before=await inspect(readSnapshot);
  if(!Array.isArray(before?.rows)||before.rows.length!==2||!Array.isArray(before?.ledger)||before.ledger.length!==1||!Array.isArray(before?.constraints)||before.constraints.length<2)throw error('DB_BACKUP_VERIFY_FAILED');
  await command('pg_dump',[...fixed,'--schema='+schema,'--format=custom','--no-owner','--no-privileges','--file='+archive]);
  await sql('DROP SCHEMA '+identifier+' CASCADE');
  await command('pg_restore',[...fixed,'--exit-on-error','--no-owner','--no-privileges',archive]);
  const after=await inspect(readSnapshot);
  if(!isDeepStrictEqual(before,after))throw error('DB_BACKUP_VERIFY_FAILED');
 }catch(caught){problem=caught?.code==='DB_BACKUP_VERIFY_FAILED'?error('DB_BACKUP_VERIFY_FAILED'):error('DB_BACKUP_COMMAND_FAILED');}
 finally{
  if(created){try{await sql('DROP SCHEMA IF EXISTS '+identifier+' CASCADE');}catch{problem??=error('DB_BACKUP_CLEANUP_FAILED');}}
 }
 if(problem)throw problem;
 return {restored:true,rows:before.rows.length,migrations:before.ledger.length,constraints:before.constraints.length};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const result=await runBackupRehearsal({allowCI:process.env.GITHUB_ACTIONS==='true'&&process.env.DB_TEST_ALLOW==='1',containerId:process.env.DB_RESTORE_CONTAINER,nonce:randomBytes(8).toString('hex')});
  console.log(JSON.stringify({event:'database.backup_rehearsal',outcome:'succeeded',...result}));
 }catch(caught){console.error(JSON.stringify({event:'database.backup_rehearsal',outcome:'failed',errorCode:['DB_BACKUP_TARGET_INVALID','DB_BACKUP_VERIFY_FAILED','DB_BACKUP_COMMAND_FAILED','DB_BACKUP_CLEANUP_FAILED'].includes(caught?.code)?caught.code:'DB_BACKUP_COMMAND_FAILED'}));process.exitCode=1;}
}
