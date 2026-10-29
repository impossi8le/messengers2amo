import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './helpers/db.ts';
import { seedAttention, seedInboundMessage, seedEdit, seedSendOperation, countRows } from './helpers/attention.ts';
import type { Db } from '../src/platform/db.ts';
import {
  openIncoming,
  editIncoming,
  captureSnapshot,
  confirmSendCoverage,
  revokeProvisionalSent,
  listObligations,
} from '../src/repo/attention.ts';

const deps = (schema: string) => ({ schema });

/**
 * Wraps the pool so every `DELETE FROM send_coverage` completes before either
 * transaction continues: both revokes have then read the same "other coverage"
 * state, which is exactly the race under test.
 */
function revokeBarrier(db: Db): Db {
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  // Both revokes must be in flight before either may continue.
  let started = 0;
  let releaseStart: () => void = () => undefined;
  const bothStarted = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });

  // Then both withdrawals delete their own coverage before either counts the
  // remaining one. If the implementation serialises them, the second delete never
  // arrives and the wait expires.
  let deleted = 0;
  let releaseDeletes: () => void = () => undefined;
  const bothDeleted = new Promise<void>((resolve) => {
    releaseDeletes = resolve;
  });

  // Finally the first count waits briefly for the other count, so both observe each
  // other's coverage; serialised implementations simply let the wait expire.
  let counted = 0;
  let secondCounted: () => void = () => undefined;
  const bothCounted = new Promise<void>((resolve) => {
    secondCounted = resolve;
  });

  const gated = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'connect') return Reflect.get(target, property, receiver);
      return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(inner, key, innerReceiver) {
            if (key !== 'query') return Reflect.get(inner, key, innerReceiver);
            return async (sql: unknown, params?: unknown[]) => {
              const text = typeof sql === 'string' ? sql : '';
              if (text.includes('FROM') && text.includes('send_operations') && text.includes('FOR UPDATE')) {
                const result = await inner.query(text, params);
                started += 1;
                if (started >= 2) releaseStart();
                await bothStarted;
                return result;
              }
              if (text.includes('DELETE FROM') && text.includes('send_coverage')) {
                const result = await inner.query(text, params);
                deleted += 1;
                if (deleted >= 2) releaseDeletes();
                await Promise.race([bothDeleted, wait(750)]);
                return result;
              }
              if (
                text.includes('FROM') &&
                text.includes('send_coverage') &&
                (text.includes('SELECT 1 AS c') || text.includes('count(*)::int AS c'))
              ) {
                counted += 1;
                if (counted === 1) await Promise.race([bothCounted, wait(750)]);
                else secondCounted();
              }
              return inner.query(text, params);
            };
          },
        });
      };
    },
  }) as Db;
  return gated;
}

/** Runs every transaction of this pool at the requested isolation level. */
function withIsolation(db: Db, isolation: 'read committed' | 'repeatable read'): Db {
  if (isolation === 'read committed') return db;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'connect') return Reflect.get(target, property, receiver);
      return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(inner, key, innerReceiver) {
            if (key !== 'query') return Reflect.get(inner, key, innerReceiver);
            return (sql: unknown, params?: unknown[]) =>
              inner.query(sql === 'BEGIN' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : (sql as string), params);
          },
        });
      };
    },
  }) as Db;
}

async function seedTwoCoveringOperations(db: Db, schema: string, fx: { companyId: string; workItemId: string; conversationId: string; staffId: string }) {
  // Both snapshots must be sealed while the obligation is still open.
  for (const id of ['opA', 'opB']) {
    const snapshot = await captureSnapshot(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      actorId: fx.staffId,
    });
    await seedSendOperation(db, schema, {
      companyId: fx.companyId,
      operationId: id,
      workItemId: fx.workItemId,
      conversationId: fx.conversationId,
      snapshotId: snapshot.snapshotId,
      actorId: fx.staffId,
    });
  }
  for (const id of ['opA', 'opB']) {
    await confirmSendCoverage(db, deps(schema), { companyId: fx.companyId, operationId: id });
  }
}

async function retryOnSerialization<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== '40001' || attempt >= 4) throw error;
    }
  }
}

