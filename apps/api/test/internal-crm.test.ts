import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createTestApp, cookieFromResponse } from './helpers/app.ts';
import { seedCompany, seedConnection } from './helpers/seed.ts';
import type { Db } from '../src/platform/db.ts';

const PASSWORD = 'correct horse battery staple';
const SERVICE_TOKEN = 'internal-service-token-for-tests-0123456789';

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

type SeedCrmInput = {
  companyId: string;
  connectionId?: string;
  accountId?: string;
  conversationId?: string;
  bindingId?: string;
  bindingState?: 'pending' | 'bound' | 'creation_unknown' | 'disabled';
  workItemId?: string;
  workItemState?: string;
  ownerId?: string;
  sendEnabled?: boolean;
};

/** Account, active connection, conversation, binding and a live work item. */
async function seedCrm(db: Db, input: SeedCrmInput): Promise<void> {
  const connectionId = input.connectionId ?? 'conn1';
  const conversationId = input.conversationId ?? 'conv1';
  const accountId = input.accountId ?? 'acc1';
  const bindingState = input.bindingState ?? 'bound';
  await seedConnection(db, { companyId: input.companyId, id: connectionId, state: 'active' });
  if (input.sendEnabled ?? true) {
    await db.query(`UPDATE connections SET send_enabled = true WHERE company_id = $1 AND id = $2`, [
      input.companyId,
      connectionId,
    ]);
  }
  await db.query(`INSERT INTO crm_accounts (company_id, id) VALUES ($1,$2)`, [input.companyId, accountId]);
  await db.query(
    `INSERT INTO conversations (company_id,id,connection_id,binding_epoch,external_chat_id,chat_kind)
     VALUES ($1,$2,$3,0,$4,'private')`,
    [input.companyId, conversationId, connectionId, `chat_${conversationId}`],
  );
  await db.query(
    `INSERT INTO crm_bindings
       (company_id,id,account_id,conversation_id,state,contact_id,chat_id,lead_id,version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.companyId,
      input.bindingId ?? 'b1',
      accountId,
      conversationId,
      bindingState,
      bindingState === 'bound' ? 'contact-1' : null,
      bindingState === 'bound' ? 'chat-1' : null,
      null,
      2,
    ],
  );
  const ownerId = input.ownerId ?? 'owner';
  await db.query(`INSERT INTO staff (company_id,id,display_name) VALUES ($1,$2,$2) ON CONFLICT DO NOTHING`, [
    input.companyId,
    ownerId,
  ]);
  await db.query(
    `INSERT INTO work_items
       (company_id,id,conversation_id,state,owner_id,assignment_version)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      input.companyId,
      input.workItemId ?? 'wi1',
      conversationId,
      input.workItemState ?? 'in_progress',
      ownerId,
      3,
    ],
  );
}

const VALID_COMMAND = {
  crmEventId: 'crm-event-1',
  crmBindingId: 'b1',
  idempotencyKey: 'cmd-key-1',
  text: 'Здравствуйте! Уточните, пожалуйста, адрес.',
  coverage: 'unconfirmed' as const,
};

test('internal CRM routes require the adapter service token and ignore the operator cookie', async () => {
  const { app, db, close } = await createTestApp({ internalServiceToken: SERVICE_TOKEN });
  try {
    await seedCompany(db, {
      companyId: 'c1',
      staff: [{ id: 'reader', password: PASSWORD, role: 'read' }],
    });
    await seedCrm(db, { companyId: 'c1' });
    const cookie = await login(app, 'c1', 'reader');

    const anonymous = await app.inject({ method: 'GET', url: '/api/v2/internal/crm/bindings' });
    assert.equal(anonymous.statusCode, 401, anonymous.body);
    assert.equal(json<{ code: string }>(anonymous).code, 'UNAUTHENTICATED');

    const cookieOnly = await app.inject({
      method: 'GET',
      url: '/api/v2/internal/crm/bindings',
      headers: { cookie },
    });
    assert.equal(cookieOnly.statusCode, 401, cookieOnly.body);

    const wrongToken = await app.inject({
      method: 'GET',
      url: '/api/v2/internal/crm/bindings',
      headers: { authorization: 'Bearer not-the-service-token' },
    });
    assert.equal(wrongToken.statusCode, 401, wrongToken.body);

    const cookieOutbound = await app.inject({
      method: 'POST',
      url: '/api/v2/internal/crm/outbound',
      headers: { cookie },
      payload: VALID_COMMAND,
    });
    assert.equal(cookieOutbound.statusCode, 401, cookieOutbound.body);
  } finally {
    await close();
  }
});

