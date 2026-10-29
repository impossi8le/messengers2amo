import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createTestApp, cookieFromResponse } from './helpers/app.ts';
import { seedCompany, seedConnection } from './helpers/seed.ts';
import { seedEdit, seedInboundMessage } from './helpers/attention.ts';
import { openIncoming, editIncoming, listObligations } from '../src/repo/attention.ts';
import type { Db } from '../src/platform/db.ts';

const PASSWORD = 'correct horse battery staple';
const deps = (schema: string) => ({ schema });

function json<T>(response: LightMyRequestResponse): T {
  return response.json() as T;
}

function sortedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort();
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

type Fixture = {
  companyId: string;
  schema: string;
  db: Db;
  workItemId: string;
  foreignWorkItemId: string;
  conversationId: string;
  foreignConversationId: string;
};

/**
 * Company-wide and workshop-scoped tenants in one schema. `wi1` lives on the
 * connection routed to `ws1`; `wi2` is routed to `ws2` and must be invisible to
 * a `ws1` session.
 */
async function seedOperatorFixture(db: Db, schema: string): Promise<Fixture> {
  const companyId = 'c1';
  await seedCompany(db, {
    companyId,
    workshops: ['ws1', 'ws2'],
    staff: [
      { id: 's1', password: PASSWORD, role: 'send', workshopId: 'ws1' },
      { id: 's2', password: PASSWORD, role: 'send', workshopId: 'ws1' },
      { id: 'reader', password: PASSWORD, role: 'read' },
      { id: 'boss', password: PASSWORD, role: 'manage' },
    ],
  });
  await db.query(`UPDATE "${schema}".staff SET capacity = 5, availability = 'online' WHERE company_id = $1`, [companyId]);
  await db.query(
    `INSERT INTO "${schema}".departments (company_id, id, display_name) VALUES ($1,'dep1','Department 1')`,
    [companyId],
  );
  await seedConnection(db, {
    companyId,
    id: 'conn1',
    state: 'active',
    workshopId: 'ws1',
    ownerId: 's1',
  });
  await seedConnection(db, {
    companyId,
    id: 'conn2',
    state: 'active',
    workshopId: 'ws2',
    ownerId: 's1',
  });
  await db.query(
    `INSERT INTO "${schema}".conversations
       (company_id,id,connection_id,binding_epoch,external_chat_id,chat_kind)
     VALUES ($1,'conv1','conn1',0,'chat-conv1','private'),
            ($1,'conv2','conn2',0,'chat-conv2','private')`,
    [companyId],
  );
  await db.query(
    `INSERT INTO "${schema}".work_items (company_id,id,conversation_id,state,owner_id)
     VALUES ($1,'wi1','conv1','queued',NULL), ($1,'wi2','conv2','queued',NULL)`,
    [companyId],
  );
  return {
    companyId,
    schema,
    db,
    workItemId: 'wi1',
    foreignWorkItemId: 'wi2',
    conversationId: 'conv1',
    foreignConversationId: 'conv2',
  };
}

async function openObligation(
  fx: Fixture,
  messageId: string,
  contentVersion = 0,
): Promise<{ obligationId: string; contentVersion: number }> {
  await seedInboundMessage(fx.db, fx.schema, {
    companyId: fx.companyId,
    conversationId: fx.conversationId,
    messageId,
    contentVersion,
    content: { kind: 'text', text: `question ${messageId}` },
  });
  const opened = await openIncoming(fx.db, deps(fx.schema), {
    companyId: fx.companyId,
    workItemId: fx.workItemId,
    messageId,
    contentVersion,
  });
  return { obligationId: opened.obligation.id, contentVersion };
}

