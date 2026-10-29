import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { seedConnection } from './helpers/channel-fixtures.ts';
import {
  comparePilotEvents,
  claimSendOwnership,
  enableSending,
  getSendOwner,
  releaseSendOwnership,
  SendOwnershipConflictError,
  type PilotEvent,
} from '../src/migration/pilot.ts';

const SNAPSHOT = '2026-10-21T11:00:00.000Z';

function event(overrides: Partial<PilotEvent> & { eventKey: string }): PilotEvent {
  return {
    direction: 'in',
    occurredAt: '2026-10-21T10:00:00.000Z',
    contentKind: 'text',
    text: 'hello',
    mediaId: null,
    conversationKey: 'chat-1',
    contactKey: 'contact-1',
    waiting: true,
    ...overrides,
  };
}

test('pilot: matches events and explains delay and filter without blocking the pilot', () => {
  const report = comparePilotEvents({
    oldEvents: [
      event({ eventKey: 'e1' }),
      event({ eventKey: 'e2' }),
      event({ eventKey: 'e3', filterReason: 'internal_group' }),
    ],
    newEvents: [
      event({ eventKey: 'e1', observedAt: '2026-10-21T10:00:05.000Z' }),
      event({ eventKey: 'e2', observedAt: '2026-10-21T10:10:00.000Z' }),
    ],
    maxDelayMs: 60_000,
    snapshotAt: SNAPSHOT,
  });

  assert.equal(report.totals.match, 1);
  assert.equal(report.totals.delay, 1);
  assert.equal(report.totals.filtered, 1);
  assert.equal(report.totals.real_loss, 0);
  assert.equal(report.totals.normalization_error, 0);
  assert.equal(report.totals.duplicate, 0);
  assert.equal(report.reconciled, true);
  assert.deepEqual(report.blocking, []);

  const delayed = report.results.find((row) => row.eventKey === 'e2');
  assert.equal(delayed?.classification, 'delay');
  assert.equal(delayed?.delayMs, 600_000);
  assert.ok(delayed?.reasons.includes('delay_exceeds_threshold'));

  const filtered = report.results.find((row) => row.eventKey === 'e3');
  assert.equal(filtered?.classification, 'filtered');
  assert.ok(filtered?.reasons.includes('filtered:internal_group'));
});

test('pilot: reports real loss, normalization errors and duplicates as blocking', () => {
  const report = comparePilotEvents({
    oldEvents: [
      event({ eventKey: 'lost' }),
      event({ eventKey: 'changed-text' }),
      event({ eventKey: 'duplicated' }),
      event({ eventKey: 'other-chat' }),
      event({ eventKey: 'waiting-changed' }),
    ],
    newEvents: [
      event({ eventKey: 'changed-text', text: 'different' }),
      event({ eventKey: 'duplicated' }),
      event({ eventKey: 'duplicated' }),
      event({ eventKey: 'other-chat', conversationKey: 'chat-2' }),
      event({ eventKey: 'waiting-changed', waiting: false }),
    ],
    maxDelayMs: 60_000,
    snapshotAt: SNAPSHOT,
  });

  assert.equal(report.totals.match, 1);
  assert.equal(report.totals.duplicate, 1);
  assert.equal(report.totals.real_loss, 1);
  assert.equal(report.totals.normalization_error, 3);
  assert.equal(report.totals.delay, 0);
  assert.equal(report.totals.filtered, 0);
  assert.equal(report.reconciled, false);
  assert.deepEqual(report.blocking.sort(), ['duplicate', 'normalization_error', 'real_loss']);

  const lost = report.results.find((row) => row.eventKey === 'lost');
  assert.equal(lost?.classification, 'real_loss');
  assert.ok(lost?.reasons.includes('not_observed'));

  const changed = report.results.find((row) => row.eventKey === 'changed-text');
  assert.equal(changed?.classification, 'normalization_error');
  assert.ok(changed?.reasons.includes('content_mismatch'));

  const otherChat = report.results.find((row) => row.eventKey === 'other-chat');
  assert.ok(otherChat?.reasons.includes('conversation_mismatch'));

  const waiting = report.results.find((row) => row.eventKey === 'waiting-changed');
  assert.ok(waiting?.reasons.includes('waiting_mismatch'));
});

test('pilot: an event still inside the delay window is not declared lost', () => {
  const report = comparePilotEvents({
    oldEvents: [event({ eventKey: 'recent', occurredAt: '2026-10-21T10:59:50.000Z' })],
    newEvents: [],
    maxDelayMs: 60_000,
    snapshotAt: SNAPSHOT,
  });

  assert.equal(report.totals.real_loss, 0);
  assert.equal(report.totals.delay, 1);
  const row = report.results[0];
  assert.equal(row?.classification, 'delay');
  assert.ok(row?.reasons.includes('delay_window_open'));
  assert.equal(report.reconciled, true);
});

test('pilot: an event present only in the new contour is an unexplained normalization anomaly', () => {
  const report = comparePilotEvents({
    oldEvents: [],
    newEvents: [event({ eventKey: 'extra' }), event({ eventKey: 'extra' })],
    maxDelayMs: 60_000,
    snapshotAt: SNAPSHOT,
  });

  assert.equal(report.totals.normalization_error, 1);
  assert.equal(report.totals.duplicate, 1);
  const unexpected = report.results.find((row) => row.classification === 'normalization_error');
  assert.ok(unexpected?.reasons.includes('unexpected_event'));
  assert.equal(report.reconciled, false);
});

