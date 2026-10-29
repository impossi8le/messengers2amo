// One-shot migration entrypoint for the messengers2amo production image.
//
// Runs the transactional, advisory-lock migration runner from
// packages/database/src/migrate.mjs against the domain schema, then exits.
// Invoked as a separate compose service (profile `migrate`) so that the API
// never applies DDL on startup and so that two replicas cannot race.
//
// Contract:
//   DATABASE_URL  required, postgresql:// URL of the target database
//   M2A_SCHEMA    optional, defaults to `messengers2amo`
//
// Exit code 0 = schema is at the expected version. Non-zero = do not start API.
// Never prints DATABASE_URL, SQL bodies or driver messages: only a safe code.

import pg from 'pg';
import { runMigrations } from '../../../packages/database/src/migrate.mjs';
// Single source of truth for the migration list: the same module the API and
// its tests use. It covers shared 001..004 (packages/database) and
// application-owned 005..007 (apps/api/migrations). Do not maintain a second
// list here — a divergence would produce a checksum mismatch in the ledger.
import { loadDomainMigrations } from '../../../apps/api/src/platform/migrate.ts';

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
const SAFE_CODES = new Set([
  'MIGRATION_INPUT_INVALID',
  'MIGRATION_CONNECTION_FAILED',
  'MIGRATION_LOCK_BUSY',
  'MIGRATION_HISTORY_MISMATCH',
  'MIGRATION_FAILED',
  'MIGRATION_ROLLBACK_FAILED',
  'MIGRATION_COMMIT_UNKNOWN',
  'MIGRATION_UNLOCK_FAILED',
  'MIGRATION_RELEASE_FAILED',
  'MIGRATION_SESSION_DISCARDED',
]);

function emit(outcome, fields) {
  process.stdout.write(JSON.stringify({ event: 'database.migrations', outcome, ...fields }) + '\n');
}

async function ensureSchema(pool, schema) {
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  } finally {
    client.release();
  }
}

async function main() {
  const schema = process.env.M2A_SCHEMA || 'messengers2amo';
  const databaseUrl = process.env.DATABASE_URL || '';

  if (!databaseUrl) {
    emit('failed', { errorCode: 'DATABASE_URL_MISSING' });
    return 1;
  }
  if (!SCHEMA_PATTERN.test(schema)) {
    emit('failed', { errorCode: 'SCHEMA_INVALID' });
    return 1;
  }

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 10_000,
    application_name: 'messengers2amo-migrate',
  });

  try {
    try {
      await ensureSchema(pool, schema);
    } catch {
      emit('failed', { schema, errorCode: 'MIGRATION_CONNECTION_FAILED' });
      return 1;
    }

    const migrations = await loadDomainMigrations(schema);
    const { applied } = await runMigrations({ pool, migrations, schema });
    emit('succeeded', { schema, applied, expected: migrations.map((m) => m.version) });
    return 0;
  } catch (error) {
    const code = SAFE_CODES.has(error?.code) ? error.code : 'MIGRATION_FAILED';
    emit('failed', { schema, errorCode: code });
    return 1;
  } finally {
    // Pool teardown failure must not turn a successful migration into a failed job.
    await pool.end().catch(() => undefined);
  }
}

process.exitCode = await main();
