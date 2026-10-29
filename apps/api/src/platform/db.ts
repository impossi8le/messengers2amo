import pg from 'pg';

const { Pool } = pg;

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export type PoolOptions = {
  /** Upper bound on simultaneous connections; tests lower this to stay inside server limits. */
  max?: number;
  connectionTimeoutMillis?: number;
};

export function createPool(databaseUrl: string, options: PoolOptions = {}): Db {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    application_name: 'messengers2amo-api',
  });
  return pool;
}

export async function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // rollback failure must not mask the original error
    }
    throw error;
  } finally {
    client.release();
  }
}
