import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createTestApp, cookieFromResponse } from './helpers/app.ts';
import { seedCompany, seedConnection } from './helpers/seed.ts';
import { seedInboundMessage } from './helpers/attention.ts';
import { openIncoming } from '../src/repo/attention.ts';
import type { Db } from '../src/platform/db.ts';

const PASSWORD = 'correct horse battery staple';
const deps = (schema: string) => ({ schema });

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

type Notification = {
  id: string;
  kind: 'reply_required' | 'overdue' | 'assignment_changed' | 'send_unknown';
  workItemId: string;
  conversationId: string;
  attentionSeq: number | null;
  createdAt: string;
  hint: string;
};

type NotificationList = {
  items: Notification[];
  page: { nextCursor: string | null };
  hints: { replyRequiredCount: number; overdueCount: number; unknownSendCount: number };
};

type Fixture = {
  companyId: string;
  schema: string;
  db: Db;
};

/**
 * One company with two workshops. `wi1` belongs to `s1` on a `ws1` connection;
 * `wi2` belongs to `s2` on the same workshop; `wi3` belongs to `s1` but its
 * conversation is routed to `ws2`; `wi4` belongs to the company-wide manager.
 */
async function seedNotificationFixture(db: Db, schema: string): Promise<Fixture> {
  const companyId = 'c1';
  await seedCompany(db, {
    companyId,
    workshops: ['ws1', 'ws2'],
    staff: [
      { id: 's1', password: PASSWORD, role: 'send', workshopId: 'ws1' },
      { id: 's2', password: PASSWORD, role: 'send', workshopId: 'ws1' },
      { id: 'boss', password: PASSWORD, role: 'manage', workshopId: null },
    ],
  });
  await seedConnection(db, { companyId, id: 'conn1', state: 'active', workshopId: 'ws1', ownerId: 's1' });
  await seedConnection(db, { companyId, id: 'conn2', state: 'active', workshopId: 'ws2', ownerId: 's1' });

  for (const [conversationId, connectionId, suffix] of [
    ['conv1', 'conn1', '1'],
    ['conv2', 'conn1', '2'],
    ['conv3', 'conn2', '3'],
    ['conv4', 'conn1', '4'],
  ] as const) {
    await db.query(
      `INSERT INTO "${schema}".conversations
         (company_id,id,connection_id,binding_epoch,external_chat_id,chat_kind)
       VALUES ($1,$2,$3,0,$4,'private')`,
      [companyId, conversationId, connectionId, `chat-${suffix}`],
    );
  }

  await db.query(
    `INSERT INTO "${schema}".work_items (company_id,id,conversation_id,state,owner_id)
     VALUES ($1,'wi1','conv1','assigned','s1'),
            ($1,'wi2','conv2','assigned','s2'),
            ($1,'wi3','conv3','assigned','s1'),
            ($1,'wi4','conv4','assigned','boss')`,
    [companyId],
  );

  return { companyId, schema, db };
}

async function openObligation(
  fx: Fixture,
  workItemId: string,
  conversationId: string,
  messageId: string,
): Promise<{ id: string; attentionSeq: number }> {
  await seedInboundMessage(fx.db, fx.schema, {
    companyId: fx.companyId,
    conversationId,
    messageId,
    contentVersion: 0,
    content: { kind: 'text', text: `question ${messageId}` },
  });
  const opened = await openIncoming(fx.db, deps(fx.schema), {
    companyId: fx.companyId,
    workItemId,
    messageId,
    contentVersion: 0,
  });
  return { id: opened.obligation.id, attentionSeq: opened.obligation.attentionSeq };
}

/** Ages the waiting start so the obligation falls past the reply SLA. */
async function ageObligation(fx: Fixture, obligationId: string, interval: string): Promise<void> {
  await fx.db.query(
    `UPDATE "${fx.schema}".attention_obligations
        SET opened_at = now() - $3::interval
      WHERE company_id = $1 AND id = $2`,
    [fx.companyId, obligationId, interval],
  );
}

async function setObligationCreatedAt(fx: Fixture, obligationId: string, interval: string): Promise<void> {
  await fx.db.query(
    `UPDATE "${fx.schema}".attention_obligations
        SET created_at = now() - $3::interval
      WHERE company_id = $1 AND id = $2`,
    [fx.companyId, obligationId, interval],
  );
}

