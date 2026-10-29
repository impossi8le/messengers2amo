// Acceptance matrix (#21) for docs/messenger-logic-acceptance.ru.md.
//
// The matrix is a report, not a test runner. It parses the 45 contractual
// scenarios, joins them with an explicit registry of test names and with actual
// test results when the caller has them. Without results every covered scenario
// stays NOT RUN: this module never invents a PASS.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Priority = 'P0' | 'P1';
export type ScenarioStatus = 'PASS' | 'FAIL' | 'NOT RUN';
export type TestStatus = 'pass' | 'fail' | 'skipped';

export type AcceptanceScenario = {
  id: string;
  priority: Priority;
  title: string;
};

export type CoverageRegistry = Readonly<Record<string, readonly string[]>>;

export type MatrixRow = {
  id: string;
  priority: Priority;
  title: string;
  /** At least one linked test exists in the test index. */
  covered: boolean;
  /** Linked test names, including broken links. */
  testNames: string[];
  /** Linked names that do not exist in the test index. */
  missingTests: string[];
  status: ScenarioStatus;
};

export type BlockerDetail = {
  id: string;
  reason: 'uncovered' | 'failing' | 'not_run';
  testNames: string[];
};

export type AcceptanceSummary = {
  total: number;
  p0Total: number;
  p1Total: number;
  p0Covered: number;
  p0Uncovered: number;
  p0Pass: number;
  p0Fail: number;
  p0NotRun: number;
  p1Covered: number;
  p1Uncovered: number;
  /** P0 scenarios that are not PASS, in document order. */
  blockers: string[];
  blockerDetails: BlockerDetail[];
  acceptanceBlocked: boolean;
};

export type AcceptanceMatrix = {
  rows: MatrixRow[];
  summary: AcceptanceSummary;
};

export type AcceptanceMatrixInput = {
  scenarios: readonly AcceptanceScenario[];
  coverage?: CoverageRegistry;
  /** Test name -> files that define it. When omitted, links are treated as present. */
  testIndex?: ReadonlyMap<string, readonly string[]>;
  /** Actual outcomes. Missing outcomes mean NOT RUN. */
  results?: ReadonlyMap<string, TestStatus>;
};

export const DEFAULT_ACCEPTANCE_DOC = new URL(
  '../../../../docs/messenger-logic-acceptance.ru.md',
  import.meta.url,
);

export const DEFAULT_TEST_DIR = new URL('../../test/', import.meta.url);

