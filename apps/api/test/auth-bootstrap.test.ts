import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { createTestApp, cookieFromResponse } from './helpers/app.ts';
import { seedCompany } from './helpers/seed.ts';

const TOKEN = 'bootstrap-token-for-tests-0123456789';
const PASSWORD = 'correct horse battery staple';
const COMPANY = 'acme';
const STAFF = 'owner';

type BootstrapResult = {
  status: number;
  body: Record<string, unknown>;
  raw: string;
};

async function bootstrap(
  app: FastifyInstance,
  payload: Record<string, unknown> = { companyId: COMPANY, staffId: STAFF, password: PASSWORD },
  token: string | null = TOKEN,
): Promise<BootstrapResult> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v2/auth/bootstrap',
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    payload,
  });
  return {
    status: response.statusCode,
    body: response.json() as Record<string, unknown>,
    raw: response.body,
  };
}

test('bootstrap rejects a missing bearer token', async () => {
  const { app, db, close } = await createTestApp({ adminBootstrapToken: TOKEN });
  try {
    const result = await bootstrap(app, undefined, null);
    assert.equal(result.status, 401);
    assert.equal(result.body.code, 'UNAUTHENTICATED');

    const companies = await db.query<{ c: number }>('SELECT count(*)::int AS c FROM companies');
    assert.equal(companies.rows[0]!.c, 0, 'an unauthenticated call must not create a company');
  } finally {
    await close();
  }
});

test('bootstrap rejects a wrong bearer token', async () => {
  const { app, db, close } = await createTestApp({ adminBootstrapToken: TOKEN });
  try {
    const result = await bootstrap(app, undefined, `${TOKEN}-wrong`);
    assert.equal(result.status, 401);
    assert.equal(result.body.code, 'UNAUTHENTICATED');

    const staff = await db.query<{ c: number }>('SELECT count(*)::int AS c FROM staff');
    assert.equal(staff.rows[0]!.c, 0);
  } finally {
    await close();
  }
});

test('bootstrap route is not registered when the token is not configured', async () => {
  const { app, close } = await createTestApp();
  try {
    const result = await bootstrap(app);
    assert.equal(result.status, 404);
  } finally {
    await close();
  }
});

test('bootstrap creates the company, the staff member and the admin grant', async () => {
  const { app, db, logs, close } = await createTestApp({ adminBootstrapToken: TOKEN });
  try {
    const result = await bootstrap(app, {
      companyId: COMPANY,
      staffId: STAFF,
      password: PASSWORD,
      displayName: 'First Admin',
    });
    assert.equal(result.status, 201);
    assert.deepEqual(result.body, { companyId: COMPANY, staffId: STAFF, role: 'admin' });
    assert.equal(result.raw.includes(PASSWORD), false, 'the password must never be echoed');
    assert.equal(logs.some((line) => line.includes(PASSWORD)), false, 'the password must never be logged');

    const companies = await db.query<{ display_name: string | null }>(
      'SELECT display_name FROM companies WHERE id = $1',
      [COMPANY],
    );
    assert.equal(companies.rowCount, 1);

    const staff = await db.query<{ display_name: string | null; capacity: number }>(
      'SELECT display_name, capacity FROM staff WHERE company_id = $1 AND id = $2',
      [COMPANY, STAFF],
    );
    assert.equal(staff.rowCount, 1);
    assert.equal(staff.rows[0]!.display_name, 'First Admin');

    const access = await db.query<{ role: string; workshop_id: string | null }>(
      'SELECT role, workshop_id FROM staff_access WHERE company_id = $1 AND staff_id = $2',
      [COMPANY, STAFF],
    );
    assert.equal(access.rowCount, 1);
    assert.equal(access.rows[0]!.role, 'admin');
    assert.equal(access.rows[0]!.workshop_id, null);

    const credentials = await db.query<{ salt: string; password_hash: string; algorithm: string }>(
      'SELECT salt, password_hash, algorithm FROM staff_credentials WHERE company_id = $1 AND staff_id = $2',
      [COMPANY, STAFF],
    );
    assert.equal(credentials.rowCount, 1);
    assert.equal(credentials.rows[0]!.algorithm, 'scrypt');
    assert.notEqual(credentials.rows[0]!.password_hash, PASSWORD);
    assert.equal(credentials.rows[0]!.password_hash.includes(PASSWORD), false);

    // The created credential must work through the normal login route.
    const login = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { companyId: COMPANY, staffId: STAFF, password: PASSWORD },
    });
    assert.equal(login.statusCode, 200);
    const loginBody = login.json() as Record<string, unknown>;
    assert.equal(loginBody.role, 'admin');
    assert.ok(cookieFromResponse(login));
  } finally {
    await close();
  }
});

