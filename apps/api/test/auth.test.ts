import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { createTestApp, cookieFromResponse } from './helpers/app.ts';
import { seedCompany, seedConnection } from './helpers/seed.ts';

const PASSWORD = 'correct horse battery staple';

async function login(
  app: FastifyInstance,
  companyId: string,
  staffId: string,
  password = PASSWORD,
): Promise<{ status: number; cookie: string | null; body: Record<string, unknown> }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v2/auth/login',
    payload: { companyId, staffId, password },
  });
  return {
    status: response.statusCode,
    cookie: response.statusCode === 200 ? cookieFromResponse(response) : null,
    body: response.json() as Record<string, unknown>,
  };
}

test('login rejects bad credentials without issuing a cookie', async () => {
  const { app, db, close } = await createTestApp();
  try {
    await seedCompany(db, { companyId: 'c1', staff: [{ id: 's1', password: PASSWORD, role: 'read' }] });

    for (const [staffId, password] of [
      ['s1', 'wrong password'],
      ['missing', PASSWORD],
    ] as const) {
      const attempt = await login(app, 'c1', staffId, password);
      assert.equal(attempt.status, 401, `expected 401 for ${staffId}`);
      assert.equal(attempt.cookie, null);
      assert.equal(attempt.body.code, 'UNAUTHENTICATED');
      assert.equal(typeof attempt.body.requestId, 'string');
      assert.equal(attempt.body.retryable, false);
      assert.equal(JSON.stringify(attempt.body).includes(PASSWORD), false);
    }

    // A staff row without a credential record must not be able to log in.
    await db.query(`INSERT INTO staff (company_id, id) VALUES ('c1','s_nocred')`);
    const noCredential = await login(app, 'c1', 's_nocred');
    assert.equal(noCredential.status, 401);
  } finally {
    await close();
  }
});

test('login stores only hash and salt and issues a hardened session cookie', async () => {
  const { app, db, close } = await createTestApp({ secureCookies: true });
  try {
    await seedCompany(db, { companyId: 'c1', staff: [{ id: 's1', password: PASSWORD, role: 'send' }] });

    const { rows } = await db.query<{ salt: string; password_hash: string; algorithm: string }>(
      `SELECT salt, password_hash, algorithm FROM staff_credentials WHERE company_id='c1' AND staff_id='s1'`,
    );
    assert.equal(rows.length, 1);
    const stored = rows[0]!;
    assert.equal(stored.algorithm, 'scrypt');
    assert.ok(stored.salt.length >= 16);
    assert.notEqual(stored.password_hash, PASSWORD);
    assert.equal(stored.password_hash.includes(PASSWORD), false);

    const attempt = await login(app, 'c1', 's1');
    assert.equal(attempt.status, 200);
    assert.ok(attempt.cookie);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { companyId: 'c1', staffId: 's1', password: PASSWORD },
    });
    const raw = String(response.headers['set-cookie']);
    assert.match(raw, /HttpOnly/i);
    assert.match(raw, /SameSite=Strict/i);
    assert.match(raw, /Secure/i);
    assert.match(raw, /Path=\//);

    const bodyText = response.body;
    assert.equal(bodyText.includes(PASSWORD), false);
    assert.equal(bodyText.toLowerCase().includes('token'), false);
    assert.equal(bodyText.includes(attempt.cookie!.split('=')[1]!), false);
    assert.deepEqual(Object.keys(response.json() as object).sort(), ['companyId', 'expiresAt', 'role', 'staffId', 'workshopId']);

    const sessions = await db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM staff_sessions WHERE company_id='c1' AND staff_id='s1' AND revoked_at IS NULL`,
    );
    assert.ok(sessions.rows[0]!.c >= 1, 'login must persist a server-side session row');
  } finally {
    await close();
  }
});

test('operator endpoints reject unauthenticated requests before disclosing state', async () => {
  const { app, close } = await createTestApp();
  try {
    const list = await app.inject({ method: 'GET', url: '/api/v2/operator/connections' });
    assert.equal(list.statusCode, 401);
    assert.equal((list.json() as { code: string }).code, 'UNAUTHENTICATED');

    const create = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/connections',
      payload: { idempotencyKey: 'k1', channelMode: 'telegram_bot', credentialRef: 'credref_abc' },
    });
    assert.equal(create.statusCode, 401);

    // A signed but forged cookie must not authenticate.
    const forged = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/connections',
      headers: { cookie: 'staff_session=eyJzdGFmZklkIjoiczEifQ.deadbeef' },
    });
    assert.equal(forged.statusCode, 401);
  } finally {
    await close();
  }
});

test('logout and administrative revocation kill an already issued live session', async () => {
  const { app, db, close } = await createTestApp();
  try {
    await seedCompany(db, {
      companyId: 'c1',
      staff: [
        { id: 's1', password: PASSWORD, role: 'read' },
        { id: 'admin', password: PASSWORD, role: 'admin' },
      ],
    });

    const first = await login(app, 'c1', 's1');
    assert.equal(first.status, 200);
    const live = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/connections',
      headers: { cookie: first.cookie! },
    });
    assert.equal(live.statusCode, 200);

    // Revoke through the admin API: the cookie stays cryptographically valid but must die.
    const admin = await login(app, 'c1', 'admin');
    const revoke = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/staff/s1/sessions/revoke',
      headers: { cookie: admin.cookie! },
      payload: { reason: 'access_revoked' },
    });
    assert.equal(revoke.statusCode, 202, revoke.body);
    assert.ok((revoke.json() as { revoked: number }).revoked >= 1);

    const afterRevoke = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/connections',
      headers: { cookie: first.cookie! },
    });
    assert.equal(afterRevoke.statusCode, 401);

    // The same cookie value must keep failing (revocation is durable).
    const again = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/connections',
      headers: { cookie: first.cookie! },
    });
    assert.equal(again.statusCode, 401);

    // Logout revokes the current session too.
    const second = await login(app, 'c1', 's1');
    const logout = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/logout',
      headers: { cookie: second.cookie! },
    });
    assert.equal(logout.statusCode, 204);
    const afterLogout = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/connections',
      headers: { cookie: second.cookie! },
    });
    assert.equal(afterLogout.statusCode, 401);

    const revoked = await db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM staff_sessions WHERE company_id='c1' AND staff_id='s1' AND revoked_at IS NOT NULL`,
    );
    assert.ok(revoked.rows[0]!.c >= 2);
  } finally {
    await close();
  }
});

