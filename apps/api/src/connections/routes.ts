import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Db } from '../platform/db.ts';
import { withTransaction } from '../platform/db.ts';
import { fingerprint, randomId, roleAtLeast } from '../platform/auth.ts';
import { sendError } from '../platform/errors.ts';
import { writeAudit } from '../platform/audit.ts';
import {
  authorizeConnection,
  claimCommand,
  findConnection,
  listConnections,
  readConnectionHealth,
  toHealthProjection,
  toProjection,
  type ConnectionRow,
} from './service.ts';
import { raiseAlert } from '../channels/alerts.ts';

export type ConnectionRouteDeps = {
  db: Db;
  now?: () => number;
  /** Schema holding the connection tables; unqualified queries rely on search_path. */
  schema?: string;
};

const CHANNEL_MODES = [
  'telegram_bot',
  'telegram_personal',
  'telegram_business',
  'whatsapp_cloud',
  'whatsapp_qr',
  'max_bot',
  'vk_community',
] as const;

const CREDENTIAL_REF = /^credref_[A-Za-z0-9_-]{1,128}$/;

const listQuery = z
  .object({
    after: z.string().min(1).max(256).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const createBody = z
  .object({
    idempotencyKey: z.string().min(1).max(128),
    channelMode: z.enum(CHANNEL_MODES),
    credentialRef: z.string().regex(CREDENTIAL_REF),
  })
  .strict();

const lifecycleBody = z
  .object({
    idempotencyKey: z.string().min(1).max(128),
    expectedVersion: z.number().int().min(0),
    desiredState: z.enum(['active', 'paused', 'disabled']),
  })
  .strict();

const rotationBody = z
  .object({
    idempotencyKey: z.string().min(1).max(128),
    expectedVersion: z.number().int().min(0),
    credentialRef: z.string().regex(CREDENTIAL_REF),
  })
  .strict();

const idParams = z.object({ id: z.string().min(1).max(128) }).strict();

const DEFAULT_CAPABILITIES = {
  textReply: 'unknown',
  mediaReply: 'unknown',
  readReceipts: 'unknown',
  deliveryReceipts: 'unknown',
  messageEditing: 'unknown',
  messageDeletion: 'unknown',
} as const;

const SELECT_COLUMNS = `company_id, id, channel_mode, binding_epoch, credentials_version, state, version,
       capabilities, ingress_enabled, send_enabled, health, created_at, display_name`;

function parse<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

type Outcome =
  | {
      kind: 'ok';
      row: ConnectionRow;
      /**
       * The state the connection was in before the change. Only the lifecycle
       * command reports it: it decides whether the change was a transition into
       * `disabled` (which alerts) or a repeat of it (which does not).
       */
      previousState?: string | null;
    }
  | { kind: 'forbidden' }
  | { kind: 'not_found' }
  | { kind: 'version_conflict' }
  | { kind: 'idempotency_conflict' };

function respond(reply: FastifyReply, requestId: string, outcome: Outcome) {
  switch (outcome.kind) {
    case 'forbidden':
      return sendError(reply, requestId, 'FORBIDDEN');
    case 'not_found':
      return sendError(reply, requestId, 'NOT_FOUND');
    case 'version_conflict':
      return sendError(reply, requestId, 'VERSION_CONFLICT');
    case 'idempotency_conflict':
      return sendError(reply, requestId, 'IDEMPOTENCY_CONFLICT');
    case 'ok':
      return reply.code(202).send(toProjection(outcome.row));
  }
}

export function registerConnectionRoutes(app: FastifyInstance, deps: ConnectionRouteDeps): void {
  const nowIso = () => new Date(deps.now?.() ?? Date.now()).toISOString();

  app.get('/api/v2/operator/connections', async (request, reply: FastifyReply) => {
    const session = request.session;
    if (!session) return sendError(reply, request.correlationId, 'UNAUTHENTICATED');
    if (!roleAtLeast(session.role, 'read')) return sendError(reply, request.correlationId, 'FORBIDDEN');

    const query = parse(listQuery, request.query ?? {});
    if (!query) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    const { items, nextCursor } = await listConnections(deps.db, session, {
      after: query.after ?? null,
      limit: query.limit,
    });
    return reply.code(200).send({ items, page: { nextCursor } });
  });

  app.get('/api/v2/operator/connections/:id/health', async (request, reply: FastifyReply) => {
    const session = request.session;
    if (!session) return sendError(reply, request.correlationId, 'UNAUTHENTICATED');
    if (!roleAtLeast(session.role, 'read')) return sendError(reply, request.correlationId, 'FORBIDDEN');

    const params = parse(idParams, request.params);
    if (!params) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    const row = await readConnectionHealth(deps.db, session, params.id);
    // A foreign, workshop-out-of-scope and non-existent id all answer the same 404:
    // the response must not disclose whether a connection exists outside the scope.
    if (!row) return sendError(reply, request.correlationId, 'NOT_FOUND');
    return reply.code(200).send(toHealthProjection(row, nowIso()));
  });

  app.post('/api/v2/operator/connections', async (request, reply: FastifyReply) => {
    const session = request.session;
    if (!session) return sendError(reply, request.correlationId, 'UNAUTHENTICATED');
    if (!roleAtLeast(session.role, 'manage')) return sendError(reply, request.correlationId, 'FORBIDDEN');
    // A new connection has no route yet, so only company-wide managers may create one.
    if (session.workshopId !== null) return sendError(reply, request.correlationId, 'FORBIDDEN');

    const body = parse(createBody, request.body);
    if (!body) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    const connectionId = randomId('conn');
    const commandFingerprint = fingerprint({
      command: 'connection.create',
      channelMode: body.channelMode,
      credentialRef: body.credentialRef,
    });

    const outcome = await withTransaction(deps.db, async (tx): Promise<Outcome> => {
      // The ledger row is written before the connection exists, so it starts with a null
      // reference and is linked after the insert (the FK is immediate, not deferrable).
      const claim = await claimCommand(tx, {
        companyId: session.companyId,
        idempotencyKey: body.idempotencyKey,
        command: 'connection.create',
        connectionId: null,
        fingerprint: commandFingerprint,
      });
      if (claim.kind === 'conflict') return { kind: 'idempotency_conflict' };
      if (claim.kind === 'replay') {
        const row = claim.connectionId ? await findConnection(tx, session.companyId, claim.connectionId) : null;
        return row ? { kind: 'ok', row } : { kind: 'idempotency_conflict' };
      }

      await tx.query(
        `INSERT INTO connections
           (company_id, id, channel_mode, binding_epoch, credentials_version, state, version,
            capabilities, ingress_enabled, send_enabled, health, credential_ref)
         VALUES ($1,$2,$3,0,1,'setup',0,$4::jsonb,false,false,$5::jsonb,$6)`,
        [
          session.companyId,
          connectionId,
          body.channelMode,
          JSON.stringify(DEFAULT_CAPABILITIES),
          JSON.stringify({ checkedAt: nowIso(), lastInboundAt: null, lastSuccessAt: null, errorCode: null }),
          body.credentialRef,
        ],
      );
      // Circular deferred FK: the identity row completes the current binding epoch.
      await tx.query(
        `INSERT INTO connection_identities (company_id, connection_id, binding_epoch) VALUES ($1,$2,0)`,
        [session.companyId, connectionId],
      );
      await tx.query(
        `UPDATE connection_commands SET connection_id = $3
          WHERE company_id = $1 AND idempotency_key = $2`,
        [session.companyId, body.idempotencyKey, connectionId],
      );
      await writeAudit(tx, {
        companyId: session.companyId,
        eventName: 'connection.created',
        subjectId: connectionId,
        actorId: session.staffId,
        traceId: request.correlationId,
        diagnosticCode: body.channelMode,
      });

      const row = await findConnection(tx, session.companyId, connectionId);
      if (!row) throw new Error('connection_insert_visibility');
      return { kind: 'ok', row };
    });

    return respond(reply, request.correlationId, outcome);
  });

  app.post('/api/v2/operator/connections/:id/lifecycle', async (request, reply: FastifyReply) => {
    const session = request.session;
    if (!session) return sendError(reply, request.correlationId, 'UNAUTHENTICATED');
    if (!roleAtLeast(session.role, 'manage')) return sendError(reply, request.correlationId, 'FORBIDDEN');

    const params = parse(idParams, request.params);
    const body = parse(lifecycleBody, request.body);
    if (!params || !body) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    const commandFingerprint = fingerprint({
      command: 'connection.lifecycle',
      connectionId: params.id,
      expectedVersion: body.expectedVersion,
      desiredState: body.desiredState,
    });
    const ingressEnabled = body.desiredState === 'active';
    const sendEnabled = body.desiredState === 'active';

    const outcome = await withTransaction(deps.db, async (tx): Promise<Outcome> => {
      const auth = await authorizeConnection(tx, session, params.id, 'manage', { forUpdate: true });
      if (auth.kind !== 'ok') return { kind: auth.kind };

      const claim = await claimCommand(tx, {
        companyId: session.companyId,
        idempotencyKey: body.idempotencyKey,
        command: 'connection.lifecycle',
        connectionId: params.id,
        fingerprint: commandFingerprint,
      });
      if (claim.kind === 'conflict') return { kind: 'idempotency_conflict' };
      if (claim.kind === 'replay') {
        const row = await findConnection(tx, session.companyId, params.id);
        return row ? { kind: 'ok', row } : { kind: 'not_found' };
      }

      // The previous state decides whether this is a transition into `disabled`
      // or a no-op repeat of it. Only a real transition alerts.
      const before = await findConnection(tx, session.companyId, params.id);
      const previousState = before?.state ?? null;

      const updated = await tx.query<ConnectionRow>(
        `UPDATE connections
            SET state = $3,
                ingress_enabled = $4,
                send_enabled = $5,
                version = version + 1,
                health = jsonb_set(COALESCE(health, '{}'::jsonb), '{checkedAt}', to_jsonb($6::timestamptz))
          WHERE company_id = $1 AND id = $2 AND version = $7
          RETURNING ${SELECT_COLUMNS}`,
        [session.companyId, params.id, body.desiredState, ingressEnabled, sendEnabled, nowIso(), body.expectedVersion],
      );
      const row = updated.rows[0];
      if (!row) return { kind: 'version_conflict' };

      await writeAudit(tx, {
        companyId: session.companyId,
        eventName: 'connection.lifecycle_changed',
        subjectId: params.id,
        actorId: session.staffId,
        traceId: request.correlationId,
        diagnosticCode: body.desiredState,
      });
      if (row.state === 'disabled' && previousState !== null && previousState !== 'disabled') {
        await raiseAlert(tx, { schema: deps.schema ?? 'public' }, {
          companyId: session.companyId, connectionId: row.id, kind: 'channel_disabled',
          dedupeKey: `channel_disabled:${row.id}:${row.version}`,
          errorCode: 'CHANNEL_DISABLED', connectionState: row.state,
        });
      }
      return { kind: 'ok', row, previousState };
    });

    return respond(reply, request.correlationId, outcome);
  });

  app.post('/api/v2/operator/connections/:id/credentials-reference', async (request, reply: FastifyReply) => {
    const session = request.session;
    if (!session) return sendError(reply, request.correlationId, 'UNAUTHENTICATED');
    if (!roleAtLeast(session.role, 'manage')) return sendError(reply, request.correlationId, 'FORBIDDEN');

    const params = parse(idParams, request.params);
    const body = parse(rotationBody, request.body);
    if (!params || !body) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    const commandFingerprint = fingerprint({
      command: 'connection.credentials',
      connectionId: params.id,
      expectedVersion: body.expectedVersion,
      credentialRef: body.credentialRef,
    });

    const outcome = await withTransaction(deps.db, async (tx): Promise<Outcome> => {
      const auth = await authorizeConnection(tx, session, params.id, 'manage', { forUpdate: true });
      if (auth.kind !== 'ok') return { kind: auth.kind };

      const claim = await claimCommand(tx, {
        companyId: session.companyId,
        idempotencyKey: body.idempotencyKey,
        command: 'connection.credentials',
        connectionId: params.id,
        fingerprint: commandFingerprint,
      });
      if (claim.kind === 'conflict') return { kind: 'idempotency_conflict' };
      if (claim.kind === 'replay') {
        const row = await findConnection(tx, session.companyId, params.id);
        return row ? { kind: 'ok', row } : { kind: 'not_found' };
      }

      const updated = await tx.query<ConnectionRow>(
        `UPDATE connections
            SET credential_ref = $3,
                credentials_version = credentials_version + 1,
                version = version + 1,
                health = jsonb_set(COALESCE(health, '{}'::jsonb), '{checkedAt}', to_jsonb($4::timestamptz))
          WHERE company_id = $1 AND id = $2 AND version = $5
          RETURNING ${SELECT_COLUMNS}`,
        [session.companyId, params.id, body.credentialRef, nowIso(), body.expectedVersion],
      );
      const row = updated.rows[0];
      if (!row) return { kind: 'version_conflict' };

      await writeAudit(tx, {
        companyId: session.companyId,
        eventName: 'connection.credentials_rotated',
        subjectId: params.id,
        actorId: session.staffId,
        traceId: request.correlationId,
      });
      return { kind: 'ok', row };
    });

    return respond(reply, request.correlationId, outcome);
  });
}
