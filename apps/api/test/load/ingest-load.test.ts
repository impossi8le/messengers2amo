import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createTestDb } from '../helpers/db.ts';
import { seedConnection } from '../helpers/channel-fixtures.ts';
import { createWhatsAppCloudAdapter } from '../../src/channels/whatsapp-cloud.ts';
import { ingestWebhook } from '../../src/channels/inbox.ts';
import type { Db } from '../../src/platform/db.ts';
import { formatSummary, nowMs, runWithConcurrency, summarize } from './support.ts';

/**
 * Load profile for inbound webhooks.
 *
 * 500 webhooks are delivered with 25 in flight at a time, which is the shape of
 * a provider burst after a reconnect. Messages are spread over 50 chats so the
 * concurrent conversation upsert path is exercised, not just one hot row.
 */
const WEBHOOKS = 500;
const CONCURRENCY = 25;
const CHATS = 50;

/**
 * Thresholds.
 *
 * - p95 500 ms comes from the platform target for durable webhook storage
 *   (docs/messenger-platform-architecture.ru.md: "p95 сохранения webhook до 500 ms").
 * - p99 1000 ms is twice the p95 budget: with 25 concurrent writers over a
 *   10-connection pool, a few requests queue behind the pool by design.
 * - max 3000 ms catches a single pathological stall (lock wait, missing index)
 *   that averages would hide.
 * - total 60 s leaves room inside the 2-minute budget for the other load files.
 *
 * These are regression gates for the local PostgreSQL, not production SLOs;
 * see README.md for what this test cannot prove.
 */
const P95_BUDGET_MS = 500;
const P99_BUDGET_MS = 1_000;
const MAX_BUDGET_MS = 3_000;
const TOTAL_BUDGET_MS = 60_000;

const APP_SECRET = 'load-app-secret';

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', APP_SECRET).update(body, 'utf8').digest('hex');
}