async function createSnapshot(app: FastifyInstance, cookie: string, workItemId: string) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v2/operator/work-items/${workItemId}/snapshot`,
    headers: { cookie },
    payload: {},
  });
  assert.equal(response.statusCode, 200, response.body);
  return json<{
    id: string;
    workItemId: string;
    conversationId: string;
    bindingEpoch: number;
    assignmentVersion: number;
    obligationRefs: Array<{ obligationId: string; contentVersion: number }>;
  }>(response);
}

async function insertConfirmedSendOperation(
  fx: Fixture,
  operationId: string,
  snapshotId: string | null = null,
): Promise<void> {
  await fx.db.query(
    `INSERT INTO "${fx.schema}".send_operations
       (company_id,id,work_item_id,conversation_id,connection_id,binding_epoch,snapshot_id,actor_id,
        command_type,idempotency_key,payload_fingerprint,state,coverage,content,deadline)
     VALUES ($1,$2,$3,$4,'conn1',0,$5,'s1','reply',$6,$7,'sent','unconfirmed','{"text":"sent already"}'::jsonb, now() + interval '1 hour')`,
    [fx.companyId, operationId, fx.workItemId, fx.conversationId, snapshotId, `idem-${operationId}`, 'a'.repeat(64)],
  );
}

test('operator routes authenticate before disclosing resources and honour roles', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedOperatorFixture(db, schema);

    const anonymous = await app.inject({ method: 'GET', url: '/api/v2/operator/work-items' });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(json<{ code: string }>(anonymous).code, 'UNAUTHENTICATED');

    const reader = await login(app, 'c1', 'reader');
    const list = await app.inject({ method: 'GET', url: '/api/v2/operator/work-items', headers: { cookie: reader } });
    assert.equal(list.statusCode, 200, list.body);

    const forbidden = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/work-items/${fx.workItemId}/claim`,
      headers: { cookie: reader },
      payload: { expectedAssignmentVersion: 0, idempotencyKey: 'reader-claim' },
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(json<{ code: string }>(forbidden).code, 'FORBIDDEN');
  } finally {
    await close();
  }
});

