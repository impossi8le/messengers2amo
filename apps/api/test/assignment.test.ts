import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import type { Db } from '../src/platform/db.ts';
import { seedAttention, countRows } from './helpers/attention.ts';
import {
  claimWorkItem,
  claimWorkItemInTransaction,
  transferWorkItem,
  resolveWorkItem,
  readWorkItem,
  recordCrmContactOwner,
  readCrmContactOwner,
  AssignmentError,
} from '../src/repo/assignment.ts';

const deps = (schema: string) => ({ schema });

async function addWorkItem(
  db: Db,
  schema: string,
  input: { companyId: string; connectionId: string; conversationId: string; workItemId: string },
): Promise<void> {
  await db.query(
    `INSERT INTO "${schema}".conversations (company_id,id,connection_id,binding_epoch,external_chat_id,chat_kind)
     VALUES ($1,$2,$3,1,$4,'private')`,
    [input.companyId, input.conversationId, input.connectionId, `chat-${input.conversationId}`],
  );
  await db.query(
    `INSERT INTO "${schema}".work_items (company_id,id,conversation_id,state,owner_id)
     VALUES ($1,$2,$3,'queued',NULL)`,
    [input.companyId, input.workItemId, input.conversationId],
  );
}

test('claim assigns the owner, bumps the version and takes one capacity slot', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedAttention(db, schema);
    const result = await claimWorkItem(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      staffId: fx.staffId,
      expectedVersion: 0,
      requestKey: 'claim-1',
    });
    assert.equal(result.workItem.ownerId, fx.staffId);
    assert.equal(result.workItem.assignmentVersion, 1);
    assert.equal(result.workItem.state, 'assigned');
    assert.equal(result.replayed, false);
    assert.equal(result.activeCount, 1);

    const { rows } = await db.query<{ active_count: number }>(
      `SELECT active_count FROM "${schema}".staff WHERE company_id=$1 AND id=$2`,
      [fx.companyId, fx.staffId],
    );
    assert.equal(rows[0]?.active_count, 1);
    assert.equal(await countRows(db, schema, 'assignment_history', 'work_item_id=$1', [fx.workItemId]), 1);
  } finally {
    await close();
  }
});

test('two concurrent claims from the same version produce exactly one winner', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedAttention(db, schema, {
      staff: [
        { id: 's1', capacity: 5 },
        { id: 's2', capacity: 5 },
      ],
    });

    const outcomes = await Promise.allSettled([
      claimWorkItem(db, deps(schema), {
        companyId: fx.companyId,
        workItemId: fx.workItemId,
        staffId: 's1',
        expectedVersion: 0,
        requestKey: 'claim-s1',
      }),
      claimWorkItem(db, deps(schema), {
        companyId: fx.companyId,
        workItemId: fx.workItemId,
        staffId: 's2',
        expectedVersion: 0,
        requestKey: 'claim-s2',
      }),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one claim must win');
    assert.equal(rejected.length, 1, 'the loser must receive an explicit conflict');

    const loser = rejected[0] as PromiseRejectedResult;
    assert.ok(loser.reason instanceof AssignmentError, 'loser gets a typed conflict, not a silent overwrite');
    assert.equal(loser.reason.code, 'VERSION_CONFLICT');
    assert.ok(loser.reason.current, 'conflict exposes the current assignment');
    assert.equal(loser.reason.current?.assignmentVersion, 1);
    assert.ok(['s1', 's2'].includes(loser.reason.current?.ownerId ?? ''));

    const winner = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof claimWorkItem>>>).value;
    const stored = await readWorkItem(db, deps(schema), { companyId: fx.companyId, workItemId: fx.workItemId });
    assert.equal(stored?.ownerId, winner.workItem.ownerId);
    assert.equal(stored?.assignmentVersion, 1);
    assert.equal(await countRows(db, schema, 'assignment_history', 'work_item_id=$1', [fx.workItemId]), 1);
    const { rows } = await db.query<{ total: number }>(
      `SELECT active_count AS total FROM "${schema}".staff WHERE company_id=$1 AND id=$2`,
      [fx.companyId, winner.workItem.ownerId],
    );
    assert.equal(rows[0]?.total, 1, 'only the winner holds a slot');
  } finally {
    await close();
  }
});

