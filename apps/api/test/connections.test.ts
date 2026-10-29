import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { createTestApp, cookieFromResponse } from './helpers/app.ts';
import { seedCompany } from './helpers/seed.ts';

const PASSWORD = 'correct horse battery staple';
const CRED = 'credref_live_secret_value_123';

async function login(app: FastifyInstance, companyId: string, staffId: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v2/auth/login',
    payload: { companyId, staffId, password: PASSWORD },
  });
  assert.equal(response.statusCode, 200, response.body);
  return cookieFromResponse(response);
}

function projectionKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort();
}

test('connection creation returns a secret-free projection, audits atomically and replays idempotently', async () => {
  const { app, db, close } = await createTestApp();
  try {
    await seedCompany(db, { companyId: 'c1', staff: [{ id: 'manager', password: PASSWORD, role: 'manage' }] });
    const cookie = await login(app, 'c1', 'manager');

    const payload = { idempotencyKey: 'create-1', channelMode: 'telegram_bot', credentialRef: CRED };
    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/connections',
      headers: { cookie },
      payload,
    });
    assert.equal(created.statusCode, 202, created.body);
    const body = created.json() as Record<string, unknown>;
    assert.deepEqual(projectionKeys(body), [
      'bindingEpoch',
      'capabilities',
      'channelMode',
      'credentialsVersion',
      'health',
      'id',
      'ingressEnabled',
      'sendEnabled',
      'state',
      'version',
    ]);
    assert.equal(body.state, 'setup');
    assert.equal(body.version, 0);
    assert.equal(body.bindingEpoch, 0);
    assert.equal(body.ingressEnabled, false);
    assert.equal(body.sendEnabled, false);
    assert.equal(created.body.includes(CRED), false);
    assert.equal(created.body.toLowerCase().includes('credentialref'), false);
    assert.equal(created.body.toLowerCase().includes('credential_ref'), false);

    const connectionId = body.id as string;
    const { rows } = await db.query<{ credential_ref: string; state: string }>(
      `SELECT credential_ref, state FROM connections WHERE company_id='c1' AND id=$1`,
      [connectionId],
    );
    assert.equal(rows[0]!.credential_ref, CRED);
    assert.equal(rows[0]!.state, 'setup');

    const audits = await db.query<{ event_name: string; subject_id: string; actor_id: string }>(
      `SELECT event_name, subject_id, actor_id FROM audit_events WHERE company_id='c1'`,
    );
    assert.equal(audits.rows.length, 1);
    assert.equal(audits.rows[0]!.event_name, 'connection.created');
    assert.equal(audits.rows[0]!.subject_id, connectionId);
    assert.equal(audits.rows[0]!.actor_id, 'manager');

    // Same key and payload: replay of the same resource, no second mutation or audit row.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/connections',
      headers: { cookie },
      payload,
    });
    assert.equal(replay.statusCode, 202);
    assert.equal((replay.json() as { id: string }).id, connectionId);
    const auditCount = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM audit_events WHERE company_id='c1'`);
    assert.equal(auditCount.rows[0]!.c, 1);
    const connectionCount = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM connections WHERE company_id='c1'`);
    assert.equal(connectionCount.rows[0]!.c, 1);

    // Same key, different payload: hard conflict, nothing mutated.
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/connections',
      headers: { cookie },
      payload: { ...payload, channelMode: 'whatsapp_cloud' },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal((conflict.json() as { code: string }).code, 'IDEMPOTENCY_CONFLICT');
  } finally {
    await close();
  }
});

