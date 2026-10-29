import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { createTestApp, cookieFromResponse } from './helpers/app.ts';
import { seedCompany } from './helpers/seed.ts';
import {
  createPasswordRecord,
  verifyPassword,
  scryptStats,
  resetScryptStats,
  MAX_CONCURRENT_PASSWORD_CHECKS,
} from '../src/platform/auth.ts';
import { LoginRateLimiter } from '../src/platform/login-limiter.ts';

const PASSWORD = 'correct horse battery staple';

function login(app: FastifyInstance, companyId: string, staffId: string, password = PASSWORD) {
  return app.inject({
    method: 'POST',
    url: '/api/v2/auth/login',
    payload: { companyId, staffId, password },
  });
}

/**
 * The password check must not run on the event loop thread. A 0 ms timer scheduled
 * right before the check fires almost immediately when scrypt runs on the libuv
 * thread pool, and only after the whole ~33 ms hash when it runs synchronously.
 */
test('password verification yields the event loop instead of blocking it', async () => {
  const record = await createPasswordRecord(PASSWORD);

  // The property that matters is ordering, not a millisecond budget: a zero-delay
  // timer scheduled before verification must fire while verification is still
  // running. If scrypt blocked the loop, the timer could only fire afterwards.
  // An absolute time bound would flake whenever the machine is busy.
  let timerFired = false;
  let firedBeforeVerifyResolved = false;
  const timer = new Promise<void>((resolve) => {
    setTimeout(() => {
      timerFired = true;
      resolve();
    }, 0);
  });

  const verified = await verifyPassword(PASSWORD, record.salt, record.hash);
  firedBeforeVerifyResolved = timerFired;
  assert.equal(verified, true);

  await timer;
  assert.equal(
    firedBeforeVerifyResolved,
    true,
    'the event loop was blocked for the whole verification: a zero-delay timer did not run until it finished',
  );
});

test('concurrent password checks are capped and actually run in parallel', async () => {
  const record = await createPasswordRecord(PASSWORD);
  resetScryptStats();
  const results = await Promise.all(
    Array.from({ length: MAX_CONCURRENT_PASSWORD_CHECKS * 3 }, () =>
      verifyPassword(PASSWORD, record.salt, record.hash),
    ),
  );
  assert.ok(results.every(Boolean));
  const stats = scryptStats();
  assert.ok(
    stats.maxObserved <= MAX_CONCURRENT_PASSWORD_CHECKS,
    `at most ${MAX_CONCURRENT_PASSWORD_CHECKS} checks may run at once, saw ${stats.maxObserved}`,
  );
  assert.ok(stats.maxObserved >= 2, 'queued checks must be able to overlap, not serialize');
  assert.equal(stats.active, 0, 'every slot must be released');
});

test('parallel logins do not block each other and the event loop keeps ticking', async () => {
  const { app, db, close } = await createTestApp();
  try {
    const staff = Array.from({ length: 8 }, (_, index) => ({
      id: `s${index}`,
      password: PASSWORD,
      role: 'read' as const,
    }));
    await seedCompany(db, { companyId: 'c1', staff });

    resetScryptStats();
    let ticks = 0;
    const heartbeat = setInterval(() => {
      ticks += 1;
    }, 5);
    try {
      const responses = await Promise.all(staff.map((member) => login(app, 'c1', member.id)));
      assert.deepEqual(
        responses.map((response) => response.statusCode),
        staff.map(() => 200),
      );
      for (const response of responses) assert.ok(cookieFromResponse(response));
    } finally {
      clearInterval(heartbeat);
    }

    assert.ok(ticks >= 3, `the event loop must stay responsive during logins, saw ${ticks} ticks`);
    assert.ok(scryptStats().maxObserved >= 2, 'logins must verify passwords concurrently');
    assert.ok(scryptStats().maxObserved <= MAX_CONCURRENT_PASSWORD_CHECKS);
  } finally {
    await close();
  }
});

test('login attempts are rate limited per IP and staff id with exponential delay', async () => {
  const { app, db, close } = await createTestApp({}, {
    auth: { login: { maxFailures: 3, windowMs: 60_000, baseDelayMs: 1, maxDelayMs: 4 } },
  });
  try {
    await seedCompany(db, {
      companyId: 'c1',
      staff: [
        { id: 's1', password: PASSWORD, role: 'read' },
        { id: 's2', password: PASSWORD, role: 'read' },
      ],
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await login(app, 'c1', 's1', 'wrong password');
      assert.equal(response.statusCode, 401, `attempt ${attempt + 1} must be a plain rejection`);
    }

    // The cap is reached: even the correct password is refused without verification.
    resetScryptStats();
    const blocked = await login(app, 'c1', 's1');
    assert.equal(blocked.statusCode, 429);
    const body = blocked.json() as { code: string; retryable: boolean };
    assert.equal(body.code, 'RATE_LIMITED');
    assert.equal(body.retryable, true);
    assert.ok(blocked.headers['retry-after']);
    assert.equal(scryptStats().total, 0, 'a blocked attempt must not spend CPU on scrypt');

    // Another staff id from the same IP is a different key and still works.
    const other = await login(app, 'c1', 's2');
    assert.equal(other.statusCode, 200);

    // Unknown staff ids are limited too (they cannot be used as an oracle).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal((await login(app, 'c1', 'ghost', 'nope')).statusCode, 401);
    }
    assert.equal((await login(app, 'c1', 'ghost', 'nope')).statusCode, 429);
  } finally {
    await close();
  }
});

test('the limiter backs off exponentially and forgives after the window', () => {
  let now = 1_000_000;
  const limiter = new LoginRateLimiter({
    maxFailures: 4,
    windowMs: 60_000,
    baseDelayMs: 250,
    maxDelayMs: 2_000,
    now: () => now,
  });
  const key = 'ip|company|staff';

  const delays: number[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const gate = limiter.begin(key);
    assert.equal(gate.allowed, true);
    if (gate.allowed) delays.push(gate.delayMs);
    limiter.fail(key);
  }
  assert.deepEqual(delays, [0, 250, 500], 'each failure doubles the enforced delay');

  limiter.fail(key); // fourth failure trips the cap
  const blocked = limiter.begin(key);
  assert.equal(blocked.allowed, false);
  if (!blocked.allowed) assert.equal(blocked.retryAfterMs, 60_000);

  now += 59_000;
  assert.equal(limiter.begin(key).allowed, false);
  now += 1_001;
  const forgiven = limiter.begin(key);
  assert.equal(forgiven.allowed, true);
  if (forgiven.allowed) assert.equal(forgiven.delayMs, 0, 'a new window starts from zero');

  // A success clears the counter for that key only.
  limiter.fail(key);
  limiter.succeed(key);
  const afterSuccess = limiter.begin(key);
  assert.equal(afterSuccess.allowed, true);
  if (afterSuccess.allowed) assert.equal(afterSuccess.delayMs, 0);
});