test('capacity fence never lets a staff member exceed capacity', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedAttention(db, schema, { capacity: 1 });
    await addWorkItem(db, schema, {
      companyId: fx.companyId,
      connectionId: 'conn1',
      conversationId: 'conv2',
      workItemId: 'wi2',
    });

    const outcomes = await Promise.allSettled([
      claimWorkItem(db, deps(schema), {
        companyId: fx.companyId,
        workItemId: 'wi1',
        staffId: fx.staffId,
        expectedVersion: 0,
        requestKey: 'claim-wi1',
      }),
      claimWorkItem(db, deps(schema), {
        companyId: fx.companyId,
        workItemId: 'wi2',
        staffId: fx.staffId,
        expectedVersion: 0,
        requestKey: 'claim-wi2',
      }),
    ]);

    assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
    const rejected = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof AssignmentError);
    assert.equal(rejected.reason.code, 'CAPACITY_EXCEEDED');

    const { rows } = await db.query<{ active_count: number }>(
      `SELECT active_count FROM "${schema}".staff WHERE company_id=$1 AND id=$2`,
      [fx.companyId, fx.staffId],
    );
    assert.equal(rows[0]?.active_count, 1);
    assert.equal(await countRows(db, schema, 'work_items', 'company_id=$1 AND owner_id IS NOT NULL', [fx.companyId]), 1);
  } finally {
    await close();
  }
});

test('resolve releases the slot once and replaying the command is idempotent', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedAttention(db, schema, { capacity: 1 });
    await claimWorkItem(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      staffId: fx.staffId,
      expectedVersion: 0,
      requestKey: 'claim-1',
    });

    const resolved = await resolveWorkItem(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      actorId: fx.staffId,
      expectedVersion: 1,
      requestKey: 'resolve-1',
    });
    assert.equal(resolved.workItem.state, 'resolved');
    assert.equal(resolved.workItem.ownerId, null);
    assert.equal(resolved.workItem.assignmentVersion, 2);

    const replay = await resolveWorkItem(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      actorId: fx.staffId,
      expectedVersion: 1,
      requestKey: 'resolve-1',
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.workItem.assignmentVersion, 2);

    const { rows } = await db.query<{ active_count: number }>(
      `SELECT active_count FROM "${schema}".staff WHERE company_id=$1 AND id=$2`,
      [fx.companyId, fx.staffId],
    );
    assert.equal(rows[0]?.active_count, 0, 'slot released exactly once');
    assert.equal(await countRows(db, schema, 'assignment_history', 'work_item_id=$1', [fx.workItemId]), 2);
  } finally {
    await close();
  }
});

test('replaying a claim with the same key does not consume a second slot', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedAttention(db, schema, { capacity: 1 });
    const first = await claimWorkItem(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      staffId: fx.staffId,
      expectedVersion: 0,
      requestKey: 'same-key',
    });
    const second = await claimWorkItem(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      staffId: fx.staffId,
      expectedVersion: 0,
      requestKey: 'same-key',
    });
    assert.equal(second.replayed, true);
    assert.equal(second.workItem.assignmentVersion, first.workItem.assignmentVersion);
    assert.equal(second.activeCount, 1);

    const { rows } = await db.query<{ active_count: number }>(
      `SELECT active_count FROM "${schema}".staff WHERE company_id=$1 AND id=$2`,
      [fx.companyId, fx.staffId],
    );
    assert.equal(rows[0]?.active_count, 1);

    await assert.rejects(
      claimWorkItem(db, deps(schema), {
        companyId: fx.companyId,
        workItemId: fx.workItemId,
        staffId: fx.staffId,
        expectedVersion: 1,
        requestKey: 'same-key',
      }),
      (error: unknown) => error instanceof AssignmentError && error.code === 'IDEMPOTENCY_CONFLICT',
    );
  } finally {
    await close();
  }
});