test('lifecycle and credential rotation are version-checked and never expose the credential reference', async () => {
  const { app, db, close } = await createTestApp();
  try {
    await seedCompany(db, { companyId: 'c1', staff: [{ id: 'manager', password: PASSWORD, role: 'manage' }] });
    const cookie = await login(app, 'c1', 'manager');
    const create = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/connections',
      headers: { cookie },
      payload: { idempotencyKey: 'create-1', channelMode: 'telegram_bot', credentialRef: CRED },
    });
    const id = (create.json() as { id: string }).id;

    const activate = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/connections/${id}/lifecycle`,
      headers: { cookie },
      payload: { idempotencyKey: 'life-1', expectedVersion: 0, desiredState: 'active' },
    });
    assert.equal(activate.statusCode, 202, activate.body);
    const activated = activate.json() as { state: string; version: number; ingressEnabled: boolean; sendEnabled: boolean };
    assert.equal(activated.state, 'active');
    assert.equal(activated.version, 1);
    assert.equal(activated.ingressEnabled, true);
    assert.equal(activated.sendEnabled, true);

    const stale = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/connections/${id}/lifecycle`,
      headers: { cookie },
      payload: { idempotencyKey: 'life-2', expectedVersion: 0, desiredState: 'paused' },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal((stale.json() as { code: string }).code, 'VERSION_CONFLICT');

    const rotate = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/connections/${id}/credentials-reference`,
      headers: { cookie },
      payload: { idempotencyKey: 'cred-1', expectedVersion: 1, credentialRef: 'credref_rotated_456' },
    });
    assert.equal(rotate.statusCode, 202, rotate.body);
    const rotated = rotate.json() as Record<string, unknown>;
    assert.equal(rotated.version, 2);
    assert.equal(rotated.credentialsVersion, 2);
    assert.equal(rotate.body.includes('credref_rotated_456'), false);
    assert.equal(rotate.body.toLowerCase().includes('credentialref'), false);

    const stored = await db.query<{ credential_ref: string; credentials_version: string }>(
      `SELECT credential_ref, credentials_version FROM connections WHERE company_id='c1' AND id=$1`,
      [id],
    );
    assert.equal(stored.rows[0]!.credential_ref, 'credref_rotated_456');
    assert.equal(Number(stored.rows[0]!.credentials_version), 2);

    const audits = await db.query<{ event_name: string }>(
      `SELECT event_name FROM audit_events WHERE company_id='c1' AND subject_id=$1 ORDER BY recorded_at`,
      [id],
    );
    assert.deepEqual(audits.rows.map((r) => r.event_name), [
      'connection.created',
      'connection.lifecycle_changed',
      'connection.credentials_rotated',
    ]);

    const list = await app.inject({ method: 'GET', url: '/api/v2/operator/connections', headers: { cookie } });
    assert.equal(list.statusCode, 200);
    assert.equal(list.body.includes('credref_'), false);
  } finally {
    await close();
  }
});

test('a failed audit write rolls the connection change back', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    await seedCompany(db, { companyId: 'c1', staff: [{ id: 'manager', password: PASSWORD, role: 'manage' }] });
    const cookie = await login(app, 'c1', 'manager');
    const create = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/connections',
      headers: { cookie },
      payload: { idempotencyKey: 'create-1', channelMode: 'telegram_bot', credentialRef: CRED },
    });
    assert.equal(create.statusCode, 202);
    const id = (create.json() as { id: string }).id;

    await db.query(`CREATE FUNCTION "${schema}".fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='audit_forced_failure'; END $$`);
    await db.query(`CREATE TRIGGER fail_audit BEFORE INSERT ON "${schema}".audit_events
      FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_audit()`);

    const failed = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/connections/${id}/lifecycle`,
      headers: { cookie },
      payload: { idempotencyKey: 'life-1', expectedVersion: 0, desiredState: 'active' },
    });
    assert.equal(failed.statusCode, 500, failed.body);

    const after = await db.query<{ state: string; version: string }>(
      `SELECT state, version FROM connections WHERE company_id='c1' AND id=$1`,
      [id],
    );
    assert.equal(after.rows[0]!.state, 'setup');
    assert.equal(Number(after.rows[0]!.version), 0);

    // No orphaned idempotency ledger row either: the whole transaction rolled back.
    const ledger = await db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM connection_commands WHERE company_id='c1' AND idempotency_key='life-1'`,
    );
    assert.equal(ledger.rows[0]!.c, 0);

    // Once auditing works, the same command succeeds.
    await db.query(`DROP TRIGGER fail_audit ON "${schema}".audit_events`);
    const retried = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/connections/${id}/lifecycle`,
      headers: { cookie },
      payload: { idempotencyKey: 'life-1', expectedVersion: 0, desiredState: 'active' },
    });
    assert.equal(retried.statusCode, 202, retried.body);
    assert.equal((retried.json() as { state: string }).state, 'active');
  } finally {
    await close();
  }
});

