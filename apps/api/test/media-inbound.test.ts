import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { seedTenant } from './helpers/fixtures.ts';
import { buildTestApp, sessionCookie, TEST_SESSION_SECRET } from './helpers/app.ts';
import { InMemoryObjectStorage } from '../src/media/storage.ts';
import { MediaService } from '../src/media/service.ts';

const START = Date.parse('2026-01-01T00:00:00.000Z');

function makeService(db: Parameters<typeof seedTenant>[0], schema: string, storage: InMemoryObjectStorage, extra: Record<string, unknown> = {}) {
  return new MediaService({
    db,
    schema,
    storage,
    sessionSecret: TEST_SESSION_SECRET,
    now: () => START,
    ...extra,
  });
}

function inboundInput(tenant: Awaited<ReturnType<typeof seedTenant>>, overrides: Record<string, unknown> = {}) {
  return {
    companyId: tenant.companyId,
    conversationId: tenant.conversationId,
    connectionId: tenant.connectionId,
    bindingEpoch: tenant.bindingEpoch,
    externalChatId: tenant.externalChatId,
    messageId: tenant.messageId,
    externalMessageId: tenant.externalMessageId,
    externalAttachmentId: 'att-ext-1',
    fileName: 'report.pdf',
    declaredMimeType: 'application/pdf',
    bytes: Buffer.from('pdf-bytes'),
    ...overrides,
  };
}