const SCENARIO_PATTERN = /^\*\*(AC\d{2}) · (P0|P1)\.\s*(.+?)\*\*/;
const TEST_DEFINITION_PATTERN = /^test\(\s*(['"])(.+?)\1\s*,/gm;

export async function loadAcceptanceScenarios(
  docPath: string | URL = DEFAULT_ACCEPTANCE_DOC,
): Promise<AcceptanceScenario[]> {
  const text = await readFile(docPath, 'utf8');
  const scenarios: AcceptanceScenario[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = SCENARIO_PATTERN.exec(line);
    if (!match) continue;
    const id = match[1]!;
    const priority = match[2] as Priority;
    const title = match[3]!.trim().replace(/\.$/, '');
    scenarios.push({ id, priority, title });
  }
  return scenarios;
}

/** Indexes test names defined in `*.test.ts` files. */
export async function loadTestIndex(
  testDir: string | URL = DEFAULT_TEST_DIR,
): Promise<Map<string, string[]>> {
  const entries = await readdir(testDir, { withFileTypes: true });
  const index = new Map<string, string[]>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.test.ts')) continue;
    const filePath = typeof testDir === 'string' ? join(testDir, entry.name) : new URL(entry.name, testDir);
    const source = await readFile(filePath, 'utf8');
    for (const match of source.matchAll(TEST_DEFINITION_PATTERN)) {
      const name = match[2]!;
      const files = index.get(name);
      if (files) {
        if (!files.includes(entry.name)) files.push(entry.name);
      } else {
        index.set(name, [entry.name]);
      }
    }
  }
  return index;
}

function statusFor(
  testNames: readonly string[],
  results: ReadonlyMap<string, TestStatus>,
): ScenarioStatus {
  if (testNames.length === 0) return 'NOT RUN';
  const outcomes = testNames.map((name) => results.get(name));
  if (outcomes.some((outcome) => outcome === 'fail')) return 'FAIL';
  if (outcomes.every((outcome) => outcome === 'pass')) return 'PASS';
  return 'NOT RUN';
}

/**
 * Joins scenarios, the explicit coverage registry, the test index and actual
 * results. A scenario is covered only by a test that really exists.
 */
export function buildAcceptanceMatrix(input: AcceptanceMatrixInput): AcceptanceMatrix {
  const coverage = input.coverage ?? DEFAULT_TEST_COVERAGE;
  const testIndex = input.testIndex;
  const results = input.results ?? new Map<string, TestStatus>();

  const rows: MatrixRow[] = input.scenarios.map((scenario) => {
    const testNames = [...(coverage[scenario.id] ?? [])];
    const missingTests =
      testIndex === undefined
        ? []
        : testNames.filter((name) => !testIndex.has(name));
    const existingTests =
      testIndex === undefined
        ? testNames
        : testNames.filter((name) => testIndex.has(name));
    const covered = existingTests.length > 0;
    return {
      id: scenario.id,
      priority: scenario.priority,
      title: scenario.title,
      covered,
      testNames,
      missingTests,
      status: covered ? statusFor(existingTests, results) : 'NOT RUN',
    };
  });

  const p0 = rows.filter((row) => row.priority === 'P0');
  const p1 = rows.filter((row) => row.priority === 'P1');
  const p0Covered = p0.filter((row) => row.covered).length;
  const blockers = p0.filter((row) => row.status !== 'PASS');
  const blockerDetails: BlockerDetail[] = blockers.map((row) => ({
    id: row.id,
    reason: !row.covered ? 'uncovered' : row.status === 'FAIL' ? 'failing' : 'not_run',
    testNames: row.testNames,
  }));

  const summary: AcceptanceSummary = {
    total: rows.length,
    p0Total: p0.length,
    p1Total: p1.length,
    p0Covered,
    p0Uncovered: p0.length - p0Covered,
    p0Pass: p0.filter((row) => row.status === 'PASS').length,
    p0Fail: p0.filter((row) => row.status === 'FAIL').length,
    p0NotRun: p0.filter((row) => row.status === 'NOT RUN').length,
    p1Covered: p1.filter((row) => row.covered).length,
    p1Uncovered: p1.length - p1.filter((row) => row.covered).length,
    blockers: blockers.map((row) => row.id),
    blockerDetails,
    acceptanceBlocked: blockers.length > 0,
  };

  return { rows, summary };
}

/**
 * Explicit scenario -> test-name registry. It is intentionally curated: adding a
 * link asserts that the named test really exercises the scenario. A link that
 * does not resolve to a real test is reported as a broken link and does not
 * count as coverage.
 */
export const DEFAULT_TEST_COVERAGE: CoverageRegistry = {
  AC01: [
    'webhook stores a valid Telegram update durably before ACK',
    'new inbound opens exactly one obligation and replays idempotently',
  ],
  AC02: [
    'duplicate delivery is acknowledged but stored once',
    'webhook deduplicates the same event and rejects a changed payload',
    'a repeated inbound event creates no duplicate contact, lead, chat or message',
  ],
  AC03: [
    'a bad signature is rejected before parsing and never reaches the inbox',
    'no acknowledgement is sent when the durable write fails',
    'signature covers raw bytes, so re-serialized JSON does not verify',
  ],
  AC04: ['reading a conversation never closes the obligation or resets waiting_since'],
  AC05: [
    'substantial edit of an open obligation inherits opened_at and records supersession',
    'editing an already answered message starts a fresh waiting cycle',
  ],
  AC06: ['technical edit is not substantial and creates no new obligation'],
  AC07: [
    'snapshot is exact and a later inbound is not covered by it',
    'an old snapshot does not cover a substantial edit made after it',
  ],
  AC08: ['failed and unknown outcomes keep the obligation open'],
  AC10: ['closing with open obligations needs managerial authority and is audited with the reason'],
  AC11: [
    'accepting the same idempotent command twice creates one operation and one job',
    'the same idempotency key with changed content is rejected and never overwrites',
  ],
  AC12: [
    'a confirmed send marks the operation sent with one attempt and one provider call',
    'whatsapp_cloud: out-of-order statuses never downgrade read to delivered',
  ],
  AC13: [
    'timeout produces unknown, blocks blind retry and survives restart',
    'timeout aborts the request, returns unknown and never retries',
  ],
  AC14: [
    'an expired lease fences the old worker out of the result write',
    'a reclaimed job whose attempt may have reached the network becomes unknown, never a blind resend',
  ],
  AC15: [
    'revoking the only coverage reopens the obligation, but never after a delivered receipt',
    'a delivered receipt blocks withdrawal of a provisional sent',
  ],
  AC17: [
    'two concurrent claims from the same version produce exactly one winner',
    'REPEATABLE READ claim race fails with a retryable conflict instead of overwriting',
  ],
  AC19: [
    'workshop scope restricts reads and writes and never leaks foreign state',
    'a foreign work item is indistinguishable from a missing one on every route',
  ],
  AC20: ['same-name contacts are never merged automatically; a manual ambiguity is recorded'],
  AC21: [
    'a repeated inbound event creates no duplicate contact, lead, chat or message',
    'an unknown creation outcome is reconciled without creating a second entity',
    'a lost contact-creation response survives the rollback and blocks a duplicate',
  ],
  AC23: ['CRM-originated changes never write back to amoCRM'],
  AC24: [
    'CRM contact owner changes never replace the local assignee',
    'a CRM change that disagrees with a platform-owned assignment is recorded as a conflict, not silently applied',
  ],
  AC25: ['a failed sync is stored and exposed in diagnostics without throwing'],
  AC26: ['upload is accepted as pending and only becomes ready after verified bytes'],
  AC27: [
    'remote attachment URLs are SSRF-guarded and never fetched from private hosts',
    'SSRF guard blocks loopback, metadata and private destinations',
  ],
  AC29: [
    'an expired deadline fails the operation without calling the transport',
    'a deadline that expires during a 429 retry delay stops the resend',
  ],
  AC31: ['expired upload reservations and presigned links stop working'],
  AC33: [
    'lifecycle and credential rotation are version-checked and never expose the credential reference',
    'revoked access stops workers, is recorded once, and reconnect restores the account',
  ],
  AC36: ['webhook keeps out-of-order updates and never overwrites an event'],
  AC39: [
    'parallel refresh exchanges the refresh token exactly once and keeps the newest pair',
    'rate limited refresh surfaces 429 explicitly and does not rotate stored tokens',
  ],
  AC41: [
    'capacity fence never lets a staff member exceed capacity',
    'REPEATABLE READ capacity fence admits only one of two parallel assignments',
  ],
  AC43: ['manual coverage requires a confirmed send, records its reason and replays idempotently'],
  AC44: ['substantial edit of an open obligation inherits opened_at and records supersession'],
};
