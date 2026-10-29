import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildTestApp, createTestApp, cookieFromResponse } from './helpers/app.ts';
import { createTestDb } from './helpers/db.ts';
import { seedCompany, seedConnection } from './helpers/seed.ts';
import type { Db } from '../src/platform/db.ts';

const PASSWORD = 'correct horse battery staple';

type SystemStatus = {
  checkedAt: string;
  database: { reachable: boolean; latencyMs: number | null };
  queues: {
    inboxPending: number;
    outboxPending: number;
    outboxLeased: number;
    outboxFailed: number;
    sendUnknown: number;
  };
  activity: { lastInboundAt: string | null; lastSendAt: string | null };
  connections: { total: number; active: number; degraded: number; authRequired: number };
  health: 'ok' | 'degraded' | 'critical';
  issues: Array<{ code: string; severity: 'warning' | 'critical'; title: string; detail: string }>;
};

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

async function readStatus(app: FastifyInstance, cookie: string): Promise<SystemStatus> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v2/operator/system-status',
    headers: { cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  return json<SystemStatus>(response);
}

/** One company with an admin and a plain operator (for the 403 case). */
async function seedTenant(db: Db): Promise<void> {
  await seedCompany(db, {
    companyId: 'c1',
    staff: [
      { id: 'admin', password: PASSWORD, role: 'admin' },
      { id: 'operator', password: PASSWORD, role: 'send' },
    ],
  });
}

/** Minimal delivery slice needed by the send_operations foreign keys. */
async function seedDeliverySlice(db: Db, schema: string): Promise<void> {
  await seedConnection(db, { companyId: 'c1', id: 'conn1', state: 'active' });
  await db.query(
    `INSERT INTO "${schema}".conversations
       (company_id,id,connection_id,binding_epoch,external_chat_id,chat_kind)
     VALUES ('c1','conv1','conn1',0,'chat-secret-value','private')`,
  );
  await db.query(
    `INSERT INTO "${schema}".work_items (company_id,id,conversation_id,state,owner_id)
     VALUES ('c1','wi1','conv1','assigned','admin')`,
  );
}

async function insertSendOperation(db: Db, schema: string, state: string): Promise<void> {
  await db.query(
    `INSERT INTO "${schema}".send_operations
       (company_id,id,work_item_id,conversation_id,connection_id,binding_epoch,actor_id,
        command_type,idempotency_key,payload_fingerprint,state,content,deadline)
     VALUES ('c1','op1','wi1','conv1','conn1',0,'admin','reply','key-1',$1,$2,'{}'::jsonb,
             now() + interval '1 hour')`,
    ['a'.repeat(64), state],
  );
}

/** A db whose queue read fails, as if PostgreSQL dropped the connection. */
function dbWithFailingStatusQuery(db: Db): Db {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'query') {
        return (text: unknown, values?: unknown[]) => {
          if (typeof text === 'string' && text.includes('outbox_jobs')) {
            return Promise.reject(new Error('database is unreachable'));
          }
          return target.query(text as string, values as never);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Db;
}

test('an empty system reports ok', async () => {
  const { app, db, close } = await createTestApp();
  try {
    await seedTenant(db);
    const cookie = await login(app, 'c1', 'admin');
    const body = await readStatus(app, cookie);

    assert.equal(body.health, 'ok');
    assert.deepEqual(body.issues, []);
    assert.equal(body.database.reachable, true);
    assert.equal(typeof body.database.latencyMs, 'number');
    assert.deepEqual(body.queues, {
      inboxPending: 0,
      outboxPending: 0,
      outboxLeased: 0,
      outboxFailed: 0,
      sendUnknown: 0,
    });
    assert.deepEqual(body.activity, { lastInboundAt: null, lastSendAt: null });
    assert.deepEqual(body.connections, { total: 0, active: 0, degraded: 0, authRequired: 0 });
    assert.match(body.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await close();
  }
});

test('a failed outbox job is critical', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    await seedTenant(db);
    await db.query(
      `INSERT INTO "${schema}".outbox_jobs(company_id,id,job_kind,intent_key,payload,state)
       VALUES ('c1','j1','telegram.send','k1','{}','failed')`,
    );
    const cookie = await login(app, 'c1', 'admin');
    const body = await readStatus(app, cookie);

    assert.equal(body.health, 'critical');
    assert.equal(body.queues.outboxFailed, 1);
    assert.ok(body.issues.some((issue) => issue.code === 'OUTBOX_FAILED' && issue.severity === 'critical'));
  } finally {
    await close();
  }
});

test('an unknown send operation is critical', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    await seedTenant(db);
    await seedDeliverySlice(db, schema);
    await insertSendOperation(db, schema, 'unknown');
    const cookie = await login(app, 'c1', 'admin');
    const body = await readStatus(app, cookie);

    assert.equal(body.health, 'critical');
    assert.equal(body.queues.sendUnknown, 1);
    assert.ok(body.issues.some((issue) => issue.code === 'SEND_UNKNOWN' && issue.severity === 'critical'));
  } finally {
    await close();
  }
});

