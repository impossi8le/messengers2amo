// Local fixture only. Never writes to an existing schema. No application starts.
// DATABASE_URL must explicitly point to loopback; --inspect is read-only.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { migrateDomain } from '../../../../apps/api/src/platform/migrate.ts';
const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const { Pool } = require('pg');
const url = new URL(process.env.DATABASE_URL || 'invalid:');
if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
  throw new Error('Explicit loopback DATABASE_URL required');
}
const pool = new Pool({ connectionString: url.href, max: 2, connectionTimeoutMillis: 10000 });
try {
  if (process.argv[2] === '--inspect' && process.argv.length === 3) {
    console.log((await pool.query("SELECT version(), current_database(), current_setting('data_directory') AS data_directory")).rows);
  } else {
    const schema = process.argv[3];
    if (process.argv.length !== 4 || process.argv[2] !== '--schema' ||
        !/^rehearsal_[a-z0-9_]{1,40}$/.test(schema)) throw new Error('Usage: --schema rehearsal_UNIQUE_NAME');
    // CREATE fails if the schema exists. No cleanup of pre-existing data.
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const applied = await migrateDomain(pool, schema);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path TO "${schema}", pg_catalog`);
      await client.query(await readFile(new URL('./seed-restore-rehearsal.sql', import.meta.url), 'utf8'));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
    console.log(JSON.stringify({ schema, applied, companies: 3, connections: 6, conversations: 60, messages: 6000 }));
  }
} finally { await pool.end(); }
