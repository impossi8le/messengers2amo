import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createTestApp, cookieFromResponse } from './helpers/app.ts';
import { seedCompany, seedConnection } from './helpers/seed.ts';
import type { Db } from '../src/platform/db.ts';

const PASSWORD = 'correct horse battery staple';

async function login(app: FastifyInstance, companyId: string, staffId: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v2/auth/login',
    payload: { companyId, staffId, password: PASSWORD },
  });
  assert.equal(response.statusCode, 200, response.body);
  return cookieFromResponse(response);
}

function json<T>(response: LightMyRequestResponse): T {
  return response.json() as T;
}

function sortedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort();
}

/** A complete tenant slice for one binding: account, connection, conversation, binding. */
async function seedBinding(
  db: Db,
  input: {
    companyId: string;
    connectionId: string;
    accountId: string;
    conversationId: string;
    bindingId: string;
    state: 'pending' | 'bound' | 'creation_unknown' | 'disabled';
    contactId?: string | null;
    chatId?: string | null;
    leadId?: string | null;
    version?: number;
  },
): Promise<void> {
  const existing = await db.query(`SELECT 1 FROM connections WHERE company_id = $1 AND id = $2`, [
    input.companyId,
    input.connectionId,
  ]);
  if (!existing.rowCount) {
    await seedConnection(db, { companyId: input.companyId, id: input.connectionId, state: 'active' });
  }
  await db.query(`INSERT INTO crm_accounts (company_id, id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [
    input.companyId,
    input.accountId,
  ]);
  await db.query(
    `INSERT INTO conversations (company_id,id,connection_id,binding_epoch,external_chat_id,chat_kind)
     VALUES ($1,$2,$3,0,$4,'private')`,
    [input.companyId, input.conversationId, input.connectionId, `chat_${input.conversationId}`],
  );
  await db.query(
    `INSERT INTO crm_bindings
       (company_id,id,account_id,conversation_id,state,contact_id,chat_id,lead_id,version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.companyId,
      input.bindingId,
      input.accountId,
      input.conversationId,
      input.state,
      input.contactId ?? null,
      input.chatId ?? null,
      input.leadId ?? null,
      input.version ?? 0,
    ],
  );
}

test('connection health returns the connection projection with computed health', async () => {
  const { app, db, close } = await createTestApp();
  try {
    await seedCompany(db, {
      companyId: 'c1',
      staff: [
        { id: 'reader', password: PASSWORD, role: 'read' },
        { id: 'manager', password: PASSWORD, role: 'manage' },
      ],
    });
    await seedConnection(db, {
      companyId: 'c1',
      id: 'conn1',
      state: 'active',
      version: 3,
    });
    await db.query(
      `INSERT INTO inbox_events
         (company_id,id,connection_id,binding_epoch,payload_major,kind,payload,received_at)
       VALUES ('c1','ev1','conn1',0,2,'message.inbound','{}'::jsonb,'2026-01-02T03:04:05Z')`,
    );

    const cookie = await login(app, 'c1', 'reader');
    const response = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/connections/conn1/health',
      headers: { cookie },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = json<Record<string, unknown>>(response);

    // Exactly the web's ConnectionProjection shape: no extra top-level fields.
    assert.deepEqual(sortedKeys(body), [
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
    assert.equal(body.id, 'conn1');
    assert.equal(body.state, 'active');
    assert.equal(body.version, 3);
    assert.equal(body.credentialsVersion, 1);
    assert.equal(body.bindingEpoch, 0);
    assert.equal(body.ingressEnabled, false);
    assert.equal(body.sendEnabled, false);
    assert.equal(body.channelMode, 'telegram_bot');

    const health = body.health as Record<string, unknown>;
    assert.deepEqual(sortedKeys(health), ['checkedAt', 'errorCode', 'lastInboundAt', 'lastSuccessAt']);
    assert.equal(typeof health.checkedAt, 'string');
    assert.equal(health.lastInboundAt, '2026-01-02T03:04:05.000Z');
    assert.equal(health.lastSuccessAt, null);
    assert.equal(health.errorCode, null);
  } finally {
    await close();
  }
});

test('connection health hides foreign and missing connections behind the same 404', async () => {
  const { app, db, close } = await createTestApp();
  try {
    await seedCompany(db, {
      companyId: 'c1',
      staff: [{ id: 'reader', password: PASSWORD, role: 'read' }],
    });
    await seedCompany(db, {
      companyId: 'c2',
      staff: [{ id: 'other', password: PASSWORD, role: 'read' }],
    });
    await seedConnection(db, { companyId: 'c2', id: 'conn_foreign', state: 'active' });

    const cookie = await login(app, 'c1', 'reader');

    const foreign = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/connections/conn_foreign/health',
      headers: { cookie },
    });
    const missing = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/connections/does_not_exist/health',
      headers: { cookie },
    });

    assert.equal(foreign.statusCode, 404, foreign.body);
    assert.equal(missing.statusCode, 404, missing.body);
    const foreignBody = json<Record<string, unknown>>(foreign);
    const missingBody = json<Record<string, unknown>>(missing);
    // The body carries a per-request id, so compare the shape and stable fields.
    assert.deepEqual(sortedKeys(foreignBody), sortedKeys(missingBody));
    assert.equal(foreignBody.code, missingBody.code);
    assert.equal(foreignBody.retryable, missingBody.retryable);
    assert.equal(foreignBody.code, 'NOT_FOUND');
    assert.equal(foreignBody.retryable, false);
  } finally {
    await close();
  }
});

