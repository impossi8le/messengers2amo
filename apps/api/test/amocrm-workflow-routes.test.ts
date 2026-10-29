import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LightMyRequestResponse } from 'fastify';
import { buildTestApp, sessionCookie } from './helpers/app.ts';
import { createTestDb } from './helpers/db.ts';
import { sessionIdFor } from './helpers/fixtures.ts';
import { seedWorkshopBase, type WorkshopBase } from './helpers/workshops.ts';
import { countRows } from './helpers/attention.ts';
import { createTokenCipher } from '../src/integrations/amocrm/crypto.ts';
import type { WorkflowClient } from '../src/integrations/amocrm/workflow.ts';
import type { Db } from '../src/platform/db.ts';

const BASE = '/api/v2/operator/crm';

type ClientState = {
  reads: number;
  contactOwnerRef: string | null;
  lead: { id: string; responsibleUserId: string | null } | null;
};

function fakeClient(overrides: Partial<ClientState> = {}): { client: WorkflowClient; state: ClientState } {
  const state: ClientState = {
    reads: 0,
    contactOwnerRef: 'amo-user-1',
    lead: { id: 'lead-1', responsibleUserId: 'amo-user-1' },
    ...overrides,
  };
  const client: WorkflowClient = {
    async readResponsible() {
      state.reads += 1;
      return { contactOwnerRef: state.contactOwnerRef, lead: state.lead };
    },
    async setContactOwner() {
      throw new Error('not used in these routes');
    },
  };
  return { client, state };
}

function json<T>(response: LightMyRequestResponse): T {
  return response.json() as T;
}

function keys(value: object): string[] {
  return Object.keys(value).sort();
}

type Grant = { staffId: string; role: 'read' | 'send' | 'manage' | 'admin'; workshopId: string | null };

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

/**
 * Two workshops with separate routed connections and CRM accounts. `agent1` is a
 * workshop-scoped manager of wA; `outsider` is a company-wide reader.
 */
async function fixture(db: Db, schema: string): Promise<WorkshopBase> {
  const base = await seedWorkshopBase(db, schema);
  await grantAccess(db, schema, [
    { staffId: base.staff.owner, role: 'admin', workshopId: null },
    { staffId: base.staff.noSend, role: 'manage', workshopId: base.workshops.a },
    { staffId: base.staff.outsider, role: 'read', workshopId: null },
  ]);
  await db.query(
    `INSERT INTO "${schema}".connection_routes
       (company_id, connection_id, workshop_id, crm_account_id, funnel_id, default_owner_id, technical_source_id, version)
     VALUES ('c1','connA','wA','accA','funnel-1','owner1','srcA',1),
            ('c1','connB','wB','accB','funnel-1','owner1','srcB',1)`,
  );
  await db.query(
    `INSERT INTO "${schema}".work_items (company_id, id, conversation_id, state, owner_id)
     VALUES ('c1','wiA','convA','assigned','owner1'), ('c1','wiB','convB','assigned','owner1')`,
  );
  await db.query(
    `INSERT INTO "${schema}".crm_bindings
       (company_id, id, account_id, conversation_id, state, contact_id, chat_id, lead_id)
     VALUES ('c1','bindA','accA','convA','bound','contact-1','chat-1','lead-1'),
            ('c1','bindB','accB','convB','bound','contact-2','chat-2','lead-2')`,
  );
  return base;
}

async function buildCrmApp(
  db: Db,
  schema: string,
  client: WorkflowClient,
  accountDomain: string | null = 'p14lenrem.amocrm.ru',
) {
  return buildTestApp({
    db,
    schema,
    amocrm: {
      cipher: createTokenCipher('test-token-key-material-0123456789'),
      workflowClient: client,
      accountDomain,
    },
  });
}

test('CRM workflow routes authenticate first and enforce roles', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await fixture(db, schema);
    const { client } = fakeClient();
    const app = await buildCrmApp(db, schema, client);

    const anonymous = await app.inject({ method: 'GET', url: `${BASE}/policy` });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(json<{ code: string }>(anonymous).code, 'UNAUTHENTICATED');

    const reader = sessionCookie('c1', 'outsider', 'read');
    const forbidden = await app.inject({
      method: 'POST',
      url: `${BASE}/policy`,
      headers: { cookie: reader },
      payload: { sourceOfTruth: 'crm', expectedVersion: 0 },
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(json<{ code: string }>(forbidden).code, 'FORBIDDEN');

    const resyncForbidden = await app.inject({
      method: 'POST',
      url: `${BASE}/resync`,
      headers: { cookie: reader },
      payload: { accountId: 'accA', conversationId: 'convA', idempotencyKey: 'r1' },
    });
    assert.equal(resyncForbidden.statusCode, 403);
    assert.equal(json<{ code: string }>(resyncForbidden).code, 'FORBIDDEN');

    await app.close();
  } finally {
    await close();
  }
});

