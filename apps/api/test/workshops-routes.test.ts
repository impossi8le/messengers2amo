import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildTestApp, sessionCookie } from './helpers/app.ts';
import { createTestDb } from './helpers/db.ts';
import { sessionIdFor } from './helpers/fixtures.ts';
import { seedWorkshopBase, type WorkshopBase } from './helpers/workshops.ts';
import { countRows } from './helpers/attention.ts';
import type { Db } from '../src/platform/db.ts';

type Grant = {
  staffId: string;
  role: 'read' | 'send' | 'manage' | 'admin';
  workshopId: string | null;
};

const BASE = '/api/v2/operator/workshops';

function json<T>(response: LightMyRequestResponse): T {
  return response.json() as T;
}

function keys(value: object): string[] {
  return Object.keys(value).sort();
}

async function grantAccess(db: Db, schema: string, grants: Grant[]): Promise<void> {
  for (const grant of grants) {
    await db.query(
      `INSERT INTO "${schema}".staff_access (company_id, staff_id, role, workshop_id, version)
       VALUES ('c1',$1,$2,$3,1)`,
      [grant.staffId, grant.role, grant.workshopId],
    );
    await db.query(
      `INSERT INTO "${schema}".staff_sessions (company_id, id, staff_id, epoch, expires_at)
       VALUES ('c1',$1,$2,1, now() + interval '1 day')`,
      [sessionIdFor('c1', grant.staffId), grant.staffId],
    );
  }
}

async function fixture(db: Db, schema: string): Promise<WorkshopBase> {
  const base = await seedWorkshopBase(db, schema);
  await db.query(
    `INSERT INTO "${schema}".staff (company_id, id, display_name) VALUES ('c1','scopedAdmin','Scoped Admin')`,
  );
  await grantAccess(db, schema, [
    { staffId: base.staff.owner, role: 'admin', workshopId: null },
    { staffId: base.staff.noSend, role: 'read', workshopId: base.workshops.a },
    { staffId: base.staff.outsider, role: 'send', workshopId: base.workshops.b },
    { staffId: 'scopedAdmin', role: 'admin', workshopId: base.workshops.a },
  ]);
  return base;
}

async function createRoute(
  app: FastifyInstance,
  cookie: string,
  workshopId: string,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `${BASE}/${workshopId}/routes`,
    headers: { cookie },
    payload,
  });
}

test('workshop routes authenticate first and enforce roles', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const base = await fixture(db, schema);
    const app = await buildTestApp({ db, schema });

    const anonymous = await app.inject({ method: 'GET', url: BASE });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(json<{ code: string }>(anonymous).code, 'UNAUTHENTICATED');

    // A read grant cannot create a workshop.
    const reader = sessionCookie('c1', base.staff.noSend, 'read');
    const forbidden = await app.inject({
      method: 'POST',
      url: BASE,
      headers: { cookie: reader },
      payload: { id: 'wC' },
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(json<{ code: string }>(forbidden).code, 'FORBIDDEN');

    // A send grant cannot set a group rule (manage is required).
    const sender = sessionCookie('c1', base.staff.outsider, 'send');
    const groupForbidden = await app.inject({
      method: 'POST',
      url: `${BASE}/${base.workshops.b}/groups`,
      headers: { cookie: sender },
      payload: {
        connectionId: base.connections.b,
        bindingEpoch: 1,
        externalChatId: 'group-1',
        decision: 'allow_crm',
      },
    });
    assert.equal(groupForbidden.statusCode, 403);
    assert.equal(json<{ code: string }>(groupForbidden).code, 'FORBIDDEN');

    await app.close();
  } finally {
    await close();
  }
});

test('workshop list is scoped to the session workshop', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const base = await fixture(db, schema);
    const app = await buildTestApp({ db, schema });

    const admin = sessionCookie('c1', base.staff.owner, 'admin');
    const companyWide = await app.inject({ method: 'GET', url: BASE, headers: { cookie: admin } });
    assert.equal(companyWide.statusCode, 200, companyWide.body);
    const all = json<{ items: Array<{ id: string; displayName: string | null }> }>(companyWide);
    assert.deepEqual(all.items.map((item) => item.id), ['wA', 'wB']);
    assert.deepEqual(keys(all.items[0]!), ['displayName', 'id']);

    const scoped = sessionCookie('c1', base.staff.noSend, 'read');
    const own = await app.inject({ method: 'GET', url: BASE, headers: { cookie: scoped } });
    assert.equal(own.statusCode, 200, own.body);
    assert.deepEqual(json<{ items: Array<{ id: string }> }>(own).items.map((item) => item.id), ['wA']);

    await app.close();
  } finally {
    await close();
  }
});

