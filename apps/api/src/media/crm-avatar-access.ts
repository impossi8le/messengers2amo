import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../platform/db.ts';
import { downloadTelegramAvatar } from '../telegram/avatar.ts';

type Scope = { companyId: string; accountId: string; conversationId: string; bindingEpoch: number };
const ROUTE = '/api/v2/amocrm/avatars/:conversationId/content';
const digest = (secret: string, scope: Scope) =>
  createHmac('sha256', secret)
    .update(JSON.stringify(['amocrm-avatar-v1', scope.companyId, scope.accountId, scope.conversationId, scope.bindingEpoch]))
    .digest();

/** A capability for one conversation's Telegram avatar, scoped to its company,
 * CRM account, and binding epoch. The URL carries no provider credentials.
 */
export function crmAvatarUrl(input: Scope & { baseUrl: string | null | undefined; secret: string }): string {
  let base: URL;
  try {
    base = new URL(input.baseUrl ?? '');
  } catch {
    throw new Error('crm_media_base_url_missing');
  }
  if (
    base.protocol !== 'https:' ||
    base.port ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/'
  ) {
    throw new Error('crm_media_base_url_invalid');
  }
  const url = new URL(ROUTE.replace(':conversationId', encodeURIComponent(input.conversationId)), base);
  url.search = new URLSearchParams({
    companyId: input.companyId,
    accountId: input.accountId,
    bindingEpoch: String(input.bindingEpoch),
    signature: digest(input.secret, input).toString('hex'),
  }).toString();
  return url.toString();
}

export function registerCrmAvatarRoutes(
  app: FastifyInstance,
  deps: {
    db: Db;
    schema: string;
    secret: string;
    resolveBotToken: (input: {
      companyId: string;
      connectionId: string;
      credentialRef: string | null;
    }) => Promise<string | null> | string | null;
    fetch?: typeof fetch;
  },
): void {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(deps.schema)) throw new Error('INVALID_SCHEMA');
  const q = (table: string) => `"${deps.schema}"."${table}"`;
  const querySchema = z
    .object({
      companyId: z.string().min(1).max(128),
      accountId: z.string().min(1).max(128),
      bindingEpoch: z.string().regex(/^\d+$/),
      signature: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict();
  let inFlight = 0;
  app.get<{ Params: { conversationId: string } }>(ROUTE, async (request, reply) => {
    reply.header('cache-control', 'private, no-store').header('referrer-policy', 'no-referrer');
    const parsed = querySchema.safeParse(request.query);
    const conversationId = request.params.conversationId;
    if (!parsed.success || !/^[a-f0-9-]{36}$/i.test(conversationId)) {
      return reply.code(404).send({ code: 'NOT_FOUND' });
    }
    const bindingEpoch = Number(parsed.data.bindingEpoch);
    if (!Number.isSafeInteger(bindingEpoch) || bindingEpoch < 0) {
      return reply.code(404).send({ code: 'NOT_FOUND' });
    }
    const scope: Scope = {
      companyId: parsed.data.companyId,
      accountId: parsed.data.accountId,
      conversationId,
      bindingEpoch,
    };
    if (!timingSafeEqual(digest(deps.secret, scope), Buffer.from(parsed.data.signature, 'hex'))) {
      return reply.code(404).send({ code: 'NOT_FOUND' });
    }
    if (inFlight >= 2) {
      return reply.header('retry-after', '1').code(429).send({ code: 'RATE_LIMITED' });
    }
    inFlight++;
    try {
      const rows = (
        await deps.db.query<{
          connection_id: string;
          credential_ref: string | null;
          external_chat_id: string;
        }>(
          `SELECT n.id AS connection_id,n.credential_ref,c.external_chat_id
           FROM ${q('conversations')} c
           JOIN ${q('connections')} n ON n.company_id=c.company_id AND n.id=c.connection_id AND n.binding_epoch=c.binding_epoch
           JOIN ${q('connection_routes')} r ON r.company_id=c.company_id AND r.connection_id=c.connection_id AND r.crm_account_id=$2
           JOIN ${q('crm_accounts')} a ON a.company_id=r.company_id AND a.id=r.crm_account_id AND a.state='active'
            JOIN ${q('amocrm_channels')} ch ON ch.company_id=c.company_id AND ch.account_id=r.crm_account_id
              AND ch.connection_id=c.connection_id AND ch.binding_epoch=c.binding_epoch AND ch.state='connected'
           WHERE c.company_id=$1 AND c.id=$3 AND c.binding_epoch=$4 AND c.chat_kind='private'
             AND c.external_chat_id ~ '^[1-9][0-9]*$'
              AND n.channel_mode='telegram_bot' AND n.state IN ('active','degraded')
             AND ${q('channel_crm_import_allowed')}(c.company_id,c.connection_id,c.binding_epoch,c.external_chat_id,c.chat_kind)`,
          [scope.companyId, scope.accountId, scope.conversationId, scope.bindingEpoch],
        )
      ).rows;
      if (rows.length !== 1) return reply.code(404).send({ code: 'NOT_FOUND' });
      const row = rows[0]!;
      const userId = Number(row.external_chat_id);
      if (!Number.isSafeInteger(userId) || userId <= 0) return reply.code(404).send({ code: 'NOT_FOUND' });
      const botToken = await deps.resolveBotToken({
        companyId: scope.companyId,
        connectionId: row.connection_id,
        credentialRef: row.credential_ref,
      });
      if (!botToken) return reply.code(404).send({ code: 'NOT_FOUND' });
      const bytes = await downloadTelegramAvatar({
        botToken,
        userId,
        fetch: deps.fetch,
        timeoutMs: 15000,
        maxBytes: 1024 * 1024,
      });
      if (bytes === null) return reply.code(404).send({ code: 'NOT_FOUND' });
      return reply
        .header('content-type', 'image/jpeg')
        .header('x-content-type-options', 'nosniff')
        .send(Buffer.from(bytes));
    } catch {
      return reply.code(503).send({ code: 'UPSTREAM_UNAVAILABLE', retryable: true });
    } finally {
      inFlight--;
    }
  });
}