async function runConcurrentRevoke(handle: TestDb, isolation: 'read committed' | 'repeatable read') {
  const { schema } = handle;
  const db = handle.db;
  try {
    const fx = await seedAttention(db, schema);
    await seedInboundMessage(db, schema, { companyId: fx.companyId, conversationId: fx.conversationId, messageId: 'm1' });
    const opened = await openIncoming(db, deps(schema), {
      companyId: fx.companyId,
      workItemId: fx.workItemId,
      messageId: 'm1',
      contentVersion: 0,
    });
    await seedTwoCoveringOperations(db, schema, fx);
    assert.equal(await countRows(db, schema, 'send_coverage', 'company_id=$1', [fx.companyId]), 2);

    const gated = revokeBarrier(withIsolation(db, isolation));
    await Promise.all([
      retryOnSerialization(() => revokeProvisionalSent(gated, deps(schema), { companyId: fx.companyId, operationId: 'opA' })),
      retryOnSerialization(() => revokeProvisionalSent(gated, deps(schema), { companyId: fx.companyId, operationId: 'opB' })),
    ]);

    const coverage = await countRows(db, schema, 'send_coverage', 'company_id=$1', [fx.companyId]);
    const after = await listObligations(db, deps(schema), { companyId: fx.companyId, workItemId: fx.workItemId });
    assert.equal(coverage, 0, 'both provisional answers were withdrawn');
    assert.equal(
      after[0]?.state,
      'open',
      'with no coverage left the obligation must be reopened, not left covered',
    );
    assert.equal(after[0]?.id, opened.obligation.id);
  } finally {
    if (db !== handle.db) await db.end();
  }
}

test('concurrent withdrawal of the only two covering answers reopens the obligation (READ COMMITTED)', async () => {
  const handle = await createTestDb();
  try {
    await runConcurrentRevoke(handle, 'read committed');
  } finally {
    await handle.close();
  }
});

test('concurrent withdrawal of the only two covering answers reopens the obligation (REPEATABLE READ)', async () => {
  const handle = await createTestDb();
  try {
    await runConcurrentRevoke(handle, 'repeatable read');
  } finally {
    await handle.close();
  }
});

test('revoking an answer to a superseded version does not reopen the replaced obligation', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedAttention(db, schema);
    await seedInboundMessage(db, schema, {
      companyId: fx.companyId,
      conversationId: fx.conversationId,
      messageId: 'm1',
      content: { kind: 'text', text: 'сумма 100' },
    });
    const v1 = await openIncoming(db, deps(schema), {
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
    await seedSendOperation(db, schema, {
      companyId: fx.companyId,
      operationId: 'op-v1',
      workItemId: fx.workItemId,
      conversationId: fx.conversationId,
      snapshotId: snapshot.snapshotId,
      actorId: fx.staffId,
    });
    await confirmSendCoverage(db, deps(schema), { companyId: fx.companyId, operationId: 'op-v1' });

    // The customer rewrites the message: v1 is superseded by v2.
    await seedEdit(db, schema, {
      companyId: fx.companyId,
      messageId: 'm1',
      contentVersion: 1,
      content: { kind: 'text', text: 'сумма 250' },
    });
    const v2 = await editIncoming(db, deps(schema), {
      companyId: fx.companyId,
      messageId: 'm1',
      contentVersion: 1,
      substantial: true,
    });
    assert.equal(v2.obligation.supersedesId, v1.obligation.id);

    const revoked = await revokeProvisionalSent(db, deps(schema), { companyId: fx.companyId, operationId: 'op-v1' });
    assert.deepEqual(revoked.reopened, [], 'a replaced version must not be reopened');
    assert.deepEqual(revoked.keptCovered, [v1.obligation.id]);

    const after = await listObligations(db, deps(schema), { companyId: fx.companyId, workItemId: fx.workItemId });
    const open = after.filter((item) => item.state === 'open');
    assert.deepEqual(
      open.map((item) => item.id),
      [v2.obligation.id],
      'only the current version stays outstanding',
    );
    assert.equal(after.find((item) => item.id === v1.obligation.id)?.state, 'covered');
  } finally {
    await close();
  }
});