test('creating a workshop is audited in the same transaction', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const base = await fixture(db, schema);
    const app = await buildTestApp({ db, schema });
    const admin = sessionCookie('c1', base.staff.owner, 'admin');

    const created = await app.inject({
      method: 'POST',
      url: BASE,
      headers: { cookie: admin },
      payload: { id: 'wC', displayName: 'Workshop C' },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.deepEqual(json(created), { id: 'wC', displayName: 'Workshop C' });
    assert.equal(
      await countRows(db, schema, 'audit_events', "event_name='workshop.created' AND subject_id='wC'", []),
      1,
    );

    // Idempotent by natural key: the same request does not duplicate the workshop.
    const again = await app.inject({
      method: 'POST',
      url: BASE,
      headers: { cookie: admin },
      payload: { id: 'wC', displayName: 'Workshop C' },
    });
    assert.equal(again.statusCode, 201, again.body);
    assert.equal(await countRows(db, schema, 'workshops', "id='wC'", []), 1);

        // A scoped admin cannot create a workshop outside their scope.
    const scopedAdmin = sessionCookie('c1', 'scopedAdmin', 'admin');
    const foreign = await app.inject({
      method: 'POST',
      url: BASE,
      headers: { cookie: scopedAdmin },
      payload: { id: 'wD' },
    });
    assert.equal(foreign.statusCode, 404);
    assert.equal(json<{ code: string }>(foreign).code, 'NOT_FOUND');

    await app.close();
  } finally {
    await close();
  }
});

test('connection routes are created and updated with CAS and audit', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const base = await fixture(db, schema);
    const app = await buildTestApp({ db, schema });
    const admin = sessionCookie('c1', base.staff.owner, 'admin');

    const payload = {
      connectionId: base.connections.a,
      crmAccountId: base.accounts.a,
      funnelId: 'funnel-1',
      defaultOwnerId: base.staff.owner,
      technicalSourceId: base.sources.a,
      expectedVersion: 0,
    };
    const created = await createRoute(app, admin, base.workshops.a, payload);
    assert.equal(created.statusCode, 200, created.body);
    const route = json<Record<string, unknown>>(created);
    assert.deepEqual(keys(route), [
      'alertStaffId',
      'connectionId',
      'crmAccountId',
      'defaultOwnerId',
      'funnelId',
      'normalizePhone',
      'statusId',
      'technicalSourceId',
      'version',
      'workshopId',
    ]);
    assert.deepEqual(route, {
      connectionId: 'connA',
      workshopId: 'wA',
      crmAccountId: 'accA',
      funnelId: 'funnel-1',
      defaultOwnerId: 'owner1',
      technicalSourceId: 'srcA',
      statusId: null,
      alertStaffId: null,
      normalizePhone: false,
      version: 1,
    });
    assert.equal(
      await countRows(db, schema, 'audit_events', "event_name='workshop.route_updated' AND subject_id='connA'", []),
      1,
    );

    const listed = await app.inject({
      method: 'GET',
      url: `${BASE}/${base.workshops.a}/routes`,
      headers: { cookie: admin },
    });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(json<{ items: unknown[] }>(listed).items, [route]);

    // A stale expected version is a conflict that reports the current version.
    const stale = await createRoute(app, admin, base.workshops.a, { ...payload, funnelId: 'funnel-2' });
    assert.equal(stale.statusCode, 409);
    assert.equal(json<{ code: string }>(stale).code, 'VERSION_CONFLICT');
    assert.equal(stale.headers['x-current-version'], '1');

    const updated = await createRoute(app, admin, base.workshops.a, {
      ...payload,
      funnelId: 'funnel-2',
      expectedVersion: 1,
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(json<{ version: number }>(updated).version, 2);
    assert.equal(
      await countRows(db, schema, 'audit_events', "event_name='workshop.route_updated'", []),
      2,
    );

    // A foreign workshop is not disclosed to a workshop-scoped session.
    const scoped = sessionCookie('c1', base.staff.noSend, 'read');
    const foreign = await app.inject({
      method: 'GET',
      url: `${BASE}/${base.workshops.b}/routes`,
      headers: { cookie: scoped },
    });
    assert.equal(foreign.statusCode, 404);
    assert.equal(json<{ code: string }>(foreign).code, 'NOT_FOUND');

    await app.close();
  } finally {
    await close();
  }
});