test('assignment policy defaults to platform and changes with CAS and audit', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await fixture(db, schema);
    const { client } = fakeClient();
    const app = await buildCrmApp(db, schema, client);
    const admin = sessionCookie('c1', 'owner1', 'admin');

    const initial = await app.inject({ method: 'GET', url: `${BASE}/policy`, headers: { cookie: admin } });
    assert.equal(initial.statusCode, 200, initial.body);
    assert.deepEqual(json(initial), { sourceOfTruth: 'platform', version: 0 });
    assert.deepEqual(keys(json(initial)), ['sourceOfTruth', 'version']);

    const updated = await app.inject({
      method: 'POST',
      url: `${BASE}/policy`,
      headers: { cookie: admin },
      payload: { sourceOfTruth: 'crm', expectedVersion: 0 },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.deepEqual(json(updated), { sourceOfTruth: 'crm', version: 1 });
    assert.equal(
      await countRows(db, schema, 'audit_events', "event_name='amocrm.assignment_policy_changed'", []),
      1,
    );

    const stale = await app.inject({
      method: 'POST',
      url: `${BASE}/policy`,
      headers: { cookie: admin },
      payload: { sourceOfTruth: 'platform', expectedVersion: 0 },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(json<{ code: string }>(stale).code, 'VERSION_CONFLICT');
    assert.equal(stale.headers['x-current-version'], '1');

    const current = await app.inject({ method: 'GET', url: `${BASE}/policy`, headers: { cookie: admin } });
    assert.deepEqual(json(current), { sourceOfTruth: 'crm', version: 1 });

    await app.close();
  } finally {
    await close();
  }
});

test('conversations outside the session workshop are not disclosed', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await fixture(db, schema);
    const { client } = fakeClient();
    const app = await buildCrmApp(db, schema, client);
    const scoped = sessionCookie('c1', 'agent1', 'manage');
    const companyWide = sessionCookie('c1', 'outsider', 'read');

    const foreign = await app.inject({
      method: 'GET',
      url: `${BASE}/diagnostics?accountId=accB&conversationId=convB`,
      headers: { cookie: scoped },
    });
    assert.equal(foreign.statusCode, 404);
    assert.equal(json<{ code: string }>(foreign).code, 'NOT_FOUND');

    const own = await app.inject({
      method: 'GET',
      url: `${BASE}/diagnostics?accountId=accA&conversationId=convA`,
      headers: { cookie: scoped },
    });
    assert.equal(own.statusCode, 200, own.body);

    const visible = await app.inject({
      method: 'GET',
      url: `${BASE}/diagnostics?accountId=accA&conversationId=convA`,
      headers: { cookie: companyWide },
    });
    assert.equal(visible.statusCode, 200, visible.body);

    const resyncForeign = await app.inject({
      method: 'POST',
      url: `${BASE}/resync`,
      headers: { cookie: scoped },
      payload: { accountId: 'accB', conversationId: 'convB', idempotencyKey: 'r-foreign' },
    });
    assert.equal(resyncForeign.statusCode, 404);
    assert.equal(json<{ code: string }>(resyncForeign).code, 'NOT_FOUND');

    const unknown = await app.inject({
      method: 'POST',
      url: `${BASE}/resync`,
      headers: { cookie: scoped },
      payload: { accountId: 'accA', conversationId: 'conv-missing', idempotencyKey: 'r-missing' },
    });
    assert.equal(unknown.statusCode, 404);

    await app.close();
  } finally {
    await close();
  }
});