test('internal CRM routes are not registered when the service token is not configured', async () => {
  const { app, db, close } = await createTestApp();
  try {
    await seedCompany(db, {
      companyId: 'c1',
      staff: [{ id: 'reader', password: PASSWORD, role: 'read' }],
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v2/internal/crm/bindings',
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    assert.equal(response.statusCode, 404, response.body);
  } finally {
    await close();
  }
});

test('a valid service token reads CRM bindings', async () => {
  const { app, db, close } = await createTestApp({ internalServiceToken: SERVICE_TOKEN });
  try {
    await seedCompany(db, { companyId: 'c1', staff: [] });
    await seedCrm(db, { companyId: 'c1' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v2/internal/crm/bindings',
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = json<{ items: Array<Record<string, unknown>>; page: { nextCursor: string | null } }>(response);
    assert.deepEqual(body.items, [
      {
        id: 'b1',
        conversationId: 'conv1',
        crmAccountId: 'acc1',
        contactId: 'contact-1',
        leadId: null,
        chatId: 'chat-1',
        version: 2,
        state: 'bound',
      },
    ]);
    assert.equal(body.page.nextCursor, null);
  } finally {
    await close();
  }
});

test('operator CRM bindings are session-scoped and never return another company', async () => {
  const { app, db, close } = await createTestApp({ internalServiceToken: SERVICE_TOKEN });
  try {
    await seedCompany(db, {
      companyId: 'c1',
      staff: [{ id: 'reader', password: PASSWORD, role: 'read' }],
    });
    await seedCompany(db, {
      companyId: 'c2',
      staff: [{ id: 'other', password: PASSWORD, role: 'read' }],
    });
    await seedCrm(db, { companyId: 'c1', bindingId: 'b1' });
    await seedCrm(db, {
      companyId: 'c2',
      connectionId: 'conn9',
      accountId: 'acc9',
      conversationId: 'conv9',
      bindingId: 'b9',
      workItemId: 'wi9',
    });

    const first = await login(app, 'c1', 'reader');
    const firstRead = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/crm/bindings',
      headers: { cookie: first },
    });
    assert.equal(firstRead.statusCode, 200, firstRead.body);
    assert.deepEqual(json<{ items: Array<{ id: string }> }>(firstRead).items.map((item) => item.id), ['b1']);

    const second = await login(app, 'c2', 'other');
    const secondRead = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/crm/bindings',
      headers: { cookie: second },
    });
    assert.equal(secondRead.statusCode, 200, secondRead.body);
    assert.deepEqual(json<{ items: Array<{ id: string }> }>(secondRead).items.map((item) => item.id), ['b9']);

    const override = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/crm/bindings?companyId=c2',
      headers: { cookie: first },
    });
    assert.equal(override.statusCode, 400, override.body);

    const anonymous = await app.inject({ method: 'GET', url: '/api/v2/operator/crm/bindings' });
    assert.equal(anonymous.statusCode, 401, anonymous.body);
  } finally {
    await close();
  }
});

test('outbound accepts a command with 202 and keeps coverage unconfirmed', async () => {
  const { app, db, close } = await createTestApp({ internalServiceToken: SERVICE_TOKEN });
  try {
    await seedCompany(db, { companyId: 'c1', staff: [{ id: 'owner', password: PASSWORD, role: 'send' }] });
    await seedCrm(db, { companyId: 'c1' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/internal/crm/outbound',
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
      payload: VALID_COMMAND,
    });
    assert.equal(response.statusCode, 202, response.body);
    const body = json<{
      id: string;
      state: string;
      providerMessageId: string | null;
      coverage: string;
      selectedRefs: unknown[];
      deliveryEvidence: unknown;
      readEvidence: unknown;
    }>(response);
    assert.equal(body.state, 'accepted');
    assert.equal(body.providerMessageId, null);
    assert.equal(body.coverage, 'unconfirmed');
    assert.deepEqual(body.selectedRefs, []);
    assert.equal(body.deliveryEvidence, null);
    assert.equal(body.readEvidence, null);

    const operations = await db.query<{ id: string; coverage: string; actor_id: string; command_type: string }>(
      `SELECT id, coverage, actor_id, command_type FROM send_operations WHERE company_id = $1`,
      ['c1'],
    );
    assert.equal(operations.rows.length, 1);
    assert.equal(operations.rows[0]!.id, body.id);
    assert.equal(operations.rows[0]!.coverage, 'unconfirmed');
    assert.equal(operations.rows[0]!.actor_id, 'owner');
    assert.equal(operations.rows[0]!.command_type, 'crm_outbound');

    const jobs = await db.query(`SELECT 1 FROM outbox_jobs WHERE company_id = $1`, ['c1']);
    assert.equal(jobs.rows.length, 1);
  } finally {
    await close();
  }
});

