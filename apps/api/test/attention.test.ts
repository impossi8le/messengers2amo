import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { seedAttention, seedInboundMessage, seedEdit, seedSendOperation, countRows } from './helpers/attention.ts';
import {
  openIncoming,
  editIncoming,
  captureSnapshot,
  markConversationRead,
  confirmSendCoverage,
  recordSendOutcome,
  revokeProvisionalSent,
  listObligations,
} from '../src/repo/attention.ts';
import { isSubstantialEdit, waitingSince } from '../src/domain/attention.ts';

const deps = (schema: string) => ({ schema });

test('new inbound opens exactly one obligation and replays idempotently', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedAttention(db, schema);
    await seedInboundMessage(db, schema, { companyId: fx.companyId, conversationId: fx.conversationId, messageId: 'm1' });

    const first = await openIncoming(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      messageId: 'm1',
      contentVersion: 0,
    });
    assert.equal(first.created, true);
    assert.equal(first.obligation.state, 'open');
    assert.equal(first.obligation.attentionSeq, 1);

    const replay = await openIncoming(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      messageId: 'm1',
      contentVersion: 0,
    });
    assert.equal(replay.created, false);
    assert.equal(replay.obligation.id, first.obligation.id);
    assert.equal(await countRows(db, schema, 'attention_obligations', 'company_id=$1', [fx.companyId]), 1);
  } finally {
    await close();
  }
});

test('reading a conversation never closes the obligation or resets waiting_since', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedAttention(db, schema);
    await seedInboundMessage(db, schema, { companyId: fx.companyId, conversationId: fx.conversationId, messageId: 'm1' });
    const opened = await openIncoming(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      messageId: 'm1',
      contentVersion: 0,
    });

    await markConversationRead(db, deps(schema), {
      companyId: fx.companyId,
      conversationId: fx.conversationId,
      staffId: fx.staffId,
      attentionSeq: opened.obligation.attentionSeq,
    });
    await markConversationRead(db, deps(schema), {
      companyId: fx.companyId,
      conversationId: fx.conversationId,
      staffId: fx.staffId,
      attentionSeq: opened.obligation.attentionSeq,
    });

    const after = await listObligations(db, deps(schema), { companyId: fx.companyId, workItemId: fx.workItemId });
    assert.equal(after.length, 1);
    assert.equal(after[0]?.state, 'open');
    assert.equal(after[0]?.openedAt, opened.obligation.openedAt);
    assert.equal(await countRows(db, schema, 'staff_read_marks', 'company_id=$1', [fx.companyId]), 1);
    const since = waitingSince(after);
    assert.equal(since?.toISOString(), new Date(opened.obligation.openedAt).toISOString());
  } finally {
    await close();
  }
});

