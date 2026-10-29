import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Db } from './db.ts';

export type Migration = { version: number; name: string; sql: string };

type MigrationSource = { version: number; name: string; file: string; base: string };

const PACKAGE_MIGRATIONS_BASE = '../../../../packages/database/migrations/';
const APP_MIGRATIONS_BASE = '../../migrations/';

// Package migrations are the shared domain foundation; app migrations are owned by
// this service. Both are applied in version order through the same ledger.
const MIGRATIONS: MigrationSource[] = [
  { version: 1, name: 'core_v2', file: '001-core.sql', base: PACKAGE_MIGRATIONS_BASE },
  { version: 2, name: 'core_v2_hardening', file: '002-hardening.sql', base: PACKAGE_MIGRATIONS_BASE },
  { version: 3, name: 'provider_receipts', file: '003-receipts.sql', base: PACKAGE_MIGRATIONS_BASE },
  { version: 4, name: 'receipt_proof_guards', file: '004-proof-guards.sql', base: PACKAGE_MIGRATIONS_BASE },
  { version: 5, name: 'auth', file: '005-auth.sql', base: APP_MIGRATIONS_BASE },
  { version: 6, name: 'amocrm', file: '006-amocrm.sql', base: APP_MIGRATIONS_BASE },
  { version: 7, name: 'attention_assignment', file: '007-attention-assignment.sql', base: APP_MIGRATIONS_BASE },
  { version: 8, name: 'operator_read', file: '008-operator-read.sql', base: APP_MIGRATIONS_BASE },
  { version: 9, name: 'amocrm_workflow', file: '009-amocrm-workflow.sql', base: APP_MIGRATIONS_BASE },
  { version: 10, name: 'workshops', file: '010-workshops.sql', base: APP_MIGRATIONS_BASE },
  { version: 11, name: 'migration_inventory', file: '011-migration-inventory.sql', base: APP_MIGRATIONS_BASE },
  { version: 12, name: 'migration_pilot', file: '012-migration-pilot.sql', base: APP_MIGRATIONS_BASE },
  { version: 13, name: 'metrics_indexes', file: '013-metrics-indexes.sql', base: APP_MIGRATIONS_BASE },
  { version: 14, name: 'route_routing', file: '014-route-routing.sql', base: APP_MIGRATIONS_BASE },
  { version: 15, name: 'channel_alerts', file: '015-channel-alerts.sql', base: APP_MIGRATIONS_BASE },
  { version: 16, name: 'connection_name', file: '016-connection-name.sql', base: APP_MIGRATIONS_BASE },
  { version: 17, name: 'crm_directory', file: '017-crm-directory.sql', base: APP_MIGRATIONS_BASE },
  { version: 18, name: 'amocrm_files', file: '018-amocrm-files.sql', base: APP_MIGRATIONS_BASE },
  { version: 19, name: 'message_references', file: '019-message-references.sql', base: APP_MIGRATIONS_BASE },
  { version: 20, name: 'outbound_files', file: '020-outbound-files.sql', base: APP_MIGRATIONS_BASE },
];

/** The ledger this service expects, without reading any migration file. */
export const MIGRATION_LEDGER: ReadonlyArray<{ version: number; name: string }> = MIGRATIONS.map(
  ({ version, name }) => ({ version, name }),
);

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export async function loadDomainMigrations(schema: string): Promise<Migration[]> {
  if (!SCHEMA_PATTERN.test(schema)) throw new Error('INVALID_SCHEMA');
  const out: Migration[] = [];
  for (const migration of MIGRATIONS) {
    const base = new URL(migration.base, import.meta.url);
    const sql = await readFile(new URL(migration.file, base), 'utf8');
    out.push({ version: migration.version, name: migration.name, sql: sql.replaceAll('__SCHEMA__', `"${schema}"`) });
  }
  return out;
}

export function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export async function migrateDomain(db: Db, schema: string): Promise<number[]> {
  const migrations = await loadDomainMigrations(schema);
  const client = await db.connect();
  const applied: number[] = [];
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS "${schema}".schema_migrations (
         version bigint PRIMARY KEY,
         name text NOT NULL,
         checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
         applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const { rows } = await client.query<{ version: string }>(
      `SELECT version FROM "${schema}".schema_migrations ORDER BY version`,
    );
    const done = new Set(rows.map((row) => Number(row.version)));
    for (const migration of migrations) {
      if (done.has(migration.version)) continue;
      await client.query(migration.sql);
      await client.query(
        `INSERT INTO "${schema}".schema_migrations (version, name, checksum) VALUES ($1,$2,$3)`,
        [migration.version, migration.name, checksum(migration.sql)],
      );
      applied.push(migration.version);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return applied;
}