test('a repeated command key replays instead of creating a duplicate', async () => {
  const { app, db, close } = await createTestApp({ internalServiceToken: SERVICE_TOKEN });
  try {
    await seedCompany(db, { companyId: 'c1', staff: [{ id: 'owner', password: PASSWORD, role: 'send' }] });
    await seedCrm(db, { companyId: 'c1' });
    const headers = { authorization: `Bearer ${SERVICE_TOKEN}` };

    const first = await app.inject({
      method: 'POST',
      url: '/api/v2/internal/crm/outbound',
      headers,
      payload: VALID_COMMAND,
    });
    assert.equal(first.statusCode, 202, first.body);
    const firstId = json<{ id: string }>(first).id;

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v2/internal/crm/outbound',
      headers,
      payload: VALID_COMMAND,
    });
    assert.equal(replay.statusCode, 202, replay.body);
    assert.equal(json<{ id: string }>(replay).id, firstId);

    const operations = await db.query(`SELECT id FROM send_operations WHERE company_id = $1`, ['c1']);
    assert.equal(operations.rows.length, 1);

    const conflict = await app.inject({
      method: 'POST',
      url: '/api/v2/internal/crm/outbound',
      headers,
      payload: { ...VALID_COMMAND, text: 'Другой текст' },
    });
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.equal(json<{ code: string }>(conflict).code, 'IDEMPOTENCY_CONFLICT');
  } finally {
    await close();
  }
});

test('outbound rejects actor and recipient fields in the body', async () => {
  const { app, db, close } = await createTestApp({ internalServiceToken: SERVICE_TOKEN });
  try {
    await seedCompany(db, { companyId: 'c1', staff: [{ id: 'owner', password: PASSWORD, role: 'send' }] });
    await seedCrm(db, { companyId: 'c1' });
    const headers = { authorization: `Bearer ${SERVICE_TOKEN}` };

    for (const extra of [{ actor: 'someone' }, { recipient: 'someone' }, { actorId: 'someone' }]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v2/internal/crm/outbound',
        headers,
        payload: { ...VALID_COMMAND, ...extra },
      });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(json<{ code: string }>(response).code, 'VALIDATION_FAILED');
    }
  } finally {
    await close();
  }
});

test('outbound returns 404 for an unknown binding', async () => {
  const { app, db, close } = await createTestApp({ internalServiceToken: SERVICE_TOKEN });
  try {
    await seedCompany(db, { companyId: 'c1', staff: [{ id: 'owner', password: PASSWORD, role: 'send' }] });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/internal/crm/outbound',
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
      payload: VALID_COMMAND,
    });
    assert.equal(response.statusCode, 404, response.body);
    assert.equal(json<{ code: string }>(response).code, 'NOT_FOUND');
  } finally {
    await close();
  }
});

test('outbound rejects commands whose binding, epoch or assignment preconditions are stale', async () => {
  const { app, db, close } = await createTestApp({ internalServiceToken: SERVICE_TOKEN });
  try {
    await seedCompany(db, { companyId: 'c1', staff: [{ id: 'owner', password: PASSWORD, role: 'send' }] });
    await seedCrm(db, { companyId: 'c1' });
    const headers = { authorization: `Bearer ${SERVICE_TOKEN}` };

    // Disabled binding: not a valid send target.
    await db.query(`UPDATE crm_bindings SET state = 'disabled' WHERE company_id = $1 AND id = $2`, ['c1', 'b1']);
    const disabled = await app.inject({
      method: 'POST',
      url: '/api/v2/internal/crm/outbound',
      headers,
      payload: VALID_COMMAND,
    });
    assert.equal(disabled.statusCode, 422, disabled.body);
    assert.equal(json<{ code: string }>(disabled).code, 'CAPABILITY_BLOCKED');
    await db.query(`UPDATE crm_bindings SET state = 'bound' WHERE company_id = $1 AND id = $2`, ['c1', 'b1']);

    // A rotated connection epoch no longer matches the conversation's epoch.
    await db.query(`INSERT INTO connection_identities (company_id, connection_id, binding_epoch) VALUES ($1,$2,1)`, [
      'c1',
      'conn1',
    ]);
    await db.query(`UPDATE connections SET binding_epoch = 1 WHERE company_id = $1 AND id = $2`, ['c1', 'conn1']);
    const staleEpoch = await app.inject({
      method: 'POST',
      url: '/api/v2/internal/crm/outbound',
      headers,
      payload: { ...VALID_COMMAND, idempotencyKey: 'cmd-key-epoch' },
    });
    assert.equal(staleEpoch.statusCode, 422, staleEpoch.body);
    assert.equal(json<{ code: string }>(staleEpoch).code, 'CAPABILITY_BLOCKED');
    await db.query(`UPDATE connections SET binding_epoch = 0 WHERE company_id = $1 AND id = $2`, ['c1', 'conn1']);

    // No live assignment: the work item was resolved.
    await db.query(`UPDATE work_items SET state = 'resolved' WHERE company_id = $1 AND id = $2`, ['c1', 'wi1']);
    const noAssignment = await app.inject({
      method: 'POST',
      url: '/api/v2/internal/crm/outbound',
      headers,
      payload: { ...VALID_COMMAND, idempotencyKey: 'cmd-key-assignment' },
    });
    assert.equal(noAssignment.statusCode, 422, noAssignment.body);
    assert.equal(json<{ code: string }>(noAssignment).code, 'CAPABILITY_BLOCKED');
  } finally {
    await close();
  }
});