test('work item list is scoped to the session workshop and paginates by cursor', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedOperatorFixture(db, schema);

    const companyWide = await login(app, 'c1', 'reader');
    const all = await app.inject({ method: 'GET', url: '/api/v2/operator/work-items', headers: { cookie: companyWide } });
    assert.equal(all.statusCode, 200, all.body);
    const allBody = json<{ items: Array<{ id: string }>; page: { nextCursor: string | null } }>(all);
    assert.deepEqual(allBody.items.map((item) => item.id), ['wi1', 'wi2']);
    assert.deepEqual(sortedKeys(allBody.items[0] as unknown as Record<string, unknown>), [
      'assignmentVersion',
      'conversationId',
      'id',
      'owner',
      'state',
    ]);

    const scoped = await login(app, 'c1', 's1');
    const scopedList = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/work-items',
      headers: { cookie: scoped },
    });
    assert.equal(scopedList.statusCode, 200, scopedList.body);
    assert.deepEqual(json<{ items: Array<{ id: string }> }>(scopedList).items.map((item) => item.id), ['wi1']);

    const firstPage = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/work-items?limit=1',
      headers: { cookie: companyWide },
    });
    const firstBody = json<{ items: Array<{ id: string }>; page: { nextCursor: string | null } }>(firstPage);
    assert.deepEqual(firstBody.items.map((item) => item.id), ['wi1']);
    assert.equal(firstBody.page.nextCursor, 'wi1');

    const secondPage = await app.inject({
      method: 'GET',
      url: `/api/v2/operator/work-items?limit=1&after=${firstBody.page.nextCursor}`,
      headers: { cookie: companyWide },
    });
    const secondBody = json<{ items: Array<{ id: string }>; page: { nextCursor: string | null } }>(secondPage);
    assert.deepEqual(secondBody.items.map((item) => item.id), ['wi2']);

    // A full page always offers a cursor; the page after the last item is empty.
    const thirdPage = await app.inject({
      method: 'GET',
      url: `/api/v2/operator/work-items?limit=1&after=${secondBody.page.nextCursor}`,
      headers: { cookie: companyWide },
    });
    const thirdBody = json<{ items: Array<{ id: string }>; page: { nextCursor: string | null } }>(thirdPage);
    assert.deepEqual(thirdBody.items, []);
    assert.equal(thirdBody.page.nextCursor, null);

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/v2/operator/work-items/${fx.foreignWorkItemId}`,
      headers: { cookie: scoped },
    });
    assert.equal(foreign.statusCode, 404, 'a foreign scope must look like a missing resource');
    assert.equal(json<{ code: string }>(foreign).code, 'NOT_FOUND');
  } finally {
    await close();
  }
});

test('work item detail returns the contract shape and open obligations', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedOperatorFixture(db, schema);
    const obligation = await openObligation(fx, 'm1');
    const cookie = await login(app, 'c1', 's1');

    const response = await app.inject({
      method: 'GET',
      url: `/api/v2/operator/work-items/${fx.workItemId}`,
      headers: { cookie },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = json<{
      workItem: Record<string, unknown>;
      conversation: Record<string, unknown>;
      outstandingObligations: Array<Record<string, unknown>>;
    }>(response);
    assert.deepEqual(sortedKeys(body), ['conversation', 'outstandingObligations', 'workItem']);
    assert.deepEqual(sortedKeys(body.workItem), ['assignmentVersion', 'conversationId', 'id', 'owner', 'state']);
    assert.deepEqual(sortedKeys(body.conversation), ['bindingEpoch', 'connectionId', 'externalChatId', 'id']);
    assert.equal(body.outstandingObligations.length, 1);
    assert.deepEqual(sortedKeys(body.outstandingObligations[0]!), ['attentionSeq', 'contentVersion', 'id', 'messageId']);
    assert.equal(body.outstandingObligations[0]!.id, obligation.obligationId);
  } finally {
    await close();
  }
});

test('message history is paginated and carries the current content version', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedOperatorFixture(db, schema);
    await seedInboundMessage(db, schema, {
      companyId: fx.companyId,
      conversationId: fx.conversationId,
      messageId: 'm1',
      content: { kind: 'text', text: 'first' },
    });
    await seedInboundMessage(db, schema, {
      companyId: fx.companyId,
      conversationId: fx.conversationId,
      messageId: 'm2',
      content: { kind: 'text', text: 'second' },
    });
    const cookie = await login(app, 'c1', 's1');

    const first = await app.inject({
      method: 'GET',
      url: `/api/v2/operator/work-items/${fx.workItemId}/messages?limit=1`,
      headers: { cookie },
    });
    assert.equal(first.statusCode, 200, first.body);
    const firstBody = json<{
      items: Array<Record<string, unknown>>;
      page: { nextCursor: string | null };
    }>(first);
    assert.equal(firstBody.items.length, 1);
    assert.deepEqual(sortedKeys(firstBody.items[0]!), [
      'content',
      'contentVersion',
      'conversationId',
      'createdAt',
      'direction',
      'id',
      'sendOperationId',
    ]);
    assert.equal(firstBody.items[0]!.contentVersion, 0);
    assert.equal(firstBody.page.nextCursor, 'm1');

    const second = await app.inject({
      method: 'GET',
      url: `/api/v2/operator/work-items/${fx.workItemId}/messages?limit=1&after=m1`,
      headers: { cookie },
    });
    const secondBody = json<{ items: Array<{ id: string }>; page: { nextCursor: string | null } }>(second);
    assert.deepEqual(secondBody.items.map((item) => item.id), ['m2']);

    const third = await app.inject({
      method: 'GET',
      url: `/api/v2/operator/work-items/${fx.workItemId}/messages?limit=1&after=${secondBody.page.nextCursor}`,
      headers: { cookie },
    });
    const thirdBody = json<{ items: Array<{ id: string }>; page: { nextCursor: string | null } }>(third);
    assert.deepEqual(thirdBody.items, []);
    assert.equal(thirdBody.page.nextCursor, null);
  } finally {
    await close();
  }
});

test('snapshot freezes the open obligations and claim is a version-checked CAS', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedOperatorFixture(db, schema);
    const obligation = await openObligation(fx, 'm1');
    const s1 = await login(app, 'c1', 's1');

    const snapshot = await createSnapshot(app, s1, fx.workItemId);
    assert.deepEqual(sortedKeys(snapshot as unknown as Record<string, unknown>), [
      'assignmentVersion',
      'bindingEpoch',
      'conversationId',
      'id',
      'obligationRefs',
      'workItemId',
    ]);
    assert.equal(snapshot.workItemId, fx.workItemId);
    assert.equal(snapshot.conversationId, fx.conversationId);
    assert.equal(snapshot.assignmentVersion, 0);
    assert.deepEqual(snapshot.obligationRefs, [obligation]);

    const claim = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/work-items/${fx.workItemId}/claim`,
      headers: { cookie: s1 },
      payload: { expectedAssignmentVersion: 0, idempotencyKey: 'claim-1' },
    });
    assert.equal(claim.statusCode, 200, claim.body);
    const claimed = json<Record<string, unknown>>(claim);
    assert.deepEqual(sortedKeys(claimed), ['assignmentVersion', 'conversationId', 'id', 'owner', 'state']);
    assert.equal(claimed.owner, 's1');
    assert.equal(claimed.assignmentVersion, 1);
    assert.equal(claimed.state, 'assigned');

    const s2 = await login(app, 'c1', 's2');
    const conflict = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/work-items/${fx.workItemId}/claim`,
      headers: { cookie: s2 },
      payload: { expectedAssignmentVersion: 0, idempotencyKey: 'claim-2' },
    });
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.equal(json<{ code: string }>(conflict).code, 'VERSION_CONFLICT');
    // The loser learns the current owner and version without the contract body
    // growing a field the schema does not allow.
    assert.equal(conflict.headers['x-current-owner'], 's1');
    assert.equal(conflict.headers['x-assignment-version'], '1');

    const audits = await db.query<{ event_name: string; subject_id: string; actor_id: string }>(
      `SELECT event_name, subject_id, actor_id FROM "${schema}".audit_events WHERE company_id = $1`,
      [fx.companyId],
    );
    assert.ok(
      audits.rows.some(
        (row) => row.event_name === 'work_item.claimed' && row.subject_id === fx.workItemId && row.actor_id === 's1',
      ),
      `expected a work_item.claimed audit row, got ${JSON.stringify(audits.rows)}`,
    );
  } finally {
    await close();
  }
});

test('a claim refused for capacity names the capacity, not a stale version', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedOperatorFixture(db, schema);
    // No free slots for this operator. Retrying cannot help, so the answer must
    // not be the version conflict the console tells operators to refresh away.
    await db.query(`UPDATE "${schema}".staff SET capacity = 0 WHERE company_id = $1 AND id = 's1'`, [fx.companyId]);
    const s1 = await login(app, 'c1', 's1');

    const claim = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/work-items/${fx.workItemId}/claim`,
      headers: { cookie: s1 },
      payload: { expectedAssignmentVersion: 0, idempotencyKey: 'claim-capacity' },
    });
    assert.equal(claim.statusCode, 409, claim.body);
    assert.equal(json<{ code: string }>(claim).code, 'CAPACITY_EXCEEDED');
  } finally {
    await close();
  }
});

