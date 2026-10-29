import { randomBytes } from 'node:crypto';
import { createPool, type Db } from '../../src/platform/db.ts';
import { migrateDomain } from '../../src/platform/migrate.ts';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://testuser:testpass@127.0.0.1:55440/m2a';

// Concurrency tests hold several clients at once, so the pool must stay at the
// production size; the longer acquisition timeout absorbs transient bursts
// instead of failing a test on a timing hiccup.
const TEST_POOL_OPTIONS = {
  max: 10,
  connectionTimeoutMillis: 30_000,
} as const;

export type TestDb = {
  db: Db;
  schema: string;
  close: () => Promise<void>;
};

function withSearchPath(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

export async function createTestDb(): Promise<TestDb> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  // The admin pool exists only to run migrations. Ending it immediately keeps one
  // long-lived pool per test database, so many files in sequence cannot exhaust the
  // server's connection limit.
  const admin = createPool(TEST_DATABASE_URL, TEST_POOL_OPTIONS);
  try {
    await migrateDomain(admin, schema);
  } finally {
    await admin.end();
  }
  // Application queries are unqualified; route them into the isolated schema.
  const db = createPool(withSearchPath(TEST_DATABASE_URL, schema), TEST_POOL_OPTIONS);
  return {
    db,
    schema,
    close: async () => {
      try {
        await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await db.end();
      }
    },
  };
}

export function requireTestDatabase(): void {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required for integration tests');
}
