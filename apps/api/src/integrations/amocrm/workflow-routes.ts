// HTTP layer for the amoCRM assignment workflow.
//
// The policy is versioned and changed with compare-and-set; a stale version is a
// 409 that carries the current version in headers (the error body stays a plain
// ApiError). Conversation-scoped endpoints are authorized against the session
// workshop before any state is read, and a foreign scope is a 404.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../../app.ts';
import type { Db } from '../../platform/db.ts';
import { sendError } from '../../platform/errors.ts';
import type { Session } from '../../platform/auth.ts';
import { AmocrmWorkflow, AmocrmWorkflowError, type WorkflowClient } from './workflow.ts';

export type WorkflowRouteDeps = {
  db: Db;
  schema: string;
  client: WorkflowClient;
  now?: () => number;
  /** Used to build the linked-card URL; without it the card is simply not linked. */
  accountDomain?: string | null;
};

/**
 * Used when the app has no live CRM client wired. Read-only workflow endpoints still
 * work; operations that need the CRM fail as a visible upstream failure rather than
 * pretending to succeed.
 */
export const unavailableWorkflowClient: WorkflowClient = {
  async readResponsible(): Promise<never> {
    throw new Error('upstream_unavailable');
  },
  async setContactOwner(): Promise<never> {
    throw new Error('upstream_unavailable');
  },
};

const policyBody = z
  .object({
    sourceOfTruth: z.enum(['crm', 'platform']),
    expectedVersion: z.number().int().min(0),
  })
  .strict();

const resyncBody = z
  .object({
    accountId: z.string().min(1).max(128),
    conversationId: z.string().min(1).max(128),
    idempotencyKey: z.string().min(1).max(128),
  })
  .strict();

const conflictsQuery = z
  .object({
    accountId: z.string().min(1).max(128).optional(),
    conversationId: z.string().min(1).max(128).optional(),
    // The console asks for a page size like it does for every other list; the
    // strict schema used to reject the whole request with VALIDATION_FAILED.
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const diagnosticsQuery = z
  .object({
    accountId: z.string().min(1).max(128),
    conversationId: z.string().min(1).max(128),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

/** Maps a typed workflow failure onto the contract error enum. */
function sendWorkflowError(reply: FastifyReply, requestId: string, error: AmocrmWorkflowError): FastifyReply {
  const code =
    error.code === 'VERSION_CONFLICT'
      ? 'VERSION_CONFLICT'
      : error.statusCode === 404
        ? 'NOT_FOUND'
        : error.statusCode === 403
          ? 'FORBIDDEN'
          : 'VALIDATION_FAILED';
  return sendError(reply, requestId, code, error.statusCode);
}

async function run<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  fn: () => Promise<T>,
): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AmocrmWorkflowError) return sendWorkflowError(reply, request.correlationId, error);
    throw error;
  }
}

