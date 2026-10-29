import {createHash} from 'node:crypto';

// Advisory locks are database-wide, so the key is derived from the schema name:
// migrations of one schema still serialize, while independent schemas do not
// contend. sha256 gives a deterministic, effectively collision-free signed
// 64-bit key accepted by pg_advisory_lock(bigint).
function lockKey(schema){return createHash('sha256').update('schema_migrations:'+schema,'utf8').digest().readBigInt64BE(0).toString();}
// Line endings are not part of a migration's meaning. The same file reaches the
// server as CRLF when it is packaged on Windows and as LF from a Linux checkout or
// a git archive, so a ledger row may legitimately hold the hash of either form.
// Both are accepted for an already-applied row; new rows record the LF hash.
// Anything that changes the SQL itself still matches neither and is rejected.
const canonicalSql=sql=>sql.replace(/\r\n/g,'\n');
const crlfSql=sql=>canonicalSql(sql).replace(/\n/g,'\r\n');
const SAFE_CODES=new Set(['MIGRATION_INPUT_INVALID','MIGRATION_CONNECTION_FAILED','MIGRATION_LOCK_BUSY','MIGRATION_HISTORY_MISMATCH','MIGRATION_FAILED','MIGRATION_ROLLBACK_FAILED','MIGRATION_COMMIT_UNKNOWN','MIGRATION_UNLOCK_FAILED','MIGRATION_RELEASE_FAILED','MIGRATION_SESSION_DISCARDED']);
export class MigrationError extends Error {
 constructor(code){const safe=SAFE_CODES.has(code)?code:'MIGRATION_FAILED';super(safe);this.name='MigrationError';this.code=safe;}
}
const failure=code=>new MigrationError(code);

function prepare(migrations,schema){
 if(!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)||!Array.isArray(migrations))throw failure('MIGRATION_INPUT_INVALID');
 let previous=0;
 return migrations.map(m=>{
  if(!m||!Number.isSafeInteger(m.version)||m.version<=previous||typeof m.name!=='string'||!m.name.trim()||m.name.length>128||typeof m.sql!=='string'||!m.sql.trim())throw failure('MIGRATION_INPUT_INVALID');
  previous=m.version;
  const hash=sql=>createHash('sha256').update(sql,'utf8').digest('hex');
  // `checksum` is what a new row records. `legacyChecksum` is only ever accepted
  // for rows already in the ledger, so a database migrated from a Windows package
  // or from an older runner upgrades in place instead of failing.
  return {...m,checksum:hash(canonicalSql(m.sql)),legacyChecksum:hash(crlfSql(m.sql))};
 });
}

/** Trusted transactional SQL only. Never pass customer/provider SQL here.
 * Uses one dedicated client for the session lock, history and all transactions.
 * Contention fails fast: caller can retry this local migration command later.
 */
export async function runMigrations({pool,migrations,schema='public'}={}){
 const planned=prepare(migrations,schema);
 if(!pool||typeof pool.connect!=='function')throw failure('MIGRATION_INPUT_INVALID');
 const key=lockKey(schema);
 const ledger='"'+schema+'"."schema_migrations"';
 let client;
 try {client=await pool.connect();}catch{throw failure('MIGRATION_CONNECTION_FAILED');}
 let locked=false,acquiring=false,inTransaction=false,committing=false,discard=false,error=null;
 const applied=[];
 try{
  acquiring=true;
  const lock=await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked',[key]);
  acquiring=false;
  if(lock.rows[0]?.locked!==true)throw failure('MIGRATION_LOCK_BUSY');
  locked=true;
  await client.query("CREATE TABLE IF NOT EXISTS "+ledger+" (version bigint PRIMARY KEY, name text NOT NULL, checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'), applied_at timestamptz NOT NULL DEFAULT now())");
  const {rows}=await client.query('SELECT version, name, checksum FROM '+ledger+' ORDER BY version');
  const matchesApplied=(row,i)=>Number(row.version)===planned[i]?.version&&row.name===planned[i]?.name&&(row.checksum===planned[i]?.checksum||row.checksum===planned[i]?.legacyChecksum);
  if(rows.length>planned.length||rows.some((row,i)=>!matchesApplied(row,i)))throw failure('MIGRATION_HISTORY_MISMATCH');
  for(const migration of planned.slice(rows.length)){
   inTransaction=true;
   await client.query('BEGIN');
   await client.query(migration.sql);
   await client.query('INSERT INTO '+ledger+' (version,name,checksum) VALUES ($1,$2,$3)',[migration.version,migration.name,migration.checksum]);
   committing=true;
   await client.query('COMMIT');
   committing=false;
   inTransaction=false;
   applied.push(migration.version);
  }
 }catch(caught){
  if(acquiring)discard=true;
  if(committing){discard=true;error=failure('MIGRATION_COMMIT_UNKNOWN');}
  else error=caught instanceof MigrationError?failure(caught.code):failure('MIGRATION_FAILED');
  if(inTransaction){
   try{await client.query('ROLLBACK');inTransaction=false;}catch{discard=true;if(!committing)error=failure('MIGRATION_ROLLBACK_FAILED');}
  }
 }finally{
  if(locked&&!discard){
   try{const unlocked=await client.query('SELECT pg_advisory_unlock($1::bigint) AS unlocked',[key]);if(unlocked.rows[0]?.unlocked!==true)throw Error();}
   catch{discard=true;error??=failure('MIGRATION_UNLOCK_FAILED');}
  }
  try{client.release(discard?failure('MIGRATION_SESSION_DISCARDED'):undefined);}
  catch{error??=failure('MIGRATION_RELEASE_FAILED');}
 }
 if(error)throw error;
 return {applied};
}