test('inbound attachment is stored once and redelivery is idempotent', async () => {
  const { db, schema, close } = await createTestDb();
  const storage = new InMemoryObjectStorage('secret', () => START);
  const service = makeService(db, schema, storage);
  const tenant = await seedTenant(db, schema);
  try {
    const first = await service.ingestInboundAttachment(inboundInput(tenant));
    assert.equal(first.accepted, true);
    assert.equal(first.duplicate, false);
    assert.ok(first.mediaId);
    assert.match(first.attachmentId, /^att_[a-f0-9]{32}$/);

    const attachment = await db.query(
      `SELECT storage_state, archive_status, s3_key, sha256, byte_size, original_name, mime_type
         FROM "${schema}".attachments WHERE company_id=$1 AND id=$2`,
      [tenant.companyId, first.attachmentId],
    );
    assert.equal(attachment.rows[0].storage_state, 'verified');
    assert.equal(attachment.rows[0].archive_status, 'pending');
    assert.match(attachment.rows[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(attachment.rows[0].original_name, 'report.pdf');
    assert.equal(Number(attachment.rows[0].byte_size), 9);

    const media = await db.query(`SELECT state, sha256, byte_size FROM "${schema}".media_assets WHERE id=$1`, [first.mediaId]);
    assert.equal(media.rows[0].state, 'ready');
    assert.equal(media.rows[0].sha256, attachment.rows[0].sha256);

    const jobs = await db.query(
      `SELECT state, delivery_enabled, contract_ref FROM "${schema}".archive_handoff_jobs WHERE attachment_id=$1`,
      [first.attachmentId],
    );
    assert.equal(jobs.rowCount, 1);
    assert.equal(jobs.rows[0].state, 'pending');
    assert.equal(jobs.rows[0].delivery_enabled, false);
    assert.equal(jobs.rows[0].contract_ref, null);

    const second = await service.ingestInboundAttachment(inboundInput(tenant));
    assert.equal(second.duplicate, true);
    assert.equal(second.attachmentId, first.attachmentId);
    assert.equal(second.mediaId, first.mediaId);

    const counts = await db.query(
      `SELECT (SELECT count(*)::int FROM "${schema}".attachments) AS attachments,
              (SELECT count(*)::int FROM "${schema}".media_assets) AS media,
              (SELECT count(*)::int FROM "${schema}".archive_handoff_jobs) AS jobs,
              (SELECT count(*)::int FROM "${schema}".messages) AS messages`,
    );
    assert.deepEqual(counts.rows[0], { attachments: 1, media: 1, jobs: 1, messages: 1 });
  } finally {
    await close();
  }
});

test('forbidden inbound mime keeps an honest placeholder and the message', async () => {
  const { db, schema, close } = await createTestDb();
  const storage = new InMemoryObjectStorage('secret', () => START);
  const service = makeService(db, schema, storage);
  const tenant = await seedTenant(db, schema);
  try {
    const result = await service.ingestInboundAttachment(
      inboundInput(tenant, {
        externalAttachmentId: 'att-evil',
        fileName: 'invoice.exe',
        declaredMimeType: 'application/x-msdownload',
        bytes: Buffer.from('MZ'),
      }),
    );
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'mime_not_allowed');
    assert.equal(result.mediaId, null);

    const attachment = await db.query(
      `SELECT storage_state, archive_status, mime_type, original_name, s3_key, sha256
         FROM "${schema}".attachments WHERE id=$1`,
      [result.attachmentId],
    );
    assert.equal(attachment.rowCount, 1, 'placeholder attachment must exist');
    assert.equal(attachment.rows[0].storage_state, 'failed');
    assert.equal(attachment.rows[0].archive_status, 'failed');
    assert.equal(attachment.rows[0].mime_type, 'application/octet-stream');
    assert.match(attachment.rows[0].original_name, /invoice\.exe/);
    assert.equal(attachment.rows[0].s3_key, null);
    assert.equal(attachment.rows[0].sha256, null);

    const messages = await db.query(`SELECT count(*)::int AS c FROM "${schema}".messages`);
    assert.equal(messages.rows[0].c, 1);
    const stored = await storage.get(`media/${tenant.companyId}/${result.attachmentId}/invoice.exe`);
    assert.equal(stored, null);
  } finally {
    await close();
  }
});

test('oversized and sha-mismatched inbound attachments are quarantined without losing the message', async () => {
  const { db, schema, close } = await createTestDb();
  const storage = new InMemoryObjectStorage('secret', () => START);
  const service = makeService(db, schema, storage, { limits: { maxFileBytes: 4 } });
  const tenant = await seedTenant(db, schema);
  try {
    const tooLarge = await service.ingestInboundAttachment(
      inboundInput(tenant, { externalAttachmentId: 'att-big', bytes: Buffer.from('0123456789') }),
    );
    assert.equal(tooLarge.accepted, false);
    assert.equal(tooLarge.reason, 'too_large');

    const badSha = await service.ingestInboundAttachment(
      inboundInput(tenant, { externalAttachmentId: 'att-sha', bytes: Buffer.from('abc'), declaredSha256: 'f'.repeat(64) }),
    );
    assert.equal(badSha.accepted, false);
    assert.equal(badSha.reason, 'sha_mismatch');

    const rows = await db.query(`SELECT storage_state, sha256 FROM "${schema}".attachments ORDER BY id`);
    assert.equal(rows.rowCount, 2);
    for (const row of rows.rows) {
      assert.equal(row.storage_state, 'failed');
      assert.equal(row.sha256, null);
    }
  } finally {
    await close();
  }
});

test('remote attachment URLs are SSRF-guarded and never fetched from private hosts', async () => {
  const { db, schema, close } = await createTestDb();
  const storage = new InMemoryObjectStorage('secret', () => START);
  let fetched = 0;
  const service = makeService(db, schema, storage, {
    remoteFetch: {
      allowedHosts: ['cdn.example.com'],
      resolve: async () => ['127.0.0.1'],
    },
  });
  const tenant = await seedTenant(db, schema);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched += 1;
    return new Response(Buffer.from('remote-bytes'));
  }) as typeof fetch;
  try {
    const blocked = await service.ingestInboundAttachment(
      inboundInput(tenant, { externalAttachmentId: 'att-remote-private', bytes: null, remoteUrl: 'https://cdn.example.com/a.pdf' }),
    );
    assert.equal(blocked.accepted, false);
    assert.equal(blocked.reason, 'remote_blocked');
    assert.equal(fetched, 0, 'no network request may happen for a private resolution');

    const disallowed = await service.ingestInboundAttachment(
      inboundInput(tenant, { externalAttachmentId: 'att-remote-other', bytes: null, remoteUrl: 'https://169.254.169.254/latest' }),
    );
    assert.equal(disallowed.accepted, false);
    assert.equal(disallowed.reason, 'remote_blocked');
    assert.equal(fetched, 0);

    const noPolicy = makeService(db, schema, storage);
    const disabled = await noPolicy.ingestInboundAttachment(
      inboundInput(tenant, { externalAttachmentId: 'att-remote-none', bytes: null, remoteUrl: 'https://cdn.example.com/a.pdf' }),
    );
    assert.equal(disabled.accepted, false);
    assert.equal(disabled.reason, 'remote_blocked');
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await close();
  }
});