test('snapshot is exact and a later inbound is not covered by it', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedAttention(db, schema);
    for (const id of ['m1', 'm2']) {
      await seedInboundMessage(db, schema, { companyId: fx.companyId, conversationId: fx.conversationId, messageId: id });
      await openIncoming(db, deps(schema), {
        companyId: fx.companyId,
        workItemId: fx.workItemId,
        messageId: id,
        contentVersion: 0,
      });
    }

    const snapshot = await captureSnapshot(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      actorId: fx.staffId,
    });
    assert.deepEqual(
      snapshot.items.map((item) => item.contentVersion),
      [0, 0],
    );
    assert.equal(snapshot.items.length, 2);

    // A new inbound arrives after the snapshot; the stored snapshot must not grow.
    await seedInboundMessage(db, schema, { companyId: fx.companyId, conversationId: fx.conversationId, messageId: 'm3' });
    const third = await openIncoming(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      messageId: 'm3',
      contentVersion: 0,
    });
    assert.equal(third.obligation.attentionSeq, 3);

    const { rows: stored } = await db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM "${schema}".reply_snapshot_items WHERE company_id=$1 AND snapshot_id=$2`,
      [fx.companyId, snapshot.snapshotId],
    );
    assert.equal(stored[0]?.c, 2);
    const { rows: sealed } = await db.query<{ sealed_at: Date | null }>(
      `SELECT sealed_at FROM "${schema}".reply_snapshots WHERE company_id=$1 AND id=$2`,
      [fx.companyId, snapshot.snapshotId],
    );
    assert.notEqual(sealed[0]?.sealed_at, null);

    // Confirmed send closes the two snapshot items only.
    await seedSendOperation(db, schema, {
      companyId: fx.companyId,
      operationId: 'op1',
      workItemId: fx.workItemId,
      conversationId: fx.conversationId,
      snapshotId: snapshot.snapshotId,
      actorId: fx.staffId,
    });
    const result = await confirmSendCoverage(db, deps(schema), { companyId: fx.companyId, operationId: 'op1' });
    assert.equal(result.covered.length, 2);
    assert.deepEqual(
      result.remaining.map((item) => item.obligationId),
      [third.obligation.id],
    );
  } finally {
    await close();
  }
});

test('substantial edit of an open obligation inherits opened_at and records supersession', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedAttention(db, schema);
    await seedInboundMessage(db, schema, {
      companyId: fx.companyId,
      conversationId: fx.conversationId,
      messageId: 'm1',
      content: { kind: 'text', text: 'сумма 100' },
    });
    const opened = await openIncoming(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      messageId: 'm1',
      contentVersion: 0,
    });

    await seedEdit(db, schema, {
      companyId: fx.companyId,
      messageId: 'm1',
      contentVersion: 1,
      content: { kind: 'text', text: 'сумма 250' },
    });
    const edited = await editIncoming(db, deps(schema), {
      companyId: fx.companyId,
      messageId: 'm1',
      contentVersion: 1,
      substantial: true,
    });

    assert.equal(edited.obligation.contentVersion, 1);
    assert.equal(edited.obligation.attentionSeq, 2);
    assert.equal(edited.obligation.openedAt, opened.obligation.openedAt);
    assert.equal(edited.obligation.supersedesId, opened.obligation.id);
    assert.equal(edited.superseded?.id, opened.obligation.id);
    assert.notEqual(edited.superseded?.state, 'open');
  } finally {
    await close();
  }
});

test('technical edit is not substantial and creates no new obligation', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedAttention(db, schema);
    await seedInboundMessage(db, schema, {
      companyId: fx.companyId,
      conversationId: fx.conversationId,
      messageId: 'm1',
      content: { kind: 'text', text: 'hello', edited_at: '2026-01-01T00:00:00Z' },
    });
    await openIncoming(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      messageId: 'm1',
      contentVersion: 0,
    });

    assert.equal(isSubstantialEdit({ kind: 'text', text: 'hello' }, { kind: 'text', text: 'hello', edited_at: 'x' }), false);
    assert.equal(isSubstantialEdit({ kind: 'text', text: 'hello' }, { kind: 'text', text: 'bye' }), true);

    await seedEdit(db, schema, {
      companyId: fx.companyId,
      messageId: 'm1',
      contentVersion: 1,
      content: { kind: 'text', text: 'hello', edited_at: '2026-01-02T00:00:00Z' },
    });
    const result = await editIncoming(db, deps(schema), {
      companyId: fx.companyId,
      messageId: 'm1',
      contentVersion: 1,
      substantial: false,
    });
    assert.equal(result.superseded, null);
    assert.equal(await countRows(db, schema, 'attention_obligations', 'company_id=$1', [fx.companyId]), 1);
  } finally {
    await close();
  }
});

test('editing an already answered message starts a fresh waiting cycle', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedAttention(db, schema);
    await seedInboundMessage(db, schema, {
      companyId: fx.companyId,
      conversationId: fx.conversationId,
      messageId: 'm1',
      content: { kind: 'text', text: 'адрес A' },
    });
    const opened = await openIncoming(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      messageId: 'm1',
      contentVersion: 0,
    });
    const snapshot = await captureSnapshot(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      actorId: fx.staffId,
    });
    assert.ok(snapshot.snapshotId, 'snapshot must be persisted before an operation is accepted');
    await seedSendOperation(db, schema, {
      companyId: fx.companyId,
      operationId: 'op1',
      workItemId: fx.workItemId,
      conversationId: fx.conversationId,
      snapshotId: snapshot.snapshotId,
      actorId: fx.staffId,
    });
    await confirmSendCoverage(db, deps(schema), { companyId: fx.companyId, operationId: 'op1' });

    await seedEdit(db, schema, {
      companyId: fx.companyId,
      messageId: 'm1',
      contentVersion: 1,
      content: { kind: 'text', text: 'адрес B' },
    });
    const edited = await editIncoming(db, deps(schema), {
      companyId: fx.companyId,
      messageId: 'm1',
      contentVersion: 1,
      substantial: true,
    });

    assert.equal(edited.obligation.state, 'open');
    assert.notEqual(edited.obligation.openedAt, opened.obligation.openedAt);
    assert.equal(edited.obligation.supersedesId, opened.obligation.id);
  } finally {
    await close();
  }
});

test('an old snapshot does not cover a substantial edit made after it', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedAttention(db, schema);
    await seedInboundMessage(db, schema, {
      companyId: fx.companyId,
      conversationId: fx.conversationId,
      messageId: 'm1',
      content: { kind: 'text', text: 'сумма 100' },
    });
    await openIncoming(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      messageId: 'm1',
      contentVersion: 0,
    });
    const snapshot = await captureSnapshot(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      actorId: fx.staffId,
    });
    assert.ok(snapshot.snapshotId);

    await seedEdit(db, schema, {
      companyId: fx.companyId,
      messageId: 'm1',
      contentVersion: 1,
      content: { kind: 'text', text: 'сумма 250' },
    });
    const edited = await editIncoming(db, deps(schema), {
      companyId: fx.companyId,
      messageId: 'm1',
      contentVersion: 1,
      substantial: true,
    });

    await seedSendOperation(db, schema, {
      companyId: fx.companyId,
      operationId: 'op-old',
      workItemId: fx.workItemId,
      conversationId: fx.conversationId,
      snapshotId: snapshot.snapshotId,
      actorId: fx.staffId,
    });
    const result = await confirmSendCoverage(db, deps(schema), { companyId: fx.companyId, operationId: 'op-old' });
    assert.deepEqual(result.covered, [], 'the superseded version must not be covered');
    assert.deepEqual(
      result.remaining.map((item) => item.obligationId),
      [edited.obligation.id],
      'the new version stays outstanding',
    );
  } finally {
    await close();
  }
});

test('a delivered receipt blocks withdrawal of a provisional sent', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedAttention(db, schema);
    await seedInboundMessage(db, schema, { companyId: fx.companyId, conversationId: fx.conversationId, messageId: 'm1' });
    await openIncoming(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      messageId: 'm1',
      contentVersion: 0,
    });
    const snapshot = await captureSnapshot(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      actorId: fx.staffId,
    });
    assert.ok(snapshot.snapshotId);
    await seedSendOperation(db, schema, {
      companyId: fx.companyId,
      operationId: 'op1',
      workItemId: fx.workItemId,
      conversationId: fx.conversationId,
      snapshotId: snapshot.snapshotId,
      actorId: fx.staffId,
    });
    await confirmSendCoverage(db, deps(schema), { companyId: fx.companyId, operationId: 'op1' });

    await db.query(`UPDATE "${schema}".send_operations SET provider_message_id='ext-m1' WHERE company_id=$1 AND id='op1'`, [
      fx.companyId,
    ]);
    await db.query(
      `INSERT INTO "${schema}".send_attempts
         (company_id,id,operation_id,attempt_no,dispatch_fence,state,provider_message_id)
       VALUES ($1,'att1','op1',1,1,'sent','ext-m1')`,
      [fx.companyId],
    );
    await db.query(
      `INSERT INTO "${schema}".provider_receipt_evidence
         (company_id,id,connection_id,binding_epoch,external_chat_id,provider_message_id,
          kind,status,evidence_key,occurred_at,received_at,observed_at)
       VALUES ($1,'ev1','conn1',1,$2,'ext-m1','message.delivery_observed','delivered','ev-key-1',
               clock_timestamp(),clock_timestamp(),clock_timestamp())`,
      [fx.companyId, `chat-${fx.conversationId}`],
    );
    await db.query(
      `INSERT INTO "${schema}".provider_receipt_links
         (company_id,evidence_id,conversation_id,message_id,operation_id,attempt_id)
       VALUES ($1,'ev1',$2,'m1','op1','att1')`,
      [fx.companyId, fx.conversationId],
    );

    await assert.rejects(
      revokeProvisionalSent(db, deps(schema), { companyId: fx.companyId, operationId: 'op1' }),
      (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === 'COVERAGE_CONFIRMED_BY_RECEIPT',
    );

    const after = await listObligations(db, deps(schema), { companyId: fx.companyId, workItemId: fx.workItemId });
    assert.equal(after[0]?.state, 'covered', 'delivered proof must not be downgraded');
    assert.equal(await countRows(db, schema, 'send_coverage', 'company_id=$1', [fx.companyId]), 1);
  } finally {
    await close();
  }
});

test('concurrent openIncoming on two READ COMMITTED connections creates one obligation', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedAttention(db, schema);
    await seedInboundMessage(db, schema, { companyId: fx.companyId, conversationId: fx.conversationId, messageId: 'm1' });

    // Two pool clients => two real PostgreSQL sessions at READ COMMITTED.
    const [first, second] = await Promise.all([
      openIncoming(db, deps(schema), {
        companyId: fx.companyId,
        workItemId: fx.workItemId,
        messageId: 'm1',
        contentVersion: 0,
      }),
      openIncoming(db, deps(schema), {
        companyId: fx.companyId,
        workItemId: fx.workItemId,
        messageId: 'm1',
        contentVersion: 0,
      }),
    ]);

    assert.equal(first.obligation.id, second.obligation.id);
    assert.equal([first.created, second.created].filter(Boolean).length, 1);
    assert.equal(await countRows(db, schema, 'attention_obligations', 'company_id=$1', [fx.companyId]), 1);
    assert.equal(await countRows(db, schema, 'staff_read_marks', 'company_id=$1', [fx.companyId]), 0);
  } finally {
    await close();
  }
});

test('two concurrent confirms on separate connections both persist their coverage', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedAttention(db, schema);
    await seedInboundMessage(db, schema, { companyId: fx.companyId, conversationId: fx.conversationId, messageId: 'm1' });
    const opened = await openIncoming(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      messageId: 'm1',
      contentVersion: 0,
    });
    for (const id of ['opA', 'opB']) {
      const snapshot = await captureSnapshot(db, deps(schema), {
        companyId: fx.companyId,
        workItemId: fx.workItemId,
        actorId: fx.staffId,
      });
      assert.ok(snapshot.snapshotId);
      await seedSendOperation(db, schema, {
        companyId: fx.companyId,
        operationId: id,
        workItemId: fx.workItemId,
        conversationId: fx.conversationId,
        snapshotId: snapshot.snapshotId,
        actorId: fx.staffId,
      });
    }

    const results = await Promise.all([
      confirmSendCoverage(db, deps(schema), { companyId: fx.companyId, operationId: 'opA' }),
      confirmSendCoverage(db, deps(schema), { companyId: fx.companyId, operationId: 'opB' }),
    ]);
    for (const result of results) {
      assert.deepEqual(
        result.covered.map((item) => item.obligationId),
        [opened.obligation.id],
      );
      assert.deepEqual(result.remaining, []);
    }
    assert.equal(await countRows(db, schema, 'send_coverage', 'company_id=$1', [fx.companyId]), 2);
    const after = await listObligations(db, deps(schema), { companyId: fx.companyId, workItemId: fx.workItemId });
    assert.equal(after[0]?.state, 'covered');
  } finally {
    await close();
  }
});

test('failed and unknown outcomes keep the obligation open', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedAttention(db, schema);
    await seedInboundMessage(db, schema, { companyId: fx.companyId, conversationId: fx.conversationId, messageId: 'm1' });
    const opened = await openIncoming(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      messageId: 'm1',
      contentVersion: 0,
    });
    const snapshot = await captureSnapshot(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      actorId: fx.staffId,
    });
    assert.ok(snapshot.snapshotId, 'snapshot must be persisted before operations are accepted');

    for (const [index, outcome] of (['failed', 'unknown'] as const).entries()) {
      await seedSendOperation(db, schema, {
        companyId: fx.companyId,
        operationId: `op-${outcome}`,
        workItemId: fx.workItemId,
        conversationId: fx.conversationId,
        snapshotId: snapshot.snapshotId,
        actorId: fx.staffId,
        state: 'dispatching',
      });
      const recorded = await recordSendOutcome(db, deps(schema), {
        companyId: fx.companyId,
        operationId: `op-${outcome}`,
        outcome,
      });
      assert.equal(recorded.state, outcome, `outcome ${index} must be stored as reported`);
    }

    const after = await listObligations(db, deps(schema), { companyId: fx.companyId, workItemId: fx.workItemId });
    assert.equal(after[0]?.id, opened.obligation.id);
    assert.equal(after[0]?.state, 'open');
    assert.equal(await countRows(db, schema, 'send_coverage', 'company_id=$1', [fx.companyId]), 0);
  } finally {
    await close();
  }
});

test('coverage from concurrent answers is merged and revoking one keeps the other', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedAttention(db, schema);
    await seedInboundMessage(db, schema, { companyId: fx.companyId, conversationId: fx.conversationId, messageId: 'm1' });
    const opened = await openIncoming(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      messageId: 'm1',
      contentVersion: 0,
    });
    const snapshotA = await captureSnapshot(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      actorId: fx.staffId,
    });
    const snapshotB = await captureSnapshot(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      actorId: fx.staffId,
    });
    assert.ok(snapshotA.snapshotId, 'snapshot A must be persisted before an operation is accepted');
    await seedSendOperation(db, schema, {
      companyId: fx.companyId,
      operationId: 'opA',
      workItemId: fx.workItemId,
      conversationId: fx.conversationId,
      snapshotId: snapshotA.snapshotId,
      actorId: fx.staffId,
    });
    assert.ok(snapshotB.snapshotId, 'snapshot B must be persisted before an operation is accepted');
    await seedSendOperation(db, schema, {
      companyId: fx.companyId,
      operationId: 'opB',
      workItemId: fx.workItemId,
      conversationId: fx.conversationId,
      snapshotId: snapshotB.snapshotId,
      actorId: fx.staffId,
    });

    const [a, b] = await Promise.all([
      confirmSendCoverage(db, deps(schema), { companyId: fx.companyId, operationId: 'opA' }),
      confirmSendCoverage(db, deps(schema), { companyId: fx.companyId, operationId: 'opB' }),
    ]);
    assert.deepEqual(
      a.covered.map((item) => item.obligationId),
      [opened.obligation.id],
    );
    assert.deepEqual(
      b.covered.map((item) => item.obligationId),
      [opened.obligation.id],
    );
    assert.equal(await countRows(db, schema, 'send_coverage', 'company_id=$1', [fx.companyId]), 2);

    const revoked = await revokeProvisionalSent(db, deps(schema), { companyId: fx.companyId, operationId: 'opA' });
    assert.deepEqual(
      revoked.revoked.map((item) => item.obligationId),
      [opened.obligation.id],
    );
    assert.deepEqual(revoked.reopened, []);
    const after = await listObligations(db, deps(schema), { companyId: fx.companyId, workItemId: fx.workItemId });
    assert.equal(after[0]?.state, 'covered');
    assert.equal(await countRows(db, schema, 'send_coverage', 'company_id=$1 AND operation_id=$2', [fx.companyId, 'opB']), 1);
  } finally {
    await close();
  }
});

test('revoking the only coverage reopens the obligation, but never after a delivered receipt', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedAttention(db, schema);
    await seedInboundMessage(db, schema, { companyId: fx.companyId, conversationId: fx.conversationId, messageId: 'm1' });
    const opened = await openIncoming(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      messageId: 'm1',
      contentVersion: 0,
    });
    const snapshot = await captureSnapshot(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      actorId: fx.staffId,
    });
    assert.ok(snapshot.snapshotId, 'snapshot must be persisted before an operation is accepted');
    await seedSendOperation(db, schema, {
      companyId: fx.companyId,
      operationId: 'op1',
      workItemId: fx.workItemId,
      conversationId: fx.conversationId,
      snapshotId: snapshot.snapshotId,
      actorId: fx.staffId,
    });
    await confirmSendCoverage(db, deps(schema), { companyId: fx.companyId, operationId: 'op1' });

    const revoked = await revokeProvisionalSent(db, deps(schema), { companyId: fx.companyId, operationId: 'op1' });
    assert.deepEqual(revoked.reopened, [opened.obligation.id]);
    const reopened = await listObligations(db, deps(schema), { companyId: fx.companyId, workItemId: fx.workItemId });
    assert.equal(reopened[0]?.state, 'open');
    assert.equal(await countRows(db, schema, 'send_coverage', 'company_id=$1', [fx.companyId]), 0);
  } finally {
    await close();
  }
});

test('repeated confirmation of the same operation is deterministic', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedAttention(db, schema);
    await seedInboundMessage(db, schema, { companyId: fx.companyId, conversationId: fx.conversationId, messageId: 'm1' });
    const opened = await openIncoming(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      messageId: 'm1',
      contentVersion: 0,
    });
    const snapshot = await captureSnapshot(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      actorId: fx.staffId,
    });
    assert.ok(snapshot.snapshotId, 'snapshot must be persisted before an operation is accepted');
    await seedSendOperation(db, schema, {
      companyId: fx.companyId,
      operationId: 'op1',
      workItemId: fx.workItemId,
      conversationId: fx.conversationId,
      snapshotId: snapshot.snapshotId,
      actorId: fx.staffId,
    });

    const [first, second] = await Promise.all([
      confirmSendCoverage(db, deps(schema), { companyId: fx.companyId, operationId: 'op1' }),
      confirmSendCoverage(db, deps(schema), { companyId: fx.companyId, operationId: 'op1' }),
    ]);
    assert.deepEqual(first.covered, second.covered);
    assert.deepEqual(
      first.covered.map((item) => item.obligationId),
      [opened.obligation.id],
    );
    assert.equal(await countRows(db, schema, 'send_coverage', 'company_id=$1', [fx.companyId]), 1);
    const after = await listObligations(db, deps(schema), { companyId: fx.companyId, workItemId: fx.workItemId });
    assert.equal(after[0]?.state, 'covered');
  } finally {
    await close();
  }
});