test('transfer and resolve audit their assignment changes in the same transaction', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedOperatorFixture(db, schema);
    const s1 = await login(app, 'c1', 's1');

    const claim = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/work-items/${fx.workItemId}/claim`,
      headers: { cookie: s1 },
      payload: { expectedAssignmentVersion: 0, idempotencyKey: 'claim-for-transfer' },
    });
    assert.equal(claim.statusCode, 200, claim.body);

    const transfer = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/work-items/${fx.workItemId}/transfer`,
      headers: { cookie: s1 },
      payload: {
        expectedAssignmentVersion: 1,
        idempotencyKey: 'transfer-1',
        departmentId: 'dep1',
        assigneeId: 's2',
      },
    });
    assert.equal(transfer.statusCode, 200, transfer.body);
    const transferred = json<{ owner: string; assignmentVersion: number }>(transfer);
    assert.equal(transferred.owner, 's2');
    assert.equal(transferred.assignmentVersion, 2);

    const resolve = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/work-items/${fx.workItemId}/resolve`,
      headers: { cookie: s1 },
      payload: {
        reason: 'customer request handled offline',
        expectedAssignmentVersion: 2,
        idempotencyKey: 'resolve-1',
      },
    });
    assert.equal(resolve.statusCode, 200, resolve.body);
    const resolved = json<{ state: string; owner: string | null; assignmentVersion: number }>(resolve);
    assert.equal(resolved.state, 'resolved');
    assert.equal(resolved.owner, null);
    assert.equal(resolved.assignmentVersion, 3);

    const audits = await db.query<{ event_name: string; diagnostic_code: string | null }>(
      `SELECT event_name, diagnostic_code FROM "${schema}".audit_events WHERE company_id = $1 ORDER BY recorded_at`,
      [fx.companyId],
    );
    assert.ok(audits.rows.some((row) => row.event_name === 'work_item.transferred'));
    const resolvedAudit = audits.rows.find((row) => row.event_name === 'work_item.resolved');
    assert.ok(resolvedAudit, 'resolve must be audited');
    assert.equal(resolvedAudit.diagnostic_code, 'customer request handled offline');
  } finally {
    await close();
  }
});

test('closing with open obligations needs managerial authority and is audited with the reason', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedOperatorFixture(db, schema);
    await openObligation(fx, 'm1');

    const operator = await login(app, 'c1', 's1');
    const refused = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/work-items/${fx.workItemId}/resolve`,
      headers: { cookie: operator },
      payload: { reason: 'no reply needed', expectedAssignmentVersion: 0, idempotencyKey: 'resolve-op' },
    });
    assert.equal(refused.statusCode, 403, refused.body);
    assert.equal(json<{ code: string }>(refused).code, 'FORBIDDEN');

    const stillOpen = await db.query<{ state: string }>(
      `SELECT state FROM "${schema}".work_items WHERE company_id = $1 AND id = $2`,
      [fx.companyId, fx.workItemId],
    );
    assert.equal(stillOpen.rows[0]?.state, 'queued', 'a refused close must not mutate the work item');

    const boss = await login(app, 'c1', 'boss');
    const resolved = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/work-items/${fx.workItemId}/resolve`,
      headers: { cookie: boss },
      payload: {
        reason: 'customer wrote on another channel',
        expectedAssignmentVersion: 0,
        idempotencyKey: 'resolve-boss',
      },
    });
    assert.equal(resolved.statusCode, 200, resolved.body);
    assert.equal(json<{ state: string }>(resolved).state, 'resolved');

    const audit = await db.query<{ actor_id: string; diagnostic_code: string | null }>(
      `SELECT actor_id, diagnostic_code FROM "${schema}".audit_events
        WHERE company_id = $1 AND event_name = 'work_item.resolved'`,
      [fx.companyId],
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0]?.actor_id, 'boss');
    assert.equal(audit.rows[0]?.diagnostic_code, 'customer wrote on another channel');
  } finally {
    await close();
  }
});

test('a foreign work item is indistinguishable from a missing one on every route', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedOperatorFixture(db, schema);
    const s1 = await login(app, 'c1', 's1');

    const routes: Array<{ method: 'GET' | 'POST'; url: string; payload?: Record<string, unknown> }> = [
      { method: 'GET', url: `/api/v2/operator/work-items/${fx.foreignWorkItemId}` },
      { method: 'GET', url: `/api/v2/operator/work-items/${fx.foreignWorkItemId}/messages` },
      { method: 'POST', url: `/api/v2/operator/work-items/${fx.foreignWorkItemId}/snapshot`, payload: {} },
      {
        method: 'POST',
        url: `/api/v2/operator/work-items/${fx.foreignWorkItemId}/claim`,
        payload: { expectedAssignmentVersion: 0, idempotencyKey: 'foreign-claim' },
      },
    ];
    for (const route of routes) {
      const response = await app.inject({ method: route.method, url: route.url, headers: { cookie: s1 }, payload: route.payload });
      assert.equal(response.statusCode, 404, `${route.method} ${route.url}: ${response.body}`);
      assert.equal(json<{ code: string }>(response).code, 'NOT_FOUND');
    }

    const snapshots = await db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM "${schema}".reply_snapshots WHERE company_id = $1`,
      [fx.companyId],
    );
    assert.equal(snapshots.rows[0]?.c, 0, 'a foreign snapshot must never be sealed');
  } finally {
    await close();
  }
});