test('transfer moves the slot between staff in one transaction', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedAttention(db, schema, {
      staff: [
        { id: 's1', capacity: 2 },
        { id: 's2', capacity: 2 },
      ],
    });
    await claimWorkItem(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      staffId: 's1',
      expectedVersion: 0,
      requestKey: 'claim-1',
    });

    const transferred = await transferWorkItem(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      actorId: 's1',
      toStaffId: 's2',
      toDepartmentId: null,
      expectedVersion: 1,
      requestKey: 'transfer-1',
    });
    assert.equal(transferred.workItem.ownerId, 's2');
    assert.equal(transferred.workItem.assignmentVersion, 2);

    const { rows } = await db.query<{ id: string; active_count: number }>(
      `SELECT id, active_count FROM "${schema}".staff WHERE company_id=$1 ORDER BY id`,
      [fx.companyId],
    );
    assert.deepEqual(
      rows.map((row) => [row.id, row.active_count]),
      [
        ['s1', 0],
        ['s2', 1],
      ],
    );
  } finally {
    await close();
  }
});

test('transfer respects the receiving operator capacity', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedAttention(db, schema, {
      staff: [
        { id: 's1', capacity: 2 },
        { id: 's2', capacity: 0 },
      ],
    });
    await claimWorkItem(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      staffId: 's1',
      expectedVersion: 0,
      requestKey: 'claim-1',
    });

    await assert.rejects(
      transferWorkItem(db, deps(schema), {
        companyId: fx.companyId,
        workItemId: fx.workItemId,
        actorId: 's1',
        toStaffId: 's2',
        toDepartmentId: null,
        expectedVersion: 1,
        requestKey: 'transfer-1',
      }),
      (error: unknown) => error instanceof AssignmentError && error.code === 'CAPACITY_EXCEEDED',
    );

    const stored = await readWorkItem(db, deps(schema), { companyId: fx.companyId, workItemId: fx.workItemId });
    assert.equal(stored?.ownerId, 's1', 'failed transfer leaves the original owner');
    assert.equal(stored?.assignmentVersion, 1);
  } finally {
    await close();
  }
});

test('CRM contact owner changes never replace the local assignee', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedAttention(db, schema);
    await claimWorkItem(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      staffId: fx.staffId,
      expectedVersion: 0,
      requestKey: 'claim-1',
    });

    await recordCrmContactOwner(db, deps(schema), {
      companyId: fx.companyId,
      conversationId: fx.conversationId,
      crmOwnerRef: 'amo-user-777',
    });
    const crmOwner = await readCrmContactOwner(db, deps(schema), {
      companyId: fx.companyId,
      conversationId: fx.conversationId,
    });
    assert.equal(crmOwner?.crmOwnerRef, 'amo-user-777');

    const workItem = await readWorkItem(db, deps(schema), { companyId: fx.companyId, workItemId: fx.workItemId });
    assert.equal(workItem?.ownerId, fx.staffId);
    assert.equal(workItem?.assignmentVersion, 1);

    await recordCrmContactOwner(db, deps(schema), {
      companyId: fx.companyId,
      conversationId: fx.conversationId,
      crmOwnerRef: 'amo-user-888',
      expectedVersion: crmOwner?.version,
    });
    const after = await readWorkItem(db, deps(schema), { companyId: fx.companyId, workItemId: fx.workItemId });
    assert.equal(after?.ownerId, fx.staffId);
    assert.equal(after?.assignmentVersion, 1);
  } finally {
    await close();
  }
});

