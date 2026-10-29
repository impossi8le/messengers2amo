// Internal CRM adapter boundary.
//
// The adapter is a separate service identity, never an operator. Requests carry
// `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`; the operator session cookie is
// not consulted at all. When the token is not configured the whole group is not
// registered (see app.ts), so the paths answer 404 rather than accepting anything.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../platform/db.ts';
import { withTransaction } from '../platform/db.ts';
import { sendError } from '../platform/errors.ts';
import { acceptSendCommandInTransaction, IdempotencyConflictError } from '../telegram/send.ts';
import { listCrmBindings, type OperatorRepoDeps } from '../operator/service.ts';

export type InternalRouteDeps = {
  db: Db;
  schema: string;
  token: string;
  /** Deployment-level company scope for the adapter; null means every company. */
  companyId: string | null;
};

/**
 * Fixed acceptance deadline. It is part of the immutable command fingerprint, so a
 * retry of the same key must produce the same value; a per-request `now()` would
 * turn every retry into an idempotency conflict.
 */
const OUTBOUND_DEADLINE_SECONDS = 300;

const crmBindingListQuery = z
  .object({
    after: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    conversationId: z.string().min(1).max(128).optional(),
    state: z.enum(['pending', 'bound', 'creation_unknown', 'disabled']).optional(),
  })
  .strict();

// Exactly the contract's CrmOutboundCommand. There is deliberately no actor,
// recipient, connectionId, snapshotId or assignmentVersion: those are derived from
// the trusted binding context and the live rows on the server.
const crmOutboundBody = z
  .object({
    crmEventId: z.string().min(1).max(128),
    crmBindingId: z.string().min(1).max(128),
    idempotencyKey: z.string().min(1).max(128),
    text: z.string().min(1).max(4096).regex(/\S/),
    coverage: z.literal('unconfirmed'),
  })
  .strict();

