import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { redact, logEvent } from '../src/platform/logger.ts';
import { createPasswordRecord, verifyPassword, issueSession, decodeSession, encodeSession } from '../src/platform/auth.ts';
import { loadDomainMigrations } from '../src/platform/migrate.ts';

test('migrations create the full domain schema and are idempotent', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const { rows } = await db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM information_schema.tables WHERE table_schema = $1`,
      [schema],
    );
    assert.ok(rows[0]!.c >= 38, `expected >= 38 tables, got ${rows[0]!.c}`);
    const again = await db.query<{ version: string }>(`SELECT version FROM "${schema}".schema_migrations ORDER BY version`);
    // Every registered migration must be applied exactly once; the list grows with the
    // service, so the expectation is derived from the registry rather than hardcoded.
    const registered = (await loadDomainMigrations(schema)).map((migration) => migration.version);
    assert.deepEqual(again.rows.map((r) => Number(r.version)), registered);
  } finally {
    await close();
  }
});

test('logger redacts secrets and message text', () => {
  const lines: string[] = [];
  logEvent('info', 'test.event', { token: 'abc', text: 'hello', nested: { authorization: 'Bearer x', ok: 1 } }, (l) => lines.push(l));
  const parsed = JSON.parse(lines[0]!);
  assert.equal(parsed.token, '[redacted]');
  assert.equal(parsed.text, '[redacted]');
  assert.equal(parsed.nested.authorization, '[redacted]');
  assert.equal(parsed.nested.ok, 1);
  assert.equal(redact('short'), 'short');
});

test('sessions are signed, expire and reject tampering', () => {
  const secret = 'x'.repeat(40);
  const token = issueSession(
    secret,
    { sessionId: 'sess_test', staffId: 's1', companyId: 'c1', role: 'send', workshopId: null, epoch: 1 },
    60,
  );
  const decoded = decodeSession(secret, token);
  assert.equal(decoded?.staffId, 's1');
  assert.equal(decoded?.sessionId, 'sess_test');
  assert.equal(decodeSession(secret, token + 'x'), null);
  assert.equal(decodeSession(secret, token, Date.now() + 61_000), null);

  // A token without a server-side session id can never authenticate.
  const legacy = encodeSession(secret, {
    staffId: 's1',
    companyId: 'c1',
    role: 'send',
    workshopId: null,
    epoch: 1,
    expiresAt: Date.now() + 60_000,
  } as unknown as Parameters<typeof encodeSession>[1]);
  assert.equal(decodeSession(secret, legacy), null);
});

test('password verification rejects wrong secrets', async () => {
  const record = await createPasswordRecord('correct horse battery');
  assert.equal(await verifyPassword('correct horse battery', record.salt, record.hash), true);
  assert.equal(await verifyPassword('wrong', record.salt, record.hash), false);
});
