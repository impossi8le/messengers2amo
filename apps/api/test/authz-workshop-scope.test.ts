import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildTestApp, cookieFromResponse } from './helpers/app.ts';
import { createTestDb } from './helpers/db.ts';
import { seedCompany, seedConnection } from './helpers/seed.ts';
import { InMemoryObjectStorage } from '../src/media/storage.ts';
import { MediaService } from '../src/media/service.ts';
import { withTransaction } from '../src/platform/db.ts';
import { TEST_SESSION_SECRET } from './helpers/app.ts';

const PASSWORD = 'correct horse battery staple';
const START = Date.parse('2026-01-01T00:00:00.000Z');

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

type WorkshopFixture = {
  companyId: string;
  mediaWs1: string;
  mediaWs2: string;
};

/**
 * One company with two workshops. Each workshop owns a connection (and its route),
 * a conversation, a message and a work item; each conversation carries a media asset
 * created through real inbound ingest, so the asset is linked to its workshop through
 * attachments -> connection_routes.
 */
async function seedWorkshopFixture(
  db: Parameters<typeof seedCompany>[0],
  schema: string,
  storage: InMemoryObjectStorage,
): Promise<WorkshopFixture> {
  const companyId = 'c1';
  await seedCompany(db, {
    companyId,
    workshops: ['ws1', 'ws2'],
    staff: [
      { id: 'ca', password: PASSWORD, role: 'admin' },
      { id: 'wa', password: PASSWORD, role: 'admin', workshopId: 'ws1' },
      { id: 'wb', password: PASSWORD, role: 'admin', workshopId: 'ws2' },
      { id: 'm1', password: PASSWORD, role: 'manage', workshopId: 'ws1' },
      { id: 'm2', password: PASSWORD, role: 'manage', workshopId: 'ws2' },
      { id: 'r2', password: PASSWORD, role: 'read', workshopId: 'ws2' },
      { id: 'op1', password: PASSWORD, role: 'send', workshopId: 'ws1' },
      { id: 'op2', password: PASSWORD, role: 'send', workshopId: 'ws2' },
    ],
  });

  for (const [connectionId, workshopId, ownerId] of [
    ['conn1', 'ws1', 'op1'],
    ['conn2', 'ws2', 'op2'],
  ] as const) {
    await seedConnection(db, {
      companyId,
      id: connectionId,
      state: 'active',
      workshopId,
      ownerId,
      permissions: [{ staffId: ownerId, canRead: true, canSend: true }],
    });
  }

  await withTransaction(db, async (tx) => {
    const q = (sql: string, params: unknown[] = []) => tx.query(sql.replaceAll('__S__', `"${schema}"`), params);
    for (const [suffix, connectionId, ownerId] of [
      ['1', 'conn1', 'op1'],
      ['2', 'conn2', 'op2'],
    ] as const) {
      await q(
        `INSERT INTO __S__.conversations
           (company_id,id,connection_id,binding_epoch,external_chat_id,chat_kind)
         VALUES ($1,$2,$3,0,$4,'private')`,
        [companyId, `conv${suffix}`, connectionId, `chat-conv${suffix}`],
      );
      await q(
        `INSERT INTO __S__.messages
           (company_id,id,conversation_id,direction,provider_message_id,current_content_version)
         VALUES ($1,$2,$3,'in',$4,0)`,
        [companyId, `msg${suffix}`, `conv${suffix}`, `ext-msg-${suffix}`],
      );
      await q(
        `INSERT INTO __S__.message_versions (company_id,message_id,content_version,content)
         VALUES ($1,$2,0,'{"kind":"text"}'::jsonb)`,
        [companyId, `msg${suffix}`],
      );
      await q(
        `INSERT INTO __S__.work_items (company_id,id,conversation_id,state,owner_id)
         VALUES ($1,$2,$3,'assigned',$4)`,
        [companyId, `wi${suffix}`, `conv${suffix}`, ownerId],
      );
    }
  });

  const service = new MediaService({
    db,
    schema,
    storage,
    sessionSecret: TEST_SESSION_SECRET,
    now: () => START,
  });
  const inbound = (suffix: string, connectionId: string) =>
    service.ingestInboundAttachment({
      companyId,
      conversationId: `conv${suffix}`,
      connectionId,
      bindingEpoch: 0,
      externalChatId: `chat-conv${suffix}`,
      messageId: `msg${suffix}`,
      externalMessageId: `ext-msg-${suffix}`,
      externalAttachmentId: `att-ext-${suffix}`,
      fileName: `file-${suffix}.png`,
      declaredMimeType: 'image/png',
      bytes: Buffer.from(`workshop-${suffix}-bytes`),
    });
  const first = await inbound('1', 'conn1');
  const second = await inbound('2', 'conn2');
  assert.ok(first.mediaId);
  assert.ok(second.mediaId);
  return { companyId, mediaWs1: first.mediaId, mediaWs2: second.mediaId };
}