async function listNotifications(
  app: FastifyInstance,
  cookie: string,
  query = '',
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'GET',
    url: `/api/v2/operator/notifications${query}`,
    headers: { cookie },
  });
}

test('notifications are personal and limited to the session workshop scope', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedNotificationFixture(db, schema);
    await openObligation(fx, 'wi1', 'conv1', 'm1');
    await openObligation(fx, 'wi2', 'conv2', 'm2');
    await openObligation(fx, 'wi3', 'conv3', 'm3');
    await openObligation(fx, 'wi4', 'conv4', 'm4');

    const s1 = await login(app, 'c1', 's1');
    const own = json<NotificationList>(await listNotifications(app, s1));
    assert.deepEqual(
      own.items.map((item) => item.workItemId),
      ['wi1'],
      'only the session staff member\'s work item on a ws1 connection is visible',
    );

    const s2 = await login(app, 'c1', 's2');
    const other = json<NotificationList>(await listNotifications(app, s2));
    assert.deepEqual(
      other.items.map((item) => item.workItemId),
      ['wi2'],
    );
  } finally {
    await close();
  }
});

test('an open obligation yields reply_required with identifiers and a hint', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedNotificationFixture(db, schema);
    const obligation = await openObligation(fx, 'wi1', 'conv1', 'm1');

    const cookie = await login(app, 'c1', 's1');
    const body = json<NotificationList>(await listNotifications(app, cookie));
    assert.equal(body.items.length, 1);
    const item = body.items[0]!;
    assert.equal(item.kind, 'reply_required');
    assert.equal(item.id, `obligation:${obligation.id}`);
    assert.equal(item.workItemId, 'wi1');
    assert.equal(item.conversationId, 'conv1');
    assert.equal(item.attentionSeq, obligation.attentionSeq);
    assert.ok(item.hint.length > 0);
    assert.equal(Number.isNaN(Date.parse(item.createdAt)), false);
    assert.equal(body.hints.replyRequiredCount, 1);
    assert.equal(body.hints.overdueCount, 0);
  } finally {
    await close();
  }
});

test('an obligation past the reply SLA yields overdue instead of reply_required', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedNotificationFixture(db, schema);
    const obligation = await openObligation(fx, 'wi1', 'conv1', 'm1');
    await ageObligation(fx, obligation.id, '2 hours');

    const cookie = await login(app, 'c1', 's1');
    const body = json<NotificationList>(await listNotifications(app, cookie));
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0]!.kind, 'overdue');
    assert.equal(body.items[0]!.workItemId, 'wi1');
    assert.equal(body.hints.overdueCount, 1);
    assert.equal(body.hints.replyRequiredCount, 1, 'an overdue reply is still an unanswered reply');
  } finally {
    await close();
  }
});

test('a send operation in unknown state yields send_unknown', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedNotificationFixture(db, schema);
    await db.query(
      `INSERT INTO "${schema}".send_operations
         (company_id,id,work_item_id,conversation_id,connection_id,binding_epoch,actor_id,
          command_type,idempotency_key,payload_fingerprint,state,content,deadline)
       VALUES ($1,'op1','wi1','conv1','conn1',0,'s1','reply','key-1',$2,'unknown','{}'::jsonb,
               now() + interval '1 hour')`,
      [fx.companyId, 'a'.repeat(64)],
    );

    const cookie = await login(app, 'c1', 's1');
    const body = json<NotificationList>(await listNotifications(app, cookie));
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0]!.kind, 'send_unknown');
    assert.equal(body.items[0]!.workItemId, 'wi1');
    assert.equal(body.items[0]!.conversationId, 'conv1');
    assert.equal(body.items[0]!.attentionSeq, null);
    assert.equal(body.hints.unknownSendCount, 1);
  } finally {
    await close();
  }
});

test('a transfer of ownership yields assignment_changed', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedNotificationFixture(db, schema);
    await db.query(
      `INSERT INTO "${schema}".assignment_history
         (company_id,id,work_item_id,previous_owner_id,owner_id,assignment_version,reason,actor_id)
       VALUES ($1,'ah1','wi1','s2','s1',1,'transfer','s2')`,
      [fx.companyId],
    );

    const cookie = await login(app, 'c1', 's1');
    const body = json<NotificationList>(await listNotifications(app, cookie));
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0]!.kind, 'assignment_changed');
    assert.equal(body.items[0]!.id, 'assignment:ah1');
    assert.equal(body.items[0]!.workItemId, 'wi1');
  } finally {
    await close();
  }
});