test('a connection waiting for authorization degrades the system', async () => {
  const { app, db, close } = await createTestApp();
  try {
    await seedTenant(db);
    await seedConnection(db, { companyId: 'c1', id: 'conn-auth', state: 'auth_required' });
    const cookie = await login(app, 'c1', 'admin');
    const body = await readStatus(app, cookie);

    assert.equal(body.health, 'degraded');
    assert.equal(body.connections.authRequired, 1);
    assert.ok(
      body.issues.some((issue) => issue.code === 'CONNECTIONS_AUTH_REQUIRED' && issue.severity === 'warning'),
    );
  } finally {
    await close();
  }
});

test('a degraded connection degrades the system', async () => {
  const { app, db, close } = await createTestApp();
  try {
    await seedTenant(db);
    await seedConnection(db, { companyId: 'c1', id: 'conn-degraded', state: 'degraded' });
    const cookie = await login(app, 'c1', 'admin');
    const body = await readStatus(app, cookie);

    assert.equal(body.health, 'degraded');
    assert.equal(body.connections.degraded, 1);
    assert.ok(body.issues.some((issue) => issue.code === 'CONNECTIONS_DEGRADED'));
  } finally {
    await close();
  }
});

test('an inbox backlog over the threshold degrades the system', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    await seedTenant(db);
    await seedConnection(db, { companyId: 'c1', id: 'conn1', state: 'active' });
    await db.query(
      `INSERT INTO "${schema}".inbox_events
         (company_id,id,connection_id,binding_epoch,payload_major,kind,payload,state)
       SELECT 'c1', 'e' || g, 'conn1', 0, 2, 'message', '{}'::jsonb, 'pending'
         FROM generate_series(1, 1001) AS g`,
    );
    const cookie = await login(app, 'c1', 'admin');
    const body = await readStatus(app, cookie);

    assert.equal(body.health, 'degraded');
    assert.equal(body.queues.inboxPending, 1001);
    assert.ok(body.issues.some((issue) => issue.code === 'INBOX_BACKLOG' && issue.severity === 'warning'));
  } finally {
    await close();
  }
});

test('no inbound activity with active connections degrades the system', async () => {
  const { app, db, close } = await createTestApp();
  try {
    await seedTenant(db);
    await seedConnection(db, { companyId: 'c1', id: 'conn1', state: 'active' });
    const cookie = await login(app, 'c1', 'admin');
    const body = await readStatus(app, cookie);

    assert.equal(body.health, 'degraded');
    assert.equal(body.connections.active, 1);
    assert.equal(body.activity.lastInboundAt, null);
    assert.ok(body.issues.some((issue) => issue.code === 'INBOUND_IDLE'));
  } finally {
    await close();
  }
});

test('pending outbox jobs older than the threshold are critical', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    await seedTenant(db);
    await db.query(
      `INSERT INTO "${schema}".outbox_jobs(company_id,id,job_kind,intent_key,payload,state,created_at)
       VALUES ('c1','j-old','telegram.send','k-old','{}','pending', now() - interval '30 minutes')`,
    );
    const cookie = await login(app, 'c1', 'admin');
    const body = await readStatus(app, cookie);

    assert.equal(body.health, 'critical');
    assert.equal(body.queues.outboxPending, 1);
    assert.ok(body.issues.some((issue) => issue.code === 'OUTBOX_STUCK' && issue.severity === 'critical'));
  } finally {
    await close();
  }
});

test('an unreachable database is critical and reports reachable=false', async () => {
  const { db, schema, close } = await createTestDb();
  const flaky = dbWithFailingStatusQuery(db);
  const app = await buildTestApp({ db: flaky, schema });
  try {
    await seedTenant(db);
    const cookie = await login(app, 'c1', 'admin');
    const body = await readStatus(app, cookie);

    assert.equal(body.health, 'critical');
    assert.equal(body.database.reachable, false);
    assert.equal(body.database.latencyMs, null);
    assert.deepEqual(body.queues, {
      inboxPending: 0,
      outboxPending: 0,
      outboxLeased: 0,
      outboxFailed: 0,
      sendUnknown: 0,
    });
    assert.ok(body.issues.some((issue) => issue.code === 'DATABASE_UNREACHABLE'));
  } finally {
    await app.close();
    await close();
  }
});

test('a non-admin role is forbidden', async () => {
  const { app, db, close } = await createTestApp();
  try {
    await seedTenant(db);
    const cookie = await login(app, 'c1', 'operator');
    const response = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/system-status',
      headers: { cookie },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(json<{ code: string }>(response).code, 'FORBIDDEN');
  } finally {
    await close();
  }
});

test('the response never carries identifiers or personal data', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    await seedTenant(db);
    await seedDeliverySlice(db, schema);
    await insertSendOperation(db, schema, 'unknown');
    await seedConnection(db, { companyId: 'c1', id: 'conn-auth', state: 'auth_required' });
    const cookie = await login(app, 'c1', 'admin');
    const response = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/system-status',
      headers: { cookie },
    });
    assert.equal(response.statusCode, 200, response.body);
    for (const forbidden of ['conv1', 'conn1', 'conn-auth', 'chat-secret-value', 'admin', 'operator']) {
      assert.ok(!response.body.includes(forbidden), `response leaked ${forbidden}`);
    }
  } finally {
    await close();
  }
});