test('archive handoff stays disabled until the archive contract is confirmed', async () => {
  const { db, schema, close } = await createTestDb();
  const storage = new InMemoryObjectStorage('secret', () => START);
  const service = makeService(db, schema, storage);
  const tenant = await seedTenant(db, schema);
  try {
    const ingest = await service.ingestInboundAttachment(inboundInput(tenant));
    const job = await db.query(`SELECT id FROM "${schema}".archive_handoff_jobs WHERE attachment_id=$1`, [ingest.attachmentId]);
    const jobId = job.rows[0].id;

    await assert.rejects(
      () => service.confirmArchiveIndex(tenant.companyId, jobId, 'ack-1'),
      (error: unknown) => (error as { code?: string }).code === 'CAPABILITY_BLOCKED',
    );
    const unchanged = await db.query(`SELECT state, delivery_enabled FROM "${schema}".archive_handoff_jobs WHERE id=$1`, [jobId]);
    assert.equal(unchanged.rows[0].state, 'pending');
    assert.equal(unchanged.rows[0].delivery_enabled, false);

    const contracted = makeService(db, schema, storage, { archiveContractRef: 'archive-contract-v1' });
    const ingest2 = await contracted.ingestInboundAttachment(
      inboundInput(tenant, { externalAttachmentId: 'att-contracted' }),
    );
    const job2 = await db.query(
      `SELECT id, delivery_enabled, contract_ref FROM "${schema}".archive_handoff_jobs WHERE attachment_id=$1`,
      [ingest2.attachmentId],
    );
    assert.equal(job2.rows[0].delivery_enabled, true);
    assert.equal(job2.rows[0].contract_ref, 'archive-contract-v1');
    await contracted.confirmArchiveIndex(tenant.companyId, job2.rows[0].id, 'ack-2');

    const indexed = await db.query(
      `SELECT j.state, a.archive_status, a.index_ack_ref
         FROM "${schema}".archive_handoff_jobs j
         JOIN "${schema}".attachments a ON a.company_id=j.company_id AND a.id=j.attachment_id
        WHERE j.id=$1`,
      [job2.rows[0].id],
    );
    assert.equal(indexed.rows[0].state, 'indexed');
    assert.equal(indexed.rows[0].archive_status, 'indexed');
    assert.equal(indexed.rows[0].index_ack_ref, 'ack-2');
  } finally {
    await close();
  }
});

