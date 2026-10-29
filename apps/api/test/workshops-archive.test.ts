import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { seedTenant } from './helpers/fixtures.ts';
import { InMemoryObjectStorage } from '../src/media/storage.ts';
import { MediaService } from '../src/media/service.ts';
import { TEST_SESSION_SECRET } from './helpers/app.ts';
import { ArchiveService, type ArchiveIndexPort } from '../src/workshops/archive.ts';

const START = Date.parse('2026-01-01T00:00:00.000Z');

type FakePort = ArchiveIndexPort & { calls: { attachmentId: string; contractRef: string }[] };

function fakePort(
  outcome: 'acknowledged' | 'unknown' | 'error' = 'acknowledged',
): FakePort {
  const calls: { attachmentId: string; contractRef: string }[] = [];
  return {
    calls,
    async deliver(input) {
      calls.push({ attachmentId: input.attachmentId, contractRef: input.contractRef });
      if (outcome === 'acknowledged') return { outcome: 'acknowledged', ackRef: `ack-${input.attachmentId}` };
      if (outcome === 'unknown') return { outcome: 'unknown', reason: 'timeout' };
      return { outcome: 'error', reason: 'rejected' };
    },
  };
}

function mediaFor(db: Parameters<typeof seedTenant>[0], schema: string, storage: InMemoryObjectStorage) {
  return new MediaService({ db, schema, storage, sessionSecret: TEST_SESSION_SECRET, now: () => START });
}

async function ingest(
  db: Parameters<typeof seedTenant>[0],
  schema: string,
  storage: InMemoryObjectStorage,
  tenant: Awaited<ReturnType<typeof seedTenant>>,
  externalAttachmentId: string,
) {
  return mediaFor(db, schema, storage).ingestInboundAttachment({
    companyId: tenant.companyId,
    conversationId: tenant.conversationId,
    connectionId: tenant.connectionId,
    bindingEpoch: tenant.bindingEpoch,
    externalChatId: tenant.externalChatId,
    messageId: tenant.messageId,
    externalMessageId: tenant.externalMessageId,
    externalAttachmentId,
    fileName: 'report.pdf',
    declaredMimeType: 'application/pdf',
    bytes: Buffer.from('pdf-bytes'),
  });
}

/** Fails the test if any query addresses a schema other than the isolated one. */
function guardedDb<T extends { query: (...args: never[]) => unknown }>(db: T, schema: string) {
  const foreign: string[] = [];
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'query') {
        return async (text: string, params?: unknown[]) => {
          for (const match of String(text).matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+"([A-Za-z0-9_]+)"\s*\./g)) {
            if (match[1] !== schema) foreign.push(match[1]!);
          }
          return (target.query as (t: string, p?: unknown[]) => unknown)(text, params);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: proxy as T, foreign };
}

test('an object stored in S3 is not an acknowledged archive index', async () => {
  const { db, schema, close } = await createTestDb();
  const storage = new InMemoryObjectStorage('secret', () => START);
  try {
    const tenant = await seedTenant(db, schema);
    const ingested = await ingest(db, schema, storage, tenant, 'att-archive-1');
    const port = fakePort();
    const guarded = guardedDb(db, schema);
    const archive = new ArchiveService({ db: guarded.db, schema, archiveIndex: port });

    const job = await archive.createHandoff({ companyId: tenant.companyId, attachmentId: ingested.attachmentId });
    assert.equal(job.state, 'pending');
    assert.equal(job.deliveryEnabled, false);
    assert.equal(job.contractRef, null);

    const attachment = await db.query<{ storage_state: string; archive_status: string; s3_key: string }>(
      `SELECT storage_state, archive_status, s3_key FROM "${schema}".attachments WHERE id=$1`,
      [ingested.attachmentId],
    );
    assert.equal(attachment.rows[0]?.storage_state, 'verified');
    assert.equal(attachment.rows[0]?.archive_status, 'pending');
    assert.ok(attachment.rows[0]?.s3_key);

    // Handoff is off before the contract is confirmed: no adapter call at all.
    const delivery = await archive.indexAttachment({ companyId: tenant.companyId, jobId: job.id });
    assert.equal(delivery.indexed, false);
    assert.equal(delivery.reason, 'contract_missing');
    assert.equal(port.calls.length, 0);
    assert.deepEqual(guarded.foreign, []);
  } finally {
    await close();
  }
});

test('the archive index is only delivered after contract and acknowledgement', async () => {
  const { db, schema, close } = await createTestDb();
  const storage = new InMemoryObjectStorage('secret', () => START);
  try {
    const tenant = await seedTenant(db, schema);
    const ingested = await ingest(db, schema, storage, tenant, 'att-archive-2');
    const port = fakePort('acknowledged');
    const archive = new ArchiveService({
      db,
      schema,
      archiveIndex: port,
      contractRef: 'archive-contract-v1',
    });
    const job = await archive.createHandoff({ companyId: tenant.companyId, attachmentId: ingested.attachmentId });
    assert.equal(job.deliveryEnabled, true);

    // The index is registered through the adapter port; only its acknowledgement
    // makes the attachment indexed.
    const first = await archive.indexAttachment({ companyId: tenant.companyId, jobId: job.id });
    assert.equal(first.indexed, true);
    assert.equal(first.reason, 'indexed');
    assert.deepEqual(port.calls, [{ attachmentId: ingested.attachmentId, contractRef: 'archive-contract-v1' }]);

    const stored = await db.query<{ state: string; archive_status: string; index_ack_ref: string }>(
      `SELECT j.state, a.archive_status, a.index_ack_ref
         FROM "${schema}".archive_handoff_jobs j
         JOIN "${schema}".attachments a ON a.company_id=j.company_id AND a.id=j.attachment_id
        WHERE j.id=$1`,
      [job.id],
    );
    assert.equal(stored.rows[0]?.state, 'indexed');
    assert.equal(stored.rows[0]?.archive_status, 'indexed');
    assert.match(String(stored.rows[0]?.index_ack_ref), /^ack-/);

    const again = await archive.indexAttachment({ companyId: tenant.companyId, jobId: job.id });
    assert.equal(again.indexed, true);
    assert.equal(again.reason, 'already_indexed');
    assert.equal(port.calls.length, 1, 'a confirmed index is never submitted twice');
  } finally {
    await close();
  }
});

