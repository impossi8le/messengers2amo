import { readFile } from 'node:fs/promises';

const MIGRATIONS = [
  {version: 1, name: 'core_v2', url: new URL('../migrations/001-core.sql', import.meta.url)},
  {version: 2, name: 'core_v2_hardening', url: new URL('../migrations/002-hardening.sql', import.meta.url)},
  {version: 3, name: 'provider_receipts', url: new URL('../migrations/003-receipts.sql', import.meta.url)},
  {version: 4, name: 'receipt_proof_guards', url: new URL('../migrations/004-proof-guards.sql', import.meta.url)},
];

export async function domainMigrations(schema) {
  if (typeof schema !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    throw new Error('INVALID_SCHEMA');
  }
  return Promise.all(MIGRATIONS.map(async ({version, name, url}) => ({
    version,
    name,
    sql: (await readFile(url, 'utf8')).replaceAll('__SCHEMA__', '"' + schema + '"'),
  })));
}

export default domainMigrations;
