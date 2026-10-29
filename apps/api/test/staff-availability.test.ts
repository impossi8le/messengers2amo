import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createTestApp, cookieFromResponse } from './helpers/app.ts';
import { seedCompany } from './helpers/seed.ts';

const PASSWORD = 'correct horse battery staple';

function json<T>(response: LightMyRequestResponse): T {
  return response.json() as T;
}

async function login(app: FastifyInstance, companyId: string, staffId: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v2/auth/login',
    payload: { companyId, staffId, password: PASSWORD },
  });
  assert.equal(response.statusCode, 200, response.body);
  return cookieFromResponse(response);
}

type AvailabilityBody = {
  id: string;
  availability: string;
  departmentIds: string[];
  capacity: number;
  activeCount: number;
  version: number;
};

async function seedAvailabilityFixture(
  db: Awaited<ReturnType<typeof createTestApp>>['db'],
  schema: string,
): Promise<void> {
  await seedCompany(db, {
    companyId: 'c1',
    staff: [
      { id: 'admin', password: PASSWORD, role: 'admin' },
      { id: 'reader', password: PASSWORD, role: 'read' },
      { id: 's1', password: PASSWORD, role: 'send' },
      { id: 's2', password: PASSWORD, role: 'send' },
      { id: 's3', password: PASSWORD, role: 'send' },
    ],
  });
  await seedCompany(db, {
    companyId: 'c2',
    staff: [
      { id: 'foreign_admin', password: PASSWORD, role: 'admin' },
      { id: 'z9', password: PASSWORD, role: 'send' },
    ],
  });
  await db.query(`INSERT INTO "${schema}".departments (company_id, id, display_name) VALUES ($1,'dep1','D1'),($1,'dep2','D2')`, [
    'c1',
  ]);
  await db.query(
    `INSERT INTO "${schema}".staff_memberships (company_id, staff_id, department_id)
     VALUES ('c1','s1','dep1'), ('c1','s1','dep2'), ('c1','s2','dep1')`,
  );
  await db.query(
    `UPDATE "${schema}".staff
        SET availability = 'online', capacity = 3, active_count = 1
      WHERE company_id = 'c1' AND id IN ('s1','s2','s3')`,
  );
}

test('staff availability list is scoped to the session company', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    await seedAvailabilityFixture(db, schema);
    const cookie = await login(app, 'c1', 'reader');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/staff/availability',
      headers: { cookie },
    });
    assert.equal(response.statusCode, 200, response.body);

    const body = json<{ items: AvailabilityBody[]; page: { nextCursor: string | null } }>(response);
    assert.deepEqual(body.items.map((item) => item.id), ['admin', 'reader', 's1', 's2', 's3']);
    assert.deepEqual(body.page, { nextCursor: null });

    const s1 = body.items.find((item) => item.id === 's1');
    assert.deepEqual(s1, {
      id: 's1',
      availability: 'online',
      departmentIds: ['dep1', 'dep2'],
      capacity: 3,
      activeCount: 1,
      version: 0,
    });
    // Another company's staff never leaks into the list.
    assert.equal(body.items.some((item) => item.id === 'z9'), false);
  } finally {
    await close();
  }
});

test('staff availability list paginates by cursor inside the company scope', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    await seedAvailabilityFixture(db, schema);
    const cookie = await login(app, 'c1', 'reader');

    const first = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/staff/availability?limit=2',
      headers: { cookie },
    });
    assert.equal(first.statusCode, 200, first.body);
    const firstBody = json<{ items: AvailabilityBody[]; page: { nextCursor: string | null } }>(first);
    assert.deepEqual(firstBody.items.map((item) => item.id), ['admin', 'reader']);
    assert.equal(firstBody.page.nextCursor, 'reader');

    const second = await app.inject({
      method: 'GET',
      url: `/api/v2/operator/staff/availability?limit=2&after=${firstBody.page.nextCursor}`,
      headers: { cookie },
    });
    const secondBody = json<{ items: AvailabilityBody[]; page: { nextCursor: string | null } }>(second);
    assert.deepEqual(secondBody.items.map((item) => item.id), ['s1', 's2']);
    assert.equal(secondBody.page.nextCursor, 's2');

    const third = await app.inject({
      method: 'GET',
      url: `/api/v2/operator/staff/availability?limit=2&after=${secondBody.page.nextCursor}`,
      headers: { cookie },
    });
    const thirdBody = json<{ items: AvailabilityBody[]; page: { nextCursor: string | null } }>(third);
    assert.deepEqual(thirdBody.items.map((item) => item.id), ['s3']);
    assert.equal(thirdBody.page.nextCursor, null);

    // A cursor taken from another company stays a cursor: it cannot expose their staff.
    const foreignCursor = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/staff/availability?after=z9',
      headers: { cookie },
    });
    assert.equal(foreignCursor.statusCode, 200, foreignCursor.body);
    assert.deepEqual(json<{ items: AvailabilityBody[] }>(foreignCursor).items, []);
  } finally {
    await close();
  }
});

