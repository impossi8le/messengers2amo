// First-administrator bootstrap.
//
// A freshly deployed tenant has a company and no staff, and no self-service
// registration route exists by design. This route is the single, explicitly
// provisioned way in: it is registered only when ADMIN_BOOTSTRAP_TOKEN is set
// (see auth/routes.ts), so an unconfigured deployment answers 404 instead of
// accepting anything. The token is compared in constant time and is meant to be
// cleared from the environment once the first administrator exists.
//
// The route can create an administrator at most once per company. The admin
// check and the inserts share one transaction that first locks the company row,
// so two concurrent calls cannot both observe "no admin" and insert one each.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Db } from '../platform/db.ts';
import { withTransaction } from '../platform/db.ts';
import { createPasswordRecord } from '../platform/auth.ts';
import { writeAudit } from '../platform/audit.ts';
import { sendError } from '../platform/errors.ts';
import { secretMatches } from '../telegram/webhook.ts';

export type BootstrapRouteDeps = {
  db: Db;
  /** Deployment-level token; the caller registers the route only when present. */
  token: string;
};

/**
 * Identifiers follow the database's own rules: the schema objects are addressed
 * by these values, so anything outside the safe alphabet is rejected before it
 * reaches SQL rather than relying on quoting.
 */
const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

const bootstrapBody = z
  .object({
    companyId: z.string().regex(IDENTIFIER_PATTERN),
    staffId: z.string().regex(IDENTIFIER_PATTERN),
    password: z.string().min(12).max(200),
    displayName: z.string().min(1).max(200).optional(),
  })
  .strict();

type BootstrapOutcome = { kind: 'created' } | { kind: 'conflict' };

export function registerBootstrapRoute(app: FastifyInstance, deps: BootstrapRouteDeps): void {
  app.post('/api/v2/auth/bootstrap', async (request, reply: FastifyReply) => {
    const header = request.headers.authorization;
    const presented = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!secretMatches(deps.token, presented)) {
      return sendError(reply, request.correlationId, 'UNAUTHENTICATED', 401);
    }

    const parsed = bootstrapBody.safeParse(request.body);
    if (!parsed.success) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');
    const { companyId, staffId, password, displayName } = parsed.data;

    // Hashing is CPU-bound; doing it before the transaction keeps the company
    // row lock (and the pool connection) out of the scrypt window.
    const record = await createPasswordRecord(password);

    const outcome = await withTransaction(deps.db, async (tx): Promise<BootstrapOutcome> => {
      await tx.query(
        `INSERT INTO companies (id, display_name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
        [companyId, companyId],
      );
      // Serializes concurrent bootstraps for the same company: the second caller
      // waits here until the first commits, then sees the admin row below.
      await tx.query(`SELECT 1 FROM companies WHERE id = $1 FOR UPDATE`, [companyId]);

      const admin = await tx.query(
        `SELECT 1 FROM staff_access WHERE company_id = $1 AND role = 'admin' LIMIT 1`,
        [companyId],
      );
      if (admin.rowCount) return { kind: 'conflict' };

      // A pre-existing staff id is never adopted: it may already carry its own
      // credentials and grants, so the bootstrap declines instead of overwriting.
      const staff = await tx.query(
        `INSERT INTO staff (company_id, id, display_name) VALUES ($1, $2, $3)
         ON CONFLICT (company_id, id) DO NOTHING`,
        [companyId, staffId, displayName ?? staffId],
      );
      if (!staff.rowCount) return { kind: 'conflict' };

      await tx.query(
        `INSERT INTO staff_credentials (company_id, staff_id, salt, password_hash, algorithm)
         VALUES ($1, $2, $3, $4, 'scrypt')`,
        [companyId, staffId, record.salt, record.hash],
      );
      await tx.query(
        `INSERT INTO staff_access (company_id, staff_id, role, workshop_id, version)
         VALUES ($1, $2, 'admin', NULL, 0)`,
        [companyId, staffId],
      );
      await writeAudit(tx, {
        companyId,
        eventName: 'auth.admin_bootstrapped',
        subjectId: staffId,
        actorId: null,
        traceId: request.correlationId,
        diagnosticCode: null,
      });
      return { kind: 'created' };
    });

    if (outcome.kind === 'conflict') return sendError(reply, request.correlationId, 'VERSION_CONFLICT');
    reply.header('cache-control', 'no-store');
    // Only identifiers: neither the password nor its hash may leave this route.
    return reply.code(201).send({ companyId, staffId, role: 'admin' });
  });
}