test('manual resync is idempotent by key and does not duplicate rows', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await fixture(db, schema);
    const { client, state } = fakeClient();
    const app = await buildCrmApp(db, schema, client);
    const manager = sessionCookie('c1', 'agent1', 'manage');

    const first = await app.inject({
      method: 'POST',
      url: `${BASE}/resync`,
      headers: { cookie: manager },
      payload: { accountId: 'accA', conversationId: 'convA', idempotencyKey: 'resync-1' },
    });
    assert.equal(first.statusCode, 200, first.body);
    const result = json<Record<string, unknown>>(first);
    assert.deepEqual(keys(result), ['crmOwnerRef', 'errorCode', 'leadId', 'replayed', 'status']);
    assert.deepEqual(result, {
      status: 'ok',
      replayed: false,
      leadId: 'lead-1',
      crmOwnerRef: 'amo-user-1',
      errorCode: null,
    });

    const second = await app.inject({
      method: 'POST',
      url: `${BASE}/resync`,
      headers: { cookie: manager },
      payload: { accountId: 'accA', conversationId: 'convA', idempotencyKey: 'resync-1' },
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.deepEqual(json(second), { ...result, replayed: true });
    assert.equal(state.reads, 1, 'a replay must not read the CRM again');
    assert.equal(await countRows(db, schema, 'crm_sync_state', 'company_id=$1', ['c1']), 1);
    assert.equal(await countRows(db, schema, 'crm_contact_owners', 'company_id=$1', ['c1']), 1);
    assert.equal(await countRows(db, schema, 'audit_events', "event_name='amocrm.sync_completed'", []), 1);

    await app.close();
  } finally {
    await close();
  }
});

