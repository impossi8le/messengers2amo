import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createTestDb } from './helpers/db.ts';
import { seedTenant } from './helpers/fixtures.ts';
import { buildTestApp, sessionCookie } from './helpers/app.ts';
import { InMemoryObjectStorage, type ObjectStorage } from '../src/media/storage.ts';

const START = Date.parse('2026-01-01T00:00:00.000Z');

/** Bounds an inject so a regression cannot hang the suite forever. */
async function within<T>(promise: Promise<T>, ms = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`request did not settle within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function countingStream(bytes: Buffer): { stream: Readable; read: () => number } {
  let read = 0;
  const stream = new Readable({
    read() {
      read += bytes.byteLength;
      this.push(bytes);
      this.push(null);
    },
  });
  return { stream, read: () => read };
}

async function setup(options: { storage?: ObjectStorage; maxConcurrentUploads?: number } = {}) {
  const { db, schema, close } = await createTestDb();
  const storage = options.storage ?? new InMemoryObjectStorage('secret', () => START);
  const app = await buildTestApp({
    db,
    media: {
      schema,
      storage,
      limits:
        options.maxConcurrentUploads === undefined
          ? undefined
          : { maxConcurrentUploads: options.maxConcurrentUploads },
    },
    now: () => START,
  });
  const tenant = await seedTenant(db, schema);
  const cookie = sessionCookie(tenant.companyId, tenant.staffId, 'send');
  return { db, schema, storage, app, tenant, cookie, close };
}

test('an anonymous upload is rejected before any byte of the body is read', async () => {
  const { app, db, schema, cookie, close } = await setup();
  try {
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/media/uploads',
      headers: { cookie },
      payload: { idempotencyKey: 'guard-1', displayName: 'a.png', mimeType: 'image/png', sizeBytes: 1024 },
    });
    assert.equal(accepted.statusCode, 202);
    const uploadPath = accepted.json().uploadPath as string;

    const body = Buffer.alloc(1024, 0x41);
    const counted = countingStream(body);
    const response = await within(
      app.inject({
        method: 'PUT',
        url: uploadPath,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(body.byteLength),
        },
        payload: counted.stream,
      }),
    );

    assert.equal(response.statusCode, 401, 'authorization must be decided before the body');
    assert.equal((response.json() as { code: string }).code, 'UNAUTHENTICATED');
    assert.equal(counted.read(), 0, 'the upload body must never be consumed for an anonymous request');

    // Nothing was stored either.
    const { rows } = await db.query(`SELECT state FROM "${schema}".media_assets WHERE id=$1`, [
      accepted.json().asset.id,
    ]);
    assert.equal(rows[0].state, 'pending_upload');
  } finally {
    await app.close();
    await close();
  }
});

test('an oversized upload is refused from its declared length before reading', async () => {
  const { app, cookie, close } = await setup();
  try {
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/media/uploads',
      headers: { cookie },
      payload: { idempotencyKey: 'guard-2', displayName: 'b.png', mimeType: 'image/png', sizeBytes: 10 },
    });
    const uploadPath = accepted.json().uploadPath as string;

    const counted = countingStream(Buffer.alloc(10, 0x42));
    const response = await within(
      app.inject({
        method: 'PUT',
        url: uploadPath,
        headers: {
          cookie,
          'content-type': 'application/octet-stream',
          // Declared length far beyond the route limit.
          'content-length': String(200 * 1024 * 1024),
        },
        payload: counted.stream,
      }),
    );
    assert.equal(response.statusCode, 413);
    assert.equal(counted.read(), 0, 'an oversized declared body must not be read');
  } finally {
    await app.close();
    await close();
  }
});

test('an upload without a declared length is refused instead of buffered blindly', async () => {
  const { app, cookie, close } = await setup();
  try {
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v2/operator/media/uploads',
      headers: { cookie },
      payload: { idempotencyKey: 'guard-3', displayName: 'c.png', mimeType: 'image/png', sizeBytes: 4 },
    });
    const uploadPath = accepted.json().uploadPath as string;
    // A stream payload carries no content-length: the length is only known at the end.
    const response = await within(
      app.inject({
        method: 'PUT',
        url: uploadPath,
        headers: { cookie, 'content-type': 'application/octet-stream' },
        payload: countingStream(Buffer.from('abcd')).stream,
      }),
    );
    assert.equal(response.statusCode, 411);
    assert.equal((response.json() as { code: string }).code, 'VALIDATION_FAILED');
  } finally {
    await app.close();
    await close();
  }
});

test('parallel uploads are bounded and the excess is refused retryably', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  let enteredAll: () => void = () => undefined;
  const bothIn = new Promise<void>((resolve) => {
    enteredAll = resolve;
  });

  const inner = new InMemoryObjectStorage('secret', () => START);
  const slow: ObjectStorage = {
    put: async (key, body, contentType) => {
      entered += 1;
      if (entered === 2) enteredAll();
      await gate;
      return inner.put(key, body, contentType);
    },
    get: (key) => inner.get(key),
    head: (key) => inner.head(key),
    presignPut: (key, options) => inner.presignPut(key, options),
    presignGet: (key, ttl) => inner.presignGet(key, ttl),
    resolvePresigned: (url) => inner.resolvePresigned(url),
    remove: (key) => inner.remove(key),
  };

  const { app, cookie, close } = await setup({ storage: slow, maxConcurrentUploads: 2 });
  try {
    const ids: string[] = [];
    for (const index of [1, 2, 3]) {
      const accepted = await app.inject({
        method: 'POST',
        url: '/api/v2/operator/media/uploads',
        headers: { cookie },
        payload: {
          idempotencyKey: `parallel-${index}`,
          displayName: `p${index}.png`,
          mimeType: 'image/png',
          sizeBytes: 4,
        },
      });
      ids.push(accepted.json().asset.id as string);
    }

    const put = (id: string) =>
      app.inject({
        method: 'PUT',
        url: `/api/v2/media/${id}/content`,
        headers: { cookie, 'content-type': 'application/octet-stream' },
        payload: Buffer.from('abcd'),
      });

    const first = put(ids[0]!);
    const second = put(ids[1]!);
    await bothIn;

    const third = await within(put(ids[2]!), 2_000);
    assert.equal(third.statusCode, 429, 'a third concurrent upload must be refused');
    const body = third.json() as { code: string; retryable: boolean };
    assert.equal(body.code, 'RATE_LIMITED');
    assert.equal(body.retryable, true);
    assert.ok(third.headers['retry-after']);

    release();
    const settled = await Promise.all([first, second]);
    assert.deepEqual(
      settled.map((response) => response.statusCode),
      [202, 202],
    );

    // The cap is released again.
    const after = await put(ids[2]!);
    assert.equal(after.statusCode, 202);
  } finally {
    release();
    await app.close();
    await close();
  }
});
