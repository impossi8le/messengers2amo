import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, sessionCookie } from '../helpers/app.ts';
import { sessionIdFor } from '../helpers/fixtures.ts';
import { seedConnection } from '../helpers/seed.ts';
import type { Db } from '../../src/platform/db.ts';
import { formatSummary, nowMs, sleep, summarize } from './support.ts';

/**
 * Load profile for the operator read API.
 *
 * 200 sessions hit the work-item list at the same time. Every request performs
 * the same work as production: resolve the session row, then run the scoped
 * list query. The test pool is capped at 10 connections, so this also proves
 * the API queues on the pool instead of failing or leaking connections.
 */
const REQUESTS = 200;
const WORK_ITEMS = 200;
const PAGE_LIMIT = 50;

/**
 * Thresholds.
 *
 * - p95 750 ms. Firing all 200 requests at once creates a burst over a
 *   10-connection pool; requests can queue behind it. This is a configured
 *   regression budget, not a measured baseline. Its
 *   suitability must be evaluated against a recorded run and machine profile.
 *   It is a regression gate, not a production SLO.
 * - max 3000 ms absorbs the tail while 200 requests queue over 10 connections.
 * - total 30 s keeps this file inside the 2-minute load-suite budget.
 */
const P95_BUDGET_MS = 750;
const MAX_BUDGET_MS = 3_000;
const TOTAL_BUDGET_MS = 30_000;

type WorkItemsResponse = {
  items: { id: string; conversationId: string; assignmentVersion: number; state: string; owner: string | null }[];
  page: { nextCursor: string | null };
};

async function seedOperatorLoad(db: Db, companyId: string): Promise<string[]> {
  const staffIds = Array.from({ length: REQUESTS }, (_, index) => `load-staff-${String(index).padStart(3, '0')}`);
  const conversationIds = Array.from({ length: WORK_ITEMS }, (_, index) => `load-conv-${String(index).padStart(3, '0')}`);
  const workItemIds = Array.from({ length: WORK_ITEMS }, (_, index) => `load-wi-${String(index).padStart(3, '0')}`);

  const companyWide = staffIds.slice(0, REQUESTS / 2);
  const workshopScoped = staffIds.slice(REQUESTS / 2);

  await db.query(`INSERT INTO companies (id, display_name) VALUES ($1,$2)`, [companyId, companyId]);

  // Bulk inserts keep setup fast: 200 scrypt password hashes would dominate
  // the runtime and are irrelevant here because sessions are minted directly.
  await db.query(
    `INSERT INTO staff (company_id, id, display_name)
     SELECT $1, value, value FROM unnest($2::text[]) AS value`,
    [companyId, staffIds],
  );
  await db.query(`INSERT INTO workshops (company_id, id, display_name) VALUES ($1,'load-ws','Load workshop')`, [
    companyId,
  ]);
  // Half the sessions are company-wide, half are workshop-scoped. The scoped
  // half exercises the connection_routes EXISTS clause, which is the more
  // expensive read shape and the one an index regression would hit first.
  await db.query(
    `INSERT INTO staff_access (company_id, staff_id, role, workshop_id, version)
     SELECT $1, value, 'read', NULL, 1 FROM unnest($2::text[]) AS value`,
    [companyId, companyWide],
  );
  await db.query(
    `INSERT INTO staff_access (company_id, staff_id, role, workshop_id, version)
     SELECT $1, value, 'read', 'load-ws', 1 FROM unnest($2::text[]) AS value`,
    [companyId, workshopScoped],
  );
  await seedConnection(db, {
    companyId,
    id: 'load-conn',
    state: 'active',
    workshopId: 'load-ws',
    ownerId: staffIds[0],
  });
  await db.query(
    `INSERT INTO staff_sessions (company_id, id, staff_id, epoch, expires_at)
     SELECT $1, 'sess_' || value || '_' || $1, value, 1, now() + interval '1 day'
       FROM unnest($2::text[]) AS value`,
    [companyId, staffIds],
  );
  await db.query(
    `INSERT INTO conversations (company_id, id, connection_id, binding_epoch, external_chat_id, chat_kind)
     SELECT $1, value, 'load-conn', 0, 'chat-' || value, 'private'
       FROM unnest($2::text[]) AS value`,
    [companyId, conversationIds],
  );
  await db.query(
    `INSERT INTO work_items (company_id, id, conversation_id, state, owner_id)
     SELECT $1, wi.value, conv.value, 'queued', NULL
       FROM unnest($2::text[]) WITH ORDINALITY AS wi(value, ord)
       JOIN unnest($3::text[]) WITH ORDINALITY AS conv(value, ord2) ON conv.ord2 = wi.ord`,
    [companyId, workItemIds, conversationIds],
  );

  // Guard the fixture itself: a wrong count would silently weaken the load.
  const { rows } = await db.query<{ c: number }>('SELECT count(*)::int AS c FROM work_items WHERE company_id=$1', [
    companyId,
  ]);
  assert.equal(Number(rows[0]?.c ?? 0), WORK_ITEMS);
  return staffIds;
}

