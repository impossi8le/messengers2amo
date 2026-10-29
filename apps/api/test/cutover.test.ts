import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizeCutover,
  evaluateGoNoGo,
  CutoverRefusedError,
  CUTOVER_STEPS,
  ROLLBACK_STEPS,
  ROLLBACK_GUARANTEES,
  validateCutoverSteps,
  type CutoverRequest,
} from '../src/migration/cutover.ts';

function readyRequest(overrides: Partial<CutoverRequest> = {}): CutoverRequest {
  return {
    channelKey: 'asset-wa-1',
    dependenciesAccepted: true,
    reconciliationPassed: true,
    rollbackVerified: true,
    sendOwners: [{ channelKey: 'asset-wa-1', owner: 'new_contour' }],
    ...overrides,
  };
}

test('cutover: go/no-go refuses authorization and lists every unmet criterion', () => {
  const request = readyRequest({
    dependenciesAccepted: false,
    reconciliationPassed: false,
    rollbackVerified: false,
    sendOwners: [],
  });

  const result = evaluateGoNoGo(request);
  assert.equal(result.ok, false);
  assert.deepEqual(result.unmet, [
    'dependencies_accepted',
    'reconciliation_passed',
    'rollback_verified',
    'single_send_owner',
  ]);
  assert.equal(result.checks.length, 4);

  assert.throws(
    () => authorizeCutover(request),
    (error: unknown) => {
      assert.ok(error instanceof CutoverRefusedError);
      assert.equal(error.code, 'CUTOVER_REFUSED');
      assert.equal(error.channelKey, 'asset-wa-1');
      assert.deepEqual(error.unmet, [
        'dependencies_accepted',
        'reconciliation_passed',
        'rollback_verified',
        'single_send_owner',
      ]);
      return true;
    },
  );
});

test('cutover: two send owners or a missing owner blocks the single-owner criterion', () => {
  const twoOwners = evaluateGoNoGo(
    readyRequest({
      sendOwners: [
        { channelKey: 'asset-wa-1', owner: 'wazzup' },
        { channelKey: 'asset-wa-1', owner: 'new_contour' },
      ],
    }),
  );
  assert.equal(twoOwners.ok, false);
  assert.deepEqual(twoOwners.unmet, ['single_send_owner']);
  assert.match(twoOwners.checks.find((c) => c.id === 'single_send_owner')?.detail ?? '', /wazzup.*new_contour/);

  const noOwner = evaluateGoNoGo(readyRequest({ sendOwners: [] }));
  assert.deepEqual(noOwner.unmet, ['single_send_owner']);

  const sameOwnerTwice = evaluateGoNoGo(
    readyRequest({
      sendOwners: [
        { channelKey: 'asset-wa-1', owner: 'new_contour' },
        { channelKey: 'asset-wa-1', owner: 'new_contour' },
      ],
    }),
  );
  assert.equal(sameOwnerTwice.ok, true, 'duplicate rows for one owner are still one owner');
});

test('cutover: authorization produces an ordered data-driven plan and a data-safe rollback plan', () => {
  const plan = authorizeCutover(readyRequest());
  assert.equal(plan.channelKey, 'asset-wa-1');
  assert.equal(plan.goNoGo.ok, true);
  assert.equal(plan.steps.length, CUTOVER_STEPS.length);
  assert.equal(plan.rollback.length, ROLLBACK_STEPS.length);
  assert.equal(plan.rollbackGuarantees.preservesData, true);
  assert.equal(plan.rollbackGuarantees.restoresSingleOwner, true);
  assert.equal(plan.rollbackGuarantees.neverRunsBothSenders, true);

  assert.deepEqual(validateCutoverSteps(plan.steps), []);

  const first = plan.steps[0]!;
  assert.deepEqual(
    [...first.preconditions].sort(),
    ['dependencies_accepted', 'reconciliation_passed', 'rollback_verified', 'single_send_owner'],
  );

  const ids = plan.steps.map((step) => step.id);
  assert.deepEqual(ids, [
    'freeze_old_outbound',
    'drain_inflight',
    'transfer_inbound_route',
    'verify_new_ingress',
    'enable_new_outbound',
    'verify_media_and_crm',
    'record_rehearsal',
  ]);

  for (let index = 1; index < plan.steps.length; index += 1) {
    assert.ok(plan.steps[index]!.preconditions.includes(plan.steps[index - 1]!.id));
  }

  const rollbackIds = plan.rollback.map((step) => step.id);
  assert.deepEqual(rollbackIds, [
    'stop_new_effects',
    'preserve_outbox_and_unknown',
    'restore_old_inbound_route',
    'restore_exactly_one_old_sender',
    'reconcile_transition_interval',
    'keep_new_contour_quarantined',
  ]);
  assert.deepEqual(ROLLBACK_GUARANTEES, {
    preservesData: true,
    restoresSingleOwner: true,
    neverRunsBothSenders: true,
  });
});

test('cutover: reconciliation with unexplained discrepancies is not a pass', () => {
  const result = evaluateGoNoGo(
    readyRequest({
      reconciliationPassed: false,
      reconciliationDetail: 'real_loss=2, duplicate=1',
    }),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.unmet, ['reconciliation_passed']);
  assert.match(result.checks.find((c) => c.id === 'reconciliation_passed')?.detail ?? '', /real_loss=2/);
});

test('cutover: validateCutoverSteps reports broken ordering and dangling references', () => {
  const issues = validateCutoverSteps([
    {
      id: 'a',
      title: 'first',
      preconditions: ['missing_criterion'],
      postChecks: ['checked'],
    },
    {
      id: 'b',
      title: 'second',
      preconditions: ['b'],
      postChecks: [],
    },
  ]);
  assert.ok(issues.some((issue) => issue.includes('missing_criterion')));
  assert.ok(issues.some((issue) => issue.includes('b')));
  assert.ok(issues.some((issue) => issue.includes('postChecks')));
});
