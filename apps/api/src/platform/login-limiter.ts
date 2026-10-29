/**
 * Login throttling. Two independent limits protect the password check:
 *
 * - a sliding window of failures per key (IP + company + staff id): once the cap is
 *   reached the key is refused outright for the rest of the window;
 * - an enforced delay before every verification that doubles with each failure, so
 *   even attempts under the cap cost an attacker real time.
 *
 * State is per process and bounded; the hard cap on attempts is the load-bearing
 * part, the delay only slows a determined attacker down.
 */

export type LoginLimiterOptions = {
  /** Failures allowed inside one window before the key is refused. */
  maxFailures?: number;
  /** Window length in milliseconds; also the block duration once tripped. */
  windowMs?: number;
  /** Delay before the first retry after a failure; doubles per failure. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Upper bound on tracked keys, so the map cannot grow without limit. */
  maxKeys?: number;
  now?: () => number;
};

export type LoginGate =
  | { allowed: true; delayMs: number }
  | { allowed: false; retryAfterMs: number };

type Entry = {
  failures: number;
  firstFailureAt: number;
  blockedUntil: number;
};

const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 4_000;
const DEFAULT_MAX_KEYS = 10_000;

export class LoginRateLimiter {
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxKeys: number;
  private readonly clock: () => number;
  private readonly entries = new Map<string, Entry>();

  constructor(options: LoginLimiterOptions = {}) {
    this.maxFailures = Math.max(1, options.maxFailures ?? DEFAULT_MAX_FAILURES);
    this.windowMs = Math.max(1, options.windowMs ?? DEFAULT_WINDOW_MS);
    this.baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
    this.maxDelayMs = Math.max(this.baseDelayMs, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
    this.maxKeys = Math.max(1, options.maxKeys ?? DEFAULT_MAX_KEYS);
    this.clock = options.now ?? (() => Date.now());
  }

  /** Decides whether this attempt may proceed and how long to wait first. */
  begin(key: string): LoginGate {
    const now = this.clock();
    const entry = this.entries.get(key);
    if (!entry) return { allowed: true, delayMs: 0 };
    if (entry.blockedUntil > now) return { allowed: false, retryAfterMs: entry.blockedUntil - now };
    if (entry.failures > 0 && now - entry.firstFailureAt >= this.windowMs) {
      this.entries.delete(key);
      return { allowed: true, delayMs: 0 };
    }
    if (entry.failures === 0) return { allowed: true, delayMs: 0 };
    const delayMs = Math.min(this.baseDelayMs * 2 ** (entry.failures - 1), this.maxDelayMs);
    return { allowed: true, delayMs };
  }

  fail(key: string): void {
    const now = this.clock();
    const entry = this.entries.get(key) ?? { failures: 0, firstFailureAt: 0, blockedUntil: 0 };
    if (entry.firstFailureAt === 0 || now - entry.firstFailureAt >= this.windowMs) {
      entry.failures = 0;
      entry.firstFailureAt = now;
      entry.blockedUntil = 0;
    }
    entry.failures += 1;
    if (entry.failures >= this.maxFailures) entry.blockedUntil = now + this.windowMs;
    this.entries.set(key, entry);
    this.prune(now);
  }

  /** A successful login clears the key: one good password is not punished for old misses. */
  succeed(key: string): void {
    this.entries.delete(key);
  }

  reset(): void {
    this.entries.clear();
  }

  private prune(now: number): void {
    if (this.entries.size <= this.maxKeys) return;
    for (const [key, entry] of this.entries) {
      if (entry.blockedUntil <= now && now - entry.firstFailureAt >= this.windowMs) this.entries.delete(key);
    }
    // Still over budget: drop the oldest windows first.
    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

/** Rate-limit key: a staff id alone must not let one IP spread attempts across accounts. */
export function loginAttemptKey(ip: string, companyId: string, staffId: string): string {
  return `${ip}\u0000${companyId}\u0000${staffId}`;
}
