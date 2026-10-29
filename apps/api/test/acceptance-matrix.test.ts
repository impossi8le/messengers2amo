import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAcceptanceMatrix,
  loadAcceptanceScenarios,
  loadTestIndex,
  DEFAULT_TEST_COVERAGE,
  type AcceptanceScenario,
} from '../src/acceptance/matrix.ts';

const scenarios: AcceptanceScenario[] = [
  { id: 'AC01', priority: 'P0', title: 'first' },
  { id: 'AC02', priority: 'P0', title: 'second' },
  { id: 'AC03', priority: 'P1', title: 'third' },
];

test('acceptance matrix: the real document yields all 45 scenarios with priorities', async () => {
  const loaded = await loadAcceptanceScenarios();
  assert.equal(loaded.length, 45);
  assert.deepEqual(
    loaded.map((scenario) => scenario.id),
    Array.from({ length: 45 }, (_, index) => `AC${String(index + 1).padStart(2, '0')}`),
  );
  assert.equal(loaded.filter((scenario) => scenario.priority === 'P0').length, 34);
  assert.equal(loaded.filter((scenario) => scenario.priority === 'P1').length, 11);
  assert.equal(loaded[0]?.title, 'Надежный прием');
  assert.equal(loaded[44]?.title, 'Граница доступа amoCRM');
});

test('acceptance matrix: P0 coverage counts only scenarios linked to existing tests', () => {
  const matrix = buildAcceptanceMatrix({
    scenarios,
    coverage: {
      AC01: ['test one'],
      AC02: ['missing test'],
      AC03: ['test three'],
    },
    testIndex: new Map([
      ['test one', ['a.test.ts']],
      ['test three', ['b.test.ts']],
    ]),
    results: new Map([
      ['test one', 'pass'],
      ['test three', 'pass'],
    ]),
  });

  const ac01 = matrix.rows.find((row) => row.id === 'AC01');
  assert.equal(ac01?.covered, true);
  assert.equal(ac01?.status, 'PASS');
  assert.deepEqual(ac01?.missingTests, []);

  const ac02 = matrix.rows.find((row) => row.id === 'AC02');
  assert.equal(ac02?.covered, false);
  assert.equal(ac02?.status, 'NOT RUN');
  assert.deepEqual(ac02?.missingTests, ['missing test']);

  assert.equal(matrix.summary.p0Total, 2);
  assert.equal(matrix.summary.p0Covered, 1);
  assert.equal(matrix.summary.p0Uncovered, 1);
  assert.equal(matrix.summary.p0Pass, 1);
  assert.equal(matrix.summary.p0Fail, 0);
  assert.equal(matrix.summary.p0NotRun, 1);
  assert.equal(matrix.summary.p1Covered, 1);
  assert.deepEqual(matrix.summary.blockers, ['AC02']);
  assert.equal(matrix.summary.acceptanceBlocked, true);
});

test('acceptance matrix: a failing P0 test blocks acceptance even when the scenario is covered', () => {
  const matrix = buildAcceptanceMatrix({
    scenarios: scenarios.slice(0, 1),
    coverage: { AC01: ['test one'] },
    testIndex: new Map([['test one', ['a.test.ts']]]),
    results: new Map([['test one', 'fail']]),
  });

  assert.equal(matrix.rows[0]?.status, 'FAIL');
  assert.equal(matrix.summary.p0Fail, 1);
  assert.deepEqual(matrix.summary.blockers, ['AC01']);
  assert.equal(matrix.summary.acceptanceBlocked, true);
});

test('acceptance matrix: covered but unexecuted scenarios are NOT RUN, never PASS', () => {
  const matrix = buildAcceptanceMatrix({
    scenarios: scenarios.slice(0, 1),
    coverage: { AC01: ['test one'] },
    testIndex: new Map([['test one', ['a.test.ts']]]),
  });

  assert.equal(matrix.rows[0]?.covered, true);
  assert.equal(matrix.rows[0]?.status, 'NOT RUN');
  assert.equal(matrix.summary.p0Pass, 0);
  assert.equal(matrix.summary.p0NotRun, 1);
  assert.equal(matrix.summary.acceptanceBlocked, true);
});

test('acceptance matrix: every default coverage link names an existing test', async () => {
  const loaded = await loadAcceptanceScenarios();
  const testIndex = await loadTestIndex();
  assert.ok(testIndex.size > 100, `expected a populated test index, got ${testIndex.size}`);

  const matrix = buildAcceptanceMatrix({
    scenarios: loaded,
    coverage: DEFAULT_TEST_COVERAGE,
    testIndex,
  });

  const broken = matrix.rows.flatMap((row) =>
    row.missingTests.map((name) => `${row.id}: ${name}`),
  );
  assert.deepEqual(broken, [], `coverage links must resolve to real tests:\n${broken.join('\n')}`);
  assert.ok(matrix.summary.p0Covered > 0);
  assert.equal(matrix.summary.p0Covered + matrix.summary.p0Uncovered, matrix.summary.p0Total);
  assert.equal(matrix.summary.acceptanceBlocked, true);
  assert.ok(matrix.summary.blockers.length > 0);
});
