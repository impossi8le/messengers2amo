import type { Db, Tx } from '../platform/db.ts';
import { randomId, verifyPassword, type Role, type Session } from '../platform/auth.ts';

export type AccessGrant = {
  role: Role;
  workshopId: string | null;
  version: number;
};

export type IssuedSession = {
  session: Session;
};

// Used to keep failed-login timing close to a successful one for unknown staff ids.
const DUMMY_SALT = 'f'.repeat(32);
const DUMMY_HASH = 'f'.repeat(128);

type CredentialRow = {
  salt: string;
  password_hash: string;
  algorithm: string;
  role: Role | null;
  workshop_id: string | null;
  version: string | null;
};

/**
 * Verifies a staff credential and returns the current authorization grant.
 * Any missing piece (credential, grant, unknown algorithm) denies access.
 * Unknown "native amoCRM" actors simply have no local grant and are denied here.
 */
export async function authenticate(
  db: Db | Tx,
  companyId: string,
  staffId: string,
  password: string,
): Promise<AccessGrant | null> {
  const { rows } = await db.query<CredentialRow>(
    `SELECT c.salt, c.password_hash, c.algorithm, a.role, a.workshop_id, a.version
       FROM staff_credentials c
       LEFT JOIN staff_access a ON a.company_id = c.company_id AND a.staff_id = c.staff_id
      WHERE c.company_id = $1 AND c.staff_id = $2`,
    [companyId, staffId],
  );
  const row = rows[0];
  if (!row) {
    // Same scrypt cost as a real check: an unknown staff id must not be faster,
    // otherwise the response time enumerates accounts.
    await verifyPassword(password, DUMMY_SALT, DUMMY_HASH);
    return null;
  }
  if (row.algorithm !== 'scrypt') {
    await verifyPassword(password, DUMMY_SALT, DUMMY_HASH);
    return null;
  }
  if (!(await verifyPassword(password, row.salt, row.password_hash))) return null;
  if (!row.role || row.version === null) return null;
  return { role: row.role, workshopId: row.workshop_id, version: Number(row.version) };
}

export async function createSession(
  db: Db | Tx,
  input: {
    companyId: string;
    staffId: string;
    role: Role;
    workshopId: string | null;
    epoch: number;
    ttlSeconds: number;
    now?: number;
  },
): Promise<IssuedSession> {
  const now = input.now ?? Date.now();
  const sessionId = randomId('sess');
  const expiresAt = now + input.ttlSeconds * 1000;
  await db.query(
    `INSERT INTO staff_sessions (company_id, id, staff_id, epoch, issued_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [input.companyId, sessionId, input.staffId, input.epoch, new Date(now), new Date(expiresAt)],
  );
  return {
    session: {
      sessionId,
      staffId: input.staffId,
      companyId: input.companyId,
      role: input.role,
      workshopId: input.workshopId,
      epoch: input.epoch,
      expiresAt,
    },
  };
}

type SessionRow = {
  id: string;
  staff_id: string;
  epoch: string;
  expires_at: Date;
  role: Role | null;
  workshop_id: string | null;
  access_version: string | null;
};

/**
 * Resolves a signed cookie into a live session. The cookie is never trusted on its own:
 * the session row must be unrevoked and unexpired, and the authorization version must
 * still match, so revocation and role changes take effect on the very next request.
 */
export async function loadSession(
  db: Db | Tx,
  decoded: Session,
  now = Date.now(),
): Promise<Session | null> {
  const { rows } = await db.query<SessionRow>(
    `SELECT s.id, s.staff_id, s.epoch, s.expires_at,
            a.role, a.workshop_id, a.version AS access_version
       FROM staff_sessions s
       LEFT JOIN staff_access a ON a.company_id = s.company_id AND a.staff_id = s.staff_id
      WHERE s.company_id = $1 AND s.id = $2 AND s.staff_id = $3
        AND s.revoked_at IS NULL
        AND s.expires_at > $4`,
    [decoded.companyId, decoded.sessionId, decoded.staffId, new Date(now)],
  );
  const row = rows[0];
  if (!row) return null;
  if (!row.role || row.access_version === null) return null;
  if (Number(row.epoch) !== Number(row.access_version)) return null;
  if (row.expires_at.getTime() <= now) return null;
  return {
    sessionId: row.id,
    staffId: row.staff_id,
    companyId: decoded.companyId,
    role: row.role,
    workshopId: row.workshop_id,
    epoch: Number(row.epoch),
    expiresAt: row.expires_at.getTime(),
  };
}

export async function revokeSession(
  db: Db | Tx,
  companyId: string,
  sessionId: string,
  now = Date.now(),
): Promise<boolean> {
  const result = await db.query(
    `UPDATE staff_sessions SET revoked_at = $3
      WHERE company_id = $1 AND id = $2 AND revoked_at IS NULL`,
    [companyId, sessionId, new Date(now)],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function revokeStaffSessions(
  db: Db | Tx,
  companyId: string,
  staffId: string,
  now = Date.now(),
): Promise<number> {
  const result = await db.query(
    `UPDATE staff_sessions SET revoked_at = $3
      WHERE company_id = $1 AND staff_id = $2 AND revoked_at IS NULL`,
    [companyId, staffId, new Date(now)],
  );
  return result.rowCount ?? 0;
}

export type AccessUpdateResult =
  | { kind: 'updated'; grant: AccessGrant }
  | { kind: 'version_conflict' }
  | { kind: 'not_found' };

export async function updateStaffAccess(
  tx: Tx,
  input: {
    companyId: string;
    staffId: string;
    role: Role;
    workshopId: string | null;
    expectedVersion: number;
  },
): Promise<AccessUpdateResult> {
  const result = await tx.query<{ role: Role; workshop_id: string | null; version: string }>(
    `UPDATE staff_access
        SET role = $3, workshop_id = $4, version = version + 1, updated_at = now()
      WHERE company_id = $1 AND staff_id = $2 AND version = $5
      RETURNING role, workshop_id, version`,
    [input.companyId, input.staffId, input.role, input.workshopId, input.expectedVersion],
  );
  const row = result.rows[0];
  if (row) {
    return { kind: 'updated', grant: { role: row.role, workshopId: row.workshop_id, version: Number(row.version) } };
  }
  const exists = await tx.query(
    `SELECT 1 FROM staff_access WHERE company_id = $1 AND staff_id = $2`,
    [input.companyId, input.staffId],
  );
  return exists.rowCount ? { kind: 'version_conflict' } : { kind: 'not_found' };
}
