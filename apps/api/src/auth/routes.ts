import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Config } from '../platform/config.ts';
import { withTransaction, type Db } from '../platform/db.ts';
import { issueSession, PasswordCheckBusyError, roleAtLeast, type Role } from '../platform/auth.ts';
import { sendError } from '../platform/errors.ts';
import { writeAudit } from '../platform/audit.ts';
import { LoginRateLimiter, loginAttemptKey, type LoginLimiterOptions } from '../platform/login-limiter.ts';
import { authenticate, createSession, revokeSession, revokeStaffSessions, updateStaffAccess } from './service.ts';
import { registerBootstrapRoute } from './bootstrap.ts';
import { SESSION_COOKIE } from '../app.ts';

export type AuthRouteDeps = {
  db: Db;
  config: Config;
  now?: () => number;
  /** Login throttling knobs; production defaults apply when omitted. */
  loginLimiter?: LoginLimiterOptions;
};

const loginBody = z
  .object({
    companyId: z.string().min(1).max(128),
    staffId: z.string().min(1).max(128),
    password: z.string().min(1).max(1024),
  })
  .strict();

const logoutBody = z.object({}).strict().optional();

const accessBody = z
  .object({
    role: z.enum(['read', 'send', 'manage', 'admin']),
    workshopId: z.string().min(1).max(128).nullable().optional(),
    expectedVersion: z.number().int().min(0),
  })
  .strict();

const revokeBody = z
  .object({ reason: z.string().min(1).max(64).optional() })
  .strict()
  .optional();

export function sessionCookie(config: Config, token: string, maxAgeSeconds: number): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (config.secureCookies) parts.push('Secure');
  return parts.join('; ');
}

