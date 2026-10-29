// Shared measurement utilities for the load suite.
//
// These are intentionally dependency-free: the load tests must be runnable with
// the same `node --test` toolchain as the rest of the API tests, and the report
// has to be readable in CI logs without a reporter plugin.

export type LatencySummary = {
  count: number;
  minMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  totalMs: number;
  throughputPerSec: number;
};

/**
 * Nearest-rank percentile over an already sorted array. For a 500-sample run
 * p95 is the 475th sample, so the figure is never an interpolation artefact.
 */
export function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index] ?? 0;
}

export function summarize(samples: number[], totalMs: number): LatencySummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    count: sorted.length,
    minMs: sorted[0] ?? 0,
    meanMs: sorted.length > 0 ? sum / sorted.length : 0,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1] ?? 0,
    totalMs,
    throughputPerSec: totalMs > 0 ? (sorted.length * 1000) / totalMs : 0,
  };
}

export function formatSummary(label: string, summary: LatencySummary): string {
  const round = (value: number) => Math.round(value * 100) / 100;
  return [
    `${label}: n=${summary.count}`,
    `total=${round(summary.totalMs)}ms`,
    `throughput=${round(summary.throughputPerSec)}/s`,
    `min=${round(summary.minMs)}ms`,
    `p50=${round(summary.p50Ms)}ms`,
    `p95=${round(summary.p95Ms)}ms`,
    `p99=${round(summary.p99Ms)}ms`,
    `max=${round(summary.maxMs)}ms`,
    `mean=${round(summary.meanMs)}ms`,
  ].join(' ');
}

/**
 * Runs `worker` over `items` with a fixed number of in-flight tasks. Every
 * item is processed exactly once and the first failure aborts the run: a load
 * test that silently swallows errors would report a green run over lost work.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (concurrency < 1) throw new Error('concurrency must be >= 1');
  let next = 0;
  let failure: unknown = null;

  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (failure === null) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      try {
        await worker(item, index);
      } catch (error) {
        failure = error;
        return;
      }
    }
  });

  await Promise.all(lanes);
  if (failure !== null) throw failure;
}

export function nowMs(): number {
  return performance.now();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
