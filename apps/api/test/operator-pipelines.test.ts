// The admin screen must offer the account's real funnels and stages. This route is
// the only way it learns them, so the test pins what happens with amoCRM configured,
// without it, and with an explicit refresh.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { buildTestApp, sessionCookie } from './helpers/app.ts';
import { seedConnection } from './helpers/channel-fixtures.ts';
import { createTokenCipher } from '../src/integrations/amocrm/crypto.ts';
import type { PipelineCatalogue } from '../src/integrations/amocrm/pipelines.ts';
import { sessionIdFor } from './helpers/fixtures.ts';

const URL = '/api/v2/operator/amocrm/pipelines';

function fakeCatalogue(): PipelineCatalogue & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async list(input) {
      calls.push(`list:${input.companyId}:${input.accountId}`);
      return [
        {
          id: '1',
          name: 'Продажи',
          stages: [
            { id: '10', name: 'Новый', isFinal: false },
            { id: '142', name: 'Успешно', isFinal: true },
          ],
        },
      ];
    },
    invalidate(input) {
      calls.push(input ? `invalidate:${input.companyId}:${input.accountId}` : 'invalidate:all');
    },
  };
}

const cipher = createTokenCipher('x'.repeat(32));

/** A live session needs the actor, its grant and the session row that matches the cookie. */
async function seedStaff(
  db: Parameters<typeof seedConnection>[0],
  schema: string,
  id: string,
  role: 'admin' | 'read',
): Promise<void> {
  await db.query(
    `INSERT INTO "${schema}".staff(company_id,id,display_name) VALUES ('c1',$1,$2) ON CONFLICT DO NOTHING`,
    [id, id],
  );
  await db.query(
    `INSERT INTO "${schema}".staff_access (company_id,staff_id,role,workshop_id,version)
     VALUES ('c1',$1,$2,NULL,1)`,
    [id, role],
  );
  await db.query(
    `INSERT INTO "${schema}".staff_sessions (company_id,id,staff_id,epoch,expires_at)
     VALUES ('c1',$1,$2,1, now() + interval '1 day')`,
    [sessionIdFor('c1', id), id],
  );
}

test('an admin reads the funnels of the bound account', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await seedConnection(db, schema);
    await seedStaff(db, schema, 'admin1', 'admin');
    const pipelines = fakeCatalogue();
    const app = await buildTestApp({ db, schema, amocrm: { cipher, pipelines } });

    const response = await app.inject({
      method: 'GET',
      url: URL,
      headers: { cookie: sessionCookie('c1', 'admin1', 'admin') },
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<{ items: unknown[] }>();
    assert.deepEqual(body.items, [
      {
        id: '1',
        name: 'Продажи',
        stages: [
          { id: '10', name: 'Новый', isFinal: false },
          { id: '142', name: 'Успешно', isFinal: true },
        ],
      },
    ]);
    assert.deepEqual(pipelines.calls, ['list:c1:acc1']);

    await app.close();
  } finally {
    await close();
  }
});

test('refresh drops the cached answer before reading', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await seedConnection(db, schema);
    await seedStaff(db, schema, 'admin1', 'admin');
    const pipelines = fakeCatalogue();
    const app = await buildTestApp({ db, schema, amocrm: { cipher, pipelines } });

    const response = await app.inject({
      method: 'GET',
      url: `${URL}?refresh=true`,
      headers: { cookie: sessionCookie('c1', 'admin1', 'admin') },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(pipelines.calls, ['invalidate:c1:acc1', 'list:c1:acc1']);

    await app.close();
  } finally {
    await close();
  }
});

test('read-only staff cannot read the funnel catalogue', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await seedConnection(db, schema);
    await seedStaff(db, schema, 'admin1', 'admin');
    await seedStaff(db, schema, 'staff1', 'read');
    const app = await buildTestApp({ db, schema, amocrm: { cipher, pipelines: fakeCatalogue() } });

    const response = await app.inject({
      method: 'GET',
      url: URL,
      headers: { cookie: sessionCookie('c1', 'staff1', 'read') },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json<{ code: string }>().code, 'FORBIDDEN');

    await app.close();
  } finally {
    await close();
  }
});