export function registerAmocrmWorkflowRoutes(app: FastifyInstance, deps: WorkflowRouteDeps): void {
  const flow = new AmocrmWorkflow({
    db: deps.db,
    schema: deps.schema,
    client: deps.client,
    now: deps.now,
    accountDomain: deps.accountDomain ?? null,
  });

  /** A conversation is visible only inside the company and, for a scoped session, its workshop. */
  async function conversationInScope(session: Session, conversationId: string): Promise<boolean> {
    const { rows } = await deps.db.query<{ connection_id: string }>(
      `SELECT connection_id FROM conversations WHERE company_id=$1 AND id=$2`,
      [session.companyId, conversationId],
    );
    const conversation = rows[0];
    if (!conversation) return false;
    if (session.workshopId === null) return true;
    const { rowCount } = await deps.db.query(
      `SELECT 1 FROM connection_routes
        WHERE company_id=$1 AND connection_id=$2 AND workshop_id=$3`,
      [session.companyId, conversation.connection_id, session.workshopId],
    );
    return (rowCount ?? 0) > 0;
  }

  async function accountExists(session: Session, accountId: string): Promise<boolean> {
    const { rowCount } = await deps.db.query(
      `SELECT 1 FROM crm_accounts WHERE company_id=$1 AND id=$2`,
      [session.companyId, accountId],
    );
    return (rowCount ?? 0) > 0;
  }

  app.get('/api/v2/operator/crm/policy', async (request, reply) => {
    const session = requireRole(request, reply, 'read');
    if (!session) return reply;
    const policy = await flow.getPolicy(session.companyId);
    return reply.code(200).send(policy);
  });

  app.post('/api/v2/operator/crm/policy', async (request, reply) => {
    const session = requireRole(request, reply, 'admin');
    if (!session) return reply;
    const body = parse(policyBody, request.body);
    if (!body) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    try {
      const policy = await flow.setPolicy({
        companyId: session.companyId,
        actorId: session.staffId,
        sourceOfTruth: body.sourceOfTruth,
        expectedVersion: body.expectedVersion,
      });
      return reply.code(200).send(policy);
    } catch (error) {
      if (error instanceof AmocrmWorkflowError && error.code === 'VERSION_CONFLICT') {
        const current = await flow.getPolicy(session.companyId);
        reply.header('x-current-version', String(current.version));
        reply.header('x-policy-version', String(current.version));
        return sendError(reply, request.correlationId, 'VERSION_CONFLICT');
      }
      if (error instanceof AmocrmWorkflowError) {
        return sendWorkflowError(reply, request.correlationId, error);
      }
      throw error;
    }
  });

  app.get('/api/v2/operator/crm/conflicts', async (request, reply) => {
    const session = requireRole(request, reply, 'read');
    if (!session) return reply;
    const query = parse(conflictsQuery, request.query ?? {});
    if (!query) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    if (query.conversationId !== undefined && !(await conversationInScope(session, query.conversationId))) {
      return sendError(reply, request.correlationId, 'NOT_FOUND');
    }
    if (query.accountId !== undefined && !(await accountExists(session, query.accountId))) {
      return sendError(reply, request.correlationId, 'NOT_FOUND');
    }

    const params: unknown[] = [session.companyId];
    let where = `c.company_id=$1 AND c.state='open'`;
    if (query.accountId !== undefined) {
      params.push(query.accountId);
      where += ` AND c.account_id=$${params.length}`;
    }
    if (query.conversationId !== undefined) {
      params.push(query.conversationId);
      where += ` AND c.conversation_id=$${params.length}`;
    }
    if (session.workshopId !== null) {
      params.push(session.workshopId);
      where += ` AND EXISTS (
        SELECT 1 FROM conversations cv
          JOIN connection_routes r
            ON r.company_id=cv.company_id AND r.connection_id=cv.connection_id
         WHERE cv.company_id=c.company_id AND cv.id=c.conversation_id AND r.workshop_id=$${params.length})`;
    }

    params.push(query.limit ?? 100);
    const { rows } = await deps.db.query<{
      id: string;
      account_id: string;
      conversation_id: string;
      crm_owner_ref: string;
      platform_owner_id: string | null;
      desired_crm_owner_ref: string | null;
      policy: string;
      winner: string;
      state: string;
      detected_at: Date;
    }>(
      `SELECT c.id, c.account_id, c.conversation_id, c.crm_owner_ref, c.platform_owner_id,
              c.desired_crm_owner_ref, c.policy, c.winner, c.state, c.detected_at
         FROM crm_assignment_conflicts c
        WHERE ${where}
        ORDER BY c.detected_at, c.id
        LIMIT $${params.length}::int`,
      params,
    );
    return reply.code(200).send({
      items: rows.map((row) => ({
        id: row.id,
        accountId: row.account_id,
        conversationId: row.conversation_id,
        crmOwnerRef: row.crm_owner_ref,
        platformOwnerId: row.platform_owner_id,
        desiredCrmOwnerRef: row.desired_crm_owner_ref,
        policy: row.policy,
        winner: row.winner,
        state: row.state,
        detectedAt: row.detected_at.toISOString(),
      })),
    });
  });

  app.post('/api/v2/operator/crm/resync', async (request, reply) => {
    const session = requireRole(request, reply, 'manage');
    if (!session) return reply;
    const body = parse(resyncBody, request.body);
    if (!body) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    if (!(await accountExists(session, body.accountId))) {
      return sendError(reply, request.correlationId, 'NOT_FOUND');
    }
    if (!(await conversationInScope(session, body.conversationId))) {
      return sendError(reply, request.correlationId, 'NOT_FOUND');
    }

    return run(request, reply, async () => {
      const result = await flow.syncConversation({
        companyId: session.companyId,
        accountId: body.accountId,
        conversationId: body.conversationId,
        actorId: session.staffId,
        requestKey: body.idempotencyKey,
      });
      return reply.code(200).send(result);
    });
  });

  app.get('/api/v2/operator/crm/diagnostics', async (request, reply) => {
    const session = requireRole(request, reply, 'read');
    if (!session) return reply;
    const query = parse(diagnosticsQuery, request.query ?? {});
    if (!query) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    if (!(await accountExists(session, query.accountId))) {
      return sendError(reply, request.correlationId, 'NOT_FOUND');
    }
    if (!(await conversationInScope(session, query.conversationId))) {
      return sendError(reply, request.correlationId, 'NOT_FOUND');
    }

    return run(request, reply, async () => {
      const diagnostics = await flow.getDiagnostics({
        companyId: session.companyId,
        accountId: query.accountId,
        conversationId: query.conversationId,
      });
      return reply.code(200).send(diagnostics);
    });
  });
}
