// HTTP layer for workshops, connection routes, group rules and channel permissions.
//
// Authorization is checked before any resource is read: a role failure is 401/403,
// and a workshop (or a connection routed to it) outside the session scope is 404,
// so a foreign scope is indistinguishable from a missing one. Mutations write their
// audit row on the same transaction as the change.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../app.ts';
import type { Db } from '../platform/db.ts';
import { withTransaction } from '../platform/db.ts';
import { sendError } from '../platform/errors.ts';
import { writeAudit } from '../platform/audit.ts';
import type { Session } from '../platform/auth.ts';
import { GroupPolicyService, type GroupRule } from './groups.ts';
import {
  WorkshopConflictError,
  WorkshopService,
  type ConnectionRoute,
  type Workshop,
} from './service.ts';

export type WorkshopRouteDeps = {
  db: Db;
  schema: string;
};

class NotFoundError extends Error {
  constructor() {
    super('NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

const idParams = z.object({ id: z.string().min(1).max(128) }).strict();

const createWorkshopBody = z
  .object({
    id: z.string().min(1).max(128),
    displayName: z.string().max(255).nullable().optional(),
    // The upsert is naturally idempotent by id; the key is accepted for clients that
    // send one and never changes the outcome.
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict();

const routeBody = z
  .object({
    connectionId: z.string().min(1).max(128),
    crmAccountId: z.string().min(1).max(128),
    funnelId: z.string().min(1).max(128),
    defaultOwnerId: z.string().min(1).max(128),
    technicalSourceId: z.string().min(1).max(128),
    statusId: z.string().min(1).max(128).nullable().optional(),
    alertStaffId: z.string().min(1).max(128).nullable().optional(),
    normalizePhone: z.boolean().optional(),
    expectedVersion: z.number().int().min(0),
  })
  .strict();

const groupBody = z
  .object({
    connectionId: z.string().min(1).max(128),
    bindingEpoch: z.number().int().min(0),
    externalChatId: z.string().min(1).max(512),
    decision: z.enum(['allow_crm', 'exclude', 'archive_only']),
    displayName: z.string().max(255).nullable().optional(),
  })
  .strict();

const groupQuery = z
  .object({
    connectionId: z.string().min(1).max(128).optional(),
    bindingEpoch: z.coerce.number().int().min(0).optional(),
  })
  .strict();

const permissionQuery = z
  .object({ connectionId: z.string().min(1).max(128).optional() })
  .strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

function workshopView(workshop: Workshop): { id: string; displayName: string | null } {
  return { id: workshop.id, displayName: workshop.displayName };
}

function routeView(route: ConnectionRoute) {
  return {
    connectionId: route.connectionId,
    workshopId: route.workshopId,
    crmAccountId: route.crmAccountId,
    funnelId: route.funnelId,
    defaultOwnerId: route.defaultOwnerId,
    technicalSourceId: route.technicalSourceId,
    statusId: route.statusId,
    alertStaffId: route.alertStaffId,
    normalizePhone: route.normalizePhone,
    version: route.version,
  };
}

function ruleView(rule: GroupRule) {
  return {
    connectionId: rule.connectionId,
    bindingEpoch: rule.bindingEpoch,
    externalChatId: rule.externalChatId,
    decision: rule.decision,
    displayName: rule.displayName,
    version: rule.version,
  };
}

async function run<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  fn: () => Promise<T>,
): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof WorkshopConflictError) {
      reply.header('x-current-version', String(error.currentVersion));
      reply.header('x-route-version', String(error.currentVersion));
      return sendError(reply, request.correlationId, 'VERSION_CONFLICT');
    }
    if (error instanceof NotFoundError) {
      return sendError(reply, request.correlationId, 'NOT_FOUND');
    }
    throw error;
  }
}

export function registerWorkshopRoutes(app: FastifyInstance, deps: WorkshopRouteDeps): void {
  const service = new WorkshopService({ db: deps.db, schema: deps.schema });
  const groups = new GroupPolicyService({ db: deps.db, schema: deps.schema });

  /**
   * Returns the workshop only when it exists and belongs to the session scope.
   * `null` is deliberately ambiguous between "missing" and "foreign": both are 404.
   */
  async function workshopInScope(session: Session, workshopId: string): Promise<Workshop | null> {
    if (session.workshopId !== null && session.workshopId !== workshopId) return null;
    return service.getWorkshop(session.companyId, workshopId);
  }

  /** The route of a connection, but only when it belongs to the requested workshop. */
  async function routedConnection(
    session: Session,
    workshopId: string,
    connectionId: string,
  ): Promise<boolean> {
    const { rowCount } = await deps.db.query(
      `SELECT 1 FROM connection_routes
        WHERE company_id=$1 AND connection_id=$2 AND workshop_id=$3`,
      [session.companyId, connectionId, workshopId],
    );
    return (rowCount ?? 0) > 0;
  }

  async function connectionExists(session: Session, connectionId: string): Promise<boolean> {
    const { rowCount } = await deps.db.query(
      `SELECT 1 FROM connections WHERE company_id=$1 AND id=$2`,
      [session.companyId, connectionId],
    );
    return (rowCount ?? 0) > 0;
  }

  app.get('/api/v2/operator/workshops', async (request, reply) => {
    const session = requireRole(request, reply, 'read');
    if (!session) return reply;

    const workshops = await service.listWorkshops(session.companyId);
    const visible =
      session.workshopId === null ? workshops : workshops.filter((item) => item.id === session.workshopId);
    return reply.code(200).send({ items: visible.map(workshopView) });
  });

  app.post('/api/v2/operator/workshops', async (request, reply) => {
    const session = requireRole(request, reply, 'admin');
    if (!session) return reply;
    const body = parse(createWorkshopBody, request.body);
    if (!body) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');
    if (session.workshopId !== null && session.workshopId !== body.id) {
      return sendError(reply, request.correlationId, 'NOT_FOUND');
    }

    return run(request, reply, async () => {
      const created = await withTransaction(deps.db, async (tx) => {
        const workshop = await service.createWorkshopInTransaction(tx, {
          companyId: session.companyId,
          id: body.id,
          displayName: body.displayName ?? null,
        });
        await writeAudit(tx, {
          companyId: session.companyId,
          eventName: 'workshop.created',
          subjectId: workshop.id,
          actorId: session.staffId,
          traceId: request.correlationId,
        });
        return workshop;
      });
      return reply.code(201).send(workshopView(created));
    });
  });

  app.get('/api/v2/operator/workshops/:id/routes', async (request, reply) => {
    const session = requireRole(request, reply, 'read');
    if (!session) return reply;
    const params = parse(idParams, request.params);
    if (!params) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    return run(request, reply, async () => {
      const workshop = await workshopInScope(session, params.id);
      if (!workshop) throw new NotFoundError();
      const routes = await service.listWorkshopRoutes(session.companyId, workshop.id);
      return reply.code(200).send({ items: routes.map(routeView) });
    });
  });

  app.post('/api/v2/operator/workshops/:id/routes', async (request, reply) => {
    const session = requireRole(request, reply, 'admin');
    if (!session) return reply;
    const params = parse(idParams, request.params);
    const body = parse(routeBody, request.body);
    if (!params || !body) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    return run(request, reply, async () => {
      const workshop = await workshopInScope(session, params.id);
      if (!workshop) throw new NotFoundError();

      const route = await withTransaction(deps.db, async (tx) => {
        const existing = await tx.query<{ workshop_id: string }>(
          `SELECT workshop_id FROM connection_routes
            WHERE company_id=$1 AND connection_id=$2`,
          [session.companyId, body.connectionId],
        );
        const current = existing.rows[0];
        if (current) {
          // A route belongs to one workshop; moving it through another workshop's
          // endpoint would cross the authorization scope.
          if (current.workshop_id !== workshop.id) throw new NotFoundError();
        } else if (!(await connectionExists(session, body.connectionId))) {
          throw new NotFoundError();
        }

        const updated = await service.setConnectionRouteInTransaction(tx, {
          companyId: session.companyId,
          connectionId: body.connectionId,
          workshopId: workshop.id,
          crmAccountId: body.crmAccountId,
          funnelId: body.funnelId,
          defaultOwnerId: body.defaultOwnerId,
          technicalSourceId: body.technicalSourceId,
          statusId: body.statusId ?? null,
          alertStaffId: body.alertStaffId ?? null,
          normalizePhone: body.normalizePhone ?? false,
          expectedVersion: body.expectedVersion,
        });
        await writeAudit(tx, {
          companyId: session.companyId,
          eventName: 'workshop.route_updated',
          subjectId: updated.connectionId,
          actorId: session.staffId,
          traceId: request.correlationId,
          diagnosticCode: String(updated.version),
        });
        return updated;
      });
      return reply.code(200).send(routeView(route));
    });
  });

  app.get('/api/v2/operator/workshops/:id/groups', async (request, reply) => {
    const session = requireRole(request, reply, 'read');
    if (!session) return reply;
    const params = parse(idParams, request.params);
    const query = parse(groupQuery, request.query ?? {});
    if (!params || !query) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    return run(request, reply, async () => {
      const workshop = await workshopInScope(session, params.id);
      if (!workshop) throw new NotFoundError();
      if (query.connectionId !== undefined && !(await routedConnection(session, workshop.id, query.connectionId))) {
        throw new NotFoundError();
      }
      const rules = await groups.listWorkshopRules(session.companyId, workshop.id, {
        connectionId: query.connectionId,
        bindingEpoch: query.bindingEpoch,
      });
      return reply.code(200).send({ items: rules.map(ruleView) });
    });
  });

  app.post('/api/v2/operator/workshops/:id/groups', async (request, reply) => {
    const session = requireRole(request, reply, 'manage');
    if (!session) return reply;
    const params = parse(idParams, request.params);
    const body = parse(groupBody, request.body);
    if (!params || !body) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    return run(request, reply, async () => {
      const workshop = await workshopInScope(session, params.id);
      if (!workshop) throw new NotFoundError();
      if (!(await routedConnection(session, workshop.id, body.connectionId))) throw new NotFoundError();

      const rule = await withTransaction(deps.db, async (tx) => {
        const stored = await groups.setRuleInTransaction(tx, {
          companyId: session.companyId,
          connectionId: body.connectionId,
          bindingEpoch: body.bindingEpoch,
          externalChatId: body.externalChatId,
          decision: body.decision,
          displayName: body.displayName ?? null,
        });
        await writeAudit(tx, {
          companyId: session.companyId,
          eventName: 'workshop.group_rule_set',
          subjectId: body.connectionId,
          actorId: session.staffId,
          traceId: request.correlationId,
          diagnosticCode: body.decision,
        });
        return stored;
      });
      return reply.code(200).send(ruleView(rule));
    });
  });

  app.get('/api/v2/operator/workshops/:id/permissions', async (request, reply) => {
    const session = requireRole(request, reply, 'read');
    if (!session) return reply;
    const params = parse(idParams, request.params);
    const query = parse(permissionQuery, request.query ?? {});
    if (!params || !query) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    return run(request, reply, async () => {
      const workshop = await workshopInScope(session, params.id);
      if (!workshop) throw new NotFoundError();
      if (query.connectionId !== undefined && !(await routedConnection(session, workshop.id, query.connectionId))) {
        throw new NotFoundError();
      }
      const permissions = await service.listWorkshopPermissions(session.companyId, workshop.id);
      const visible =
        query.connectionId === undefined
          ? permissions
          : permissions.filter((permission) => permission.connectionId === query.connectionId);
      return reply.code(200).send({ items: visible });
    });
  });
}