test('bootstrap writes an audit event in the same transaction', async () => {
  const { app, db, close } = await createTestApp({ adminBootstrapToken: TOKEN });
  try {
    const result = await bootstrap(app);
    assert.equal(result.status, 201);

    const audit = await db.query<{ event_name: string; subject_id: string; actor_id: string | null }>(
      'SELECT event_name, subject_id, actor_id FROM audit_events WHERE company_id = $1',
      [COMPANY],
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0]!.event_name, 'auth.admin_bootstrapped');
    assert.equal(audit.rows[0]!.subject_id, STAFF);
    assert.equal(audit.rows[0]!.actor_id, null);
  } finally {
    await close();
  }
});

test('bootstrap refuses a second call and does not create a second admin', async () => {
  const { app, db, close } = await createTestApp({ adminBootstrapToken: TOKEN });
  try {
    const first = await bootstrap(app);
    assert.equal(first.status, 201);

    const second = await bootstrap(app, {
      companyId: COMPANY,
      staffId: 'second_owner',
      password: 'another correct horse battery',
    });
    assert.equal(second.status, 409);
    assert.equal(second.raw.includes('another correct horse battery'), false);

    const admins = await db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM staff_access WHERE company_id = $1 AND role = 'admin'`,
      [COMPANY],
    );
    assert.equal(admins.rows[0]!.c, 1);

    const staff = await db.query<{ c: number }>(
      'SELECT count(*)::int AS c FROM staff WHERE company_id = $1',
      [COMPANY],
    );
    assert.equal(staff.rows[0]!.c, 1, 'the rejected call must not add a staff member');

    const companies = await db.query<{ c: number }>('SELECT count(*)::int AS c FROM companies');
    assert.equal(companies.rows[0]!.c, 1);
  } finally {
    await close();
  }
});

test('bootstrap refuses when the company already has an administrator', async () => {
  const { app, db, close } = await createTestApp({ adminBootstrapToken: TOKEN });
  try {
    await seedCompany(db, {
      companyId: COMPANY,
      staff: [{ id: 'existing_admin', password: PASSWORD, role: 'admin' }],
    });

    const result = await bootstrap(app);
    assert.equal(result.status, 409);

    const staff = await db.query<{ c: number }>(
      'SELECT count(*)::int AS c FROM staff WHERE company_id = $1',
      [COMPANY],
    );
    assert.equal(staff.rows[0]!.c, 1, 'no new staff member may be created');
  } finally {
    await close();
  }
});

test('concurrent bootstrap calls create exactly one administrator', async () => {
  const { app, db, close } = await createTestApp({ adminBootstrapToken: TOKEN });
  try {
    const [left, right] = await Promise.all([
      bootstrap(app),
      bootstrap(app, { companyId: COMPANY, staffId: 'second_owner', password: PASSWORD }),
    ]);
    const statuses = [left.status, right.status].sort();
    assert.deepEqual(statuses, [201, 409]);

    const admins = await db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM staff_access WHERE company_id = $1 AND role = 'admin'`,
      [COMPANY],
    );
    assert.equal(admins.rows[0]!.c, 1);
  } finally {
    await close();
  }
});

test('bootstrap validates the body strictly', async () => {
  const { app, db, close } = await createTestApp({ adminBootstrapToken: TOKEN });
  try {
    const shortPassword = await bootstrap(app, { companyId: COMPANY, staffId: STAFF, password: 'short' });
    assert.ok([400, 422].includes(shortPassword.status), `unexpected ${shortPassword.status}`);

    const extraField = await bootstrap(app, {
      companyId: COMPANY,
      staffId: STAFF,
      password: PASSWORD,
      role: 'admin',
    });
    assert.ok([400, 422].includes(extraField.status), `unexpected ${extraField.status}`);

    for (const identifier of ['Bad-Id', '1starts_with_digit', '', 'x'.repeat(64)]) {
      const invalid = await bootstrap(app, {
        companyId: identifier,
        staffId: STAFF,
        password: PASSWORD,
      });
      assert.ok([400, 422].includes(invalid.status), `identifier ${JSON.stringify(identifier)} must be rejected`);
    }

    const companies = await db.query<{ c: number }>('SELECT count(*)::int AS c FROM companies');
    assert.equal(companies.rows[0]!.c, 0, 'invalid requests must not create anything');
  } finally {
    await close();
  }
});