test('limit and after page through notifications newest first without overlap', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedNotificationFixture(db, schema);
    const first = await openObligation(fx, 'wi1', 'conv1', 'm1');
    const second = await openObligation(fx, 'wi1', 'conv1', 'm2');
    const third = await openObligation(fx, 'wi1', 'conv1', 'm3');
    await setObligationCreatedAt(fx, first.id, '3 hours');
    await setObligationCreatedAt(fx, second.id, '2 hours');
    await setObligationCreatedAt(fx, third.id, '1 hour');

    const cookie = await login(app, 'c1', 's1');
    const page1 = json<NotificationList>(await listNotifications(app, cookie, '?limit=2'));
    assert.equal(page1.items.length, 2);
    assert.equal(page1.items[0]!.id, `obligation:${third.id}`);
    assert.equal(page1.items[1]!.id, `obligation:${second.id}`);
    assert.ok(page1.page.nextCursor);

    const page2 = json<NotificationList>(
      await listNotifications(app, cookie, `?limit=2&after=${encodeURIComponent(page1.page.nextCursor!)}`),
    );
    assert.deepEqual(
      page2.items.map((item) => item.id),
      [`obligation:${first.id}`],
    );
    assert.equal(page2.page.nextCursor, null);

    const seen = new Set([...page1.items, ...page2.items].map((item) => item.id));
    assert.equal(seen.size, 3);
  } finally {
    await close();
  }
});

test('a cursor is bound to its scope and a malformed cursor is rejected', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedNotificationFixture(db, schema);
    await openObligation(fx, 'wi4', 'conv4', 'm4');

    const boss = await login(app, 'c1', 'boss');
    const bossPage = json<NotificationList>(await listNotifications(app, boss, '?limit=1'));
    assert.ok(bossPage.page.nextCursor);

    const s1 = await login(app, 'c1', 's1');
    const foreignScope = await listNotifications(
      app,
      s1,
      `?after=${encodeURIComponent(bossPage.page.nextCursor!)}`,
    );
    assert.equal(foreignScope.statusCode, 400, foreignScope.body);
    assert.equal(json<{ code: string }>(foreignScope).code, 'VALIDATION_FAILED');

    const broken = await listNotifications(app, s1, '?after=not-a-cursor');
    assert.equal(broken.statusCode, 400, broken.body);
    assert.equal(json<{ code: string }>(broken).code, 'VALIDATION_FAILED');
  } finally {
    await close();
  }
});

test('hints summarise replies, overdue replies and unknown sends', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedNotificationFixture(db, schema);
    await openObligation(fx, 'wi1', 'conv1', 'm1');
    const overdue = await openObligation(fx, 'wi1', 'conv1', 'm2');
    await ageObligation(fx, overdue.id, '3 hours');
    await db.query(
      `INSERT INTO "${schema}".send_operations
         (company_id,id,work_item_id,conversation_id,connection_id,binding_epoch,actor_id,
          command_type,idempotency_key,payload_fingerprint,state,content,deadline)
       VALUES ($1,'op1','wi1','conv1','conn1',0,'s1','reply','key-1',$2,'unknown','{}'::jsonb,
               now() + interval '1 hour')`,
      [fx.companyId, 'b'.repeat(64)],
    );

    const cookie = await login(app, 'c1', 's1');
    const body = json<NotificationList>(await listNotifications(app, cookie));
    assert.equal(body.hints.replyRequiredCount, 2);
    assert.equal(body.hints.overdueCount, 1);
    assert.equal(body.hints.unknownSendCount, 1);
    assert.equal(body.items.length, 3, 'hints cover the whole scope, not just a page');
  } finally {
    await close();
  }
});

test('notifications require an authenticated read session', async () => {
  const { app, close } = await createTestApp();
  try {
    const anonymous = await app.inject({ method: 'GET', url: '/api/v2/operator/notifications' });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(json<{ code: string }>(anonymous).code, 'UNAUTHENTICATED');
  } finally {
    await close();
  }
});
