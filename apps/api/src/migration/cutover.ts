// Channel cutover model (#19/#20). This module is deliberately side-effect free:
// it decides whether a cutover may be authorized and describes the ordered steps
// and the rollback. Executing the provider-side procedure stays a human runbook.

export const CUTOVER_CRITERIA = [
  'dependencies_accepted',
  'reconciliation_passed',
  'rollback_verified',
  'single_send_owner',
] as const;

export type CutoverCriterionId = (typeof CUTOVER_CRITERIA)[number];

export type SendOwnerRef = { channelKey: string; owner: string };

export type CutoverRequest = {
  channelKey: string;
  /** All accepted dependencies (#17 inventory, deployed contour, confirmed accesses). */
  dependenciesAccepted: boolean;
  /** Pilot reconciliation produced no real loss, duplicate or normalization error. */
  reconciliationPassed: boolean;
  /** The rollback procedure was actually rehearsed on the same connection mode. */
  rollbackVerified: boolean;
  /** Current send owners for every asset; exactly one entry for channelKey is required. */
  sendOwners: readonly SendOwnerRef[];
  /** Optional human-readable evidence, kept out of the decision itself. */
  pendingDependencies?: readonly string[];
  reconciliationDetail?: string;
  rollbackEvidence?: string;
};

export type GoNoGoCheck = {
  id: CutoverCriterionId;
  title: string;
  ok: boolean;
  detail: string;
};

export type GoNoGoResult = {
  ok: boolean;
  checks: GoNoGoCheck[];
  unmet: CutoverCriterionId[];
};

export type CutoverStep = {
  id: string;
  title: string;
  /** Criterion ids or ids of earlier steps. */
  preconditions: readonly string[];
  /** Facts that must be recorded after the step. */
  postChecks: readonly string[];
};

export type RollbackStep = {
  id: string;
  title: string;
  actions: readonly string[];
  verifies: readonly string[];
};

export type CutoverPlan = {
  channelKey: string;
  goNoGo: GoNoGoResult;
  steps: readonly CutoverStep[];
  rollback: readonly RollbackStep[];
  rollbackGuarantees: typeof ROLLBACK_GUARANTEES;
};

export class CutoverRefusedError extends Error {
  readonly code = 'CUTOVER_REFUSED';
  readonly channelKey: string;
  readonly unmet: CutoverCriterionId[];
  readonly checks: GoNoGoCheck[];
  constructor(channelKey: string, checks: GoNoGoCheck[]) {
    const unmet = checks.filter((check) => !check.ok).map((check) => check.id);
    super(`cutover refused for ${channelKey}: ${unmet.join(', ')}`);
    this.name = 'CutoverRefusedError';
    this.channelKey = channelKey;
    this.unmet = unmet;
    this.checks = checks;
  }
}

const CHECK_TITLES: Record<CutoverCriterionId, string> = {
  dependencies_accepted: 'Dependencies accepted',
  reconciliation_passed: 'Pilot reconciliation passed',
  rollback_verified: 'Rollback procedure verified',
  single_send_owner: 'Exactly one send owner',
};

export function evaluateGoNoGo(request: CutoverRequest): GoNoGoResult {
  const ownerNames = [
    ...new Set(
      request.sendOwners
        .filter((entry) => entry.channelKey === request.channelKey && entry.owner.length > 0)
        .map((entry) => entry.owner),
    ),
  ];
  const pending = request.pendingDependencies ?? [];

  const checks: GoNoGoCheck[] = [
    {
      id: 'dependencies_accepted',
      title: CHECK_TITLES.dependencies_accepted,
      ok: request.dependenciesAccepted === true && pending.length === 0,
      detail:
        request.dependenciesAccepted === true
          ? pending.length === 0
            ? 'all dependencies accepted'
            : `pending dependencies: ${pending.join(', ')}`
          : 'dependencies are not accepted',
    },
    {
      id: 'reconciliation_passed',
      title: CHECK_TITLES.reconciliation_passed,
      ok: request.reconciliationPassed === true,
      detail:
        request.reconciliationDetail ??
        (request.reconciliationPassed === true ? 'no blocking discrepancies' : 'reconciliation is not passed'),
    },
    {
      id: 'rollback_verified',
      title: CHECK_TITLES.rollback_verified,
      ok: request.rollbackVerified === true,
      detail:
        request.rollbackEvidence ??
        (request.rollbackVerified === true ? 'rollback was verified' : 'rollback was not verified'),
    },
    {
      id: 'single_send_owner',
      title: CHECK_TITLES.single_send_owner,
      ok: ownerNames.length === 1,
      detail:
        ownerNames.length === 1
          ? `owner: ${ownerNames[0]!}`
          : ownerNames.length === 0
            ? 'no send owner'
            : `multiple send owners: ${ownerNames.join(', ')}`,
    },
  ];

  const unmet = checks.filter((check) => !check.ok).map((check) => check.id);
  return { ok: unmet.length === 0, checks, unmet };
}

