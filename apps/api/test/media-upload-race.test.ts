import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { seedTenant } from './helpers/fixtures.ts';
import { TEST_SESSION_SECRET } from './helpers/app.ts';
import { InMemoryObjectStorage, sha256Hex, type ObjectStorage } from '../src/media/storage.ts';
import { MediaService, MediaError } from '../src/media/service.ts';

const START = Date.parse('2026-01-01T00:00:00.000Z');

/**
 * Defect 1: the object is written before the CAS transition, so two concurrent
 * uploads of different same-size payloads leave the DB hash of the winner pointing
 * at the loser's bytes. The loser's `put` is gated until the winner has committed
 * `ready`, which makes the race deterministic.
 */
test('a losing concurrent upload never overwrites the stored bytes of the winner', async () => {
  const { db, schema, close } = await createTestDb();
  const time = { now: () => START };
  const inner = new InMemoryObjectStorage('secret', time.now);

  const bytesA = Buffer.from('AAAAAAAA');
  const bytesB = Buffer.from('BBBBBBBB');
  const shaA = sha256Hex(bytesA);
  const shaB = sha256Hex(bytesB);

  let releaseLoser: () => void = () => undefined;
  const winnerCommitted = new Promise<void>((resolve) => {
    releaseLoser = resolve;
  });
  let loserWriteStarted: () => void = () => undefined;
  const loserStarted = new Promise<void>((resolve) => {
    loserWriteStarted = resolve;
  });

  // The winner waits until the loser has also passed its `pending_upload` check,
  // then commits first; the loser's write is held back until that commit.
  const gated: ObjectStorage = {
    put: async (key, body, contentType) => {
      const digest = sha256Hex(body);
      if (digest === shaA) {
        await loserStarted;
      } else if (digest === shaB) {
        loserWriteStarted();
        await winnerCommitted;
      }
      return inner.put(key, body, contentType);
    },
    get: (key) => inner.get(key),
    head: (key) => inner.head(key),
    presignPut: (key, options) => inner.presignPut(key, options),
    presignGet: (key, ttl) => inner.presignGet(key, ttl),
    resolvePresigned: (url) => inner.resolvePresigned(url),
    remove: (key) => inner.remove(key),
  };

  const service = new MediaService({
    db,
    schema,
    storage: gated,
    sessionSecret: TEST_SESSION_SECRET,
    now: time.now,
  });
  const tenant = await seedTenant(db, schema);

  try {
    const accepted = await service.requestUpload(tenant.companyId, {
      idempotencyKey: 'race-upload',
      displayName: 'race.png',
      mimeType: 'image/png',
      sizeBytes: bytesA.byteLength,
    });
    const mediaId = accepted.asset.id;

    const winner = service.uploadBytes(tenant.companyId, mediaId, bytesA);
    const loser = service.uploadBytes(tenant.companyId, mediaId, bytesB);
    const winnerAsset = await winner;
    assert.equal(winnerAsset.state, 'ready');
    assert.equal(winnerAsset.sha256, shaA);
    releaseLoser();

    await assert.rejects(loser, (error: unknown) => error instanceof MediaError && error.code === 'VERSION_CONFLICT');

    const row = await db.query<{ sha256: string; storage_key: string; byte_size: string }>(
      `SELECT sha256, storage_key, byte_size FROM "${schema}".media_assets WHERE company_id=$1 AND id=$2`,
      [tenant.companyId, mediaId],
    );
    assert.equal(row.rows[0]?.sha256, shaA);
    assert.equal(Number(row.rows[0]?.byte_size), bytesA.byteLength);

    const stored = await inner.get(row.rows[0]!.storage_key);
    assert.ok(stored, 'the object referenced by the DB must exist');
    assert.equal(
      sha256Hex(stored),
      row.rows[0]!.sha256,
      'bytes in storage must match the hash recorded in the database',
    );
    assert.equal(sha256Hex(stored), shaA);
  } finally {
    await close();
  }
});