test('role matrix is enforced server-side for every level', async () => {
  const { app, db, close } = await createTestApp();
  try {
    await seedCompany(db, {
      companyId: 'c1',
      staff: [
        { id: 'reader', password: PASSWORD, role: 'read' },
        { id: 'sender', password: PASSWORD, role: 'send' },
        { id: 'manager', password: PASSWORD, role: 'manage' },
        { id: 'admin', password: PASSWORD, role: 'admin' },
      ],
    });
    await db.query(
      `INSERT INTO connections (company_id,id,channel_mode,binding_epoch,credentials_version,state,version,capabilities)
       VALUES ('c1','conn1','telegram_bot',0,1,'setup',0,'{}');
       INSERT INTO connection_identities (company_id,connection_id,binding_epoch) VALUES ('c1','conn1',0)`,
    );

    const lifecycle = (cookie: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v2/operator/connections/conn1/lifecycle',
        headers: { cookie },
        payload: { idempotencyKey: `k-${Math.random()}`, expectedVersion: 0, desiredState: 'paused' },
      });

    const reader = await login(app, 'c1', 'reader');
    const sender = await login(app, 'c1', 'sender');
    const manager = await login(app, 'c1', 'manager');
    const admin = await login(app, 'c1', 'admin');

    assert.equal((await lifecycle(reader.cookie!)).statusCode, 403);
    assert.equal((await lifecycle(sender.cookie!)).statusCode, 403);
    assert.equal((await lifecycle(manager.cookie!)).statusCode, 202);
    // Version advanced by the manager's accepted change.
    assert.equal((await lifecycle(admin.cookie!)).statusCode, 409);

    // A read role can list connections.
    const list = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/connections',
      headers: { cookie: reader.cookie! },
    });
    assert.equal(list.statusCode, 200);
    const items = (list.json() as { items: { id: string }[] }).items;
    assert.equal(items.length, 1);
  } finally {
    await close();
  }
});