test(
  'operator API load: 200 concurrent list requests from distinct sessions stay healthy',
  { timeout: 120_000 },
  async (t) => {
    const app = await createTestApp();
    try {
      const companyId = 'c-load';
      const staffIds = await seedOperatorLoad(app.db, companyId);

      const cookies = staffIds.map((staffId) => sessionCookie(companyId, staffId, 'read'));
      assert.equal(new Set(cookies).size, REQUESTS, 'each request uses a distinct session');
      // The cookie names the session row seeded above; a mismatch would turn the
      // whole burst into a 401 measurement instead of a read measurement.
      assert.equal(sessionIdFor(companyId, staffIds[0]!), `sess_${staffIds[0]}_${companyId}`);

      const latencies = new Array<number>(REQUESTS);
      const statuses = new Array<number>(REQUESTS);
      const bodies = new Array<WorkItemsResponse | null>(REQUESTS);
      const failures: string[] = [];

      // Sample pool queueing while the burst is in flight. This is diagnostic:
      // the hard assertion is that no request failed to acquire a connection.
      let peakWaiting = 0;
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          peakWaiting = Math.max(peakWaiting, app.db.waitingCount);
          await sleep(2);
        }
      })();

      const started = nowMs();
      await Promise.all(
        cookies.map(async (cookie, index) => {
          const requestStarted = nowMs();
          try {
            const response = await app.app.inject({
              method: 'GET',
              url: `/api/v2/operator/work-items?limit=${PAGE_LIMIT}`,
              headers: { cookie },
            });
            statuses[index] = response.statusCode;
            bodies[index] = response.statusCode === 200 ? (response.json() as WorkItemsResponse) : null;
            if (response.statusCode !== 200) failures.push(`${response.statusCode}: ${response.body.slice(0, 200)}`);
          } catch (error) {
            failures.push(error instanceof Error ? error.message : String(error));
          } finally {
            latencies[index] = nowMs() - requestStarted;
          }
        }),
      );
      const totalMs = nowMs() - started;
      sampling = false;
      await sampler;

      const summary = summarize(latencies, totalMs);
      t.diagnostic(
        formatSummary(`operator list 200 requests / 200 sessions / limit ${PAGE_LIMIT}`, summary) +
          ` concurrency=${REQUESTS} http5xx=${statuses.filter((status) => status >= 500).length}` +
          ` requestFailures=${failures.length} peakPoolWaiting=${peakWaiting}` +
          ` poolWaiting=${app.db.waitingCount} poolTotal=${app.db.totalCount}` +
          ` poolIdle=${app.db.idleCount}`,
      );

      assert.deepEqual(failures, [], 'no request failed');
      for (let index = 0; index < REQUESTS; index += 1) {
        assert.equal(statuses[index], 200, `request ${index} returned ${statuses[index]}`);
      }
      // No 5xx anywhere; a 4xx would also invalidate the profile.
      assert.equal(statuses.filter((status) => status >= 400).length, 0);

      for (const body of bodies) {
        assert.ok(body, 'every request returned a body');
        assert.equal(body.items.length, PAGE_LIMIT, 'the page is full');
        assert.ok(body.page.nextCursor, 'more pages are advertised');
        assert.equal(new Set(body.items.map((item) => item.id)).size, PAGE_LIMIT, 'no item repeats inside a page');
      }

      // Pool health: nothing is left waiting and no connection leaked.
      assert.equal(app.db.waitingCount, 0, 'no client is still waiting for a connection');
      const poolMax = (app.db as unknown as { options: { max: number } }).options.max;
      t.diagnostic(`pool max=${poolMax} total=${app.db.totalCount} idle=${app.db.idleCount} waiting=${app.db.waitingCount}`);
      assert.ok(app.db.totalCount <= poolMax, `pool holds ${app.db.totalCount} of ${poolMax} connections`);
      const ping = await app.db.query<{ ok: number }>('SELECT 1 AS ok');
      assert.equal(ping.rows[0]?.ok, 1, 'the pool still serves queries after the burst');

      assert.ok(summary.p95Ms <= P95_BUDGET_MS, `p95 ${summary.p95Ms.toFixed(1)}ms exceeds ${P95_BUDGET_MS}ms`);
      assert.ok(summary.maxMs <= MAX_BUDGET_MS, `max ${summary.maxMs.toFixed(1)}ms exceeds ${MAX_BUDGET_MS}ms`);
      assert.ok(totalMs <= TOTAL_BUDGET_MS, `total ${totalMs.toFixed(1)}ms exceeds ${TOTAL_BUDGET_MS}ms`);
    } finally {
      await app.close();
    }
  },
);