function mediaApp(
  db: Parameters<typeof seedCompany>[0],
  schema: string,
  storage: InMemoryObjectStorage,
): Promise<FastifyInstance> {
  return buildTestApp({ db, media: { schema, storage }, now: () => START });
}

// Vulnerability 1 (HIGH): a workshop admin widened their own grant to the whole company.
test('workshop admin cannot widen scope to the company or manage another workshop', async () => {
  const { db, schema, close } = await createTestDb();
  const storage = new InMemoryObjectStorage('secret', () => START);
  const app = await mediaApp(db, schema, storage);
  try {
    await seedWorkshopFixture(db, schema, storage);
    const wa = await login(app, 'c1', 'wa');
    const ca = await login(app, 'c1', 'ca');

    const change = (cookie: string, staffId: string, payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: `/api/v2/operator/staff/${staffId}/access`,
        headers: { cookie },
        payload,
      });

    // The exploit: workshop admin grants themselves company-wide scope.
    const selfEscalation = await change(wa, 'wa', { role: 'admin', workshopId: null, expectedVersion: 0 });
    assert.equal(selfEscalation.statusCode, 403, selfEscalation.body);

    // A workshop admin may still administer staff inside their own workshop.
    const ownWorkshop = await change(wa, 'op1', { role: 'send', workshopId: 'ws1', expectedVersion: 0 });
    assert.equal(ownWorkshop.statusCode, 200, ownWorkshop.body);
    assert.equal(json<{ workshopId: string | null }>(ownWorkshop).workshopId, 'ws1');

    // ... but not staff of another workshop.
    const foreignWorkshop = await change(wa, 'op2', { role: 'send', workshopId: 'ws2', expectedVersion: 0 });
    assert.equal(foreignWorkshop.statusCode, 403, foreignWorkshop.body);

    // ... and cannot strip the workshop restriction from their own staff.
    const widenOther = await change(wa, 'op1', { role: 'send', workshopId: null, expectedVersion: 1 });
    assert.equal(widenOther.statusCode, 403, widenOther.body);

    // A company-level admin keeps the ability to change grants and scope.
    const companyWide = await change(ca, 'op1', { role: 'send', workshopId: null, expectedVersion: 1 });
    assert.equal(companyWide.statusCode, 200, companyWide.body);
    assert.equal(json<{ workshopId: string | null }>(companyWide).workshopId, null);
  } finally {
    await app.close();
    await close();
  }
});

// Vulnerability 2 (HIGH): a reply could be accepted into another workshop's work item
// or carry media the sender cannot read.
test('attachment reply is rejected for foreign work items and unreadable media', async () => {
  const { db, schema, close } = await createTestDb();
  const storage = new InMemoryObjectStorage('secret', () => START);
  const app = await mediaApp(db, schema, storage);
  try {
    const fixture = await seedWorkshopFixture(db, schema, storage);
    const op2 = await login(app, 'c1', 'op2');
    const deadline = new Date(START + 60_000).toISOString();

    const reply = (workItemId: string, mediaIds: string[], idempotencyKey: string) =>
      app.inject({
        method: 'POST',
        url: `/api/v2/operator/work-items/${workItemId}/attachment-reply`,
        headers: { cookie: op2 },
        payload: {
          idempotencyKey,
          snapshotId: 'snap-1',
          expectedAssignmentVersion: 0,
          selectedObligations: [],
          mediaIds,
          caption: '',
          deadline,
        },
      });

    // Foreign work item (ws1) with media the caller legitimately owns (ws2).
    const foreignWorkItem = await reply('wi1', [fixture.mediaWs2], 'reply-foreign-work-item');
    assert.equal(foreignWorkItem.statusCode, 404, foreignWorkItem.body);

    // Own work item (ws2) but media from another workshop (ws1).
    const foreignMedia = await reply('wi2', [fixture.mediaWs1], 'reply-foreign-media');
    assert.equal(foreignMedia.statusCode, 404, foreignMedia.body);

    // Positive control: own work item and own media are accepted.
    const accepted = await reply('wi2', [fixture.mediaWs2], 'reply-own');
    assert.equal(accepted.statusCode, 202, accepted.body);
    assert.equal(json<{ state: string }>(accepted).state, 'accepted');
  } finally {
    await app.close();
    await close();
  }
});

