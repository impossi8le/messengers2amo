import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { seedTenant } from './helpers/fixtures.ts';
import { buildTestApp, sessionCookie, TEST_SESSION_SECRET } from './helpers/app.ts';
import { InMemoryObjectStorage } from '../src/media/storage.ts';
import { MediaService } from '../src/media/service.ts';

const START = Date.parse('2026-01-01T00:00:00.000Z');

/** A real PNG signature followed by filler; enough for magic-byte detection. */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('IHDR-filler-bytes'),
]);
/** A Windows PE image, as a .exe would start. */
const EXE_BYTES = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 0x00), Buffer.from('This program cannot be run')]);

function serviceFor(db: Parameters<typeof seedTenant>[0], schema: string, storage: InMemoryObjectStorage) {
  return new MediaService({ db, schema, storage, sessionSecret: TEST_SESSION_SECRET, now: () => START });
}

test('a real PNG signature is accepted and becomes ready', async () => {
  const { db, schema, close } = await createTestDb();
  const storage = new InMemoryObjectStorage('secret', () => START);
  const app = await buildTestApp({ db, media: { schema, storage }, now: () => START });
  const tenant = await seedTenant(db, schema);
  const cookie = sessionCookie(tenant.companyId, tenant.staffId, 'send');
  try {
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/media/uploads',
      headers: { cookie },
      payload: {
        idempotencyKey: 'sniff-png',
        displayName: 'photo.png',
        mimeType: 'image/png',
        sizeBytes: PNG_BYTES.byteLength,
      },
    });
    assert.equal(accepted.statusCode, 202);
    const put = await app.inject({
      method: 'PUT',
      url: accepted.json().uploadPath,
      headers: { cookie, 'content-type': 'application/octet-stream' },
      payload: PNG_BYTES,
    });
    assert.equal(put.statusCode, 202, put.body);
    assert.equal(put.json().state, 'ready');
  } finally {
    await app.close();
    await close();
  }
});

test('executable bytes declared as image/png are rejected, never ready', async () => {
  const { db, schema, close } = await createTestDb();
  const storage = new InMemoryObjectStorage('secret', () => START);
  const app = await buildTestApp({ db, media: { schema, storage }, now: () => START });
  const tenant = await seedTenant(db, schema);
  const cookie = sessionCookie(tenant.companyId, tenant.staffId, 'send');
  try {
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/media/uploads',
      headers: { cookie },
      payload: {
        idempotencyKey: 'sniff-exe',
        displayName: 'photo.png',
        mimeType: 'image/png',
        sizeBytes: EXE_BYTES.byteLength,
      },
    });
    assert.equal(accepted.statusCode, 202);
    const id = accepted.json().asset.id as string;

    const put = await app.inject({
      method: 'PUT',
      url: `/api/v2/media/${id}/content`,
      headers: { cookie, 'content-type': 'application/octet-stream' },
      payload: EXE_BYTES,
    });
    assert.equal(put.statusCode, 422, put.body);
    assert.equal(put.json().code, 'VALIDATION_FAILED');

    const row = await db.query(`SELECT state, sha256, storage_key FROM "${schema}".media_assets WHERE id=$1`, [id]);
    assert.equal(row.rows[0].state, 'rejected');
    assert.equal(row.rows[0].sha256, null);
    assert.equal(row.rows[0].storage_key, `media/${tenant.companyId}/${id}/photo.png`, 'the reservation key must not be published');
  } finally {
    await app.close();
    await close();
  }
});