test('reply binds a valid snapshot, returns SendOperation and rejects a stale snapshot', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedOperatorFixture(db, schema);
    const obligation = await openObligation(fx, 'm1');
    const s1 = await login(app, 'c1', 's1');
    const snapshot = await createSnapshot(app, s1, fx.workItemId);
    const deadline = new Date(Date.now() + 60_000).toISOString();

    const reply = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/work-items/${fx.workItemId}/reply`,
      headers: { cookie: s1 },
      payload: {
        idempotencyKey: 'reply-1',
        snapshotId: snapshot.id,
        expectedAssignmentVersion: 0,
        selectedObligations: [obligation],
        text: 'answer',
        deadline,
      },
    });
    assert.equal(reply.statusCode, 202, reply.body);
    const operation = json<Record<string, unknown>>(reply);
    assert.deepEqual(sortedKeys(operation), [
      'coverage',
      'deliveryEvidence',
      'id',
      'providerMessageId',
      'readEvidence',
      'selectedRefs',
      'state',
    ]);
    assert.equal(operation.coverage, 'unconfirmed');
    assert.deepEqual(operation.selectedRefs, [obligation]);

    const stored = await db.query<{ snapshot_id: string | null; command_type: string }>(
      `SELECT snapshot_id, command_type FROM "${schema}".send_operations WHERE company_id = $1 AND id = $2`,
      [fx.companyId, operation.id],
    );
    assert.equal(stored.rows[0]?.snapshot_id, snapshot.id);
    assert.equal(stored.rows[0]?.command_type, 'reply');
    assert.equal(reply.headers['x-snapshot-id'], snapshot.id);
    assert.equal(reply.headers['x-assignment-version'], '0');

    // Same key and same content: the original operation is replayed, not duplicated.
    const replay = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/work-items/${fx.workItemId}/reply`,
      headers: { cookie: s1 },
      payload: {
        idempotencyKey: 'reply-1',
        snapshotId: snapshot.id,
        expectedAssignmentVersion: 0,
        selectedObligations: [obligation],
        text: 'answer',
        deadline,
      },
    });
    assert.equal(replay.statusCode, 202, replay.body);
    assert.equal(json<{ id: string }>(replay).id, operation.id);

    // Same key, different text: a replay must not silently change the intent.
    const conflict = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/work-items/${fx.workItemId}/reply`,
      headers: { cookie: s1 },
      payload: {
        idempotencyKey: 'reply-1',
        snapshotId: snapshot.id,
        expectedAssignmentVersion: 0,
        selectedObligations: [obligation],
        text: 'different answer',
        deadline: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.equal(json<{ code: string }>(conflict).code, 'IDEMPOTENCY_CONFLICT');

    // A substantial edit supersedes the snapshotted version; the old snapshot is stale.
    await seedEdit(db, schema, {
      companyId: fx.companyId,
      messageId: 'm1',
      contentVersion: 1,
      content: { kind: 'text', text: 'question m1, amount changed' },
    });
    await editIncoming(db, deps(schema), {
      companyId: fx.companyId,
      messageId: 'm1',
      contentVersion: 1,
      substantial: true,
    });
    const stale = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/work-items/${fx.workItemId}/reply`,
      headers: { cookie: s1 },
      payload: {
        idempotencyKey: 'reply-2',
        snapshotId: snapshot.id,
        expectedAssignmentVersion: 0,
        selectedObligations: [obligation],
        text: 'late answer',
        deadline: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(json<{ code: string }>(stale).code, 'STALE_EPOCH');

    const operations = await db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM "${schema}".send_operations WHERE company_id = $1`,
      [fx.companyId],
    );
    assert.equal(operations.rows[0]?.c, 1, 'a rejected reply must not create an operation');
  } finally {
    await close();
  }
});

test('manual coverage requires a confirmed send, records its reason and replays idempotently', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedOperatorFixture(db, schema);
    const obligation = await openObligation(fx, 'm1');
    await insertConfirmedSendOperation(fx, 'op-confirmed');
    const s1 = await login(app, 'c1', 's1');

    const payload = {
      confirmedSendOperationId: 'op-confirmed',
      obligationRefs: [obligation],
      reason: 'answered in the native chat',
      expectedAssignmentVersion: 0,
      idempotencyKey: 'manual-1',
    };
    const response = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/work-items/${fx.workItemId}/manual-coverage`,
      headers: { cookie: s1 },
      payload,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(sortedKeys(json<Record<string, unknown>>(response)), [
      'assignmentVersion',
      'conversationId',
      'id',
      'owner',
      'state',
    ]);

    const obligations = await listObligations(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
    });
    assert.equal(obligations.find((item) => item.id === obligation.obligationId)?.state, 'covered');
    const coverage = await db.query<{ reason: string | null }>(
      `SELECT reason FROM "${schema}".send_coverage WHERE company_id = $1 AND operation_id = $2`,
      [fx.companyId, 'op-confirmed'],
    );
    assert.equal(coverage.rowCount, 1);
    assert.equal(coverage.rows[0]?.reason, 'answered in the native chat');

    const audit = await db.query<{ event_name: string; diagnostic_code: string | null }>(
      `SELECT event_name, diagnostic_code FROM "${schema}".audit_events
        WHERE company_id = $1 AND subject_id = $2 AND event_name = 'work_item.manual_coverage'`,
      [fx.companyId, fx.workItemId],
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0]?.diagnostic_code, 'answered in the native chat');

    const replay = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/work-items/${fx.workItemId}/manual-coverage`,
      headers: { cookie: s1 },
      payload,
    });
    assert.equal(replay.statusCode, 200, replay.body);
    const replayAudit = await db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM "${schema}".audit_events
        WHERE company_id = $1 AND event_name = 'work_item.manual_coverage'`,
      [fx.companyId],
    );
    assert.equal(replayAudit.rows[0]?.c, 1, 'a replay must not append a second audit row');

    const conflicting = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/work-items/${fx.workItemId}/manual-coverage`,
      headers: { cookie: s1 },
      payload: { ...payload, reason: 'another reason' },
    });
    assert.equal(conflicting.statusCode, 409, conflicting.body);
    assert.equal(json<{ code: string }>(conflicting).code, 'IDEMPOTENCY_CONFLICT');

    const unconfirmed = await db.query<{ id: string }>(
      `INSERT INTO "${schema}".send_operations
         (company_id,id,work_item_id,conversation_id,connection_id,binding_epoch,snapshot_id,actor_id,
          command_type,idempotency_key,payload_fingerprint,state,coverage,content,deadline)
       VALUES ($1,'op-queued',$2,$3,'conn1',0,NULL,'s1','reply','idem-op-queued',$4,'queued','unconfirmed','{"text":"queued"}'::jsonb, now() + interval '1 hour')
       RETURNING id`,
      [fx.companyId, fx.workItemId, fx.conversationId, 'b'.repeat(64)],
    );
    assert.equal(unconfirmed.rowCount, 1);
    const secondObligation = await openObligation(fx, 'm2');
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/work-items/${fx.workItemId}/manual-coverage`,
      headers: { cookie: s1 },
      payload: {
        confirmedSendOperationId: 'op-queued',
        obligationRefs: [secondObligation],
        reason: 'not actually sent',
        expectedAssignmentVersion: 0,
        idempotencyKey: 'manual-2',
      },
    });
    assert.equal(rejected.statusCode, 409, rejected.body);
  } finally {
    await close();
  }
});