// Vulnerability 3 (HIGH): manage/admin bypassed media authorization entirely.
test('manager cannot obtain a grant or bytes for another workshop media', async () => {
  const { db, schema, close } = await createTestDb();
  const storage = new InMemoryObjectStorage('secret', () => START);
  const app = await mediaApp(db, schema, storage);
  try {
    const fixture = await seedWorkshopFixture(db, schema, storage);
    const m2 = await login(app, 'c1', 'm2');

    const foreignGrant = await app.inject({
      method: 'GET',
      url: `/api/v2/operator/media/${fixture.mediaWs1}/access`,
      headers: { cookie: m2 },
    });
    assert.equal(foreignGrant.statusCode, 404, foreignGrant.body);

    // Even if a grant were somehow present, bytes must not cross the workshop boundary.
    const foreignBytes = await app.inject({
      method: 'GET',
      url: `/api/v2/media/${fixture.mediaWs1}/content`,
      headers: { cookie: m2 },
    });
    assert.equal(foreignBytes.statusCode, 404, foreignBytes.body);

    // Positive control: the same manager reads media from their own workshop.
    const ownGrant = await app.inject({
      method: 'GET',
      url: `/api/v2/operator/media/${fixture.mediaWs2}/access`,
      headers: { cookie: m2 },
    });
    assert.equal(ownGrant.statusCode, 200, ownGrant.body);
    const ownBytes = await app.inject({
      method: 'GET',
      url: `/api/v2/media/${fixture.mediaWs2}/content`,
      headers: { cookie: m2 },
    });
    assert.equal(ownBytes.statusCode, 200, ownBytes.body);
    assert.deepEqual(ownBytes.rawPayload, Buffer.from('workshop-2-bytes'));

    // A company-level admin is the explicit exception and sees the whole company.
    const ca = await login(app, 'c1', 'ca');
    const adminGrant = await app.inject({
      method: 'GET',
      url: `/api/v2/operator/media/${fixture.mediaWs1}/access`,
      headers: { cookie: ca },
    });
    assert.equal(adminGrant.statusCode, 200, adminGrant.body);
    const adminBytes = await app.inject({
      method: 'GET',
      url: `/api/v2/media/${fixture.mediaWs1}/content`,
      headers: { cookie: ca },
    });
    assert.equal(adminBytes.statusCode, 200, adminBytes.body);
  } finally {
    await app.close();
    await close();
  }
});

// Vulnerability 4 (MEDIUM): metadata leaked across workshops and resource state was
// disclosed before authorization.
test('media metadata is workshop-scoped and indistinguishable from missing media', async () => {
  const { db, schema, close } = await createTestDb();
  const storage = new InMemoryObjectStorage('secret', () => START);
  const app = await mediaApp(db, schema, storage);
  try {
    const fixture = await seedWorkshopFixture(db, schema, storage);
    const r2 = await login(app, 'c1', 'r2');

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/v2/operator/media/${fixture.mediaWs1}`,
      headers: { cookie: r2 },
    });
    assert.equal(foreign.statusCode, 404, foreign.body);
    assert.equal(json<{ code: string }>(foreign).code, 'NOT_FOUND');

    // Same answer as a media id that does not exist at all.
    const missing = await app.inject({
      method: 'GET',
      url: '/api/v2/operator/media/med_does_not_exist',
      headers: { cookie: r2 },
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(json<{ code: string }>(missing).code, json<{ code: string }>(foreign).code);

    // Own workshop metadata stays available.
    const own = await app.inject({
      method: 'GET',
      url: `/api/v2/operator/media/${fixture.mediaWs2}`,
      headers: { cookie: r2 },
    });
    assert.equal(own.statusCode, 200, own.body);
    assert.equal(json<{ displayName: string }>(own).displayName, 'file-2.png');
  } finally {
    await app.close();
    await close();
  }
});
