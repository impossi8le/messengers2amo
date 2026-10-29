import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AppDeps } from '../app.ts';
import { requireRole } from '../app.ts';
import { fingerprint, randomId } from '../platform/auth.ts';
import { withTransaction } from '../platform/db.ts';
import { sendError } from '../platform/errors.ts';
import { writeAudit } from '../platform/audit.ts';
import { loadActiveAccountForCompany } from '../integrations/amocrm/store.ts';
import { claimCommand, findConnection, toProjection } from './service.ts';
import { encryptTelegramCredentials, verifyTelegramBotToken } from './telegram-setup.ts';

const tokenBody = z.object({ botToken: z.string().trim().min(10).max(256) }).strict();
const id = z.string().min(1).max(128);
const setupBody = z
  .object({
    idempotencyKey: id,
    botToken: z.string().trim().min(10).max(256),
    displayName: z.string().trim().min(1).max(120),
    workshopId: id,
    funnelId: id,
    sourceId: id,
    statusId: id.nullable().default(null),
    alertStaffId: id.nullable().default(null),
    normalizePhone: z.boolean().default(false),
  })
  .strict();

/** A new channel stays off until the separately agreed cutover. No webhook is changed here. */
export function registerConnectionSetupRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/api/v2/operator/connections/setup-options', async (request, reply) => {
    const session = requireRole(request, reply, 'admin');
    if (!session) return reply;
    if (session.workshopId !== null) return sendError(reply, request.correlationId, 'FORBIDDEN');
    const [workshops, sources] = await Promise.all([
      deps.db.query(
        'SELECT id,display_name AS "displayName" FROM workshops WHERE company_id=$1 ORDER BY id',
        [session.companyId],
      ),
      deps.db.query(
        `SELECT s.id,s.external_id AS "externalId",s.origin_code AS "name"
         FROM crm_sources s JOIN crm_accounts a ON a.company_id=s.company_id AND a.id=s.account_id
         WHERE s.company_id=$1 AND a.state='active' ORDER BY s.id`,
        [session.companyId],
      ),
    ]);
    return {
      enabled: Boolean(deps.amocrm?.cipher && deps.amocrm.pipelines),
      workshops: workshops.rows,
      sources: sources.rows,
    };
  });

  app.post('/api/v2/operator/connections/verify-telegram', async (request, reply) => {
    const session = requireRole(request, reply, 'admin');
    if (!session) return reply;
    if (session.workshopId !== null) return sendError(reply, request.correlationId, 'FORBIDDEN');
    const body = tokenBody.safeParse(request.body);
    if (!body.success) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');
    if (!deps.amocrm?.cipher) return sendError(reply, request.correlationId, 'UPSTREAM_UNAVAILABLE');
    try {
      return await verifyTelegramBotToken({
        botToken: body.data.botToken,
        fetch: deps.amocrm.fetch ?? globalThis.fetch,
        apiBase: deps.config.telegram?.apiBase,
      });
    } catch {
      return sendError(reply, request.correlationId, 'UPSTREAM_UNAVAILABLE');
    }
  });

  app.post('/api/v2/operator/connections/setup-telegram', async (request, reply) => {
    const session = requireRole(request, reply, 'admin');
    if (!session) return reply;
    if (session.workshopId !== null) return sendError(reply, request.correlationId, 'FORBIDDEN');
    const parsed = setupBody.safeParse(request.body);
    if (!parsed.success) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');
    const body = parsed.data;
    const amocrm = deps.amocrm;
    if (!amocrm?.cipher || !amocrm.pipelines)
      return sendError(reply, request.correlationId, 'UPSTREAM_UNAVAILABLE');
    const commandFingerprint = fingerprint({
      command: 'connection.setup_telegram',
      ...body,
      idempotencyKey: undefined,
    });
    // A lost final HTTP response must replay the saved result even after token revocation.
    const previous = await deps.db.query<{ fingerprint: string; connection_id: string; command: string }>(
      'SELECT fingerprint,connection_id,command FROM connection_commands WHERE company_id=$1 AND idempotency_key=$2',
      [session.companyId, body.idempotencyKey],
    );
    if (previous.rows[0]) {
      const saved = previous.rows[0];
      if (saved.fingerprint !== commandFingerprint || saved.command !== 'connection.setup_telegram')
        return sendError(reply, request.correlationId, 'IDEMPOTENCY_CONFLICT');
      const row = await findConnection(deps.db, session.companyId, saved.connection_id);
      return row
        ? reply.code(202).send(toProjection(row))
        : sendError(reply, request.correlationId, 'IDEMPOTENCY_CONFLICT');
    }
    const accountId = await loadActiveAccountForCompany(
      deps.db,
      deps.operator?.schema ?? 'public',
      session.companyId,
    );
    if (!accountId) return sendError(reply, request.correlationId, 'UPSTREAM_UNAVAILABLE');
    const validRefs = await deps.db.query(
      `SELECT 1 FROM workshops w,crm_sources s
      WHERE w.company_id=$1 AND w.id=$2 AND s.company_id=$1 AND s.id=$3 AND s.account_id=$4
        AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM staff WHERE company_id=$1 AND id=$5))`,
      [session.companyId, body.workshopId, body.sourceId, accountId, body.alertStaffId],
    );
    if (validRefs.rows.length !== 1) return sendError(reply, request.correlationId, 'VALIDATION_FAILED');
    let bot: { providerId: string; displayName: string };
    try {
      const pipelines = await amocrm.pipelines.list({ companyId: session.companyId, accountId });
      const funnel = pipelines.find((item) => item.id === body.funnelId);
      if (
        !funnel ||
        (body.statusId !== null &&
          !funnel.stages.some((stage) => stage.id === body.statusId && !stage.isFinal))
      )
        return sendError(reply, request.correlationId, 'VALIDATION_FAILED');
      bot = await verifyTelegramBotToken({
        botToken: body.botToken,
        fetch: amocrm.fetch ?? globalThis.fetch,
        apiBase: deps.config.telegram?.apiBase,
      });
    } catch {
      return sendError(reply, request.correlationId, 'UPSTREAM_UNAVAILABLE');
    }
    const connectionId = randomId('conn');
    const outcome = await withTransaction(deps.db, async (tx) => {
      const claim = await claimCommand(tx, {
        companyId: session.companyId,
        idempotencyKey: body.idempotencyKey,
        command: 'connection.setup_telegram',
        connectionId: null,
        fingerprint: commandFingerprint,
      });
      if (claim.kind === 'conflict') return { kind: 'conflict' as const };
      if (claim.kind === 'replay') {
        const row = claim.connectionId
          ? await findConnection(tx, session.companyId, claim.connectionId)
          : null;
        return row ? { kind: 'ok' as const, row } : { kind: 'conflict' as const };
      }
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `telegram_bot:${bot.providerId}`,
      ]);
      const existing = await tx.query('SELECT 1 FROM connection_identities WHERE external_identity_ref=$1', [
        `telegram_bot:${bot.providerId}`,
      ]);
      if (existing.rows.length) throw new Error('telegram_identity_already_connected');
      const credential = encryptTelegramCredentials(amocrm.cipher, {
        companyId: session.companyId,
        connectionId,
        botToken: body.botToken,
        webhookSecret: randomBytes(32).toString('hex'),
      });
      await tx.query(
        `INSERT INTO connections(company_id,id,channel_mode,binding_epoch,credentials_version,state,version,capabilities,ingress_enabled,send_enabled,credential_ref,display_name)
        VALUES ($1,$2,'telegram_bot',0,1,'setup',0,$3::jsonb,false,false,$4,$5)`,
        [
          session.companyId,
          connectionId,
          JSON.stringify({
            textReply: 'supported',
            mediaReply: 'unknown',
            readReceipts: 'unsupported',
            deliveryReceipts: 'unknown',
            messageEditing: 'unknown',
            messageDeletion: 'unknown',
          }),
          credential,
          body.displayName,
        ],
      );
      await tx.query(
        'INSERT INTO connection_identities(company_id,connection_id,binding_epoch,external_identity_ref) VALUES ($1,$2,0,$3)',
        [session.companyId, connectionId, `telegram_bot:${bot.providerId}`],
      );
      await tx.query(
        `INSERT INTO connection_routes(company_id,connection_id,workshop_id,crm_account_id,funnel_id,default_owner_id,technical_source_id,status_id,alert_staff_id,normalize_phone,version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1)`,
        [
          session.companyId,
          connectionId,
          body.workshopId,
          accountId,
          body.funnelId,
          session.staffId,
          body.sourceId,
          body.statusId,
          body.alertStaffId,
          body.normalizePhone,
        ],
      );
      await tx.query(
        `INSERT INTO channel_policies(company_id,connection_id,crm_projection_enabled,private_import_enabled,group_default) VALUES ($1,$2,false,false,'deny')`,
        [session.companyId, connectionId],
      );
      await tx.query(
        'UPDATE connection_commands SET connection_id=$3 WHERE company_id=$1 AND idempotency_key=$2',
        [session.companyId, body.idempotencyKey, connectionId],
      );
      await writeAudit(tx, {
        companyId: session.companyId,
        eventName: 'connection.created',
        subjectId: connectionId,
        actorId: session.staffId,
        traceId: request.correlationId,
        diagnosticCode: 'telegram_bot',
      });
      const row = await findConnection(tx, session.companyId, connectionId);
      if (!row) throw new Error('connection_insert_visibility');
      return { kind: 'ok' as const, row };
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message === 'telegram_identity_already_connected')
        return { kind: 'conflict' as const };
      throw error;
    });
    return outcome.kind === 'ok'
      ? reply.code(202).send(toProjection(outcome.row))
      : sendError(reply, request.correlationId, 'IDEMPOTENCY_CONFLICT');
  });
}