test('connection health requires an authenticated session', async () => {
  const { app, db, close } = await createTestApp();
  try {
    await seedCompany(db, { companyId: 'c1', staff: [{ id: 'reader', password: PASSWORD, role: 'read' }] });
    await seedConnection(db, { companyId: 'c1', id: 'conn1', state: 'active' });

    const anonymous = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/connections/conn1/health',
    });
    assert.equal(anonymous.statusCode, 401, anonymous.body);
    assert.equal(json<{ code: string }>(anonymous).code, 'UNAUTHENTICATED');

    const cookie = await login(app, 'c1', 'reader');
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/connections/conn1/health',
      headers: { cookie },
    });
    assert.equal(allowed.statusCode, 200, allowed.body);
  } finally {
    await close();
  }
});

test('connection health applies the same workshop scope as the connection list', async () => {
  const { app, db, close } = await createTestApp();
  try {
    await seedCompany(db, {
      companyId: 'c1',
      workshops: ['ws1', 'ws2'],
      staff: [
        { id: 'ws_reader', password: PASSWORD, role: 'read', workshopId: 'ws1' },
        { id: 'company_reader', password: PASSWORD, role: 'read' },
      ],
    });
    await seedConnection(db, {
      companyId: 'c1',
      id: 'conn_in',
      state: 'active',
      workshopId: 'ws1',
      ownerId: 'ws_reader',
    });
    await seedConnection(db, {
      companyId: 'c1',
      id: 'conn_out',
      state: 'active',
      workshopId: 'ws2',
      ownerId: 'company_reader',
    });

    const workshopCookie = await login(app, 'c1', 'ws_reader');
    const own = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/connections/conn_in/health',
      headers: { cookie: workshopCookie },
    });
    assert.equal(own.statusCode, 200, own.body);

    const outside = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/connections/conn_out/health',
      headers: { cookie: workshopCookie },
    });
    assert.equal(outside.statusCode, 404, outside.body);
    assert.equal(json<{ code: string }>(outside).code, 'NOT_FOUND');

    const companyCookie = await login(app, 'c1', 'company_reader');
    const companyWide = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/connections/conn_out/health',
      headers: { cookie: companyCookie },
    });
    assert.equal(companyWide.statusCode, 200, companyWide.body);
  } finally {
    await close();
  }
});