test('workshop scope restricts reads and writes and never leaks foreign state', async () => {
  const { app, db, close } = await createTestApp();
  try {
    await seedCompany(db, {
      companyId: 'c1',
      workshops: ['w1', 'w2'],
      staff: [
        { id: 'w1_reader', password: PASSWORD, role: 'read', workshopId: 'w1' },
        { id: 'w1_manager', password: PASSWORD, role: 'manage', workshopId: 'w1' },
        { id: 'root_manager', password: PASSWORD, role: 'manage', workshopId: null },
      ],
    });
    // A staff row used as route default owner.
    await db.query(`INSERT INTO staff (company_id,id) VALUES ('c1','owner1')`);
    await db.query(`INSERT INTO staff (company_id,id) VALUES ('c1','owner2')`);
    await db.query(`INSERT INTO crm_accounts (company_id,id) VALUES ('c1','acc1')`);
    await db.query(`INSERT INTO crm_accounts (company_id,id) VALUES ('c1','acc2')`);
    await db.query(
      `INSERT INTO crm_sources (company_id,id,account_id,external_id,origin_code) VALUES ('c1','src1','acc1','e1','t'),('c1','src2','acc2','e2','t')`,
    );

    for (const [id, workshop, owner] of [
      ['own', 'w1', 'owner1'],
      ['foreign', 'w2', 'owner2'],
    ] as const) {
      await seedConnection(db, { companyId: 'c1', id, workshopId: workshop, ownerId: owner });
    }

    const reader = await login(app, 'c1', 'w1_reader');
    const scopedManager = await login(app, 'c1', 'w1_manager');
    const rootManager = await login(app, 'c1', 'root_manager');

    const list = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/connections',
      headers: { cookie: reader.cookie! },
    });
    assert.equal(list.statusCode, 200);
    assert.deepEqual((list.json() as { items: { id: string }[] }).items.map((i) => i.id), ['own']);

    // Workshop manager cannot mutate a connection routed to another workshop: 403, not 404.
    const foreign = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/connections/foreign/lifecycle',
      headers: { cookie: scopedManager.cookie! },
      payload: { idempotencyKey: 'k1', expectedVersion: 0, desiredState: 'paused' },
    });
    assert.equal(foreign.statusCode, 403);
    assert.equal((foreign.json() as { code: string }).code, 'FORBIDDEN');

    // Unknown connection id also yields 403 for a scoped user, never 404.
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/connections/nope/lifecycle',
      headers: { cookie: scopedManager.cookie! },
      payload: { idempotencyKey: 'k2', expectedVersion: 0, desiredState: 'paused' },
    });
    assert.equal(unknown.statusCode, 403);

    // Company-wide manager may act and gets a real 404 for a missing id.
    const rootOwn = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/connections/own/lifecycle',
      headers: { cookie: rootManager.cookie! },
      payload: { idempotencyKey: 'k3', expectedVersion: 0, desiredState: 'paused' },
    });
    assert.equal(rootOwn.statusCode, 202);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/connections/nope/lifecycle',
      headers: { cookie: rootManager.cookie! },
      payload: { idempotencyKey: 'k4', expectedVersion: 0, desiredState: 'paused' },
    });
    assert.equal(missing.statusCode, 404);

    // Scoped managers cannot create company-wide connections.
    const scopedCreate = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/connections',
      headers: { cookie: scopedManager.cookie! },
      payload: { idempotencyKey: 'k5', channelMode: 'telegram_bot', credentialRef: 'credref_abc' },
    });
    assert.equal(scopedCreate.statusCode, 403);
  } finally {
    await close();
  }
});

test('native amoCRM actor headers are never trusted', async () => {
  const { app, db, close } = await createTestApp();
  try {
    await seedCompany(db, {
      companyId: 'c1',
      staff: [
        { id: 'reader', password: PASSWORD, role: 'read' },
        { id: 'ghost', password: PASSWORD, role: 'read', withAccess: false },
      ],
    });
    const anonymous = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/connections',
      headers: { 'x-amocrm-user-id': '999', 'x-amocrm-actor': 'admin' },
    });
    assert.equal(anonymous.statusCode, 401);

    // Header cannot escalate a real session.
    const reader = await login(app, 'c1', 'reader');
    const escalated = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/connections',
      headers: { cookie: reader.cookie!, 'x-amocrm-user-id': '999', 'x-amocrm-actor': 'admin' },
      payload: { idempotencyKey: 'k1', channelMode: 'telegram_bot', credentialRef: 'credref_abc' },
    });
    assert.equal(escalated.statusCode, 403);

    // Staff without an access grant cannot authenticate at all.
    const ghost = await login(app, 'c1', 'ghost');
    assert.equal(ghost.status, 401);
  } finally {
    await close();
  }
});