test('a name whose extension contradicts the content is refused', async () => {
  const { db, schema, close } = await createTestDb();
  const storage = new InMemoryObjectStorage('secret', () => START);
  const app = await buildTestApp({ db, media: { schema, storage }, now: () => START });
  const tenant = await seedTenant(db, schema);
  const cookie = sessionCookie(tenant.companyId, tenant.staffId, 'send');
  try {
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/media/uploads',
      headers: { cookie },
      payload: {
        idempotencyKey: 'sniff-ext',
        displayName: 'payload.exe',
        mimeType: 'image/png',
        sizeBytes: PNG_BYTES.byteLength,
      },
    });
    assert.equal(accepted.statusCode, 202);
    const id = accepted.json().asset.id as string;

    const put = await app.inject({
      method: 'PUT',
      url: `/api/v2/media/${id}/content`,
      headers: { cookie, 'content-type': 'application/octet-stream' },
      payload: PNG_BYTES,
    });
    assert.equal(put.statusCode, 422, put.body);
    const row = await db.query(`SELECT state FROM "${schema}".media_assets WHERE id=$1`, [id]);
    assert.equal(row.rows[0].state, 'rejected');
  } finally {
    await app.close();
    await close();
  }
});

test('inbound executable bytes declared as an image keep an honest placeholder', async () => {
  const { db, schema, close } = await createTestDb();
  const storage = new InMemoryObjectStorage('secret', () => START);
  const service = serviceFor(db, schema, storage);
  const tenant = await seedTenant(db, schema);
  try {
    const result = await service.ingestInboundAttachment({
      companyId: tenant.companyId,
      conversationId: tenant.conversationId,
      connectionId: tenant.connectionId,
      bindingEpoch: tenant.bindingEpoch,
      externalChatId: tenant.externalChatId,
      messageId: tenant.messageId,
      externalMessageId: tenant.externalMessageId,
      externalAttachmentId: 'att-exe-as-png',
      fileName: 'photo.png',
      declaredMimeType: 'image/png',
      bytes: EXE_BYTES,
    });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'content_mime_mismatch');
    assert.equal(result.mediaId, null);

    const attachment = await db.query(
      `SELECT storage_state, mime_type, original_name, s3_key FROM "${schema}".attachments WHERE id=$1`,
      [result.attachmentId],
    );
    assert.equal(attachment.rowCount, 1, 'the message must survive with a placeholder');
    assert.equal(attachment.rows[0].storage_state, 'failed');
    assert.equal(attachment.rows[0].mime_type, 'application/octet-stream');
    assert.equal(attachment.rows[0].s3_key, null);
    assert.match(attachment.rows[0].original_name, /photo\.png/);

    const messages = await db.query(`SELECT count(*)::int AS c FROM "${schema}".messages`);
    assert.equal(messages.rows[0].c, 1);
    assert.equal(await storage.get(`media/${tenant.companyId}/${result.attachmentId}/photo.png`), null);
  } finally {
    await close();
  }
});

test('inbound content whose type contradicts the declared one is not stored', async () => {
  const { db, schema, close } = await createTestDb();
  const storage = new InMemoryObjectStorage('secret', () => START);
  const service = serviceFor(db, schema, storage);
  const tenant = await seedTenant(db, schema);
  try {
    const mismatch = await service.ingestInboundAttachment({
      companyId: tenant.companyId,
      conversationId: tenant.conversationId,
      connectionId: tenant.connectionId,
      bindingEpoch: tenant.bindingEpoch,
      externalChatId: tenant.externalChatId,
      messageId: tenant.messageId,
      externalMessageId: tenant.externalMessageId,
      externalAttachmentId: 'att-jpeg-as-png',
      fileName: 'photo.png',
      declaredMimeType: 'image/png',
      bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
    });
    assert.equal(mismatch.accepted, false);
    assert.equal(mismatch.reason, 'content_mime_mismatch');

    const ok = await service.ingestInboundAttachment({
      companyId: tenant.companyId,
      conversationId: tenant.conversationId,
      connectionId: tenant.connectionId,
      bindingEpoch: tenant.bindingEpoch,
      externalChatId: tenant.externalChatId,
      messageId: tenant.messageId,
      externalMessageId: tenant.externalMessageId,
      externalAttachmentId: 'att-real-png',
      fileName: 'real.png',
      declaredMimeType: 'image/png',
      bytes: PNG_BYTES,
    });
    assert.equal(ok.accepted, true, 'a matching signature must still be accepted');
    assert.ok(ok.mediaId);
  } finally {
    await close();
  }
});