test('concurrent lifecycle updates with the same expected version accept exactly one', async () => {
  const { app, db, close } = await createTestApp();
  try {
    await seedCompany(db, { companyId: 'c1', staff: [{ id: 'manager', password: PASSWORD, role: 'manage' }] });
    const cookie = await login(app, 'c1', 'manager');
    const create = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/connections',
      headers: { cookie },
      payload: { idempotencyKey: 'create-1', channelMode: 'telegram_bot', credentialRef: CRED },
    });
    const id = (create.json() as { id: string }).id;

    const update = (key: string, desiredState: string) =>
      app.inject({
        method: 'POST',
        url: `/api/v2/operator/connections/${id}/lifecycle`,
        headers: { cookie },
        payload: { idempotencyKey: key, expectedVersion: 0, desiredState },
      });

    const results = await Promise.all([
      update('a', 'active'),
      update('b', 'paused'),
      update('c', 'disabled'),
    ]);
    const statuses = results.map((r) => r.statusCode).sort();
    assert.deepEqual(statuses, [202, 409, 409]);

    const row = await db.query<{ version: string; state: string }>(
      `SELECT version, state FROM connections WHERE company_id='c1' AND id=$1`,
      [id],
    );
    assert.equal(Number(row.rows[0]!.version), 1);

    const auditCount = await db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM audit_events WHERE company_id='c1' AND subject_id=$1`,
      [id],
    );
    assert.equal(auditCount.rows[0]!.c, 2, 'one create + exactly one accepted lifecycle change');
  } finally {
    await close();
  }
});

test('connection secrets never appear in responses or logs', async () => {
  const { app, db, logs, close } = await createTestApp();
  try {
    await seedCompany(db, { companyId: 'c1', staff: [{ id: 'manager', password: PASSWORD, role: 'manage' }] });
    const cookie = await login(app, 'c1', 'manager');

    const create = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/connections',
      headers: { cookie },
      payload: { idempotencyKey: 'create-1', channelMode: 'telegram_bot', credentialRef: CRED },
    });
    assert.equal(create.statusCode, 202);
    const id = (create.json() as { id: string }).id;
    await app.inject({
      method: 'POST',
      url: `/api/v2/operator/connections/${id}/credentials-reference`,
      headers: { cookie },
      payload: { idempotencyKey: 'cred-1', expectedVersion: 0, credentialRef: 'credref_second_secret' },
    });
    await app.inject({ method: 'GET', url: '/api/v2/operator/connections', headers: { cookie } });

    const joinedLogs = logs.join('\n');
    assert.equal(joinedLogs.includes(CRED), false);
    assert.equal(joinedLogs.includes('credref_second_secret'), false);
    assert.equal(joinedLogs.includes(PASSWORD), false);
    assert.equal(joinedLogs.includes(cookie.split('=')[1]!), false);
  } finally {
    await close();
  }
});

test('invalid payloads are rejected with a safe validation code', async () => {
  const { app, db, close } = await createTestApp();
  try {
    await seedCompany(db, { companyId: 'c1', staff: [{ id: 'manager', password: PASSWORD, role: 'manage' }] });
    const cookie = await login(app, 'c1', 'manager');

    const badRef = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/connections',
      headers: { cookie },
      payload: { idempotencyKey: 'k1', channelMode: 'telegram_bot', credentialRef: 'raw-secret-token' },
    });
    assert.equal(badRef.statusCode, 400);
    assert.equal((badRef.json() as { code: string }).code, 'VALIDATION_FAILED');
    assert.equal(badRef.body.includes('raw-secret-token'), false);

    const badMode = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/connections',
      headers: { cookie },
      payload: { idempotencyKey: 'k2', channelMode: 'carrier_pigeon', credentialRef: CRED },
    });
    assert.equal(badMode.statusCode, 400);

    const extra = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/connections',
      headers: { cookie },
      payload: { idempotencyKey: 'k3', channelMode: 'telegram_bot', credentialRef: CRED, companyId: 'other' },
    });
    assert.equal(extra.statusCode, 400, 'company must come from the session, never the body');
  } finally {
    await close();
  }
});