test('attachment reply accepts only ready media and enforces message limits', async () => {
  const { db, schema, close } = await createTestDb();
  const storage = new InMemoryObjectStorage('secret', () => START);
  const service = makeService(db, schema, storage, { limits: { maxFileBytes: 64, maxMessageBytes: 16 } });
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
  const app = await buildTestApp({
    db,
    media: { schema, storage, limits: { maxFileBytes: 64, maxMessageBytes: 16 } },
    now: () => START,
  });
  const cookie = sessionCookie(tenant.companyId, tenant.staffId, 'send');
  try {
    const small = await service.requestUpload(tenant.companyId, {
      idempotencyKey: 'reply-small',
      displayName: 'small.png',
      mimeType: 'image/png',
      sizeBytes: 4,
    });
    await service.uploadBytes(tenant.companyId, small.asset.id, Buffer.from('abcd'));

    const pending = await service.requestUpload(tenant.companyId, {
      idempotencyKey: 'reply-pending',
      displayName: 'pending.png',
      mimeType: 'image/png',
      sizeBytes: 4,
    });

    const reply = (mediaIds: string[], overrides: Record<string, unknown> = {}) => ({
      idempotencyKey: 'reply-1',
      snapshotId: 'snap-1',
      expectedAssignmentVersion: 0,
      selectedObligations: [],
      mediaIds,
      caption: '',
      deadline: new Date(START + 60_000).toISOString(),
      ...overrides,
    });

    const accepted = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/work-items/${tenant.workItemId}/attachment-reply`,
      headers: { cookie },
      payload: reply([small.asset.id]),
    });
    assert.equal(accepted.statusCode, 202);
    const operation = accepted.json();
    assert.equal(operation.state, 'accepted');
    assert.equal(operation.coverage, 'unconfirmed');
    assert.equal(operation.providerMessageId, null);

    const repeat = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/work-items/${tenant.workItemId}/attachment-reply`,
      headers: { cookie },
      payload: reply([small.asset.id]),
    });
    assert.equal(repeat.statusCode, 202);
    assert.equal(repeat.json().id, operation.id);
    const ops = await db.query(`SELECT count(*)::int AS c FROM "${schema}".send_operations`);
    assert.equal(ops.rows[0].c, 1);

    const notReady = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/work-items/${tenant.workItemId}/attachment-reply`,
      headers: { cookie },
      payload: reply([pending.asset.id], { idempotencyKey: 'reply-2' }),
    });
    assert.equal(notReady.statusCode, 409);

    const foreign = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/work-items/${other.workItemId}/attachment-reply`,
      headers: { cookie },
      payload: reply([small.asset.id], { idempotencyKey: 'reply-3' }),
    });
    assert.equal(foreign.statusCode, 404);

    const big = await service.requestUpload(tenant.companyId, {
      idempotencyKey: 'reply-big',
      displayName: 'big.png',
      mimeType: 'image/png',
      sizeBytes: 20,
    });
    await service.uploadBytes(tenant.companyId, big.asset.id, Buffer.alloc(20, 7));
    const tooLarge = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/work-items/${tenant.workItemId}/attachment-reply`,
      headers: { cookie },
      payload: reply([big.asset.id], { idempotencyKey: 'reply-4' }),
    });
    assert.equal(tooLarge.statusCode, 413);

    const unauthenticated = await app.inject({
      method: 'POST',
      url: `/api/v2/operator/work-items/${tenant.workItemId}/attachment-reply`,
      payload: reply([small.asset.id], { idempotencyKey: 'reply-5' }),
    });
    assert.equal(unauthenticated.statusCode, 401);
  } finally {
    await app.close();
    await close();
  }
});

test('an unknown provider message id is stored as unknown instead of breaking ingest', async () => {
  const { db, schema, close } = await createTestDb();
  const storage = new InMemoryObjectStorage('secret', () => START);
  const service = makeService(db, schema, storage);
  const tenant = await seedTenant(db, schema);
  try {
    const result = await service.ingestInboundAttachment(
      inboundInput(tenant, { externalMessageId: 'not-the-provider-id' }),
    );
    assert.equal(result.accepted, true);
    const row = await db.query(
      `SELECT external_message_id FROM "${schema}".attachments WHERE id=$1`,
      [result.attachmentId],
    );
    assert.equal(row.rows[0].external_message_id, null);
  } finally {
    await close();
  }
});