test('crm bindings list is company-scoped, filterable and cursor-paginated', async () => {
  const { app, db, close } = await createTestApp();
  try {
    await seedCompany(db, {
      companyId: 'c1',
      staff: [{ id: 'reader', password: PASSWORD, role: 'read' }],
    });
    await seedCompany(db, {
      companyId: 'c2',
      staff: [{ id: 'other', password: PASSWORD, role: 'read' }],
    });

    await seedBinding(db, {
      companyId: 'c1',
      connectionId: 'conn1',
      accountId: 'acc1',
      conversationId: 'conv1',
      bindingId: 'b1',
      state: 'bound',
      contactId: 'contact-1',
      chatId: 'chat-1',
      leadId: 'lead-1',
      version: 2,
    });
    await seedBinding(db, {
      companyId: 'c1',
      connectionId: 'conn1',
      accountId: 'acc1',
      conversationId: 'conv2',
      bindingId: 'b2',
      state: 'pending',
    });
    await seedBinding(db, {
      companyId: 'c1',
      connectionId: 'conn1',
      accountId: 'acc1',
      conversationId: 'conv3',
      bindingId: 'b3',
      state: 'bound',
      contactId: 'contact-3',
      chatId: 'chat-3',
    });
    await seedBinding(db, {
      companyId: 'c2',
      connectionId: 'conn9',
      accountId: 'acc9',
      conversationId: 'conv9',
      bindingId: 'b9',
      state: 'bound',
      contactId: 'contact-9',
      chatId: 'chat-9',
    });

    const cookie = await login(app, 'c1', 'reader');

    const all = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/crm/bindings',
      headers: { cookie },
    });
    assert.equal(all.statusCode, 200, all.body);
    const allBody = json<{ items: Array<Record<string, unknown>>; page: { nextCursor: string | null } }>(all);
    assert.deepEqual(allBody.items.map((item) => item.id), ['b1', 'b2', 'b3']);
    assert.deepEqual(sortedKeys(allBody.items[0]!), [
      'chatId',
      'contactId',
      'conversationId',
      'crmAccountId',
      'id',
      'leadId',
      'state',
      'version',
    ]);
    assert.deepEqual(allBody.items[0], {
      id: 'b1',
      conversationId: 'conv1',
      crmAccountId: 'acc1',
      contactId: 'contact-1',
      leadId: 'lead-1',
      chatId: 'chat-1',
      version: 2,
      state: 'bound',
    });
    assert.equal(allBody.page.nextCursor, null);

    const byConversation = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/crm/bindings?conversationId=conv2',
      headers: { cookie },
    });
    assert.equal(byConversation.statusCode, 200, byConversation.body);
    const byConversationBody = json<{ items: Array<{ id: string }> }>(byConversation);
    assert.deepEqual(byConversationBody.items.map((item) => item.id), ['b2']);

    const byState = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/crm/bindings?state=bound',
      headers: { cookie },
    });
    assert.equal(byState.statusCode, 200, byState.body);
    assert.deepEqual(json<{ items: Array<{ id: string }> }>(byState).items.map((item) => item.id), ['b1', 'b3']);

    const firstPage = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/crm/bindings?limit=2',
      headers: { cookie },
    });
    assert.equal(firstPage.statusCode, 200, firstPage.body);
    const firstPageBody = json<{ items: Array<{ id: string }>; page: { nextCursor: string | null } }>(firstPage);
    assert.deepEqual(firstPageBody.items.map((item) => item.id), ['b1', 'b2']);
    assert.equal(firstPageBody.page.nextCursor, 'b2');

    const secondPage = await app.inject({
      method: 'GET',
      url: `/api/v2/operator/crm/bindings?limit=2&after=${firstPageBody.page.nextCursor}`,
      headers: { cookie },
    });
    assert.equal(secondPage.statusCode, 200, secondPage.body);
    const secondPageBody = json<{ items: Array<{ id: string }>; page: { nextCursor: string | null } }>(secondPage);
    assert.deepEqual(secondPageBody.items.map((item) => item.id), ['b3']);
    assert.equal(secondPageBody.page.nextCursor, null);
  } finally {
    await close();
  }
});

test('crm bindings never widen scope from the query and reject unknown parameters', async () => {
  const { app, db, close } = await createTestApp();
  try {
    await seedCompany(db, {
      companyId: 'c1',
      staff: [{ id: 'reader', password: PASSWORD, role: 'read' }],
    });
    await seedCompany(db, {
      companyId: 'c2',
      staff: [{ id: 'other', password: PASSWORD, role: 'read' }],
    });
    await seedBinding(db, {
      companyId: 'c1',
      connectionId: 'conn1',
      accountId: 'acc1',
      conversationId: 'conv1',
      bindingId: 'b1',
      state: 'bound',
      contactId: 'contact-1',
      chatId: 'chat-1',
    });
    await seedBinding(db, {
      companyId: 'c2',
      connectionId: 'conn9',
      accountId: 'acc9',
      conversationId: 'conv9',
      bindingId: 'b9',
      state: 'bound',
      contactId: 'contact-9',
      chatId: 'chat-9',
    });

    const cookie = await login(app, 'c1', 'reader');

    const companyOverride = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/crm/bindings?companyId=c2',
      headers: { cookie },
    });
    assert.equal(companyOverride.statusCode, 400, companyOverride.body);
    assert.equal(json<{ code: string }>(companyOverride).code, 'VALIDATION_FAILED');

    const unknown = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/crm/bindings?accountId=acc9',
      headers: { cookie },
    });
    assert.equal(unknown.statusCode, 400, unknown.body);
    assert.equal(json<{ code: string }>(unknown).code, 'VALIDATION_FAILED');

    const anonymous = await app.inject({ method: 'GET', url: '/api/v2/operator/crm/bindings' });
    assert.equal(anonymous.statusCode, 401, anonymous.body);
    assert.equal(json<{ code: string }>(anonymous).code, 'UNAUTHENTICATED');
  } finally {
    await close();
  }
});
