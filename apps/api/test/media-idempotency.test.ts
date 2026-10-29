import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { seedTenant } from './helpers/fixtures.ts';
import { buildTestApp, sessionCookie, TEST_SESSION_SECRET } from './helpers/app.ts';
import { InMemoryObjectStorage } from '../src/media/storage.ts';
import { MediaService } from '../src/media/service.ts';

const START = Date.parse('2026-01-01T00:00:00.000Z');

async function readyMedia(service: MediaService, companyId: string, key: string, content: string): Promise<string> {
  const bytes = Buffer.from(content);
  const accepted = await service.requestUpload(companyId, {
    idempotencyKey: key,
    displayName: `${key}.png`,
    mimeType: 'image/png',
    sizeBytes: bytes.byteLength,
  });
  await service.uploadBytes(companyId, accepted.asset.id, bytes);
  return accepted.asset.id;
}

/**
 * Defect 2: a replay with the same idempotency key but different content must be a
 * conflict, not a silent success that returns the previous operation.
 */
test('attachment reply replay with different payload is an idempotency conflict', async () => {
  const { db, schema, close } = await createTestDb();
  const storage = new InMemoryObjectStorage('secret', () => START);
  const service = new MediaService({
    db,
    schema,
    storage,
    sessionSecret: TEST_SESSION_SECRET,
    now: () => START,
  });
  const tenant = await seedTenant(db, schema);
  const app = await buildTestApp({ db, media: { schema, storage }, now: () => START });
  const cookie = sessionCookie(tenant.companyId, tenant.staffId, 'send');
  try {
    const mediaA = await readyMedia(service, tenant.companyId, 'media-a', 'aaaa');
    const mediaB = await readyMedia(service, tenant.companyId, 'media-b', 'bbbb');
    const deadline = new Date(START + 60_000).toISOString();
    const reply = (overrides: Record<string, unknown>) => ({
      idempotencyKey: 'reply-idem',
      snapshotId: 'snap-1',
      expectedAssignmentVersion: 0,
      selectedObligations: [],
      mediaIds: [mediaA],
      caption: 'first caption',
      deadline,
      ...overrides,
    });
    const post = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: `/api/v2/operator/work-items/${tenant.workItemId}/attachment-reply`,
        headers: { cookie },
        payload,
      });

    const accepted = await post(reply({}));
    assert.equal(accepted.statusCode, 202);
    const operationId = accepted.json().id;

    // Same key and identical payload: replay returns the original operation.
    const identical = await post(reply({}));
    assert.equal(identical.statusCode, 202);
    assert.equal(identical.json().id, operationId);

    // Same key, different media: conflict.
    const otherMedia = await post(reply({ mediaIds: [mediaB] }));
    assert.equal(otherMedia.statusCode, 409, otherMedia.body);
    assert.equal(otherMedia.json().code, 'IDEMPOTENCY_CONFLICT');

    // Same key, different caption: conflict.
    const otherCaption = await post(reply({ caption: 'second caption' }));
    assert.equal(otherCaption.statusCode, 409, otherCaption.body);
    assert.equal(otherCaption.json().code, 'IDEMPOTENCY_CONFLICT');

    const ops = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM "${schema}".send_operations`);
    assert.equal(ops.rows[0]?.c, 1, 'a conflict must not create a second operation');
  } finally {
    await app.close();
    await close();
  }
});

/**
 * The same check must hold on the branch where the insert loses the race: the
 * conflicting request must compare the stored fingerprint of the winner.
 */
test('attachment reply race loser with different payload is an idempotency conflict', async () => {
  const { db, schema, close } = await createTestDb();
  const storage = new InMemoryObjectStorage('secret', () => START);
  const tenant = await seedTenant(db, schema);
  try {
    const bootstrap = new MediaService({
      db,
      schema,
      storage,
      sessionSecret: TEST_SESSION_SECRET,
      now: () => START,
    });
    const mediaA = await readyMedia(bootstrap, tenant.companyId, 'media-a', 'aaaa');
    const mediaB = await readyMedia(bootstrap, tenant.companyId, 'media-b', 'bbbb');

    // Gate the pool so both callers pass the idempotency pre-check (no row yet)
    // before either INSERT runs; the inserts then race and one loses.
    const selectSuffix = `FROM "${schema}".send_operations
        WHERE company_id=$1 AND command_type='attachment_reply' AND idempotency_key=$2`;
    const insertPrefix = `INSERT INTO "${schema}".send_operations`;
    let selects = 0;
    let releaseInserts: () => void = () => undefined;
    const bothSelected = new Promise<void>((resolve) => {
      releaseInserts = resolve;
    });
    const gatedDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'query') return Reflect.get(target, property, receiver);
        return async (sql: string, params?: unknown[]) => {
          if (sql.includes(selectSuffix)) {
            const result = await target.query(sql, params);
            selects += 1;
            if (selects >= 2) releaseInserts();
            return result;
          }
          if (sql.includes(insertPrefix)) {
            await bothSelected;
            return target.query(sql, params);
          }
          return target.query(sql, params);
        };
      },
    });
    const service = new MediaService({
      db: gatedDb,
      schema,
      storage,
      sessionSecret: TEST_SESSION_SECRET,
      now: () => START,
    });

    const deadline = new Date(START + 60_000).toISOString();
    const reply = (mediaId: string, caption: string) => ({
      idempotencyKey: 'reply-race',
      snapshotId: 'snap-1',
      expectedAssignmentVersion: 0,
      selectedObligations: [],
      mediaIds: [mediaId],
      caption,
      deadline,
    });

    const results = await Promise.allSettled([
      service.createAttachmentReply(tenant.companyId, tenant.staffId, 'send', null, tenant.workItemId, reply(mediaA, 'first')),
      service.createAttachmentReply(tenant.companyId, tenant.staffId, 'send', null, tenant.workItemId, reply(mediaB, 'second')),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one payload wins');
    assert.equal(rejected.length, 1, 'the loser must not silently reuse the winner operation');
    const error = (rejected[0] as PromiseRejectedResult).reason as { code?: string };
    assert.equal(error.code, 'IDEMPOTENCY_CONFLICT');

    const ops = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM "${schema}".send_operations`);
    assert.equal(ops.rows[0]?.c, 1);
  } finally {
    await close();
  }
});
