// End-to-end flow: inbound Telegram update -> durable inbox -> message/work item/
// obligation -> operator claim -> snapshot -> reply -> send worker -> coverage.
//
// The point of this file is integration, not unit behaviour: every step uses the
// same database schema and the real HTTP routes/repositories the service uses in
// production. The only double is the Telegram transport.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createTestApp, cookieFromResponse, type TestApp } from './helpers/app.ts';
import { seedCompany, seedConnection } from './helpers/seed.ts';
import { telegramMessageUpdate } from './helpers/telegram.ts';
import { drainTelegramInbox } from '../src/telegram/processor.ts';
import { confirmSendCoverage, listObligations } from '../src/repo/attention.ts';
import { waitingSince } from '../src/domain/attention.ts';
import { runSendWorker } from '../src/telegram/send.ts';
import type { TelegramTransport, TransportOutcome } from '../src/telegram/transport.ts';
import { collectMetrics, type MetricSample } from '../src/observability/metrics.ts';
import type { Db } from '../src/platform/db.ts';

const PASSWORD = 'correct horse battery staple';
const WEBHOOK_SECRET = 'e2e-telegram-secret';
const COMPANY_ID = 'c1';
const CONNECTION_ID = 'conn1';
const WORKSHOP_ID = 'ws1';

function json<T>(response: LightMyRequestResponse): T {
  return response.json() as T;
}

function one<T>(rows: T[]): T {
  const row = rows[0];
  assert.ok(row, 'expected at least one row');
  return row;
}

type Tenant = {
  ctx: TestApp;
  companyId: string;
  connectionId: string;
};

/**
 * Company + workshop + staff + an active Telegram connection routed to that
 * workshop. This is the minimum production slice the whole flow needs.
 */
async function setupTenant(staffIds: string[] = ['s1', 's2']): Promise<Tenant> {
  const ctx = await createTestApp({
    telegram: { botToken: '123456:bot-token', webhookSecret: WEBHOOK_SECRET, apiBase: 'https://tg.test' },
  });
  await seedCompany(ctx.db, {
    companyId: COMPANY_ID,
    workshops: [WORKSHOP_ID],
    staff: staffIds.map((id) => ({ id, password: PASSWORD, role: 'send', workshopId: WORKSHOP_ID })),
  });
  // Capacity is explicit: the race test must prove the capacity fence holds.
  await ctx.db.query('UPDATE staff SET capacity = $2, availability = $3 WHERE company_id = $1', [
    COMPANY_ID,
    staffIds.length > 1 ? 1 : 5,
    'online',
  ]);
  // seedConnection creates the binding epoch 0 identity and, when a workshop is
  // given, the route + CRM account/source the workshop scope filters on.
  await seedConnection(ctx.db, {
    companyId: COMPANY_ID,
    id: CONNECTION_ID,
    state: 'active',
    workshopId: WORKSHOP_ID,
    ownerId: staffIds[0],
  });
  return { ctx, companyId: COMPANY_ID, connectionId: CONNECTION_ID };
}

async function postWebhook(
  app: FastifyInstance,
  update: Record<string, unknown>,
  secret: string = WEBHOOK_SECRET,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/webhooks/telegram/${CONNECTION_ID}`,
    headers: { 'x-telegram-bot-api-secret-token': secret },
    payload: update,
  });
}

/**
 * The production ingress is two stages: the webhook commits the raw update to the
 * durable inbox, then the inbox processor applies it. Both stages are exercised
 * here, so the test proves they are actually stitched together.
 */
async function receiveUpdate(tenant: Tenant, update: Record<string, unknown>): Promise<void> {
  const response = await postWebhook(tenant.ctx.app, update);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(json<{ ok: boolean; duplicate: boolean }>(response), { ok: true, duplicate: false });

  // This is the exact drain the running process schedules on a timer.
  const result = await drainTelegramInbox(tenant.ctx.db, { schema: tenant.ctx.schema });
  assert.equal(result.connections, 1, 'the drain must find the connection with pending work');
  assert.equal(result.processed, 1, 'the durable inbox event must be processed exactly once');
  assert.equal(result.applied, 1, 'the update must produce a conversation/message/obligation');
}

async function login(app: FastifyInstance, staffId: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v2/auth/login',
    payload: { companyId: COMPANY_ID, staffId, password: PASSWORD },
  });
  assert.equal(response.statusCode, 200, response.body);
  return cookieFromResponse(response);
}

async function listWorkItems(app: FastifyInstance, cookie: string): Promise<Array<{ id: string; assignmentVersion: number }>> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v2/operator/work-items',
    headers: { cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  return json<{ items: Array<{ id: string; assignmentVersion: number }> }>(response).items;
}

async function claim(app: FastifyInstance, cookie: string, workItemId: string, version: number, key: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v2/operator/work-items/${workItemId}/claim`,
    headers: { cookie },
    payload: { expectedAssignmentVersion: version, idempotencyKey: key },
  });
}

