import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../app.ts';
import type { Db } from '../platform/db.ts';
import { withTransaction } from '../platform/db.ts';
import { roleAtLeast, type Session } from '../platform/auth.ts';
import { sendError, type ApiErrorCode } from '../platform/errors.ts';
import { writeAudit } from '../platform/audit.ts';
import { AssignmentError, claimWorkItemInTransaction, resolveWorkItemInTransaction, transferWorkItemInTransaction } from '../repo/assignment.ts';
import { AttentionError, captureSnapshot } from '../repo/attention.ts';
import { acceptSendCommandInTransaction, IdempotencyConflictError } from '../telegram/send.ts';
import { getSystemStatus } from './system-status.ts';
import {
  applyManualCoverage,
  listCrmBindings,
  listMessagesInScope,
  listNotifications,
  listOpenObligations,
  listStaffAvailability,
  listWorkItemsInScope,
  loadObligationStates,
  loadSnapshot,
  loadSnapshotRefs,
  OperatorError,
  readSendOperationInScope,
  readWorkItemInScope,
  setStaffAvailability,
  StaffAvailabilityConflictError,
  STAFF_AVAILABILITY_STATES,
  toWorkItem,
  type OperatorRepoDeps,
  type OperatorScope,
} from './service.ts';

import type { PipelineCatalogue } from '../integrations/amocrm/pipelines.ts';
import { loadActiveAccountForCompany } from '../integrations/amocrm/store.ts';
import { WorkshopService, type ConnectionRoute } from '../workshops/service.ts';

export type OperatorRouteDeps = {
  db: Db;
  schema: string;
  /** Funnels and stages of the bound account; absent when amoCRM is not configured. */
  pipelines?: PipelineCatalogue;
  oauthEnabled?: boolean;
};

const idParams = z.object({ id: z.string().min(1).max(128) }).strict();

const pipelinesQuery = z.object({ refresh: z.enum(['true', 'false']).optional() }).strict();

