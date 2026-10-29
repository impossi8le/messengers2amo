import type { Db, Tx } from '../platform/db.ts';
import { roleAtLeast, type Role, type Session } from '../platform/auth.ts';

export type ConnectionRow = {
  company_id: string;
  id: string;
  channel_mode: string;
  display_name?: string | null;
  binding_epoch: string;
  credentials_version: string;
  state: string;
  version: string;
  capabilities: unknown;
  ingress_enabled: boolean;
  send_enabled: boolean;
  health: unknown;
  created_at: Date;
};

export type ConnectionProjection = {
  displayName?: string;
  id: string;
  state: string;
  version: number;
  bindingEpoch: number;
  credentialsVersion: number;
  ingressEnabled: boolean;
  sendEnabled: boolean;
  health: {
    checkedAt: string;
    lastInboundAt: string | null;
    lastSuccessAt: string | null;
    errorCode: string | null;
  };
  channelMode: string;
  capabilities: Record<string, string>;
};

const CAPABILITY_KEYS = [
  'textReply',
  'mediaReply',
  'readReceipts',
  'deliveryReceipts',
  'messageEditing',
  'messageDeletion',
] as const;

const HEALTH_ERROR_CODES = new Set([
  'AUTH_REQUIRED',
  'POLLING_CONFLICT',
  'UPSTREAM_TIMEOUT',
  'UPSTREAM_UNAVAILABLE',
  'CONFIGURATION_REQUIRED',
  'INTERNAL_ERROR',
]);

const TRI_STATE = new Set(['supported', 'unsupported', 'unknown']);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

/**
 * Public connection view. Deliberately excludes credential_ref: secrets are write-only
 * through this API and must never appear in a response.
 */
export function toProjection(row: ConnectionRow): ConnectionProjection {
  const health = asRecord(row.health);
  const capabilitiesRaw = asRecord(row.capabilities);
  const capabilities: Record<string, string> = {};
  for (const key of CAPABILITY_KEYS) {
    const value = capabilitiesRaw[key];
    capabilities[key] = typeof value === 'string' && TRI_STATE.has(value) ? value : 'unknown';
  }
  const errorCode = typeof health.errorCode === 'string' && HEALTH_ERROR_CODES.has(health.errorCode)
    ? health.errorCode
    : null;
  return {
    id: row.id,
    state: row.state,
    version: Number(row.version),
    bindingEpoch: Number(row.binding_epoch),
    credentialsVersion: Number(row.credentials_version),
    ingressEnabled: row.ingress_enabled,
    sendEnabled: row.send_enabled,
    health: {
      checkedAt: isoOrNull(health.checkedAt) ?? row.created_at.toISOString(),
      lastInboundAt: isoOrNull(health.lastInboundAt),
      lastSuccessAt: isoOrNull(health.lastSuccessAt),
      errorCode,
    },
    channelMode: row.channel_mode,
    ...(row.display_name ? { displayName: row.display_name } : {}),
    capabilities,
  };
}

function latestIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

export type ConnectionHealthRow = ConnectionRow & {
  last_inbound_at: Date | null;
  last_success_at: Date | null;
};

/**
 * Health projection: the regular connection view plus activity timestamps read from
 * the existing inbox/send tables. The stored `health` document is a cache; the live
 * timestamps win when they are newer, so a stale cache never hides recent traffic.
 */
export function toHealthProjection(row: ConnectionHealthRow, checkedAt: string): ConnectionProjection {
  const projection = toProjection(row);
  return {
    ...projection,
    health: {
      checkedAt,
      lastInboundAt: latestIso(projection.health.lastInboundAt, isoOrNull(row.last_inbound_at)),
      lastSuccessAt: latestIso(projection.health.lastSuccessAt, isoOrNull(row.last_success_at)),
      errorCode: projection.health.errorCode,
    },
  };
}

/**
 * Reads one connection inside the session scope together with its last inbound event
 * and last successful send. A single query: the two aggregates are correlated
 * subqueries, so a page of connections never degenerates into an N+1 loop.
 *
 * The workshop filter mirrors listConnections exactly: a workshop-scoped actor sees a
 * connection only when it is routed to their workshop, and anything else is simply
 * absent (the route answers 404, never 403).
 */
export async function readConnectionHealth(
  db: Db | Tx,
  session: Session,
  connectionId: string,
): Promise<ConnectionHealthRow | null> {
  const params: unknown[] = [session.companyId, connectionId];
  let scope = '';
  if (session.workshopId !== null) {
    params.push(session.workshopId);
    scope = ` AND EXISTS (SELECT 1 FROM connection_routes r
              WHERE r.company_id = c.company_id AND r.connection_id = c.id AND r.workshop_id = $3)`;
  }
  const { rows } = await db.query<ConnectionHealthRow>(
    `SELECT c.company_id, c.id, c.channel_mode, c.binding_epoch, c.credentials_version, c.state, c.version,
            c.capabilities, c.ingress_enabled, c.send_enabled, c.health, c.created_at, c.display_name,
            (SELECT max(e.received_at) FROM inbox_events e
              WHERE e.company_id = c.company_id AND e.connection_id = c.id) AS last_inbound_at,
            (SELECT max(o.created_at) FROM send_operations o
              WHERE o.company_id = c.company_id AND o.connection_id = c.id AND o.state = 'sent') AS last_success_at
       FROM connections c
      WHERE c.company_id = $1 AND c.id = $2${scope}`,
    params,
  );
  return rows[0] ?? null;
}