export function clearedSessionCookie(config: Config): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (config.secureCookies) parts.push('Secure');
  return parts.join('; ');
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  app.get('/api/v2/auth/session',async(request,reply)=>{
    const session=request.session;
    if(!session)return sendError(reply,request.correlationId,'UNAUTHENTICATED');
    return reply.header('cache-control','no-store').send({staffId:session.staffId,companyId:session.companyId,
      role:session.role,workshopId:session.workshopId});
  });
  const now = () => deps.now?.() ?? Date.now();
  const limiter = new LoginRateLimiter({ ...deps.loginLimiter, now: deps.loginLimiter?.now ?? now });

  app.post('/api/v2/auth/login', async (request, reply: FastifyReply) => {
    const body = parse(loginBody, request.body);
    if (!body) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');

    // Throttle before any database or scrypt work: the password check is the
    // expensive part, so a blocked attempt must not reach it at all.
    const attemptKey = loginAttemptKey(request.ip, body.companyId, body.staffId);
    const gate = limiter.begin(attemptKey);
    if (!gate.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(gate.retryAfterMs / 1000));
      reply.header('retry-after', String(retryAfterSeconds));
      return sendError(reply, request.correlationId, 'RATE_LIMITED', 429);
    }
    if (gate.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, gate.delayMs));

    let grant: Awaited<ReturnType<typeof authenticate>>;
    try {
      grant = await authenticate(deps.db, body.companyId, body.staffId, body.password);
    } catch (error) {
      if (error instanceof PasswordCheckBusyError) {
        reply.header('retry-after', '1');
        return sendError(reply, request.correlationId, 'RATE_LIMITED', 503);
      }
      throw error;
    }
    if (!grant) {
      limiter.fail(attemptKey);
      return sendError(reply, request.correlationId, 'UNAUTHENTICATED');
    }
    limiter.succeed(attemptKey);

    const issued = await createSession(deps.db, {
      companyId: body.companyId,
      staffId: body.staffId,
      role: grant.role,
      workshopId: grant.workshopId,
      epoch: grant.version,
      ttlSeconds: deps.config.sessionTtlSeconds,
      now: now(),
    });
    const token = issueSession(
      deps.config.sessionSecret,
      {
        sessionId: issued.session.sessionId,
        staffId: issued.session.staffId,
        companyId: issued.session.companyId,
        role: issued.session.role,
        workshopId: issued.session.workshopId,
        epoch: issued.session.epoch,
      },
      deps.config.sessionTtlSeconds,
    );

    reply.header('set-cookie', sessionCookie(deps.config, token, deps.config.sessionTtlSeconds));
    reply.header('cache-control', 'no-store');
    return reply.code(200).send({
      staffId: issued.session.staffId,
      companyId: issued.session.companyId,
      role: issued.session.role,
      workshopId: issued.session.workshopId,
      expiresAt: new Date(issued.session.expiresAt).toISOString(),
    });
  });

  // First-administrator bootstrap. The group exists only when its token is
  // configured: an empty value means "no bootstrap in this deployment", so the
  // path answers 404 instead of accepting anything (as with the internal CRM
  // adapter group in app.ts).
  const bootstrapToken = deps.config.adminBootstrapToken;
  if (bootstrapToken) registerBootstrapRoute(app, { db: deps.db, token: bootstrapToken });

  app.post('/api/v2/auth/logout', async (request, reply: FastifyReply) => {
    const body = parse(logoutBody, request.body ?? {});
    if (body === null) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');
    const session = request.session;
    if (!session) return sendError(reply, request.correlationId, 'UNAUTHENTICATED');

    await revokeSession(deps.db, session.companyId, session.sessionId, now());
    reply.header('set-cookie', clearedSessionCookie(deps.config));
    return reply.code(204).send();
  });

  // Administrative revocation: kills every live session of a staff member immediately.
  app.post('/api/v2/operator/staff/:id/sessions/revoke', async (request, reply: FastifyReply) => {
    const session = request.session;
    if (!session) return sendError(reply, request.correlationId, 'UNAUTHENTICATED');
    if (!roleAtLeast(session.role, 'admin')) return sendError(reply, request.correlationId, 'FORBIDDEN');

    const body = parse(revokeBody, request.body ?? {});
    if (body === null) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');
    const staffId = (request.params as { id: string }).id;

    const revoked = await withTransaction(deps.db, async (tx) => {
      const staff = await tx.query(`SELECT 1 FROM staff WHERE company_id = $1 AND id = $2`, [
        session.companyId,
        staffId,
      ]);
      if (!staff.rowCount) return null;
      const count = await revokeStaffSessions(tx, session.companyId, staffId, now());
      await writeAudit(tx, {
        companyId: session.companyId,
        eventName: 'staff.sessions_revoked',
        subjectId: staffId,
        actorId: session.staffId,
        traceId: request.correlationId,
        diagnosticCode: body?.reason ?? null,
      });
      return count;
    });

    if (revoked === null) return sendError(reply, request.correlationId, 'NOT_FOUND');
    return reply.code(202).send({ staffId, revoked });
  });

  // Authorization change: version-checked, revokes live sessions and audits atomically.
  app.post('/api/v2/operator/staff/:id/access', async (request, reply: FastifyReply) => {
    const session = request.session;
    if (!session) return sendError(reply, request.correlationId, 'UNAUTHENTICATED');
    if (!roleAtLeast(session.role, 'admin')) return sendError(reply, request.correlationId, 'FORBIDDEN');

    const body = parse(accessBody, request.body);
    if (!body) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');
    const staffId = (request.params as { id: string }).id;
    const workshopId = body.workshopId ?? null;

    const outcome = await withTransaction(deps.db, async (tx) => {
      const target = await tx.query<{ workshop_id: string | null }>(
        `SELECT workshop_id FROM staff_access WHERE company_id = $1 AND staff_id = $2`,
        [session.companyId, staffId],
      );
      if (!target.rowCount) return { kind: 'not_found' as const };

      // Only a company-level admin (no workshop) may change grants or widen scope.
      // A workshop admin administers their own workshop only and can never remove
      // the workshop restriction, on themselves or on their staff.
      if (session.workshopId !== null) {
        if (target.rows[0]!.workshop_id !== session.workshopId) return { kind: 'forbidden' as const };
        if (workshopId !== session.workshopId) return { kind: 'forbidden' as const };
      }

      if (workshopId) {
        const workshop = await tx.query(`SELECT 1 FROM workshops WHERE company_id = $1 AND id = $2`, [
          session.companyId,
          workshopId,
        ]);
        if (!workshop.rowCount) return { kind: 'invalid_workshop' as const };
      }
      const result = await updateStaffAccess(tx, {
        companyId: session.companyId,
        staffId,
        role: body.role as Role,
        workshopId,
        expectedVersion: body.expectedVersion,
      });
      if (result.kind !== 'updated') return result;

      await revokeStaffSessions(tx, session.companyId, staffId, now());
      await writeAudit(tx, {
        companyId: session.companyId,
        eventName: 'staff.access_updated',
        subjectId: staffId,
        actorId: session.staffId,
        traceId: request.correlationId,
        diagnosticCode: body.role,
      });
      return result;
    });

    if (outcome.kind === 'forbidden') return sendError(reply, request.correlationId, 'FORBIDDEN');
    if (outcome.kind === 'invalid_workshop') return sendError(reply, request.correlationId, 'VALIDATION_FAILED');
    if (outcome.kind === 'not_found') return sendError(reply, request.correlationId, 'NOT_FOUND');
    if (outcome.kind === 'version_conflict') return sendError(reply, request.correlationId, 'VERSION_CONFLICT');
    return reply.code(200).send({
      staffId,
      role: outcome.grant.role,
      workshopId: outcome.grant.workshopId,
      version: outcome.grant.version,
    });
  });
}