const routingBody = z
  .object({
    funnelId: z.string().min(1).max(128),
    statusId: z.string().min(1).max(128).nullable().optional(),
    alertStaffId: z.string().min(1).max(128).nullable().optional(),
    normalizePhone: z.boolean().optional(),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict();

function routingView(route: ConnectionRoute) {
  return {
    connectionId: route.connectionId,
    funnelId: route.funnelId,
    statusId: route.statusId,
    alertStaffId: route.alertStaffId,
    normalizePhone: route.normalizePhone,
    version: route.version,
  };
}

const listQuery = z
  .object({
    after: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

// `.strict()` is deliberate: an unknown parameter (including `companyId`) is a
// client bug and must be rejected, never silently ignored.
const crmBindingListQuery = z
  .object({
    after: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    conversationId: z.string().min(1).max(128).optional(),
    state: z.enum(['pending', 'bound', 'creation_unknown', 'disabled']).optional(),
  })
  .strict();

const emptyBody = z.object({}).strict();

const obligationRefSchema = z
  .object({ obligationId: z.string().min(1).max(128), contentVersion: z.number().int().min(0) })
  .strict();

function uniqueRefs(refs: Array<{ obligationId: string; contentVersion: number }>): boolean {
  const keys = refs.map((ref) => `${ref.obligationId}:${ref.contentVersion}`);
  return new Set(keys).size === keys.length;
}

const claimBody = z
  .object({
    expectedAssignmentVersion: z.number().int().min(0),
    idempotencyKey: z.string().min(1).max(128),
  })
  .strict();

const transferBody = z
  .object({
    expectedAssignmentVersion: z.number().int().min(0),
    idempotencyKey: z.string().min(1).max(128),
    departmentId: z.string().min(1).max(128),
    assigneeId: z.string().min(1).max(128).nullable(),
  })
  .strict();

const resolveBody = z
  .object({
    reason: z.string().min(1).max(1000),
    expectedAssignmentVersion: z.number().int().min(0),
    idempotencyKey: z.string().min(1).max(128),
  })
  .strict();

const replyBody = z
  .object({
    idempotencyKey: z.string().min(1).max(128),
    snapshotId: z.string().min(1).max(128),
    expectedAssignmentVersion: z.number().int().min(0),
    selectedObligations: z.array(obligationRefSchema).max(500).refine(uniqueRefs),
    text: z.string().min(1).max(4096).regex(/\S/),
    deadline: z.string().datetime({ offset: true }),
  })
  .strict();

const staffAvailabilityBody = z
  .object({
    idempotencyKey: z.string().min(1).max(128),
    expectedVersion: z.number().int().min(0),
    availability: z.enum(STAFF_AVAILABILITY_STATES),
  })
  .strict();

const manualCoverageBody = z
  .object({
    confirmedSendOperationId: z.string().min(1).max(128),
    obligationRefs: z.array(obligationRefSchema).min(1).max(500).refine(uniqueRefs),
    reason: z.string().min(1).max(1000),
    expectedAssignmentVersion: z.number().int().min(0),
    idempotencyKey: z.string().min(1).max(128),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

function scopeOf(session: Session): OperatorScope {
  return { companyId: session.companyId, workshopId: session.workshopId };
}

/**
 * Maps a typed repository failure onto the contract error enum. The body stays an
 * ApiError; anything the client needs to act on (current owner, assignment version)
 * travels in headers, because the contract forbids extra body fields.
 */
function sendDomainError(reply: FastifyReply, requestId: string, error: unknown): boolean {
  if (error instanceof OperatorError) {
    sendError(reply, requestId, toContractCode(error.code, error.statusCode), error.statusCode);
    return true;
  }
  if (error instanceof AssignmentError) {
    // Headers first: once the error body is sent the reply can no longer grow fields,
    // and the contract body must stay a plain ApiError.
    if (error.current) {
      reply.header('x-assignment-version', String(error.current.assignmentVersion));
      if (error.current.ownerId) reply.header('x-current-owner', error.current.ownerId);
    }
    sendError(reply, requestId, toContractCode(error.code, error.statusCode), error.statusCode);
    return true;
  }
  if (error instanceof AttentionError) {
    sendError(reply, requestId, toContractCode(error.code, error.statusCode), error.statusCode);
    return true;
  }
  if (error instanceof StaffAvailabilityConflictError) {
    // Same CAS convention as workshop/connection mutations: the body stays a plain
    // ApiError and the live version travels in a header.
    reply.header('x-current-version', String(error.currentVersion));
    sendError(reply, requestId, 'VERSION_CONFLICT');
    return true;
  }
  if (error instanceof IdempotencyConflictError) {
    sendError(reply, requestId, 'IDEMPOTENCY_CONFLICT');
    return true;
  }
  return false;
}

const CONTRACT_CODES: Record<string, ApiErrorCode> = {
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  FORBIDDEN: 'FORBIDDEN',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  STALE_EPOCH: 'STALE_EPOCH',
  CAPABILITY_BLOCKED: 'CAPABILITY_BLOCKED',
  // Without a direct mapping this collapses into the 409 fallback below, and the
  // operator is told to refresh a card that no refresh can fix.
  CAPACITY_EXCEEDED: 'CAPACITY_EXCEEDED',
};

function toContractCode(code: string, statusCode: number): ApiErrorCode {
  const direct = CONTRACT_CODES[code];
  if (direct) return direct;
  if (statusCode === 404) return 'NOT_FOUND';
  if (statusCode === 403) return 'FORBIDDEN';
  if (statusCode === 400) return 'VALIDATION_FAILED';
  if (statusCode === 409) return 'VERSION_CONFLICT';
  if (statusCode === 422) return 'CAPABILITY_BLOCKED';
  return 'INTERNAL_ERROR';
}

async function run<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  fn: () => Promise<T>,
): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (error) {
    if (sendDomainError(reply, request.correlationId, error)) return reply;
    throw error;
  }
}

export function registerOperatorRoutes(app: FastifyInstance, deps: OperatorRouteDeps): void {
  const repo: OperatorRepoDeps = { schema: deps.schema };
  const routing = new WorkshopService({ db: deps.db, schema: deps.schema });

  // Routing settings are read and written by the admin channel screen. They live on
  // the existing route, so a connection without one answers 404 rather than growing
  // a half-configured row.
  app.get('/api/v2/operator/connections/:id/routing', async (request, reply) => {
    const session = requireRole(request, reply, 'admin');
    if (!session) return reply;
    const params = parse(idParams, request.params);
    if (!params) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    return run(request, reply, async () => {
      const route = await routing.getConnectionRoute(session.companyId, params.id);
      if (!route) return sendError(reply, request.correlationId, 'NOT_FOUND');
      return reply.code(200).send(routingView(route));
    });
  });

  app.patch('/api/v2/operator/connections/:id/routing', async (request, reply) => {
    const session = requireRole(request, reply, 'admin');
    if (!session) return reply;
    const params = parse(idParams, request.params);
    const body = parse(routingBody, request.body);
    if (!params || !body) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    return run(request, reply, async () => {
      const updated = await routing.updateConnectionRouting({
        companyId: session.companyId,
        connectionId: params.id,
        funnelId: body.funnelId,
        statusId: body.statusId ?? null,
        alertStaffId: body.alertStaffId ?? null,
        normalizePhone: body.normalizePhone ?? false,
        expectedVersion: body.expectedVersion,
      });
      if (updated) return reply.code(200).send(routingView(updated));

      // A missing route and a stale version both write nothing; say which it was so
      // the screen can offer "refresh" instead of "this channel is not routed".
      const current = await routing.getConnectionRoute(session.companyId, params.id);
      if (!current) return sendError(reply, request.correlationId, 'NOT_FOUND');
      return sendError(reply, request.correlationId, 'VERSION_CONFLICT');
    });
  });

  // The admin screen chooses a funnel and a stage, so it needs the account's real
  // list rather than a copy we would have to keep in sync. `refresh` drops the
  // short-lived cache after someone edits the funnel in amoCRM.
  app.get('/api/v2/operator/amocrm/status', async (request, reply) => {
    const session = requireRole(request, reply, 'read');
    if (!session) return reply;
    // Read only account facts, never decrypt or refresh credentials on a status read.
    const table = (name: string) => `"${deps.schema}"."${name}"`;
    const { rows } = await deps.db.query<{
      id: string; state: 'setup' | 'active' | 'revoked' | 'disabled'; has_credentials: boolean;
      refresh_failure_count: number; last_authorized_at: Date | null; last_refreshed_at: Date | null;
    }>(
      `SELECT a.id,a.state,NULLIF(a.credential_ref,'') IS NOT NULL AS has_credentials,a.refresh_failure_count,
              (SELECT max(o.recorded_at) FROM ${table('amocrm_oauth_audit')} o
                WHERE o.company_id=a.company_id AND o.account_id=a.id AND o.event IN ('authorized','reconnected')) AS last_authorized_at,
              (SELECT max(o.recorded_at) FROM ${table('amocrm_oauth_audit')} o
                WHERE o.company_id=a.company_id AND o.account_id=a.id AND o.event='refreshed') AS last_refreshed_at
         FROM ${table('crm_accounts')} a WHERE a.company_id=$1
          AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM ${table('connection_routes')} r
               WHERE r.company_id=a.company_id AND r.crm_account_id=a.id AND r.workshop_id=$2)) ORDER BY a.id`,
      [session.companyId,session.workshopId],
    );
    return reply.header('cache-control','no-store').send({
      authorizationEnabled: deps.oauthEnabled ?? false,
      accounts: rows.map((row) => ({ id:row.id,
        state:row.state === 'active' && !row.has_credentials ? 'setup' : row.state,
        refreshFailureCount:row.refresh_failure_count,
        lastAuthorizedAt:row.last_authorized_at?.toISOString() ?? null,
        lastRefreshedAt:row.last_refreshed_at?.toISOString() ?? null,
      })),
    });
  });

  app.get('/api/v2/operator/amocrm/pipelines', async (request, reply) => {
    const session = requireRole(request, reply, 'admin');
    if (!session) return reply;
    const query = parse(pipelinesQuery, request.query ?? {});
    if (!query) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    return run(request, reply, async () => {
      if (!deps.pipelines) return sendError(reply, request.correlationId, 'UPSTREAM_UNAVAILABLE');
      const accountId = await loadActiveAccountForCompany(deps.db, deps.schema, session.companyId);
      if (!accountId) return sendError(reply, request.correlationId, 'NOT_FOUND');
      const scope = { companyId: session.companyId, accountId };
      if (query.refresh === 'true') deps.pipelines.invalidate(scope);
      const items = await deps.pipelines.list(scope);
      return reply.code(200).send({ items });
    });
  });

  app.get('/api/v2/operator/work-items', async (request, reply) => {
    const session = requireRole(request, reply, 'read');
    if (!session) return reply;
    const query = parse(listQuery, request.query ?? {});
    if (!query) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    return run(request, reply, async () => {
      const { items, nextCursor } = await listWorkItemsInScope(deps.db, repo, scopeOf(session), {
        after: query.after ?? null,
        limit: query.limit,
      });
      return reply.code(200).send({ items, page: { nextCursor } });
    });
  });

  app.get('/api/v2/operator/work-items/:id', async (request, reply) => {
    const session = requireRole(request, reply, 'read');
    if (!session) return reply;
    const params = parse(idParams, request.params);
    if (!params) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    return run(request, reply, async () => {
      const workItem = await readWorkItemInScope(deps.db, repo, scopeOf(session), params.id);
      const outstandingObligations = await listOpenObligations(deps.db, repo, session.companyId, params.id);
      return reply.code(200).send({
        workItem: toWorkItem(workItem),
        conversation: {
          id: workItem.conversation_id,
          connectionId: workItem.connection_id,
          externalChatId: workItem.external_chat_id,
          bindingEpoch: Number(workItem.binding_epoch),
        },
        outstandingObligations,
      });
    });
  });

  app.get('/api/v2/operator/work-items/:id/messages', async (request, reply) => {
    const session = requireRole(request, reply, 'read');
    if (!session) return reply;
    const params = parse(idParams, request.params);
    const query = parse(listQuery, request.query ?? {});
    if (!params || !query) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    return run(request, reply, async () => {
      const workItem = await readWorkItemInScope(deps.db, repo, scopeOf(session), params.id);
      const { items, nextCursor } = await listMessagesInScope(deps.db, repo, scopeOf(session), workItem, {
        after: query.after ?? null,
        limit: query.limit,
      });
      return reply.code(200).send({ items, page: { nextCursor } });
    });
  });

  app.post('/api/v2/operator/work-items/:id/snapshot', async (request, reply) => {
    const session = requireRole(request, reply, 'send');
    if (!session) return reply;
    const params = parse(idParams, request.params);
    const body = parse(emptyBody, request.body ?? {});
    if (!params || !body) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    return run(request, reply, async () => {
      // Scope is checked before a snapshot row is written for this actor.
      await readWorkItemInScope(deps.db, repo, scopeOf(session), params.id);
      const snapshot = await captureSnapshot(deps.db, repo, {
        companyId: session.companyId,
        workItemId: params.id,
        actorId: session.staffId,
      });
      return reply.code(200).send({
        id: snapshot.snapshotId,
        workItemId: snapshot.workItemId,
        conversationId: snapshot.conversationId,
        bindingEpoch: snapshot.bindingEpoch,
        assignmentVersion: snapshot.assignmentVersion,
        obligationRefs: snapshot.items,
      });
    });
  });

  app.post('/api/v2/operator/work-items/:id/claim', async (request, reply) => {
    const session = requireRole(request, reply, 'send');
    if (!session) return reply;
    const params = parse(idParams, request.params);
    const body = parse(claimBody, request.body);
    if (!params || !body) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    return run(request, reply, async () => {
      const result = await withTransaction(deps.db, async (tx) => {
        await readWorkItemInScope(tx, repo, scopeOf(session), params.id, { forUpdate: true });
        const claimed = await claimWorkItemInTransaction(tx, repo, {
          companyId: session.companyId,
          workItemId: params.id,
          staffId: session.staffId,
          expectedVersion: body.expectedAssignmentVersion,
          requestKey: body.idempotencyKey,
        });
        if (!claimed.replayed) {
          await writeAudit(tx, {
            companyId: session.companyId,
            eventName: 'work_item.claimed',
            subjectId: params.id,
            actorId: session.staffId,
            traceId: request.correlationId,
          });
        }
        return claimed;
      });
      return reply.code(200).send({
        id: result.workItem.workItemId,
        conversationId: result.workItem.conversationId,
        assignmentVersion: result.workItem.assignmentVersion,
        state: result.workItem.state,
        owner: result.workItem.ownerId,
      });
    });
  });

  app.post('/api/v2/operator/work-items/:id/transfer', async (request, reply) => {
    const session = requireRole(request, reply, 'send');
    if (!session) return reply;
    const params = parse(idParams, request.params);
    const body = parse(transferBody, request.body);
    if (!params || !body) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    return run(request, reply, async () => {
      const result = await withTransaction(deps.db, async (tx) => {
        await readWorkItemInScope(tx, repo, scopeOf(session), params.id, { forUpdate: true });
        const transferred = await transferWorkItemInTransaction(tx, repo, {
          companyId: session.companyId,
          workItemId: params.id,
          actorId: session.staffId,
          toStaffId: body.assigneeId,
          toDepartmentId: body.departmentId,
          expectedVersion: body.expectedAssignmentVersion,
          requestKey: body.idempotencyKey,
        });
        if (!transferred.replayed) {
          await writeAudit(tx, {
            companyId: session.companyId,
            eventName: 'work_item.transferred',
            subjectId: params.id,
            actorId: session.staffId,
            traceId: request.correlationId,
            diagnosticCode: body.departmentId,
          });
        }
        return transferred;
      });
      return reply.code(200).send({
        id: result.workItem.workItemId,
        conversationId: result.workItem.conversationId,
        assignmentVersion: result.workItem.assignmentVersion,
        state: result.workItem.state,
        owner: result.workItem.ownerId,
      });
    });
  });

  app.post('/api/v2/operator/work-items/:id/reply', async (request, reply) => {
    const session = requireRole(request, reply, 'send');
    if (!session) return reply;
    const params = parse(idParams, request.params);
    const body = parse(replyBody, request.body);
    if (!params || !body) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    const deadlineMs = Date.parse(body.deadline);
    if (!Number.isFinite(deadlineMs)) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');
    const deadlineSeconds = Math.floor((deadlineMs - Date.now()) / 1000);
    if (deadlineSeconds <= 0) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    return run(request, reply, async () => {
      const outcome = await withTransaction(deps.db, async (tx) => {
        const workItem = await readWorkItemInScope(tx, repo, scopeOf(session), params.id, { forUpdate: true });
        const currentVersion = Number(workItem.assignment_version);

        // A retry of an accepted command replays the original operation, even if the
        // dialogue moved on since; only a genuinely new command is re-validated.
        const previous = await tx.query<{ id: string; state: string }>(
          `SELECT id, state FROM send_operations
            WHERE company_id = $1 AND command_type = 'reply' AND idempotency_key = $2`,
          [session.companyId, body.idempotencyKey],
        );
        if (!previous.rows[0]) {
          const snapshot = await loadSnapshot(tx, repo, {
            companyId: session.companyId,
            workItemId: params.id,
            snapshotId: body.snapshotId,
          });
          if (Number(snapshot.assignment_version) !== currentVersion) {
            throw new OperatorError(409, 'STALE_EPOCH');
          }
          if (body.expectedAssignmentVersion !== currentVersion) {
            throw new OperatorError(409, 'VERSION_CONFLICT', toWorkItem(workItem));
          }

          const snapshotted = await loadSnapshotRefs(tx, repo, {
            companyId: session.companyId,
            snapshotId: body.snapshotId,
          });
          for (const ref of body.selectedObligations) {
            if (snapshotted.get(ref.obligationId) !== ref.contentVersion) {
              throw new OperatorError(409, 'STALE_EPOCH');
            }
          }

          const states = await loadObligationStates(tx, repo, {
            companyId: session.companyId,
            workItemId: params.id,
            obligationIds: body.selectedObligations.map((ref) => ref.obligationId),
          });
          for (const ref of body.selectedObligations) {
            const live = states.get(ref.obligationId);
            if (!live || live.contentVersion !== ref.contentVersion || live.superseded || live.state === 'cancelled') {
              throw new OperatorError(409, 'STALE_EPOCH');
            }
          }
        }

        const accepted = await acceptSendCommandInTransaction(
          tx,
          {
            companyId: session.companyId,
            connectionId: workItem.connection_id,
            bindingEpoch: Number(workItem.binding_epoch),
          },
          {
            commandType: 'reply',
            idempotencyKey: body.idempotencyKey,
            actorId: session.staffId,
            workItemId: params.id,
            conversationId: workItem.conversation_id,
            content: {
              text: body.text,
              snapshotId: body.snapshotId,
              selectedObligations: body.selectedObligations,
            },
            deadlineSeconds,
            snapshotId: body.snapshotId,
          },
        );
        return { accepted, assignmentVersion: currentVersion };
      });

      // The contract body is the SendOperation; the snapshot binding is echoed in
      // headers because additional body fields would violate the schema.
      reply.header('x-snapshot-id', body.snapshotId);
      reply.header('x-assignment-version', String(outcome.assignmentVersion));
      return reply.code(202).send({
        id: outcome.accepted.operationId,
        state: outcome.accepted.state,
        providerMessageId: null,
        coverage: 'unconfirmed',
        selectedRefs: body.selectedObligations,
        deliveryEvidence: null,
        readEvidence: null,
      });
    });
  });

  app.post('/api/v2/operator/work-items/:id/resolve', async (request, reply) => {
    const session = requireRole(request, reply, 'send');
    if (!session) return reply;
    const params = parse(idParams, request.params);
    const body = parse(resolveBody, request.body);
    if (!params || !body) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    return run(request, reply, async () => {
      const result = await withTransaction(deps.db, async (tx) => {
        await readWorkItemInScope(tx, repo, scopeOf(session), params.id, { forUpdate: true });

        // Closing with open questions is an explicit managerial decision, not a
        // side effect of an operator clicking "done".
        const open = await listOpenObligations(tx, repo, session.companyId, params.id);
        if (open.length > 0 && !roleAtLeast(session.role, 'manage')) {
          throw new OperatorError(403, 'FORBIDDEN');
        }

        const resolved = await resolveWorkItemInTransaction(tx, repo, {
          companyId: session.companyId,
          workItemId: params.id,
          actorId: session.staffId,
          expectedVersion: body.expectedAssignmentVersion,
          requestKey: body.idempotencyKey,
        });
        if (!resolved.replayed) {
          await writeAudit(tx, {
            companyId: session.companyId,
            eventName: 'work_item.resolved',
            subjectId: params.id,
            actorId: session.staffId,
            traceId: request.correlationId,
            diagnosticCode: body.reason,
          });
        }
        return resolved;
      });
      return reply.code(200).send({
        id: result.workItem.workItemId,
        conversationId: result.workItem.conversationId,
        assignmentVersion: result.workItem.assignmentVersion,
        state: result.workItem.state,
        owner: result.workItem.ownerId,
      });
    });
  });

  app.post('/api/v2/operator/work-items/:id/manual-coverage', async (request, reply) => {
    const session = requireRole(request, reply, 'send');
    if (!session) return reply;
    const params = parse(idParams, request.params);
    const body = parse(manualCoverageBody, request.body);
    if (!params || !body) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    return run(request, reply, async () => {
      const result = await applyManualCoverage(deps.db, repo, scopeOf(session), {
        companyId: session.companyId,
        workItemId: params.id,
        actorId: session.staffId,
        confirmedSendOperationId: body.confirmedSendOperationId,
        obligationRefs: body.obligationRefs,
        reason: body.reason,
        expectedAssignmentVersion: body.expectedAssignmentVersion,
        idempotencyKey: body.idempotencyKey,
        traceId: request.correlationId,
      });
      return reply.code(200).send(result.workItem);
    });
  });

  app.get('/api/v2/operator/send-operations/:id', async (request, reply) => {
    const session = requireRole(request, reply, 'read');
    if (!session) return reply;
    const params = parse(idParams, request.params);
    if (!params) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    return run(request, reply, async () => {
      const operation = await readSendOperationInScope(deps.db, repo, scopeOf(session), params.id);
      return reply.code(200).send(operation);
    });
  });

  // Staff availability: the roster is company-wide, so the session company is the
  // whole scope. `online|away|offline` are the database values and the API contract.
  app.get('/api/v2/operator/staff/availability', async (request, reply) => {
    const session = requireRole(request, reply, 'read');
    if (!session) return reply;
    const query = parse(listQuery, request.query ?? {});
    if (!query) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    return run(request, reply, async () => {
      const { items, nextCursor } = await listStaffAvailability(deps.db, repo, session.companyId, {
        after: query.after ?? null,
        limit: query.limit,
      });
      return reply.code(200).send({ items, page: { nextCursor } });
    });
  });

  // Availability is part of staff administration, so it follows `/staff/:id/access`
  // and requires `admin` rather than the operational `manage` role.
  app.post('/api/v2/operator/staff/:id/availability', async (request, reply) => {
    const session = requireRole(request, reply, 'admin');
    if (!session) return reply;
    const params = parse(idParams, request.params);
    const body = parse(staffAvailabilityBody, request.body);
    if (!params || !body) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    return run(request, reply, async () => {
      const updated = await setStaffAvailability(deps.db, repo, {
        companyId: session.companyId,
        staffId: params.id,
        actorId: session.staffId,
        traceId: request.correlationId,
        expectedVersion: body.expectedVersion,
        availability: body.availability,
        idempotencyKey: body.idempotencyKey,
      });
      return reply.code(200).send(updated);
    });
  });

  // Personal notification feed. It is a projection of existing state (open
  // obligations, `unknown` sends, ownership transfers), so a stale cursor only costs
  // a re-read. Only the session staff member's own work items are projected, within
  // the same company/workshop scope as the other operator lists.
  app.get('/api/v2/operator/notifications', async (request, reply) => {
    const session = requireRole(request, reply, 'read');
    if (!session) return reply;
    const query = parse(listQuery, request.query ?? {});
    if (!query) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    return run(request, reply, async () => {
      const { items, nextCursor, hints } = await listNotifications(
        deps.db,
        repo,
        scopeOf(session),
        session.staffId,
        { after: query.after ?? null, limit: query.limit },
      );
      return reply.code(200).send({ items, page: { nextCursor }, hints });
    });
  });

  // System health for the console. Admin-only: it aggregates the whole company
  // rather than the caller's workshop, so it belongs with staff administration.
  // A database failure is reported inside a 200 body (`reachable: false`), which
  // is the point of the endpoint: the console stays up and shows the outage.
  app.get('/api/v2/operator/system-status', async (request, reply) => {
    const session = requireRole(request, reply, 'admin');
    if (!session) return reply;

    const status = await getSystemStatus(deps.db, {
      schema: deps.schema,
      companyId: session.companyId,
    });
    return reply.code(200).send(status);
  });

  // Operator read model for the console: conversation↔CRM links. The internal
  // `/internal/crm/bindings` path belongs to the adapter service identity and is
  // registered in internal/routes.ts; a staff cookie never authorizes it. The
  // company is taken from the verified session only; the query schema rejects any
  // tenant selector. `read` is the least privilege matching the other lists.
  app.get('/api/v2/operator/crm/bindings', async (request, reply) => {
    const session = requireRole(request, reply, 'read');
    if (!session) return reply;
    const query = parse(crmBindingListQuery, request.query ?? {});
    if (!query) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    return run(request, reply, async () => {
      const { items, nextCursor } = await listCrmBindings(deps.db, repo, session.companyId, {
        after: query.after ?? null,
        limit: query.limit,
        conversationId: query.conversationId ?? null,
        state: query.state ?? null,
      });
      return reply.code(200).send({ items, page: { nextCursor } });
    });
  });
}