async function snapshot(app: FastifyInstance, cookie: string, workItemId: string) {
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

async function reply(
  app: FastifyInstance,
  cookie: string,
  workItemId: string,
  input: {
    idempotencyKey: string;
    snapshotId: string;
    expectedAssignmentVersion: number;
    selectedObligations: Array<{ obligationId: string; contentVersion: number }>;
    text: string;
  },
) {
  return app.inject({
    method: 'POST',
    url: `/api/v2/operator/work-items/${workItemId}/reply`,
    headers: { cookie },
    payload: { ...input, deadline: new Date(Date.now() + 60_000).toISOString() },
  });
}

function fakeTransport(outcome: TransportOutcome, calls: Array<{ chatId: string; text: string }>): TelegramTransport {
  return {
    sendMessage: async (input) => {
      calls.push({ chatId: input.chatId, text: input.text });
      return outcome;
    },
  };
}

function workerOptions(tenant: Tenant, transport: TelegramTransport, owner = 'worker-a') {
  return {
    companyId: tenant.companyId,
    connectionId: tenant.connectionId,
    owner,
    leaseMs: 30_000,
    transport,
  };
}

async function obligations(db: Db, schema: string, workItemId: string) {
  return listObligations(db, { schema }, { companyId: COMPANY_ID, workItemId });
}

function metric(samples: MetricSample[], name: string, labels: Record<string, string> = {}): number | undefined {
  return samples.find(
    (sample) =>
      sample.name === name && Object.entries(labels).every(([key, value]) => sample.labels[key] === value),
  )?.value;
}

async function sendOperation(db: Db, schema: string, id: string) {
  const { rows } = await db.query<{
    state: string;
    provider_message_id: string | null;
    snapshot_id: string | null;
    coverage: string;
    content: { text?: string };
  }>(
    `SELECT state, provider_message_id, snapshot_id, coverage, content
       FROM "${schema}".send_operations WHERE company_id = $1 AND id = $2`,
    [COMPANY_ID, id],
  );
  return one(rows);
}

async function count(db: Db, schema: string, table: string): Promise<number> {
  const { rows } = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM "${schema}"."${table}"`);
  return one(rows).c;
}

test('scenario 1: inbound update travels through obligation, assignment, snapshot, send and coverage', async () => {
  const tenant = await setupTenant();
  const { ctx } = tenant;
  try {
    // 1-2. Signed webhook -> durable inbox -> conversation/message/work item/obligation.
    await receiveUpdate(tenant, telegramMessageUpdate(1001, 501, 'Здравствуйте, сколько стоит доставка?'));

    const inbox = await ctx.db.query<{ state: string; kind: string; provider_event_key: string }>(
      `SELECT state, kind, provider_event_key FROM "${ctx.schema}".inbox_events`,
    );
    assert.equal(one(inbox.rows).provider_event_key, 'tg:update:1001');
    assert.equal(one(inbox.rows).state, 'processed');
    assert.equal(one(inbox.rows).kind, 'message');

    const message = await ctx.db.query<{
      direction: string;
      current_content_version: string;
      external_chat_id: string;
      text: string;
    }>(
      `SELECT m.direction, m.current_content_version, c.external_chat_id, v.content->>'text' AS text
         FROM "${ctx.schema}".messages m
         JOIN "${ctx.schema}".conversations c
           ON c.company_id = m.company_id AND c.id = m.conversation_id
         JOIN "${ctx.schema}".message_versions v
           ON v.company_id = m.company_id AND v.message_id = m.id
          AND v.content_version = m.current_content_version`,
    );
    assert.equal(message.rowCount, 1);
    assert.equal(one(message.rows).direction, 'in');
    assert.equal(Number(one(message.rows).current_content_version), 1);
    assert.equal(one(message.rows).external_chat_id, '42');
    assert.equal(one(message.rows).text, 'Здравствуйте, сколько стоит доставка?');

    const workItems = await listWorkItems(ctx.app, await login(ctx.app, 's1'));
    assert.equal(workItems.length, 1, 'the operator read model must see the new work item');
    const workItemId = one(workItems).id;

    const opened = await obligations(ctx.db, ctx.schema, workItemId);
    assert.equal(opened.length, 1);
    assert.equal(one(opened).state, 'open');
    assert.equal(one(opened).contentVersion, 1);
    assert.ok(waitingSince(opened), 'waiting_since must be set by the inbound');

    // The provider retries the same update: the inbox deduplicates it and the drain
    // finds nothing to apply, so the dialogue does not grow a second obligation.
    const replay = await postWebhook(ctx.app, telegramMessageUpdate(1001, 501, 'Здравствуйте, сколько стоит доставка?'));
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(json<{ ok: boolean; duplicate: boolean }>(replay), { ok: true, duplicate: true });
    const nothingToDo = await drainTelegramInbox(ctx.db, { schema: ctx.schema });
    assert.equal(nothingToDo.processed, 0);
    assert.equal((await obligations(ctx.db, ctx.schema, workItemId)).length, 1);
    assert.equal(await count(ctx.db, ctx.schema, 'messages'), 1);

    // 3. Operator takes the dialogue.
    const cookie = await login(ctx.app, 's1');
    const claimed = await claim(ctx.app, cookie, workItemId, 0, 'claim-e2e-1');
    assert.equal(claimed.statusCode, 200, claimed.body);
    assert.equal(json<{ owner: string; assignmentVersion: number }>(claimed).owner, 's1');
    assert.equal(json<{ assignmentVersion: number }>(claimed).assignmentVersion, 1);

    // 4. Snapshot exposes exact ids and versions.
    const frozen = await snapshot(ctx.app, cookie, workItemId);
    assert.equal(frozen.assignmentVersion, 1);
    assert.deepEqual(
      frozen.obligationRefs,
      opened.map((item) => ({ obligationId: item.id, contentVersion: item.contentVersion })),
    );

    // 5. Reply is accepted against the sealed snapshot.
    const accepted = await reply(ctx.app, cookie, workItemId, {
      idempotencyKey: 'reply-e2e-1',
      snapshotId: frozen.id,
      expectedAssignmentVersion: 1,
      selectedObligations: frozen.obligationRefs,
      text: 'Доставка 300 рублей.',
    });
    assert.equal(accepted.statusCode, 202, accepted.body);
    const operation = json<{ id: string; state: string; coverage: string }>(accepted);
    assert.equal(operation.state, 'accepted');
    assert.equal(operation.coverage, 'unconfirmed');
    assert.equal((await sendOperation(ctx.db, ctx.schema, operation.id)).state, 'accepted');

    // 6. The worker sends through the fake transport and records the provider id.
    const calls: Array<{ chatId: string; text: string }> = [];
    const sent = await runSendWorker(
      ctx.db,
      workerOptions(tenant, fakeTransport({ outcome: 'sent', providerMessageId: '9001' }, calls)),
    );
    assert.equal(sent.sent, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(one(calls), { chatId: '42', text: 'Доставка 300 рублей.' });
    const stored = await sendOperation(ctx.db, ctx.schema, operation.id);
    assert.equal(stored.state, 'sent');
    assert.equal(stored.provider_message_id, '9001');
    assert.equal(stored.snapshot_id, frozen.id);

    // 7. Confirmed coverage closes the obligation and clears waiting_since.
    const coverage = await confirmSendCoverage(ctx.db, { schema: ctx.schema }, {
      companyId: tenant.companyId,
      operationId: operation.id,
    });
    assert.deepEqual(coverage.covered, frozen.obligationRefs);
    assert.deepEqual(coverage.remaining, []);
    const closed = await obligations(ctx.db, ctx.schema, workItemId);
    assert.equal(one(closed).state, 'covered');
    assert.equal(waitingSince(closed), null, 'waiting_since must be cleared once nothing is open');

    // 8. Metrics reflect the same persisted state.
    const samples = await collectMetrics(ctx.db, ctx.schema);
    assert.equal(metric(samples, 'm2a_inbox_events', { state: 'processed' }), 1);
    assert.equal(metric(samples, 'm2a_send_operations', { state: 'sent' }), 1);
    assert.equal(metric(samples, 'm2a_outbox_jobs', { state: 'completed' }), 1);
    assert.equal(metric(samples, 'm2a_open_obligations'), 0);
  } finally {
    await ctx.close();
  }
});

test('scenario 2: a new inbound during composition stays open while the old snapshot is answered', async () => {
  const tenant = await setupTenant();
  const { ctx } = tenant;
  try {
    await receiveUpdate(tenant, telegramMessageUpdate(2001, 601, 'Первый вопрос'));
    const cookie = await login(ctx.app, 's1');
    const workItemId = one(await listWorkItems(ctx.app, cookie)).id;
    assert.equal((await claim(ctx.app, cookie, workItemId, 0, 'claim-e2e-2')).statusCode, 200);
    const frozen = await snapshot(ctx.app, cookie, workItemId);
    const first = one(frozen.obligationRefs);

    // The customer writes again while the operator is preparing the answer.
    await receiveUpdate(tenant, telegramMessageUpdate(2002, 602, 'И ещё один вопрос'));

    const both = await obligations(ctx.db, ctx.schema, workItemId);
    assert.equal(both.length, 2);
    assert.equal(both.filter((item) => item.state === 'open').length, 2);
    const second = both.find((item) => item.id !== first.obligationId);
    assert.ok(second);

    // Answering the old snapshot is legitimate; it must not touch the new message.
    const accepted = await reply(ctx.app, cookie, workItemId, {
      idempotencyKey: 'reply-e2e-2',
      snapshotId: frozen.id,
      expectedAssignmentVersion: 1,
      selectedObligations: [first],
      text: 'Ответ на первый вопрос',
    });
    assert.equal(accepted.statusCode, 202, accepted.body);
    const operationId = json<{ id: string }>(accepted).id;

    const calls: Array<{ chatId: string; text: string }> = [];
    assert.equal(
      (await runSendWorker(ctx.db, workerOptions(tenant, fakeTransport({ outcome: 'sent', providerMessageId: '9002' }, calls))))
        .sent,
      1,
    );
    const coverage = await confirmSendCoverage(ctx.db, { schema: ctx.schema }, {
      companyId: tenant.companyId,
      operationId,
    });
    assert.deepEqual(coverage.covered, [first]);
    assert.deepEqual(
      coverage.remaining.map((item) => item.obligationId),
      [second!.id],
    );

    const after = await obligations(ctx.db, ctx.schema, workItemId);
    assert.equal(after.find((item) => item.id === first.obligationId)?.state, 'covered');
    assert.equal(after.find((item) => item.id === second!.id)?.state, 'open');
    const since = waitingSince(after);
    assert.ok(since, 'waiting_since must not be cleared while the new message is unanswered');
    assert.equal(since.toISOString(), new Date(second!.openedAt).toISOString());
  } finally {
    await ctx.close();
  }
});

test('scenario 3: an ambiguous transport result keeps the obligation open and is never retried', async () => {
  const tenant = await setupTenant();
  const { ctx } = tenant;
  try {
    await receiveUpdate(tenant, telegramMessageUpdate(3001, 701, 'Вопрос без ответа'));
    const cookie = await login(ctx.app, 's1');
    const workItemId = one(await listWorkItems(ctx.app, cookie)).id;
    assert.equal((await claim(ctx.app, cookie, workItemId, 0, 'claim-e2e-3')).statusCode, 200);
    const frozen = await snapshot(ctx.app, cookie, workItemId);
    const accepted = await reply(ctx.app, cookie, workItemId, {
      idempotencyKey: 'reply-e2e-3',
      snapshotId: frozen.id,
      expectedAssignmentVersion: 1,
      selectedObligations: frozen.obligationRefs,
      text: 'Ответ, который потерялся',
    });
    assert.equal(accepted.statusCode, 202, accepted.body);
    const operationId = json<{ id: string }>(accepted).id;

    const calls: Array<{ chatId: string; text: string }> = [];
    const firstPass = await runSendWorker(
      ctx.db,
      workerOptions(tenant, fakeTransport({ outcome: 'unknown', reason: 'timeout' }, calls)),
    );
    assert.equal(firstPass.unknown, 1);
    assert.equal(calls.length, 1);
    assert.equal((await sendOperation(ctx.db, ctx.schema, operationId)).state, 'unknown');

    const stillOpen = await obligations(ctx.db, ctx.schema, workItemId);
    assert.equal(one(stillOpen).state, 'open');
    assert.ok(waitingSince(stillOpen));
    assert.equal(await count(ctx.db, ctx.schema, 'send_coverage'), 0);

    // A restarted worker must not perform a blind resend.
    const secondPass = await runSendWorker(
      ctx.db,
      workerOptions(tenant, fakeTransport({ outcome: 'sent', providerMessageId: '9999' }, calls), 'worker-b'),
    );
    assert.equal(secondPass.claimed, 0);
    assert.equal(calls.length, 1);
  } finally {
    await ctx.close();
  }
});

test('scenario 4: concurrent claims produce one winner and respect capacity', async () => {
  const tenant = await setupTenant(['s1', 's2']);
  const { ctx } = tenant;
  try {
    await receiveUpdate(tenant, telegramMessageUpdate(4001, 801, 'Кто возьмёт?'));
    const workItemId = one(await listWorkItems(ctx.app, await login(ctx.app, 's1'))).id;
    const [s1, s2] = await Promise.all([login(ctx.app, 's1'), login(ctx.app, 's2')]);

    const [first, second] = await Promise.all([
      claim(ctx.app, s1, workItemId, 0, 'race-claim-1'),
      claim(ctx.app, s2, workItemId, 0, 'race-claim-2'),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    assert.deepEqual(statuses, [200, 409], `${first.body} | ${second.body}`);

    const winnerResponse = first.statusCode === 200 ? first : second;
    const loserResponse = first.statusCode === 200 ? second : first;
    const winner = json<{ owner: string; assignmentVersion: number }>(winnerResponse);
    assert.equal(json<{ code: string }>(loserResponse).code, 'VERSION_CONFLICT');
    assert.equal(loserResponse.headers['x-current-owner'], winner.owner);
    assert.equal(loserResponse.headers['x-assignment-version'], '1');

    const staff = await ctx.db.query<{ id: string; active_count: number; capacity: number }>(
      `SELECT id, active_count, capacity FROM "${ctx.schema}".staff WHERE company_id = $1 ORDER BY id`,
      [COMPANY_ID],
    );
    assert.equal(staff.rows.reduce((sum, row) => sum + row.active_count, 0), 1, 'one slot total');
    assert.ok(staff.rows.every((row) => row.active_count <= row.capacity), 'capacity must never be exceeded');
    assert.equal(staff.rows.find((row) => row.id === winner.owner)?.active_count, 1);

    const item = await ctx.db.query<{ owner_id: string; assignment_version: string }>(
      `SELECT owner_id, assignment_version FROM "${ctx.schema}".work_items WHERE company_id = $1 AND id = $2`,
      [COMPANY_ID, workItemId],
    );
    assert.equal(one(item.rows).owner_id, winner.owner);
    assert.equal(Number(one(item.rows).assignment_version), 1);
  } finally {
    await ctx.close();
  }
});

test('scenario 5: an old snapshot cannot be used to cover a later inbound', async () => {
  const tenant = await setupTenant();
  const { ctx } = tenant;
  try {
    await receiveUpdate(tenant, telegramMessageUpdate(5001, 901, 'Старый вопрос'));
    const cookie = await login(ctx.app, 's1');
    const workItemId = one(await listWorkItems(ctx.app, cookie)).id;
    assert.equal((await claim(ctx.app, cookie, workItemId, 0, 'claim-e2e-5')).statusCode, 200);
    const frozen = await snapshot(ctx.app, cookie, workItemId);
    const first = one(frozen.obligationRefs);

    await receiveUpdate(tenant, telegramMessageUpdate(5002, 902, 'Новый вопрос после снимка'));
    const all = await obligations(ctx.db, ctx.schema, workItemId);
    assert.equal(all.length, 2);
    const second = all.find((item) => item.id !== first.obligationId);
    assert.ok(second);

    // The assignment version did not change, so this rejection proves the snapshot
    // membership check, not just a version fence.
    const stale = await reply(ctx.app, cookie, workItemId, {
      idempotencyKey: 'reply-e2e-5',
      snapshotId: frozen.id,
      expectedAssignmentVersion: 1,
      selectedObligations: [{ obligationId: second!.id, contentVersion: second!.contentVersion }],
      text: 'Попытка ответить старым снимком',
    });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(json<{ code: string }>(stale).code, 'STALE_EPOCH');

    assert.equal(await count(ctx.db, ctx.schema, 'send_operations'), 0, 'no operation may be accepted');
    assert.equal(await count(ctx.db, ctx.schema, 'outbox_jobs'), 0, 'nothing may be queued for sending');
    assert.equal(await count(ctx.db, ctx.schema, 'send_coverage'), 0);

    const after = await obligations(ctx.db, ctx.schema, workItemId);
    assert.equal(after.find((item) => item.id === first.obligationId)?.state, 'open');
    assert.equal(after.find((item) => item.id === second!.id)?.state, 'open');

    const calls: Array<{ chatId: string; text: string }> = [];
    const worker = await runSendWorker(
      ctx.db,
      workerOptions(tenant, fakeTransport({ outcome: 'sent', providerMessageId: '1111' }, calls)),
    );
    assert.equal(worker.claimed, 0);
    assert.equal(calls.length, 0);
  } finally {
    await ctx.close();
  }
});