test('a route carries the stage, the alert recipient and the phone rule', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const base = await fixture(db, schema);
    const app = await buildTestApp({ db, schema });
    const admin = sessionCookie('c1', base.staff.owner, 'admin');

    const payload = {
      connectionId: base.connections.a,
      crmAccountId: base.accounts.a,
      funnelId: 'funnel-1',
      defaultOwnerId: base.staff.owner,
      technicalSourceId: base.sources.a,
      statusId: 'stage-7',
      alertStaffId: base.staff.owner,
      normalizePhone: true,
      expectedVersion: 0,
    };
    const created = await createRoute(app, admin, base.workshops.a, payload);
    assert.equal(created.statusCode, 200, created.body);
    const route = json<Record<string, unknown>>(created);
    assert.equal(route.statusId, 'stage-7');
    assert.equal(route.alertStaffId, base.staff.owner);
    assert.equal(route.normalizePhone, true);

    // Routing settings are part of the versioned route, so changing the stage is a
    // compare-and-set write like any other field.
    const updated = await createRoute(app, admin, base.workshops.a, {
      ...payload,
      statusId: 'stage-8',
      normalizePhone: false,
      expectedVersion: 1,
    });
    assert.equal(updated.statusCode, 200, updated.body);
    const after = json<Record<string, unknown>>(updated);
    assert.equal(after.statusId, 'stage-8');
    assert.equal(after.normalizePhone, false);
    assert.equal(after.alertStaffId, base.staff.owner, 'the alert recipient survives an unrelated change');

    const emptyStage = await createRoute(app, admin, base.workshops.a, {
      ...payload,
      statusId: '',
      expectedVersion: 2,
    });
    assert.equal(emptyStage.statusCode, 400, 'an empty stage is not a stage');
    assert.equal(json<{ code: string }>(emptyStage).code, 'VALIDATION_FAILED');

    await app.close();
  } finally {
    await close();
  }
});