test('send operation state is readable within scope and foreign operations stay hidden', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedOperatorFixture(db, schema);
    await insertConfirmedSendOperation(fx, 'op-visible');
    const s1 = await login(app, 'c1', 's1');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/send-operations/op-visible',
      headers: { cookie: s1 },
    });
    assert.equal(response.statusCode, 200, response.body);
    const operation = json<Record<string, unknown>>(response);
    assert.deepEqual(sortedKeys(operation), [
      'coverage',
      'deliveryEvidence',
      'id',
      'providerMessageId',
      'readEvidence',
      'selectedRefs',
      'state',
    ]);
    assert.equal(operation.state, 'sent');
    assert.equal(operation.providerMessageId, null);
    assert.deepEqual(operation.selectedRefs, []);

    const foreign = await db.query<{ id: string }>(
      `INSERT INTO "${schema}".send_operations
         (company_id,id,work_item_id,conversation_id,connection_id,binding_epoch,snapshot_id,actor_id,
          command_type,idempotency_key,payload_fingerprint,state,coverage,content,deadline)
       VALUES ($1,'op-foreign','wi2','conv2','conn2',0,NULL,'s1','reply','idem-op-foreign',$2,'sent','unconfirmed','{"text":"foreign"}'::jsonb, now() + interval '1 hour')
       RETURNING id`,
      [fx.companyId, 'c'.repeat(64)],
    );
    assert.equal(foreign.rowCount, 1);
    const hidden = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/send-operations/op-foreign',
      headers: { cookie: s1 },
    });
    assert.equal(hidden.statusCode, 404, hidden.body);
  } finally {
    await close();
  }
});
