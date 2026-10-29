import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTestDb } from './helpers/db.ts';
import { seedStaff, seedTenant } from './helpers/fixtures.ts';
import { buildTestApp, sessionCookie } from './helpers/app.ts';
import { InMemoryObjectStorage, S3ObjectStorage, sha256Hex, type StoredObjectMeta } from '../src/media/storage.ts';
import { assertSafeRemoteUrl, isPrivateAddress, SsrfError } from '../src/media/ssrf.ts';

const START = Date.parse('2026-01-01T00:00:00.000Z');

function clock(start = START) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

async function uploadAsset(
  app: Awaited<ReturnType<typeof buildTestApp>>,
  cookie: string,
  input: { idempotencyKey: string; displayName: string; mimeType: string; sizeBytes: number },
) {
  return app.inject({
    method: 'POST',
    url: '/api/v2/operator/media/uploads',
    headers: { cookie },
    payload: input,
  });
}

test('upload is accepted as pending and only becomes ready after verified bytes', async () => {
  const { db, schema, close } = await createTestDb();
  const time = clock();
  const storage = new InMemoryObjectStorage('secret', time.now);
  const app = await buildTestApp({ db, media: { schema, storage }, now: time.now });
  const tenant = await seedTenant(db, schema);
  const cookie = sessionCookie(tenant.companyId, tenant.staffId, 'send');
  const bytes = Buffer.from('hello-media-bytes');
  try {
    const accepted = await uploadAsset(app, cookie, {
      idempotencyKey: 'idem-1',
      displayName: 'photo.png',
      mimeType: 'image/png',
      sizeBytes: bytes.byteLength,
    });
    assert.equal(accepted.statusCode, 202);
    const body = accepted.json();
    assert.equal(body.asset.state, 'pending_upload');
    assert.equal(body.asset.sha256, null);
    assert.equal(body.asset.displayName, 'photo.png');
    assert.equal(body.asset.mimeType, 'image/png');
    assert.equal(body.asset.sizeBytes, bytes.byteLength);
    assert.match(body.uploadPath, /^\/api\/v2\/media\/[A-Za-z0-9_-]+\/content$/);
    assert.equal(body.uploadPath, `/api/v2/media/${body.asset.id}/content`);
    assert.equal(body.expiresAt, new Date(START + 900_000).toISOString());

    // Not ready before bytes arrive: no content grant, no download.
    const beforeAccess = await app.inject({
      method: 'GET',
      url: `/api/v2/operator/media/${body.asset.id}/access`,
      headers: { cookie },
    });
    assert.equal(beforeAccess.statusCode, 409);

    const put = await app.inject({
      method: 'PUT',
      url: body.uploadPath,
      headers: { cookie, 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    assert.equal(put.statusCode, 202);
    const stored = put.json();
    assert.equal(stored.state, 'ready');
    assert.equal(stored.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(stored.sizeBytes, bytes.byteLength);

    const fetched = await app.inject({
      method: 'GET',
      url: `/api/v2/operator/media/${body.asset.id}`,
      headers: { cookie },
    });
    assert.equal(fetched.statusCode, 200);
    assert.equal(fetched.json().state, 'ready');

    const access = await app.inject({
      method: 'GET',
      url: `/api/v2/operator/media/${body.asset.id}/access`,
      headers: { cookie },
    });
    assert.equal(access.statusCode, 200);
    const grant = access.json();
    assert.equal(grant.mediaId, body.asset.id);
    assert.equal(grant.downloadPath, `/api/v2/media/${body.asset.id}/content`);

    const content = await app.inject({ method: 'GET', url: grant.downloadPath, headers: { cookie } });
    assert.equal(content.statusCode, 200);
    assert.deepEqual(content.rawPayload, bytes);
    assert.equal(content.headers['content-type'], 'image/png');
    assert.equal(content.headers['x-content-type-options'], 'nosniff');
  } finally {
    await app.close();
    await close();
  }
});

test('disallowed mime types are rejected with 415 and never stored', async () => {
  const { db, schema, close } = await createTestDb();
  const time = clock();
  const storage = new InMemoryObjectStorage('secret', time.now);
  const app = await buildTestApp({ db, media: { schema, storage }, now: time.now });
  const tenant = await seedTenant(db, schema);
  const cookie = sessionCookie(tenant.companyId, tenant.staffId, 'send');
  try {
    for (const mimeType of ['application/x-msdownload', 'application/javascript', 'text/html']) {
      const response = await uploadAsset(app, cookie, {
        idempotencyKey: `idem-${mimeType}`,
        displayName: 'payload.bin',
        mimeType,
        sizeBytes: 10,
      });
      assert.equal(response.statusCode, 415, `${mimeType} must be rejected`);
      assert.equal(response.json().code, 'VALIDATION_FAILED');
    }
    const { rows } = await db.query(`SELECT count(*)::int AS c FROM "${schema}".media_assets`);
    assert.equal(rows[0].c, 0);
  } finally {
    await app.close();
    await close();
  }
});

test('file and request size limits are enforced', async () => {
  const { db, schema, close } = await createTestDb();
  const time = clock();
  const storage = new InMemoryObjectStorage('secret', time.now);
  const app = await buildTestApp({
    db,
    media: { schema, storage, limits: { maxFileBytes: 64, maxMessageBytes: 64 } },
    now: time.now,
  });
  const tenant = await seedTenant(db, schema);
  const cookie = sessionCookie(tenant.companyId, tenant.staffId, 'send');
  try {
    const tooBig = await uploadAsset(app, cookie, {
      idempotencyKey: 'idem-big',
      displayName: 'big.png',
      mimeType: 'image/png',
      sizeBytes: 65,
    });
    assert.equal(tooBig.statusCode, 413);

    const accepted = await uploadAsset(app, cookie, {
      idempotencyKey: 'idem-small',
      displayName: 'small.png',
      mimeType: 'image/png',
      sizeBytes: 8,
    });
    assert.equal(accepted.statusCode, 202);
    const id = accepted.json().asset.id;

    const oversizedPut = await app.inject({
      method: 'PUT',
      url: `/api/v2/media/${id}/content`,
      headers: { cookie, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(65, 1),
    });
    assert.equal(oversizedPut.statusCode, 413);

    const wrongLength = await app.inject({
      method: 'PUT',
      url: `/api/v2/media/${id}/content`,
      headers: { cookie, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(4, 1),
    });
    assert.equal(wrongLength.statusCode, 422);

    const { rows } = await db.query(`SELECT state FROM "${schema}".media_assets WHERE id=$1`, [id]);
    assert.notEqual(rows[0].state, 'ready');
  } finally {
    await app.close();
    await close();
  }
});

test('asset never becomes ready without a confirmed sha256', async () => {
  const { db, schema, close } = await createTestDb();
  const time = clock();
  const storage = new InMemoryObjectStorage('secret', time.now);
  const app = await buildTestApp({ db, media: { schema, storage }, now: time.now });
  const tenant = await seedTenant(db, schema);
  const cookie = sessionCookie(tenant.companyId, tenant.staffId, 'send');
  const bytes = Buffer.from('tampered-bytes');
  try {
    const accepted = await uploadAsset(app, cookie, {
      idempotencyKey: 'idem-sha',
      displayName: 'doc.pdf',
      mimeType: 'application/pdf',
      sizeBytes: bytes.byteLength,
    });
    const id = accepted.json().asset.id;

    const wrongSha = await app.inject({
      method: 'PUT',
      url: `/api/v2/media/${id}/content`,
      headers: { cookie, 'content-type': 'application/octet-stream', 'x-content-sha256': 'f'.repeat(64) },
      payload: bytes,
    });
    assert.equal(wrongSha.statusCode, 422);
    const afterReject = await db.query(`SELECT state, sha256 FROM "${schema}".media_assets WHERE id=$1`, [id]);
    assert.notEqual(afterReject.rows[0].state, 'ready');
    assert.equal(afterReject.rows[0].sha256, null);

    // Storage reporting a different digest must also block readiness.
    const tampering = new InMemoryObjectStorage('secret', time.now);
    const originalHead = tampering.head.bind(tampering);
    tampering.head = async (key: string): Promise<StoredObjectMeta | null> => {
      const meta = await originalHead(key);
      return meta ? { ...meta, sha256: 'a'.repeat(64) } : null;
    };
    const app2 = await buildTestApp({ db, media: { schema, storage: tampering }, now: time.now });
    const accepted2 = await uploadAsset(app2, cookie, {
      idempotencyKey: 'idem-sha-2',
      displayName: 'doc2.pdf',
      mimeType: 'application/pdf',
      sizeBytes: bytes.byteLength,
    });
    const id2 = accepted2.json().asset.id;
    const put2 = await app2.inject({
      method: 'PUT',
      url: `/api/v2/media/${id2}/content`,
      headers: { cookie, 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    assert.equal(put2.statusCode, 503);
    const row2 = await db.query(`SELECT state FROM "${schema}".media_assets WHERE id=$1`, [id2]);
    assert.notEqual(row2.rows[0].state, 'ready');
    await app2.close();
  } finally {
    await app.close();
    await close();
  }
});

test('expired upload reservations and presigned links stop working', async () => {
  const { db, schema, close } = await createTestDb();
  const time = clock();
  const storage = new InMemoryObjectStorage('secret', time.now);
  const app = await buildTestApp({ db, media: { schema, storage, uploadTtlSeconds: 60 }, now: time.now });
  const tenant = await seedTenant(db, schema);
  const cookie = sessionCookie(tenant.companyId, tenant.staffId, 'send');
  try {
    const accepted = await uploadAsset(app, cookie, {
      idempotencyKey: 'idem-exp',
      displayName: 'late.png',
      mimeType: 'image/png',
      sizeBytes: 3,
    });
    const id = accepted.json().asset.id;
    time.advance(61_000);
    const put = await app.inject({
      method: 'PUT',
      url: `/api/v2/media/${id}/content`,
      headers: { cookie, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('abc'),
    });
    assert.equal(put.statusCode, 404);

    await storage.put('probe/key', Buffer.from('abc'), 'text/plain');
    const link = await storage.presignGet('probe/key', 1);
    assert.ok(await storage.resolvePresigned(link.url));
    time.advance(2_000);
    assert.equal(await storage.resolvePresigned(link.url), null);
  } finally {
    await app.close();
    await close();
  }
});

test('media access is tenant scoped and foreign tenants get 404', async () => {
  const { db, schema, close } = await createTestDb();
  const time = clock();
  const storage = new InMemoryObjectStorage('secret', time.now);
  const app = await buildTestApp({ db, media: { schema, storage }, now: time.now });
  const tenant = await seedTenant(db, schema);
  const other = await seedTenant(db, schema, {
    companyId: 'c2',
    staffId: 's2',
    connectionId: 'conn2',
    conversationId: 'conv2',
    messageId: 'msg2',
    workItemId: 'wi2',
    externalChatId: 'chat-2',
    externalMessageId: 'ext-msg-2',
  });
  const ownerCookie = sessionCookie(tenant.companyId, tenant.staffId, 'send');
  const foreignCookie = sessionCookie(other.companyId, other.staffId, 'send');
  const bytes = Buffer.from('tenant-scoped');
  try {
    const accepted = await uploadAsset(app, ownerCookie, {
      idempotencyKey: 'idem-tenant',
      displayName: 'secret.png',
      mimeType: 'image/png',
      sizeBytes: bytes.byteLength,
    });
    const id = accepted.json().asset.id;
    await app.inject({
      method: 'PUT',
      url: `/api/v2/media/${id}/content`,
      headers: { cookie: ownerCookie, 'content-type': 'application/octet-stream' },
      payload: bytes,
    });

    for (const url of [`/api/v2/operator/media/${id}`, `/api/v2/operator/media/${id}/access`, `/api/v2/media/${id}/content`]) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie: foreignCookie } });
      assert.equal(response.statusCode, 404, `${url} must not reveal foreign media`);
      assert.equal(response.json().code, 'NOT_FOUND');
    }
  } finally {
    await app.close();
    await close();
  }
});

test('access grants expire and unauthenticated callers are rejected', async () => {
  const { db, schema, close } = await createTestDb();
  const time = clock();
  const storage = new InMemoryObjectStorage('secret', time.now);
  const app = await buildTestApp({ db, media: { schema, storage, grantTtlSeconds: 1 }, now: time.now });
  const tenant = await seedTenant(db, schema);
  const cookie = sessionCookie(tenant.companyId, tenant.staffId, 'send');
  const bytes = Buffer.from('grant-bytes');
  try {
    const accepted = await uploadAsset(app, cookie, {
      idempotencyKey: 'idem-grant',
      displayName: 'a.png',
      mimeType: 'image/png',
      sizeBytes: bytes.byteLength,
    });
    const id = accepted.json().asset.id;
    await app.inject({
      method: 'PUT',
      url: `/api/v2/media/${id}/content`,
      headers: { cookie, 'content-type': 'application/octet-stream' },
      payload: bytes,
    });

    const noSession = await app.inject({ method: 'GET', url: `/api/v2/operator/media/${id}/access` });
    assert.equal(noSession.statusCode, 401);

    const access = await app.inject({
      method: 'GET',
      url: `/api/v2/operator/media/${id}/access`,
      headers: { cookie },
    });
    assert.equal(access.statusCode, 200);
    time.advance(2_000);
    const expired = await app.inject({ method: 'GET', url: `/api/v2/media/${id}/content`, headers: { cookie } });
    assert.equal(expired.statusCode, 403);

    const noGrant = await app.inject({
      method: 'GET',
      url: `/api/v2/operator/media/${id}/access`,
      headers: { cookie },
    });
    assert.equal(noGrant.statusCode, 200, noGrant.body);
  } finally {
    await app.close();
    await close();
  }
});

test('channel read permission is inherited for attachment-backed media', async () => {
  const { db, schema, close } = await createTestDb();
  const time = clock();
  const storage = new InMemoryObjectStorage('secret', time.now);
  const app = await buildTestApp({ db, media: { schema, storage }, now: time.now });
  const tenant = await seedTenant(db, schema);
  await seedStaff(db, schema, {
    companyId: tenant.companyId,
    staffId: 's-no-read',
    connectionId: tenant.connectionId,
    canRead: false,
  });
  const cookie = sessionCookie(tenant.companyId, 's-no-read', 'read');
  const bytes = Buffer.from('channel-scoped');
  try {
    const service = new (await import('../src/media/service.ts')).MediaService({
      db,
      schema,
      storage,
      sessionSecret: 'test-session-secret-'.padEnd(48, 'x'),
      now: time.now,
    });
    const ingest = await service.ingestInboundAttachment({
      companyId: tenant.companyId,
      conversationId: tenant.conversationId,
      connectionId: tenant.connectionId,
      bindingEpoch: tenant.bindingEpoch,
      externalChatId: tenant.externalChatId,
      messageId: tenant.messageId,
      externalMessageId: tenant.externalMessageId,
      externalAttachmentId: 'file-1',
      fileName: 'voice.ogg',
      declaredMimeType: 'audio/ogg',
      bytes,
    });
    assert.equal(ingest.accepted, true);
    const mediaId = ingest.mediaId;
    assert.ok(mediaId);

    const access = await app.inject({
      method: 'GET',
      url: `/api/v2/operator/media/${mediaId}/access`,
      headers: { cookie },
    });
    assert.equal(access.statusCode, 403);
    assert.equal(access.json().code, 'FORBIDDEN');
  } finally {
    await app.close();
    await close();
  }
});

test('SSRF guard blocks loopback, metadata and private destinations', async () => {
  const policy = { allowedHosts: ['files.example.com', 'cdn.example.com', 'localhost', 'internal.example.com'] };
  for (const url of [
    'https://127.0.0.1/a.png',
    'https://169.254.169.254/latest/meta-data/',
    'https://10.0.0.5/a.png',
    'https://192.168.1.10/a.png',
    'https://172.20.0.1/a.png',
    'https://[::1]/a.png',
    'https://localhost/a.png',
    'https://metadata.google.internal/a.png',
    'http://files.example.com/a.png',
    'https://user:pass@files.example.com/a.png',
    'https://evil.example.net/a.png',
  ]) {
    await assert.rejects(() => assertSafeRemoteUrl(url, policy), SsrfError, url);
  }

  await assert.rejects(
    () =>
      assertSafeRemoteUrl('https://files.example.com/a.png', {
        allowedHosts: ['files.example.com'],
        resolve: async () => ['127.0.0.1'],
      }),
    SsrfError,
  );
  await assert.rejects(
    () =>
      assertSafeRemoteUrl('https://files.example.com/a.png', {
        allowedHosts: ['files.example.com'],
        resolve: async () => ['10.1.2.3'],
      }),
    SsrfError,
  );

  const ok = await assertSafeRemoteUrl('https://cdn.example.com/a.png', {
    allowedHosts: ['cdn.example.com'],
    resolve: async () => ['93.184.216.34'],
  });
  assert.equal(ok.hostname, 'cdn.example.com');

  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('169.254.169.254'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('::1'), true);
  assert.equal(isPrivateAddress('2001:4860:4860::8888'), false);
});

test('S3 presigning is offline, carries a signature and expires', async () => {
  const time = clock();
  const storage = new S3ObjectStorage(
    {
      endpoint: 'https://s3.example.com',
      region: 'eu-central-1',
      bucket: 'media-bucket',
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secret',
      forcePathStyle: true,
    },
    time.now,
  );
  const put = await storage.presignPut('media/c1/med_1/a.png', { contentType: 'image/png', maxBytes: 1024, ttlSeconds: 60 });
  const parsed = new URL(put.url);
  assert.equal(parsed.origin, 'https://s3.example.com');
  assert.equal(parsed.pathname, '/media-bucket/media/c1/med_1/a.png');
  assert.equal(parsed.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.match(parsed.searchParams.get('X-Amz-Signature') ?? '', /^[a-f0-9]{64}$/);
  assert.equal(parsed.searchParams.get('X-Amz-Expires'), '60');
  assert.ok(parsed.searchParams.get('X-Amz-Credential')?.includes('AKIATEST'));
  assert.equal(await storage.resolvePresigned(put.url), null, 'PUT links are not download grants');

  const get = await storage.presignGet('media/c1/med_1/a.png', 1);
  assert.equal((await storage.resolvePresigned(get.url))?.key, 'media/c1/med_1/a.png');
  time.advance(2_000);
  assert.equal(await storage.resolvePresigned(get.url), null);

  const tampered = get.url.replace(/X-Amz-Signature=[a-f0-9]+/, 'X-Amz-Signature=' + '0'.repeat(64));
  assert.equal(await storage.resolvePresigned(tampered), null);

  const memory = new InMemoryObjectStorage('secret', time.now);
  const link = await memory.presignPut('k', { contentType: 'image/png', maxBytes: 10, ttlSeconds: 5 });
  const broken = link.url.replace(/token=[a-f0-9]+/, 'token=' + '0'.repeat(64));
  assert.equal(await memory.resolvePresigned(broken), null);
});