test('group rules are set by manage and listed for the workshop routes only', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const base = await fixture(db, schema);
    const app = await buildTestApp({ db, schema });
    const admin = sessionCookie('c1', base.staff.owner, 'admin');

    // The connection must be routed to the workshop before its rules are addressable.
    const routed = await createRoute(app, admin, base.workshops.a, {
      connectionId: base.connections.a,
      crmAccountId: base.accounts.a,
      funnelId: 'funnel-1',
      defaultOwnerId: base.staff.owner,
      technicalSourceId: base.sources.a,
      expectedVersion: 0,
    });
    assert.equal(routed.statusCode, 200, routed.body);

    const created = await app.inject({
      method: 'POST',
      url: `${BASE}/${base.workshops.a}/groups`,
      headers: { cookie: admin },
      payload: {
        connectionId: base.connections.a,
        bindingEpoch: 1,
        externalChatId: 'group-1',
        decision: 'allow_crm',
        displayName: 'Sales team',
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const rule = json<Record<string, unknown>>(created);
    assert.deepEqual(keys(rule), [
      'bindingEpoch',
      'connectionId',
      'decision',
      'displayName',
      'externalChatId',
      'version',
    ]);
    assert.deepEqual(rule, {
      connectionId: 'connA',
      bindingEpoch: 1,
      externalChatId: 'group-1',
      decision: 'allow_crm',
      displayName: 'Sales team',
      version: 1,
    });
    assert.equal(
      await countRows(db, schema, 'audit_events', "event_name='workshop.group_rule_set' AND subject_id='connA'", []),
      1,
    );

    const listed = await app.inject({
      method: 'GET',
      url: `${BASE}/${base.workshops.a}/groups?connectionId=${base.connections.a}&bindingEpoch=1`,
      headers: { cookie: admin },
    });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(json<{ items: unknown[] }>(listed).items, [rule]);

    // A connection routed to another workshop is a foreign scope.
    const foreign = await app.inject({
      method: 'GET',
      url: `${BASE}/${base.workshops.a}/groups?connectionId=${base.connections.b}&bindingEpoch=1`,
      headers: { cookie: admin },
    });
    assert.equal(foreign.statusCode, 404);
    assert.equal(json<{ code: string }>(foreign).code, 'NOT_FOUND');

    await app.close();
  } finally {
    await close();
  }
});

test('channel permissions expose separate read and send grants per routed connection', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const base = await fixture(db, schema);
    const app = await buildTestApp({ db, schema });
    const admin = sessionCookie('c1', base.staff.owner, 'admin');

    const routed = await createRoute(app, admin, base.workshops.a, {
      connectionId: base.connections.a,
      crmAccountId: base.accounts.a,
      funnelId: 'funnel-1',
      defaultOwnerId: base.staff.owner,
      technicalSourceId: base.sources.a,
      expectedVersion: 0,
    });
    assert.equal(routed.statusCode, 200, routed.body);

    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/${base.workshops.a}/permissions`,
      headers: { cookie: admin },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = json<{ items: Array<Record<string, unknown>> }>(response);
    assert.deepEqual(body.items, [
      { connectionId: 'connA', staffId: 'agent1', canRead: true, canSend: false },
      { connectionId: 'connA', staffId: 'owner1', canRead: true, canSend: true },
    ]);
    assert.deepEqual(keys(body.items[0]!), ['canRead', 'canSend', 'connectionId', 'staffId']);

    // A workshop-scoped reader sees only their own workshop.
    const scoped = sessionCookie('c1', base.staff.noSend, 'read');
    const own = await app.inject({
      method: 'GET',
      url: `${BASE}/${base.workshops.a}/permissions`,
      headers: { cookie: scoped },
    });
    assert.equal(own.statusCode, 200, own.body);

    const foreign = await app.inject({
      method: 'GET',
      url: `${BASE}/${base.workshops.b}/permissions`,
      headers: { cookie: scoped },
    });
    assert.equal(foreign.statusCode, 404);
    assert.equal(json<{ code: string }>(foreign).code, 'NOT_FOUND');

    await app.close();
  } finally {
    await close();
  }
});

test('a failed audit write rolls the workshop and route mutations back', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const base = await fixture(db, schema);
    const app = await buildTestApp({ db, schema });
    const admin = sessionCookie('c1', base.staff.owner, 'admin');

    // Force the audit insert to fail: the mutation and its audit share one
    // transaction, so neither may survive.
    await db.query(
      `CREATE FUNCTION "${schema}".fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'audit_unavailable'; END $$`,
    );
    await db.query(
      `CREATE TRIGGER fail_audit BEFORE INSERT ON "${schema}".audit_events
         FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_audit()`,
    );

    const failedCreate = await app.inject({
      method: 'POST',
      url: BASE,
      headers: { cookie: admin },
      payload: { id: 'wRollback' },
    });
    assert.equal(failedCreate.statusCode, 500, failedCreate.body);
    assert.equal(await countRows(db, schema, 'workshops', "id='wRollback'", []), 0);

    const failedRoute = await createRoute(app, admin, base.workshops.a, {
      connectionId: base.connections.a,
      crmAccountId: base.accounts.a,
      funnelId: 'funnel-1',
      defaultOwnerId: base.staff.owner,
      technicalSourceId: base.sources.a,
      expectedVersion: 0,
    });
    assert.equal(failedRoute.statusCode, 500, failedRoute.body);
    assert.equal(await countRows(db, schema, 'connection_routes', "connection_id='connA'", []), 0);

    const failedRule = await app.inject({
      method: 'POST',
      url: `${BASE}/${base.workshops.a}/groups`,
      headers: { cookie: admin },
      payload: {
        connectionId: base.connections.a,
        bindingEpoch: 1,
        externalChatId: 'group-1',
        decision: 'exclude',
      },
    });
    // The rule is refused earlier: the connection has no route yet.
    assert.equal(failedRule.statusCode, 404, failedRule.body);

    await app.close();
  } finally {
    await close();
  }
});
