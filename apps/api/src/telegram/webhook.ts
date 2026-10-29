import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.ts';
import { logEvent } from '../platform/logger.ts';
import { InboxConflictError, recordTelegramUpdate, type TelegramScope } from './inbox.ts';
import { decryptTelegramCredentials } from '../connections/telegram-setup.ts';

const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

const updateSchema = z
  .object({
    update_id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .passthrough();

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function secretMatches(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  return timingSafeEqual(digest(expected), digest(provided));
}

type ConnectionRow = {
  company_id: string;
  binding_epoch: string;
  channel_mode: string;
  credential_ref: string | null;
};

async function resolveScope(deps: AppDeps, connectionId: string): Promise<(TelegramScope & { credentialRef: string | null }) | 'not_found' | 'ambiguous'> {
  const { rows } = await deps.db.query<ConnectionRow>(
    'SELECT company_id, binding_epoch, channel_mode, credential_ref FROM connections WHERE id = $1',
    [connectionId],
  );
  if (rows.length === 0) return 'not_found';
  if (rows.length > 1) return 'ambiguous';
  const row = rows[0];
  if (!row) return 'not_found';
  // A Telegram update can never be applied to a non-Telegram channel.
  if (!row.channel_mode.startsWith('telegram')) return 'not_found';
  return { companyId: row.company_id, connectionId, bindingEpoch: Number(row.binding_epoch), credentialRef: row.credential_ref };
}

export function registerTelegramWebhook(app: FastifyInstance, deps: AppDeps): void {
  app.post('/webhooks/telegram/:connectionId', async (request, reply) => {
    const telegram = deps.config.telegram;
    const connectionId = (request.params as { connectionId?: string }).connectionId ?? '';
    const scope = await resolveScope(deps, connectionId);
    let webhookSecret=telegram?.webhookSecret;
    if (typeof scope==='object' && scope.credentialRef?.startsWith('chancred_v1.')) {
      if (!deps.amocrm?.cipher) return reply.code(503).send({ error: 'telegram_not_configured' });
      try { webhookSecret=decryptTelegramCredentials(deps.amocrm.cipher,scope.credentialRef,scope).webhookSecret; }
      catch { return reply.code(503).send({ error: 'telegram_not_configured' }); }
    }
    if (!webhookSecret) {
      return reply.code(503).send({ error: 'telegram_not_configured' });
    }

    if (!secretMatches(webhookSecret, request.headers[SECRET_HEADER])) {
      logEvent('warn', 'telegram.webhook.rejected', {
        correlationId: request.correlationId,
        reason: 'bad_secret',
      });
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_update' });
    }

    if (scope === 'not_found') return reply.code(404).send({ error: 'connection_not_found' });
    if (scope === 'ambiguous') return reply.code(409).send({ error: 'ambiguous_connection' });

    try {
      const result = await recordTelegramUpdate(deps.db, scope, parsed.data as Record<string, unknown>);
      logEvent('info', 'telegram.webhook.stored', {
        correlationId: request.correlationId,
        connectionId,
        duplicate: result.duplicate,
        checkpoint: result.checkpoint,
      });
      return reply.code(200).send({ ok: true, duplicate: result.duplicate });
    } catch (error) {
      if (error instanceof InboxConflictError) {
        logEvent('warn', 'telegram.webhook.conflict', {
          correlationId: request.correlationId,
          connectionId,
          reason: 'payload_changed',
        });
        return reply.code(409).send({ error: 'payload_conflict' });
      }
      // No ACK is produced when durable storage failed.
      throw error;
    }
  });
}