function messagePayload(index: number): string {
  const chat = `7900000${String(index % CHATS).padStart(4, '0')}`;
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-load',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '100', phone_number_id: 'phone-load' },
              contacts: [{ profile: { name: `customer-${index % CHATS}` }, wa_id: chat }],
              messages: [
                {
                  from: chat,
                  id: `wamid.load.${index}`,
                  timestamp: String(1_700_000_000 + index),
                  type: 'text',
                  text: { body: `load message ${index}` },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

async function count(db: Db, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.query<{ c: number }>(sql, params);
  return Number(rows[0]?.c ?? 0);
}

test(
  'ingest load: 500 concurrent webhooks are stored exactly once',
  { timeout: 120_000 },
  async (t) => {
    const { db, schema, close } = await createTestDb();
    try {
      const connection = await seedConnection(db, schema, {
        channelMode: 'whatsapp_cloud',
        crmProjectionEnabled: true,
      });
      const adapter = createWhatsAppCloudAdapter({
        appSecret: APP_SECRET,
        accessToken: 'load-token',
        phoneNumberId: 'phone-load',
        apiBase: 'https://graph.example.test',
      });

      // Signing is deliberately outside the measured section: HMAC cost is CPU
      // work the transport/proxy would absorb, not the ingest path under test.
      const raws = Array.from({ length: WEBHOOKS }, (_, index) => {
        const body = messagePayload(index);
        return { body: Buffer.from(body, 'utf8'), headers: { 'x-hub-signature-256': sign(body) } };
      });

      const latencies = new Array<number>(WEBHOOKS);
      let accepted = 0;
      let duplicates = 0;
      let projections = 0;

      const started = nowMs();
      await runWithConcurrency(raws, CONCURRENCY, async (raw, index) => {
        const requestStarted = nowMs();
        const result = await ingestWebhook({ db, schema, adapter, connection, raw });
        latencies[index] = nowMs() - requestStarted;
        accepted += result.accepted;
        duplicates += result.duplicates;
        projections += result.crmProjections;
      });
      const totalMs = nowMs() - started;

      const summary = summarize(latencies, totalMs);
      t.diagnostic(formatSummary('ingest 500 webhooks / 25 concurrent', summary));

      // Delivery accounting: no webhook lost, none counted twice.
      assert.equal(accepted, WEBHOOKS, 'every webhook was accepted');
      assert.equal(duplicates, 0, 'no webhook was reported as a duplicate');
      assert.equal(projections, WEBHOOKS, 'every accepted message planned one CRM projection');

      // Durable state: one inbox row per provider event key.
      assert.equal(await count(db, `SELECT count(*)::int AS c FROM "${schema}".inbox_events`), WEBHOOKS);
      assert.equal(
        await count(db, `SELECT count(DISTINCT provider_event_key)::int AS c FROM "${schema}".inbox_events`),
        WEBHOOKS,
        'provider event keys are unique',
      );
      assert.equal(
        await count(db, `SELECT count(*)::int AS c FROM "${schema}".inbox_events WHERE provider_event_key IS NULL`),
        0,
        'no inbox event lost its provider key',
      );

      // Archived history: one message per webhook, one conversation per chat.
      assert.equal(await count(db, `SELECT count(*)::int AS c FROM "${schema}".messages`), WEBHOOKS);
      assert.equal(
        await count(db, `SELECT count(DISTINCT provider_message_id)::int AS c FROM "${schema}".messages`),
        WEBHOOKS,
        'provider message ids are unique',
      );
      assert.equal(
        await count(db, `SELECT count(*)::int AS c FROM "${schema}".messages WHERE provider_message_id LIKE 'wamid.load.%'`),
        WEBHOOKS,
        'no message was lost between the inbox and the archive',
      );
      assert.equal(
        await count(db, `SELECT count(*)::int AS c FROM "${schema}".conversations`),
        CHATS,
        'concurrent upserts created exactly one conversation per chat',
      );
      assert.equal(
        await count(db, `SELECT count(*)::int AS c FROM "${schema}".message_versions`),
        WEBHOOKS,
        'each message has exactly one content version',
      );

      // Projection jobs: unique intent keys, no duplicates under concurrency.
      assert.equal(await count(db, `SELECT count(*)::int AS c FROM "${schema}".outbox_jobs`), WEBHOOKS);
      assert.equal(
        await count(db, `SELECT count(DISTINCT intent_key)::int AS c FROM "${schema}".outbox_jobs`),
        WEBHOOKS,
        'outbox intent keys are unique',
      );
      assert.equal(
        await count(db, `SELECT count(*)::int AS c FROM "${schema}".outbox_jobs WHERE job_kind <> 'crm.project'`),
        0,
      );
      assert.equal(
        await count(db, `SELECT count(*)::int AS c FROM "${schema}".outbox_jobs WHERE state <> 'pending'`),
        0,
        'ingest must not dispatch projections itself',
      );

      // Referential integrity across the whole ingest transaction.
      assert.equal(
        await count(
          db,
          `SELECT count(*)::int AS c FROM "${schema}".inbox_events e
             LEFT JOIN "${schema}".connection_identities i
               ON i.company_id=e.company_id AND i.connection_id=e.connection_id AND i.binding_epoch=e.binding_epoch
            WHERE i.connection_id IS NULL`,
        ),
        0,
        'every inbox event points at a real connection identity',
      );
      assert.equal(
        await count(
          db,
          `SELECT count(*)::int AS c FROM "${schema}".messages m
             LEFT JOIN "${schema}".conversations c
               ON c.company_id=m.company_id AND c.id=m.conversation_id
            WHERE c.id IS NULL`,
        ),
        0,
        'every message belongs to a conversation',
      );
      assert.equal(
        await count(
          db,
          `SELECT count(*)::int AS c FROM "${schema}".outbox_jobs j
             LEFT JOIN "${schema}".messages m
               ON m.company_id=j.company_id AND m.id=j.payload->>'messageId'
            WHERE j.job_kind='crm.project' AND m.id IS NULL`,
        ),
        0,
        'every projection job references an archived message',
      );
      assert.equal(
        await count(
          db,
          `SELECT count(*)::int AS c FROM "${schema}".outbox_jobs j
             LEFT JOIN "${schema}".conversations c
               ON c.company_id=j.company_id AND c.id=j.payload->>'conversationId'
            WHERE j.job_kind='crm.project' AND c.id IS NULL`,
        ),
        0,
        'every projection job references a real conversation',
      );
      assert.equal(
        await count(db, `SELECT count(*)::int AS c FROM "${schema}".attention_obligations`),
        0,
        'ingest archives facts but creates no operator obligations before processing',
      );
      assert.equal(
        await count(
          db,
          `SELECT count(*)::int AS c FROM "${schema}".attention_obligations o
             LEFT JOIN "${schema}".work_items w
               ON w.company_id=o.company_id AND w.id=o.work_item_id
            WHERE w.id IS NULL`,
        ),
        0,
        'no obligation is orphaned by the ingest burst',
      );

      assert.ok(summary.p95Ms <= P95_BUDGET_MS, `p95 ${summary.p95Ms.toFixed(1)}ms exceeds ${P95_BUDGET_MS}ms`);
      assert.ok(summary.p99Ms <= P99_BUDGET_MS, `p99 ${summary.p99Ms.toFixed(1)}ms exceeds ${P99_BUDGET_MS}ms`);
      assert.ok(summary.maxMs <= MAX_BUDGET_MS, `max ${summary.maxMs.toFixed(1)}ms exceeds ${MAX_BUDGET_MS}ms`);
      assert.ok(totalMs <= TOTAL_BUDGET_MS, `total ${totalMs.toFixed(1)}ms exceeds ${TOTAL_BUDGET_MS}ms`);
    } finally {
      await close();
    }
  },
);