test('REPEATABLE READ capacity fence admits only one of two parallel assignments', async () => {
  const { db, schema, close } = await createTestDb();
  const first = await db.connect();
  const second = await db.connect();
  try {
    const fx = await seedAttention(db, schema, { capacity: 1 });
    await addWorkItem(db, schema, {
      companyId: fx.companyId,
      connectionId: 'conn1',
      conversationId: 'conv2',
      workItemId: 'wi2',
    });

    await first.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await second.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    // Both transactions observe active_count = 0 before either writes.
    for (const client of [first, second]) {
      const { rows } = await client.query(`SELECT active_count FROM "${schema}".staff WHERE company_id=$1 AND id=$2`, [
        fx.companyId,
        fx.staffId,
      ]);
      assert.equal(rows[0]?.active_count, 0);
    }

    const a = await claimWorkItemInTransaction(first, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      staffId: fx.staffId,
      expectedVersion: 0,
      requestKey: 'rr-cap-1',
    });
    assert.equal(a.activeCount, 1);
    await first.query('COMMIT');

    await assert.rejects(
      claimWorkItemInTransaction(second, deps(schema), {
        companyId: fx.companyId,
        workItemId: 'wi2',
        staffId: fx.staffId,
        expectedVersion: 0,
        requestKey: 'rr-cap-2',
      }),
      (error: unknown) =>
        error instanceof AssignmentError &&
        (error.code === 'CAPACITY_EXCEEDED' || error.code === 'SERIALIZATION_FAILURE'),
    );
    await second.query('ROLLBACK');

    const { rows } = await db.query<{ active_count: number }>(
      `SELECT active_count FROM "${schema}".staff WHERE company_id=$1 AND id=$2`,
      [fx.companyId, fx.staffId],
    );
    assert.equal(rows[0]?.active_count, 1);
    assert.equal(await countRows(db, schema, 'work_items', 'company_id=$1 AND owner_id IS NOT NULL', [fx.companyId]), 1);
  } finally {
    first.release();
    second.release();
    await close();
  }
});

test('REPEATABLE READ claim race fails with a retryable conflict instead of overwriting', async () => {
  const { db, schema, close } = await createTestDb();
  const first = await db.connect();
  const second = await db.connect();
  try {
    const fx = await seedAttention(db, schema, {
      staff: [
        { id: 's1', capacity: 5 },
        { id: 's2', capacity: 5 },
      ],
    });

    await first.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await second.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    // Both transactions read the same pre-claim snapshot.
    await first.query(`SELECT id FROM "${schema}".work_items WHERE company_id=$1 AND id=$2`, [fx.companyId, fx.workItemId]);
    await second.query(`SELECT id FROM "${schema}".work_items WHERE company_id=$1 AND id=$2`, [fx.companyId, fx.workItemId]);

    const a = await claimWorkItemInTransaction(first, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      staffId: 's1',
      expectedVersion: 0,
      requestKey: 'rr-s1',
    });
    assert.equal(a.workItem.ownerId, 's1');
    await first.query('COMMIT');

    await assert.rejects(
      claimWorkItemInTransaction(second, deps(schema), {
        companyId: fx.companyId,
        workItemId: fx.workItemId,
        staffId: 's2',
        expectedVersion: 0,
        requestKey: 'rr-s2',
      }),
      (error: unknown) =>
        error instanceof AssignmentError && (error.code === 'VERSION_CONFLICT' || error.code === 'SERIALIZATION_FAILURE'),
    );
    await second.query('ROLLBACK');

    const stored = await readWorkItem(db, deps(schema), { companyId: fx.companyId, workItemId: fx.workItemId });
    assert.equal(stored?.ownerId, 's1');
    assert.equal(stored?.assignmentVersion, 1);
    assert.equal(await countRows(db, schema, 'assignment_history', 'work_item_id=$1', [fx.workItemId]), 1);
  } finally {
    first.release();
    second.release();
    await close();
  }
});