export async function findConnection(
  db: Db | Tx,
  companyId: string,
  connectionId: string,
  options: { forUpdate?: boolean } = {},
): Promise<ConnectionRow | null> {
  const { rows } = await db.query<ConnectionRow>(
    `SELECT company_id, id, channel_mode, binding_epoch, credentials_version, state, version,
            capabilities, ingress_enabled, send_enabled, health, created_at, display_name
       FROM connections
      WHERE company_id = $1 AND id = $2${options.forUpdate ? ' FOR UPDATE' : ''}`,
    [companyId, connectionId],
  );
  return rows[0] ?? null;
}

export async function isRoutedToWorkshop(
  db: Db | Tx,
  companyId: string,
  connectionId: string,
  workshopId: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM connection_routes WHERE company_id = $1 AND connection_id = $2 AND workshop_id = $3`,
    [companyId, connectionId, workshopId],
  );
  return (rowCount ?? 0) > 0;
}

export type AuthorizeResult =
  | { kind: 'ok'; row: ConnectionRow }
  | { kind: 'forbidden' }
  | { kind: 'not_found' };

/**
 * Authorization precedes disclosure: the role is checked first, then the workshop scope.
 * A workshop-scoped actor gets 403 for both foreign and non-existent ids, so resource
 * existence never leaks before authorization. Only company-wide actors see a real 404.
 */
export async function authorizeConnection(
  db: Db | Tx,
  session: Session,
  connectionId: string,
  required: Role,
  options: { forUpdate?: boolean } = {},
): Promise<AuthorizeResult> {
  if (!roleAtLeast(session.role, required)) return { kind: 'forbidden' };
  const row = await findConnection(db, session.companyId, connectionId, options);
  if (!row) {
    return session.workshopId === null ? { kind: 'not_found' } : { kind: 'forbidden' };
  }
  if (session.workshopId !== null) {
    const routed = await isRoutedToWorkshop(db, session.companyId, connectionId, session.workshopId);
    if (!routed) return { kind: 'forbidden' };
  }
  return { kind: 'ok', row };
}

export async function listConnections(
  db: Db | Tx,
  session: Session,
  options: { after: string | null; limit: number },
): Promise<{ items: ConnectionProjection[]; nextCursor: string | null }> {
  const params: unknown[] = [session.companyId];
  let where = `c.company_id = $1`;
  if (session.workshopId !== null) {
    params.push(session.workshopId);
    where += ` AND EXISTS (SELECT 1 FROM connection_routes r
                 WHERE r.company_id = c.company_id AND r.connection_id = c.id AND r.workshop_id = $${params.length})`;
  }
  if (options.after) {
    params.push(options.after);
    where += ` AND c.id > $${params.length}`;
  }
  params.push(options.limit);
  const { rows } = await db.query<ConnectionRow>(
    `SELECT c.company_id, c.id, c.channel_mode, c.binding_epoch, c.credentials_version, c.state, c.version,
            c.capabilities, c.ingress_enabled, c.send_enabled, c.health, c.created_at, c.display_name
       FROM connections c
      WHERE ${where}
      ORDER BY c.id
      LIMIT $${params.length}`,
    params,
  );
  const items = rows.map(toProjection);
  const nextCursor = rows.length === options.limit ? rows[rows.length - 1]!.id : null;
  return { items, nextCursor };
}

export type CommandClaim =
  | { kind: 'claimed' }
  | { kind: 'replay'; connectionId: string | null }
  | { kind: 'conflict' };

/**
 * Records an idempotency key on the caller's transaction. A repeat of the same key and
 * payload replays; a repeat with a different payload is a hard conflict. Because the row
 * is written in the same transaction as the mutation, a rollback also forgets the key.
 */
export async function claimCommand(
  tx: Tx,
  input: {
    companyId: string;
    idempotencyKey: string;
    command: string;
    connectionId: string | null;
    fingerprint: string;
  },
): Promise<CommandClaim> {
  const inserted = await tx.query(
    `INSERT INTO connection_commands (company_id, idempotency_key, command, connection_id, fingerprint)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (company_id, idempotency_key) DO NOTHING
     RETURNING idempotency_key`,
    [input.companyId, input.idempotencyKey, input.command, input.connectionId, input.fingerprint],
  );
  if ((inserted.rowCount ?? 0) > 0) return { kind: 'claimed' };

  const existing = await tx.query<{ command: string; connection_id: string | null; fingerprint: string }>(
    `SELECT command, connection_id, fingerprint FROM connection_commands
      WHERE company_id = $1 AND idempotency_key = $2`,
    [input.companyId, input.idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) return { kind: 'conflict' };
  if (row.command !== input.command || row.fingerprint !== input.fingerprint) return { kind: 'conflict' };
  return { kind: 'replay', connectionId: row.connection_id };
}
