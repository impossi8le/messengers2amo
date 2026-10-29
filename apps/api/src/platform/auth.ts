import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

export type Role = 'read' | 'send' | 'manage' | 'admin';

export type Session = {
  /** Server-side session row id. Every request validates it, so revocation is immediate. */
  sessionId: string;
  staffId: string;
  companyId: string;
  role: Role;
  workshopId: string | null;
  /** Authorization version the session was issued for; a grant change invalidates it. */
  epoch: number;
  expiresAt: number;
};

export const ROLE_RANK: Record<Role, number> = { read: 0, send: 1, manage: 2, admin: 3 };

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: typeof SCRYPT_OPTIONS,
) => Promise<Buffer>;

/**
 * scrypt is deliberately expensive (~33 ms at N=16384). Running it synchronously
 * would stall every other request on the event loop, so it runs on the libuv pool
 * and the number of simultaneous checks is capped. Excess checks queue; a queue
 * that grows past the bound is refused instead of hoarding memory.
 */
export const MAX_CONCURRENT_PASSWORD_CHECKS = 4;
const MAX_QUEUED_PASSWORD_CHECKS = 64;

/** Thrown when the password-check queue is saturated; callers answer 503 and retry. */
export class PasswordCheckBusyError extends Error {
  readonly code = 'password_check_busy';
  constructor() {
    super('password_check_busy');
    this.name = 'PasswordCheckBusyError';
  }
}

let activeChecks = 0;
let maxObservedChecks = 0;
let totalChecks = 0;
const waitingChecks: Array<() => void> = [];

function acquireCheckSlot(): Promise<void> | null {
  if (activeChecks < MAX_CONCURRENT_PASSWORD_CHECKS) {
    activeChecks += 1;
    if (activeChecks > maxObservedChecks) maxObservedChecks = activeChecks;
    return null;
  }
  if (waitingChecks.length >= MAX_QUEUED_PASSWORD_CHECKS) throw new PasswordCheckBusyError();
  return new Promise<void>((resolve) => {
    waitingChecks.push(() => {
      // The slot is handed over, so `activeChecks` does not change here.
      if (activeChecks > maxObservedChecks) maxObservedChecks = activeChecks;
      resolve();
    });
  });
}

function releaseCheckSlot(): void {
  const next = waitingChecks.shift();
  if (next) next();
  else activeChecks -= 1;
}

/** Observability hook for tests and metrics; never exposes passwords. */
export function scryptStats(): { active: number; maxObserved: number; total: number } {
  return { active: activeChecks, maxObserved: maxObservedChecks, total: totalChecks };
}

export function resetScryptStats(): void {
  maxObservedChecks = activeChecks;
  totalChecks = 0;
}

export async function hashPassword(password: string, salt: string): Promise<string> {
  const slot = acquireCheckSlot();
  if (slot) await slot;
  totalChecks += 1;
  try {
    const key = await scryptAsync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS);
    return key.toString('hex');
  } finally {
    releaseCheckSlot();
  }
}

export async function createPasswordRecord(password: string): Promise<{ salt: string; hash: string }> {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: await hashPassword(password, salt) };
}

export async function verifyPassword(password: string, salt: string, expectedHash: string): Promise<boolean> {
  let actual: Buffer;
  let expected: Buffer;
  try {
    actual = Buffer.from(await hashPassword(password, salt), 'hex');
    expected = Buffer.from(expectedHash, 'hex');
  } catch (error) {
    // Saturation is a transient server condition, not a wrong password.
    if (error instanceof PasswordCheckBusyError) throw error;
    return false;
  }
  if (actual.length !== expected.length || actual.length === 0) return false;
  return timingSafeEqual(actual, expected);
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function encodeSession(secret: string, session: Session): string {
  const payload = Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

export function decodeSession(secret: string, token: string, now = Date.now()): Session | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const payload = parts[0];
  const signature = parts[1];
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(secret, payload), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  let parsed: Session;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Session;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.staffId !== 'string' || typeof parsed.expiresAt !== 'number') return null;
  if (typeof parsed.sessionId !== 'string' || parsed.sessionId.length === 0) return null;
  if (parsed.expiresAt <= now) return null;
  return parsed;
}

export function roleAtLeast(role: Role, required: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

export function issueSession(secret: string, session: Omit<Session, 'expiresAt'>, ttlSeconds: number): string {
  return encodeSession(secret, { ...session, expiresAt: Date.now() + ttlSeconds * 1000 });
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('base64url')}`;
}

/** Stable digest of a command payload, used for idempotency conflict detection. */
export function fingerprint(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.keys(input as Record<string, unknown>)
          .sort()
          .map((key) => [key, canonical((input as Record<string, unknown>)[key])]),
      );
    }
    return input;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value)), 'utf8').digest('hex');
}