test('changing availability applies CAS, bumps the version and writes audit', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    await seedAvailabilityFixture(db, schema);
    const cookie = await login(app, 'c1', 'admin');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/staff/s1/availability',
      headers: { cookie },
      payload: { idempotencyKey: 'change-1', expectedVersion: 0, availability: 'away' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(json<AvailabilityBody>(response), {
      id: 's1',
      availability: 'away',
      departmentIds: ['dep1', 'dep2'],
      capacity: 3,
      activeCount: 1,
      version: 1,
    });

    const stored = await db.query<{ availability: string; version: string }>(
      `SELECT availability, version FROM "${schema}".staff WHERE company_id = 'c1' AND id = 's1'`,
    );
    assert.deepEqual(stored.rows[0], { availability: 'away', version: '1' });

    const audit = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "${schema}".audit_events
        WHERE company_id = 'c1' AND event_name = 'staff.availability_changed' AND subject_id = 's1'`,
    );
    assert.equal(audit.rows[0]!.count, '1');
  } finally {
    await close();
  }
});

test('stale expectedVersion is a 409 carrying the current version', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    await seedAvailabilityFixture(db, schema);
    const cookie = await login(app, 'c1', 'admin');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/staff/s1/availability',
      headers: { cookie },
      payload: { idempotencyKey: 'stale-1', expectedVersion: 7, availability: 'away' },
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(json<{ code: string }>(response).code, 'VERSION_CONFLICT');
    assert.equal(response.headers['x-current-version'], '0');

    const stored = await db.query<{ availability: string }>(
      `SELECT availability FROM "${schema}".staff WHERE company_id = 'c1' AND id = 's1'`,
    );
    assert.equal(stored.rows[0]!.availability, 'online', 'a rejected CAS must not change the row');
  } finally {
    await close();
  }
});

test('staff of another company is reported as missing, not forbidden', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    await seedAvailabilityFixture(db, schema);
    const cookie = await login(app, 'c1', 'admin');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/staff/z9/availability',
      headers: { cookie },
      payload: { idempotencyKey: 'foreign-1', expectedVersion: 0, availability: 'away' },
    });
    assert.equal(response.statusCode, 404, response.body);
    assert.equal(json<{ code: string }>(response).code, 'NOT_FOUND');

    const stored = await db.query<{ availability: string }>(
      `SELECT availability FROM "${schema}".staff WHERE company_id = 'c2' AND id = 'z9'`,
    );
    assert.equal(stored.rows[0]!.availability, 'offline');
  } finally {
    await close();
  }
});

test('a repeated idempotency key replays instead of applying twice', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    await seedAvailabilityFixture(db, schema);
    const cookie = await login(app, 'c1', 'admin');
    const payload = { idempotencyKey: 'retry-1', expectedVersion: 0, availability: 'away' };

    const first = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/staff/s1/availability',
      headers: { cookie },
      payload,
    });
    assert.equal(first.statusCode, 200, first.body);

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/staff/s1/availability',
      headers: { cookie },
      payload,
    });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(json<AvailabilityBody>(replay).version, 1);

    const stored = await db.query<{ availability: string; version: string }>(
      `SELECT availability, version FROM "${schema}".staff WHERE company_id = 'c1' AND id = 's1'`,
    );
    assert.deepEqual(stored.rows[0], { availability: 'away', version: '1' });

    const audit = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "${schema}".audit_events
        WHERE company_id = 'c1' AND event_name = 'staff.availability_changed' AND subject_id = 's1'`,
    );
    assert.equal(audit.rows[0]!.count, '1', 'a replay must not append a second audit row');

    // Reusing the key for a different change is a conflict, not a second mutation.
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/staff/s1/availability',
      headers: { cookie },
      payload: { idempotencyKey: 'retry-1', expectedVersion: 1, availability: 'online' },
    });
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.equal(json<{ code: string }>(conflict).code, 'IDEMPOTENCY_CONFLICT');
  } finally {
    await close();
  }
});

test('availability body is strict and only accepts database values', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    await seedAvailabilityFixture(db, schema);
    const cookie = await login(app, 'c1', 'admin');

    for (const payload of [
      { idempotencyKey: 'bad-1', expectedVersion: 0, availability: 'available' },
      { idempotencyKey: 'bad-2', expectedVersion: 0, availability: 'online', extra: true },
      { idempotencyKey: 'bad-3', expectedVersion: -1, availability: 'online' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v2/operator/staff/s1/availability',
        headers: { cookie },
        payload,
      });
      assert.equal(response.statusCode, 400, `${JSON.stringify(payload)} -> ${response.body}`);
      assert.equal(json<{ code: string }>(response).code, 'VALIDATION_FAILED');
    }

    const stored = await db.query<{ availability: string; version: string }>(
      `SELECT availability, version FROM "${schema}".staff WHERE company_id = 'c1' AND id = 's1'`,
    );
    assert.deepEqual(stored.rows[0], { availability: 'online', version: '0' });
  } finally {
    await close();
  }
});

test('availability mutation requires an administrative role', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    await seedAvailabilityFixture(db, schema);
    const cookie = await login(app, 'c1', 's1');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/staff/s1/availability',
      headers: { cookie },
      payload: { idempotencyKey: 'role-1', expectedVersion: 0, availability: 'away' },
    });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(json<{ code: string }>(response).code, 'FORBIDDEN');

    const anonymous = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/staff/availability',
    });
    assert.equal(anonymous.statusCode, 401);
  } finally {
    await close();
  }
});