test('without a configured CRM client resync fails visibly instead of pretending to succeed', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await fixture(db, schema);
    // No `amocrm` deps at all: the app must fall back to unavailableWorkflowClient.
    const app = await buildTestApp({ db, schema });
    const manager = sessionCookie('c1', 'agent1', 'manage');

    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/resync`,
      headers: { cookie: manager },
      payload: { accountId: 'accA', conversationId: 'convA', idempotencyKey: 'resync-unconfigured' },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(json(response), {
      status: 'failed',
      replayed: false,
      leadId: null,
      crmOwnerRef: null,
      errorCode: 'upstream_unavailable',
    });
    assert.equal(await countRows(db, schema, 'crm_sync_state', 'company_id=$1', ['c1']), 1);

    await app.close();
  } finally {
    await close();
  }
});

test('open owner conflicts are listed with the exact contract fields and scoped', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await fixture(db, schema);
    await db.query(
      `INSERT INTO "${schema}".crm_assignment_conflicts
         (company_id, id, account_id, conversation_id, crm_owner_ref, platform_owner_id,
          desired_crm_owner_ref, policy, winner, state)
       VALUES ('c1','confA','accA','convA','amo-user-9','owner1','amo-user-1','platform','platform','open'),
              ('c1','confB','accB','convB','amo-user-8','owner1','amo-user-1','platform','platform','open')`,
    );
    const { client } = fakeClient();
    const app = await buildCrmApp(db, schema, client);
    const scoped = sessionCookie('c1', 'agent1', 'manage');
    const companyWide = sessionCookie('c1', 'outsider', 'read');

    const own = await app.inject({ method: 'GET', url: `${BASE}/conflicts`, headers: { cookie: scoped } });
    assert.equal(own.statusCode, 200, own.body);
    const items = json<{ items: Array<Record<string, unknown>> }>(own).items;
    assert.deepEqual(items.map((item) => item.id), ['confA']);
    assert.deepEqual(keys(items[0]!), [
      'accountId',
      'conversationId',
      'crmOwnerRef',
      'desiredCrmOwnerRef',
      'detectedAt',
      'id',
      'platformOwnerId',
      'policy',
      'state',
      'winner',
    ]);
    assert.equal(items[0]!.crmOwnerRef, 'amo-user-9');
    assert.equal(items[0]!.state, 'open');
    assert.equal(typeof items[0]!.detectedAt, 'string');

    const all = await app.inject({ method: 'GET', url: `${BASE}/conflicts`, headers: { cookie: companyWide } });
    assert.equal(all.statusCode, 200, all.body);
    assert.deepEqual(
      json<{ items: Array<{ id: string }> }>(all).items.map((item) => item.id),
      ['confA', 'confB'],
    );

    const foreign = await app.inject({
      method: 'GET',
      url: `${BASE}/conflicts?conversationId=convB`,
      headers: { cookie: scoped },
    });
    assert.equal(foreign.statusCode, 404);

    await app.close();
  } finally {
    await close();
  }
});

test('diagnostics omit the CRM card link when no account domain is configured', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await fixture(db, schema);
    const { client } = fakeClient();
    const app = await buildCrmApp(db, schema, client, null);
    const manager = sessionCookie('c1', 'agent1', 'manage');

    const diagnostics = await app.inject({
      method: 'GET',
      url: `${BASE}/diagnostics?accountId=accA&conversationId=convA`,
      headers: { cookie: manager },
    });
    assert.equal(diagnostics.statusCode, 200, diagnostics.body);
    const body = json<{ binding: Record<string, unknown> | null; cardUrl: string | null }>(diagnostics);
    assert.equal(body.cardUrl, null);
    assert.equal(body.binding?.leadId, 'lead-1', 'the binding is still reported');

    await app.close();
  } finally {
    await close();
  }
});

test('diagnostics expose a missing lead instead of failing', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await fixture(db, schema);
    const { client } = fakeClient({ contactOwnerRef: 'amo-user-5', lead: null });
    const app = await buildCrmApp(db, schema, client);
    const manager = sessionCookie('c1', 'agent1', 'manage');

    const synced = await app.inject({
      method: 'POST',
      url: `${BASE}/resync`,
      headers: { cookie: manager },
      payload: { accountId: 'accA', conversationId: 'convA', idempotencyKey: 'lead-missing-1' },
    });
    assert.equal(synced.statusCode, 200, synced.body);
    assert.equal(json<{ status: string }>(synced).status, 'lead_missing');

    const diagnostics = await app.inject({
      method: 'GET',
      url: `${BASE}/diagnostics?accountId=accA&conversationId=convA`,
      headers: { cookie: manager },
    });
    assert.equal(diagnostics.statusCode, 200, diagnostics.body);
    const body = json<{
      sync: Record<string, unknown> | null;
      leadMissing: boolean;
      projection: unknown;
      openConflicts: number;
      binding: Record<string, unknown> | null;
      cardUrl: string | null;
    }>(diagnostics);
    assert.deepEqual(keys(body), [
      'binding',
      'cardUrl',
      'leadMissing',
      'openConflicts',
      'projection',
      'sync',
    ]);
    assert.deepEqual(body.binding, {
      accountId: 'accA',
      contactId: 'contact-1',
      leadId: 'lead-1',
      chatId: 'chat-1',
      state: 'bound',
    });
    assert.equal(body.cardUrl, 'https://p14lenrem.amocrm.ru/leads/detail/lead-1');
    assert.equal(body.leadMissing, true);
    assert.equal(body.openConflicts, 0);
    assert.equal(body.projection, null);
    assert.ok(body.sync);
    assert.deepEqual(keys(body.sync), ['errorCode', 'lastAttemptAt', 'lastSuccessAt', 'result', 'status']);
    assert.equal(body.sync!.status, 'lead_missing');
    assert.equal(body.sync!.errorCode, 'crm_lead_missing');

    await app.close();
  } finally {
    await close();
  }
});

test('a failed audit write rolls the policy change back', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await fixture(db, schema);
    const { client } = fakeClient();
    const app = await buildCrmApp(db, schema, client);
    const admin = sessionCookie('c1', 'owner1', 'admin');

    await db.query(
      `CREATE FUNCTION "${schema}".fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'audit_unavailable'; END $$`,
    );
    await db.query(
      `CREATE TRIGGER fail_audit BEFORE INSERT ON "${schema}".audit_events
         FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_audit()`,
    );

    const failed = await app.inject({
      method: 'POST',
      url: `${BASE}/policy`,
      headers: { cookie: admin },
      payload: { sourceOfTruth: 'crm', expectedVersion: 0 },
    });
    assert.equal(failed.statusCode, 500, failed.body);
    assert.deepEqual(await flowPolicy(db, schema), { sourceOfTruth: 'platform', version: 0 });

    await app.close();
  } finally {
    await close();
  }
});

async function flowPolicy(db: Db, schema: string): Promise<{ sourceOfTruth: string; version: number }> {
  const { rows } = await db.query<{ source_of_truth: string; version: string }>(
    `SELECT source_of_truth, version FROM "${schema}".crm_assignment_policy WHERE company_id='c1'`,
  );
  const row = rows[0];
  return row ? { sourceOfTruth: row.source_of_truth, version: Number(row.version) } : { sourceOfTruth: 'platform', version: 0 };
}