test('role changes take effect immediately and revoke live sessions', async () => {
  const { app, db, close } = await createTestApp();
  try {
    await seedCompany(db, {
      companyId: 'c1',
      staff: [
        { id: 's1', password: PASSWORD, role: 'manage' },
        { id: 'admin', password: PASSWORD, role: 'admin' },
      ],
    });
    const admin = await login(app, 'c1', 'admin');
    const member = await login(app, 'c1', 's1');

    const before = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/connections',
      headers: { cookie: member.cookie! },
      payload: { idempotencyKey: 'k1', channelMode: 'telegram_bot', credentialRef: 'credref_abc' },
    });
    assert.equal(before.statusCode, 202);

    const update = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/staff/s1/access',
      headers: { cookie: admin.cookie! },
      payload: { role: 'read', workshopId: null, expectedVersion: 0 },
    });
    assert.equal(update.statusCode, 200, update.body);
    assert.equal((update.json() as { role: string }).role, 'read');

    // Existing cookie must stop working because access version changed / sessions revoked.
    const after = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/connections',
      headers: { cookie: member.cookie! },
    });
    assert.equal(after.statusCode, 401);

    // Re-login reflects the new role and denies manage actions.
    const relogin = await login(app, 'c1', 's1');
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/connections',
      headers: { cookie: relogin.cookie! },
      payload: { idempotencyKey: 'k2', channelMode: 'telegram_bot', credentialRef: 'credref_abc' },
    });
    assert.equal(denied.statusCode, 403);

    const audits = await db.query<{ event_name: string }>(
      `SELECT event_name FROM audit_events WHERE company_id='c1' AND subject_id='s1'`,
    );
    assert.ok(audits.rows.some((row) => row.event_name === 'staff.access_updated'));
  } finally {
    await close();
  }
});

test('concurrent access changes: exactly one wins and the other conflicts', async () => {
  const { app, db, close } = await createTestApp();
  try {
    await seedCompany(db, {
      companyId: 'c1',
      staff: [
        { id: 's1', password: PASSWORD, role: 'read' },
        { id: 'admin1', password: PASSWORD, role: 'admin' },
        { id: 'admin2', password: PASSWORD, role: 'admin' },
      ],
    });
    const admin1 = await login(app, 'c1', 'admin1');
    const admin2 = await login(app, 'c1', 'admin2');

    const change = (cookie: string, role: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v2/operator/staff/s1/access',
        headers: { cookie },
        payload: { role, workshopId: null, expectedVersion: 0 },
      });

    const [a, b] = await Promise.all([change(admin1.cookie!, 'send'), change(admin2.cookie!, 'manage')]);
    const statuses = [a.statusCode, b.statusCode].sort();
    assert.deepEqual(statuses, [200, 409]);

    const { rows } = await db.query<{ role: string; version: string }>(
      `SELECT role, version FROM staff_access WHERE company_id='c1' AND staff_id='s1'`,
    );
    assert.equal(Number(rows[0]!.version), 1);
    assert.ok(['send', 'manage'].includes(rows[0]!.role));
  } finally {
    await close();
  }
});

test('login and logout never log credentials or session tokens', async () => {
  const { app, db, logs, close } = await createTestApp();
  try {
    await seedCompany(db, { companyId: 'c1', staff: [{ id: 's1', password: PASSWORD, role: 'admin' }] });
    const attempt = await login(app, 'c1', 's1');
    await app.inject({ method: 'POST', url: '/api/v2/auth/logout', headers: { cookie: attempt.cookie! } });

    const token = attempt.cookie!.split('=')[1]!;
    const joined = logs.join('\n');
    assert.ok(logs.length > 0);
    assert.equal(joined.includes(PASSWORD), false);
    assert.equal(joined.includes(token), false);
    assert.equal(joined.includes('staff_session'), false);
  } finally {
    await close();
  }
});