test('without amoCRM configured the catalogue is unavailable, not empty', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await seedConnection(db, schema);
    await seedStaff(db, schema, 'admin1', 'admin');
    const app = await buildTestApp({ db, schema });

    const response = await app.inject({
      method: 'GET',
      url: URL,
      headers: { cookie: sessionCookie('c1', 'admin1', 'admin') },
    });

    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json<{ code: string }>().code, 'UPSTREAM_UNAVAILABLE');

    await app.close();
  } finally {
    await close();
  }
});

/** A routed connection needs the workshop, owner and source the route points at. */
async function seedRoute(db: Parameters<typeof seedConnection>[0], schema: string): Promise<void> {
  await db.query(
    `INSERT INTO "${schema}".workshops(company_id,id,display_name) VALUES ('c1','w1','Workshop') ON CONFLICT DO NOTHING`,
  );
  await db.query(
    `INSERT INTO "${schema}".crm_sources(company_id,id,account_id,external_id,origin_code)
     VALUES ('c1','src1','acc1','ext-src1','chat') ON CONFLICT DO NOTHING`,
  );
  await db.query(
    `INSERT INTO "${schema}".staff(company_id,id,display_name) VALUES ('c1','owner1','Owner') ON CONFLICT DO NOTHING`,
  );
  await db.query(
    `INSERT INTO "${schema}".connection_routes
       (company_id,connection_id,workshop_id,crm_account_id,funnel_id,default_owner_id,
        technical_source_id,status_id,normalize_phone,version)
     VALUES ('c1','conn1','w1','acc1','funnel-1','owner1','src1',NULL,false,1)
     ON CONFLICT (company_id,connection_id) DO NOTHING`,
  );
}

test('a connection without a route has no routing settings', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await seedConnection(db, schema);
    await seedStaff(db, schema, 'admin1', 'admin');
    const app = await buildTestApp({ db, schema });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/connections/conn1/routing',
      headers: { cookie: sessionCookie('c1', 'admin1', 'admin') },
    });

    assert.equal(response.statusCode, 404, response.body);
    await app.close();
  } finally {
    await close();
  }
});

test('an admin reads and changes the funnel and stage of a routed channel', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await seedConnection(db, schema);
    await seedStaff(db, schema, 'admin1', 'admin');
    await seedRoute(db, schema);
    const app = await buildTestApp({ db, schema });
    const headers = { cookie: sessionCookie('c1', 'admin1', 'admin') };

    const read = await app.inject({ method: 'GET', url: '/api/v2/operator/connections/conn1/routing', headers });
    assert.equal(read.statusCode, 200, read.body);
    assert.deepEqual(read.json(), {
      connectionId: 'conn1',
      funnelId: 'funnel-1',
      statusId: null,
      alertStaffId: null,
      normalizePhone: false,
      version: 1,
    });

    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/v2/operator/connections/conn1/routing',
      headers,
      payload: { funnelId: 'funnel-9', statusId: 'stage-7', normalizePhone: true, expectedVersion: 1 },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.deepEqual(patched.json(), {
      connectionId: 'conn1',
      funnelId: 'funnel-9',
      statusId: 'stage-7',
      alertStaffId: null,
      normalizePhone: true,
      version: 2,
    });

    // A stale version writes nothing and says the row moved.
    const stale = await app.inject({
      method: 'PATCH',
      url: '/api/v2/operator/connections/conn1/routing',
      headers,
      payload: { funnelId: 'funnel-x', expectedVersion: 1 },
    });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json<{ code: string }>().code, 'VERSION_CONFLICT');

    await app.close();
  } finally {
    await close();
  }
});

test('an empty stage is refused before anything is written', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await seedConnection(db, schema);
    await seedStaff(db, schema, 'admin1', 'admin');
    await seedRoute(db, schema);
    const app = await buildTestApp({ db, schema });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v2/operator/connections/conn1/routing',
      headers: { cookie: sessionCookie('c1', 'admin1', 'admin') },
      payload: { funnelId: 'funnel-1', statusId: '' },
    });

    assert.equal(response.statusCode, 400, response.body);
    await app.close();
  } finally {
    await close();
  }
});