test('pilot: a channel accepts exactly one send owner and refuses a second', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await db.query(`INSERT INTO "${schema}".companies (id, display_name) VALUES ($1,$2)`, ['c1', 'test']);

    const first = await claimSendOwnership(db, {
      schema,
      companyId: 'c1',
      channelKey: 'asset-wa-1',
      owner: 'wazzup',
    });
    assert.equal(first.acquired, true);
    assert.equal(first.owner, 'wazzup');

    const replay = await claimSendOwnership(db, {
      schema,
      companyId: 'c1',
      channelKey: 'asset-wa-1',
      owner: 'wazzup',
    });
    assert.equal(replay.acquired, false);

    await assert.rejects(
      claimSendOwnership(db, { schema, companyId: 'c1', channelKey: 'asset-wa-1', owner: 'new_contour' }),
      (error: unknown) => {
        assert.ok(error instanceof SendOwnershipConflictError);
        assert.equal(error.code, 'SEND_OWNERSHIP_CONFLICT');
        assert.equal(error.currentOwner, 'wazzup');
        assert.equal(error.requestedOwner, 'new_contour');
        return true;
      },
    );
    assert.equal(await getSendOwner(db, { schema, companyId: 'c1', channelKey: 'asset-wa-1' }), 'wazzup');

    await releaseSendOwnership(db, { schema, companyId: 'c1', channelKey: 'asset-wa-1', owner: 'wazzup' });
    assert.equal(await getSendOwner(db, { schema, companyId: 'c1', channelKey: 'asset-wa-1' }), null);

    const handedOver = await claimSendOwnership(db, {
      schema,
      companyId: 'c1',
      channelKey: 'asset-wa-1',
      owner: 'new_contour',
    });
    assert.equal(handedOver.acquired, true);
  } finally {
    await close();
  }
});

test('pilot: concurrent claims from two contours admit exactly one send owner', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await db.query(`INSERT INTO "${schema}".companies (id, display_name) VALUES ($1,$2)`, ['c1', 'test']);

    const settled = await Promise.allSettled([
      claimSendOwnership(db, { schema, companyId: 'c1', channelKey: 'asset-wa-1', owner: 'wazzup' }),
      claimSendOwnership(db, { schema, companyId: 'c1', channelKey: 'asset-wa-1', owner: 'new_contour' }),
    ]);
    const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
    const rejected = settled.filter((entry) => entry.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);

    const winner = fulfilled[0] as PromiseFulfilledResult<{ owner: string }>;
    const loser = rejected[0] as PromiseRejectedResult;
    assert.ok(loser.reason instanceof SendOwnershipConflictError);
    assert.equal(loser.reason.currentOwner, winner.value.owner);
    assert.notEqual(loser.reason.requestedOwner, winner.value.owner);
    assert.equal(
      await getSendOwner(db, { schema, companyId: 'c1', channelKey: 'asset-wa-1' }),
      winner.value.owner,
    );
  } finally {
    await close();
  }
});

test('pilot: enabling sending for a connection owned by another contour is refused before any flag changes', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const first = await seedConnection(db, schema, { companyId: 'c1', connectionId: 'conn1' });
    await seedConnection(db, schema, { companyId: 'c1', connectionId: 'conn2' });
    await db.query(`UPDATE "${schema}".connections SET send_enabled=false WHERE company_id=$1`, ['c1']);

    await claimSendOwnership(db, {
      schema,
      companyId: first.companyId,
      channelKey: 'asset-wa-1',
      owner: 'wazzup',
    });

    await assert.rejects(
      enableSending(db, {
        schema,
        companyId: first.companyId,
        connectionId: 'conn1',
        channelKey: 'asset-wa-1',
        owner: 'conn1',
      }),
      SendOwnershipConflictError,
    );
    const stillDisabled = await db.query<{ send_enabled: boolean }>(
      `SELECT send_enabled FROM "${schema}".connections WHERE company_id=$1 AND id='conn1'`,
      [first.companyId],
    );
    assert.equal(stillDisabled.rows[0]?.send_enabled, false);

    await releaseSendOwnership(db, {
      schema,
      companyId: first.companyId,
      channelKey: 'asset-wa-1',
      owner: 'wazzup',
    });

    const enabled = await enableSending(db, {
      schema,
      companyId: first.companyId,
      connectionId: 'conn1',
      channelKey: 'asset-wa-1',
      owner: 'conn1',
    });
    assert.equal(enabled.owner, 'conn1');

    await assert.rejects(
      enableSending(db, {
        schema,
        companyId: first.companyId,
        connectionId: 'conn2',
        channelKey: 'asset-wa-1',
        owner: 'conn2',
      }),
      SendOwnershipConflictError,
    );
    const second = await db.query<{ send_enabled: boolean }>(
      `SELECT send_enabled FROM "${schema}".connections WHERE company_id=$1 AND id='conn2'`,
      [first.companyId],
    );
    assert.equal(second.rows[0]?.send_enabled, false);
  } finally {
    await close();
  }
});
