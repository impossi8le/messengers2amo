import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { buildTestApp } from './helpers/app.ts';
import { collectMetrics, renderPrometheus } from '../src/observability/metrics.ts';

const TOKEN = 'metrics-token-for-tests-0123456789';

test('metrics are disabled when no token is configured', async () => {
  const { db, close } = await createTestDb();
  const app = await buildTestApp({ db, config: {} });
  try {
    const response = await app.inject({ method: 'GET', url: '/metrics' });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    await close();
  }
});

test('metrics reject a missing or wrong bearer token', async () => {
  const { db, close } = await createTestDb();
  const app = await buildTestApp({ db, config: {}, metricsToken: TOKEN });
  try {
    const anonymous = await app.inject({ method: 'GET', url: '/metrics' });
    assert.equal(anonymous.statusCode, 401);

    const wrong = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer not-the-right-token-at-all-000000' },
    });
    assert.equal(wrong.statusCode, 401);
  } finally {
    await app.close();
    await close();
  }
});

test('metrics report queue and inbox state from the database', async () => {
  const { db, schema, close } = await createTestDb();
  const app = await buildTestApp({ db, schema, config: {}, metricsToken: TOKEN });
  try {
    await db.query(`INSERT INTO "${schema}".companies(id) VALUES ('c1')`);
    await db.query(
      `INSERT INTO "${schema}".outbox_jobs(company_id,id,job_kind,intent_key,payload,state)
       VALUES ('c1','j1','telegram.send','k1','{}','pending'),
              ('c1','j2','telegram.send','k2','{}','failed'),
              ('c1','j3','telegram.send','k3','{}','unknown')`,
    );

    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-type']), /text\/plain/);

    const body = response.body;
    assert.match(body, /m2a_up 1/);
    assert.match(body, /m2a_outbox_jobs\{state="pending"\} 1/);
    assert.match(body, /m2a_outbox_jobs\{state="failed"\} 1/);
    assert.match(body, /m2a_outbox_jobs\{state="unknown"\} 1/);
    assert.match(body, /m2a_outbox_jobs\{state="completed"\} 0/);
  } finally {
    await app.close();
    await close();
  }
});

test('metrics never expose message content or identifiers', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const metrics = await collectMetrics(db, schema);
    const rendered = renderPrometheus(metrics);
    assert.doesNotMatch(rendered, /company_id|conversation|message_id|phone|token/i);
  } finally {
    await close();
  }
});

test('prometheus rendering is stable and ends with a newline', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const metrics = await collectMetrics(db, schema);
    const rendered = renderPrometheus(metrics);
    assert.ok(rendered.endsWith('\n'));
    assert.match(rendered, /^# HELP m2a_up/m);
    assert.match(rendered, /^# TYPE m2a_up gauge/m);
  } finally {
    await close();
  }
});

test('renderer escapes newlines and backslashes in help text and labels', () => {
  const rendered = renderPrometheus([
    { name: 'probe', help: 'first\nsecond', type: 'gauge', labels: { state: 'a\nb' }, value: 1 },
    { name: 'probe2', help: 'back\slash', type: 'gauge', labels: { state: 'q"uote' }, value: 2 },
  ]);
  const lines = rendered.trimEnd().split('\n');
  for (const line of lines) {
    assert.ok(!line.includes('\n'), 'each record must be a single line');
  }
  // A newline inside a value must be emitted as the two characters backslash-n,
  // otherwise the exposition format breaks into separate records.
  assert.ok(rendered.includes('# HELP probe first\\nsecond'), 'help newline escaped');
  assert.ok(rendered.includes('probe{state="a\\nb"} 1'), 'label newline escaped');
  assert.ok(rendered.includes('probe2{state="q\\"uote"} 2'), 'label quote escaped');
});

test('collector rejects an unsafe schema name before touching the database', async () => {
  const { db, close } = await createTestDb();
  try {
    await assert.rejects(
      () => collectMetrics(db, 'public"."outbox_jobs" GROUP BY state; SELECT pg_sleep(1); --'),
      /INVALID_SCHEMA/,
    );
  } finally {
    await close();
  }
});