test('an unknown index outcome is recorded as unknown and is not retried blindly', async () => {
  const { db, schema, close } = await createTestDb();
  const storage = new InMemoryObjectStorage('secret', () => START);
  try {
    const tenant = await seedTenant(db, schema);
    const ingested = await ingest(db, schema, storage, tenant, 'att-archive-3');
    const port = fakePort('unknown');
    const archive = new ArchiveService({
      db,
      schema,
      archiveIndex: port,
      contractRef: 'archive-contract-v1',
    });
    const job = await archive.createHandoff({ companyId: tenant.companyId, attachmentId: ingested.attachmentId });

    const unknown = await archive.indexAttachment({ companyId: tenant.companyId, jobId: job.id });
    assert.equal(unknown.indexed, false);
    assert.equal(unknown.reason, 'index_unknown');
    assert.equal(port.calls.length, 1);

    const state = await db.query<{ state: string; archive_status: string }>(
      `SELECT j.state, a.archive_status
         FROM "${schema}".archive_handoff_jobs j
         JOIN "${schema}".attachments a ON a.company_id=j.company_id AND a.id=j.attachment_id
        WHERE j.id=$1`,
      [job.id],
    );
    assert.equal(state.rows[0]?.state, 'unknown');
    assert.equal(state.rows[0]?.archive_status, 'unknown');

    const retry = await archive.indexAttachment({ companyId: tenant.companyId, jobId: job.id });
    assert.equal(retry.indexed, false);
    assert.equal(retry.reason, 'index_unknown');
    assert.equal(port.calls.length, 1, 'unknown is reconciled, never re-sent as a blind duplicate');
  } finally {
    await close();
  }
});

test('one attachment stays linked to several leads and CRM deletion never removes the original', async () => {
  const { db, schema, close } = await createTestDb();
  const storage = new InMemoryObjectStorage('secret', () => START);
  try {
    const tenant = await seedTenant(db, schema);
    await db.query(`INSERT INTO "${schema}".crm_accounts(company_id,id,state) VALUES ('c1','acc1','active')`);
    const ingested = await ingest(db, schema, storage, tenant, 'att-archive-4');
    const archive = new ArchiveService({ db, schema, archiveIndex: fakePort(), contractRef: null });

    await archive.linkAttachmentToLead({
      companyId: 'c1',
      attachmentId: ingested.attachmentId,
      accountId: 'acc1',
      leadId: 'lead-1',
    });
    await archive.linkAttachmentToLead({
      companyId: 'c1',
      attachmentId: ingested.attachmentId,
      accountId: 'acc1',
      leadId: 'lead-2',
    });
    assert.deepEqual(
      (await archive.listAttachmentLeads('c1', ingested.attachmentId)).map((link) => link.leadId).sort(),
      ['lead-1', 'lead-2'],
    );

    const before = await db.query<{ s3_key: string; storage_state: string }>(
      `SELECT s3_key, storage_state FROM "${schema}".attachments WHERE id=$1`,
      [ingested.attachmentId],
    );
    const s3Key = before.rows[0]!.s3_key;
    assert.ok(await storage.get(s3Key));

    await archive.observeLeadDeleted({ companyId: 'c1', accountId: 'acc1', leadId: 'lead-1' });
    const links = await archive.listAttachmentLeads('c1', ingested.attachmentId);
    assert.deepEqual(
      links.map((link) => [link.leadId, link.linkState]).sort(),
      [
        ['lead-1', 'deleted'],
        ['lead-2', 'active'],
      ],
    );

    const after = await db.query<{ s3_key: string; storage_state: string }>(
      `SELECT s3_key, storage_state FROM "${schema}".attachments WHERE id=$1`,
      [ingested.attachmentId],
    );
    assert.equal(after.rowCount, 1, 'CRM delete must not delete the attachment row');
    assert.equal(after.rows[0]?.storage_state, 'verified');
    assert.ok(await storage.get(s3Key), 'CRM delete must not delete the stored object');

    await archive.observeLeadMerged({
      companyId: 'c1',
      accountId: 'acc1',
      leadId: 'lead-2',
      mergedIntoLeadId: 'lead-9',
    });
    const merged = (await archive.listAttachmentLeads('c1', ingested.attachmentId)).find(
      (link) => link.leadId === 'lead-2',
    );
    assert.equal(merged?.linkState, 'merged');
    assert.equal(merged?.mergedIntoLeadId, 'lead-9');
  } finally {
    await close();
  }
});