function q(sql: string, schema: string): string {
  return sql.replaceAll('__S__', `"${schema}"`);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time comparison over fixed-size digests, as in telegram/webhook.ts. */
function tokenMatches(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  return timingSafeEqual(digest(expected), digest(provided));
}

/**
 * Authenticates the adapter service. The operator cookie is ignored on purpose: a
 * staff session must never authorize an internal route.
 */
function requireService(
  request: FastifyRequest,
  reply: FastifyReply,
  expected: string,
): boolean {
  const header = request.headers.authorization;
  const presented = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!tokenMatches(expected, presented)) {
    sendError(reply, request.correlationId, 'UNAUTHENTICATED', 401);
    return false;
  }
  return true;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

type BindingRow = {
  company_id: string;
  conversation_id: string;
  connection_id: string;
  binding_state: string;
  conversation_epoch: string | number;
  connection_epoch: string | number;
  connection_state: string;
  send_enabled: boolean;
};

type WorkItemRow = {
  id: string;
  owner_id: string | null;
  assignment_version: string | number;
};

/** Precondition failures are 422, never 409: the request is well-formed but the
 * target is not currently sendable. */
function precondition(reply: FastifyReply, requestId: string): FastifyReply {
  return sendError(reply, requestId, 'CAPABILITY_BLOCKED', 422);
}

export function registerInternalRoutes(app: FastifyInstance, deps: InternalRouteDeps): void {
  const repo: OperatorRepoDeps = { schema: deps.schema };

  app.get('/api/v2/internal/crm/bindings', async (request, reply) => {
    if (!requireService(request, reply, deps.token)) return reply;
    const query = parse(crmBindingListQuery, request.query ?? {});
    if (!query) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    const { items, nextCursor } = await listCrmBindings(deps.db, repo, deps.companyId, {
      after: query.after ?? null,
      limit: query.limit,
      conversationId: query.conversationId ?? null,
      state: query.state ?? null,
    });
    return reply.code(200).send({ items, page: { nextCursor } });
  });

  app.post('/api/v2/internal/crm/outbound', async (request, reply) => {
    if (!requireService(request, reply, deps.token)) return reply;
    const body = parse(crmOutboundBody, request.body);
    if (!body) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    // The binding is the only tenant input. Actor, recipient, connection and epoch
    // are read from the binding and the live rows, never from the request.
    const bindings = await deps.db.query<BindingRow>(
      q(
        `SELECT b.company_id, b.conversation_id, b.state AS binding_state,
                c.connection_id, c.binding_epoch AS conversation_epoch,
                cn.binding_epoch AS connection_epoch, cn.state AS connection_state,
                cn.send_enabled
           FROM __S__.crm_bindings b
           JOIN __S__.conversations c
             ON c.company_id = b.company_id AND c.id = b.conversation_id
           JOIN __S__.connections cn
             ON cn.company_id = c.company_id AND cn.id = c.connection_id
          WHERE b.id = $1 AND ($2::text IS NULL OR b.company_id = $2)`,
        deps.schema,
      ),
      [body.crmBindingId, deps.companyId],
    );
    // Missing and ambiguous bindings are indistinguishable to the adapter.
    const binding = bindings.rows.length === 1 ? bindings.rows[0]! : null;
    if (!binding) return sendError(reply, request.correlationId, 'NOT_FOUND');

    if (binding.binding_state !== 'bound') return precondition(reply, request.correlationId);
    if (Number(binding.conversation_epoch) !== Number(binding.connection_epoch)) {
      return precondition(reply, request.correlationId);
    }
    if (binding.connection_state !== 'active' || !binding.send_enabled) {
      return precondition(reply, request.correlationId);
    }

    const workItems = await deps.db.query<WorkItemRow>(
      q(
        `SELECT id, owner_id, assignment_version
           FROM __S__.work_items
          WHERE company_id = $1 AND conversation_id = $2
            AND state NOT IN ('resolved','cancelled')`,
        deps.schema,
      ),
      [binding.company_id, binding.conversation_id],
    );
    const workItem = workItems.rows[0];
    // A command without a live assignment has no assignee/author context to bind to.
    if (!workItem) return precondition(reply, request.correlationId);

    // The author is the trusted CRM route owner when the connection is routed;
    // otherwise the live assignee. There is no service-principal staff row in the
    // schema, so send_operations.actor_id must reference a real staff member.
    const routes = await deps.db.query<{ default_owner_id: string }>(
      q(
        `SELECT default_owner_id FROM __S__.connection_routes
          WHERE company_id = $1 AND connection_id = $2`,
        deps.schema,
      ),
      [binding.company_id, binding.connection_id],
    );
    const actorId = routes.rows[0]?.default_owner_id ?? workItem.owner_id;
    if (!actorId) return precondition(reply, request.correlationId);

    try {
      const accepted = await withTransaction(deps.db, (tx) =>
        acceptSendCommandInTransaction(
          tx,
          {
            companyId: binding.company_id,
            connectionId: binding.connection_id,
            bindingEpoch: Number(binding.conversation_epoch),
          },
          {
            commandType: 'crm_outbound',
            idempotencyKey: body.idempotencyKey,
            actorId,
            workItemId: workItem.id,
            conversationId: binding.conversation_id,
            content: {
              text: body.text,
              crmEventId: body.crmEventId,
              crmBindingId: body.crmBindingId,
            },
            deadlineSeconds: OUTBOUND_DEADLINE_SECONDS,
            snapshotId: null,
          },
        ),
      );
      // 202: the command was accepted, not delivered. Coverage stays unconfirmed.
      return reply.code(202).send({
        id: accepted.operationId,
        state: accepted.state,
        providerMessageId: null,
        coverage: 'unconfirmed',
        selectedRefs: [],
        deliveryEvidence: null,
        readEvidence: null,
      });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return sendError(reply, request.correlationId, 'IDEMPOTENCY_CONFLICT');
      }
      throw error;
    }
  });
}