/** Ordered cutover steps from the runbook, expressed as data. */
export const CUTOVER_STEPS: readonly CutoverStep[] = [
  {
    id: 'freeze_old_outbound',
    title: 'Freeze old outbound and CRM projection',
    preconditions: [...CUTOVER_CRITERIA],
    postChecks: [
      'every old sender and CRM projector confirmed stopped',
      'no new old-contour outbound job can be claimed',
    ],
  },
  {
    id: 'drain_inflight',
    title: 'Drain and record in-flight operations',
    preconditions: ['freeze_old_outbound'],
    postChecks: [
      'pending, in-flight and unknown operations recorded',
      'no unknown operation is retried automatically',
      'transition interval boundaries recorded',
    ],
  },
  {
    id: 'transfer_inbound_route',
    title: 'Transfer the inbound route to the new contour',
    preconditions: ['drain_inflight'],
    postChecks: [
      'exactly one inbound owner for the selected connection',
      'other connections are unchanged',
    ],
  },
  {
    id: 'verify_new_ingress',
    title: 'Verify ingress in the new contour',
    preconditions: ['transfer_inbound_route'],
    postChecks: [
      'messages from two test senders create two distinct conversations',
      'a repeated event creates no duplicate',
      'ingress survives a restart',
      'an inbound arriving during a reply is not covered by the old snapshot',
    ],
  },
  {
    id: 'enable_new_outbound',
    title: 'Enable new outbound and CRM effects',
    preconditions: ['verify_new_ingress'],
    postChecks: [
      'one controlled reply has a confirmed external result',
      'exactly one CRM projection is created',
      'an unknown result stops further sends and starts reconciliation',
    ],
  },
  {
    id: 'verify_media_and_crm',
    title: 'Verify media, CRM links and unanswered state',
    preconditions: ['enable_new_outbound'],
    postChecks: [
      'attachment is linked to the original event under inherited permissions',
      'CRM links, unread and unanswered state are correct',
      'no duplicates exist in either contour',
    ],
  },
  {
    id: 'record_rehearsal',
    title: 'Record the rehearsal and execute the rollback',
    preconditions: ['verify_media_and_crm'],
    postChecks: [
      'rollback is executed even after a successful forward path',
      'actual durations, counters and deviations are recorded',
      'production readiness is not claimed from a local bot rehearsal alone',
    ],
  },
];

/** Rollback plan: stop new effects, preserve evidence, restore exactly one old owner. */
export const ROLLBACK_STEPS: readonly RollbackStep[] = [
  {
    id: 'stop_new_effects',
    title: 'Stop new outbound and CRM projection',
    actions: [
      'disable new outbound sending and CRM projection',
      'confirm no new jobs are handed out',
    ],
    verifies: ['new contour has no send owner', 'outbox is preserved'],
  },
  {
    id: 'preserve_outbox_and_unknown',
    title: 'Preserve outbox, attempts and unknown results',
    actions: [
      'record pending, in-flight and unknown operations',
      'do not re-send all messages and do not merge events by text alone',
    ],
    verifies: ['unknown outcomes remain available for manual review', 'no automatic replay is scheduled'],
  },
  {
    id: 'restore_old_inbound_route',
    title: 'Restore the old inbound route',
    actions: ['apply the confirmed provider procedure for the same connection mode'],
    verifies: ['a control inbound reaches the old contour'],
  },
  {
    id: 'restore_exactly_one_old_sender',
    title: 'Restore exactly one old sender and CRM projector',
    actions: ['re-enable one old sender', 're-enable one old CRM projector'],
    verifies: ['one control reply has a confirmed external result', 'exactly one CRM projection exists'],
  },
  {
    id: 'reconcile_transition_interval',
    title: 'Reconcile the transition interval',
    actions: ['compare events, CRM links, conversations and attachments for the whole interval'],
    verifies: ['every discrepancy is explained', 'ambiguous cases are handed to a human'],
  },
  {
    id: 'keep_new_contour_quarantined',
    title: 'Keep the new contour fenced',
    actions: ['leave the new contour without send ownership', 'preserve its data and logs for analysis'],
    verifies: ['both senders are never active at once', 'data is not deleted'],
  },
];

export const ROLLBACK_GUARANTEES = {
  preservesData: true,
  restoresSingleOwner: true,
  neverRunsBothSenders: true,
} as const;

const KNOWN_CRITERIA = new Set<string>(CUTOVER_CRITERIA);

/**
 * Structural validation of a cutover plan. Returns human-readable issues; an
 * empty array means every precondition resolves to a criterion or an earlier step.
 */
export function validateCutoverSteps(steps: readonly CutoverStep[]): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();

  for (const step of steps) {
    if (seen.has(step.id)) issues.push(`${step.id}: duplicate step id`);
    seen.add(step.id);
    if (step.postChecks.length === 0) issues.push(`${step.id}: postChecks must not be empty`);
  }

  const order = new Map<string, number>();
  steps.forEach((step, index) => order.set(step.id, index));

  for (const step of steps) {
    for (const precondition of step.preconditions) {
      if (precondition === step.id) {
        issues.push(`${step.id}: step cannot depend on itself (${precondition})`);
        continue;
      }
      if (KNOWN_CRITERIA.has(precondition)) continue;
      const index = order.get(precondition);
      if (index === undefined) {
        issues.push(`${step.id}: unknown precondition ${precondition}`);
        continue;
      }
      if (index >= (order.get(step.id) ?? 0)) {
        issues.push(`${step.id}: precondition ${precondition} must be an earlier step`);
      }
    }
  }

  return issues;
}

/**
 * Authorizes a cutover only when every go/no-go criterion is met.
 * Refusal is explicit and carries the full list of unmet criteria.
 */
export function authorizeCutover(request: CutoverRequest): CutoverPlan {
  const goNoGo = evaluateGoNoGo(request);
  if (!goNoGo.ok) throw new CutoverRefusedError(request.channelKey, goNoGo.checks);

  return {
    channelKey: request.channelKey,
    goNoGo,
    steps: CUTOVER_STEPS,
    rollback: ROLLBACK_STEPS,
    rollbackGuarantees: ROLLBACK_GUARANTEES,
  };
}
