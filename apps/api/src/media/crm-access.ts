import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../platform/db.ts';
import { MediaError } from './service.ts';
import { sha256Hex, type ObjectStorage } from './storage.ts';
import { sanitizeFileName } from './policy.ts';

type MediaScope = { companyId: string; accountId: string; attachmentId: string };
const ROUTE = '/api/v2/amocrm/media/:attachmentId/content';
const MAX_BYTES = 20 * 1024 * 1024;

function signature(secret: string, scope: MediaScope): Buffer {
  return createHmac('sha256', secret)
    .update(JSON.stringify(['amocrm-media-v1', scope.companyId, scope.accountId, scope.attachmentId]))
    .digest();
}

/** A capability for one archived attachment, scoped to its company and CRM account.
 * It survives deferred amoCRM downloads and process restarts. Current DB policy,
 * account state and binding epoch are checked on every read; rotating the signing
 * secret revokes all links. Never log or persist the resulting URL.
 */
export function crmMediaUrl(input: MediaScope & { baseUrl: string | null | undefined; secret: string }): string {
  let base: URL;
  try { base = new URL(input.baseUrl ?? ''); } catch { throw new Error('crm_media_base_url_missing'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('crm_media_base_url_invalid');
  }
  const url = new URL(ROUTE.replace(':attachmentId', encodeURIComponent(input.attachmentId)), base);
  url.search = new URLSearchParams({ companyId: input.companyId, accountId: input.accountId,
    signature: signature(input.secret, input).toString('hex') }).toString();
  return url.toString();
}

export function registerCrmMediaRoutes(app: FastifyInstance, deps: {
  db: Db; schema: string; storage: ObjectStorage; secret: string;
}): void {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(deps.schema)) throw new Error('INVALID_SCHEMA');
  const table = (name: string) => `"${deps.schema}"."${name}"`;
  const querySchema = z.object({companyId:z.string().min(1).max(128),accountId:z.string().min(1).max(128),
    signature:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
  // Bound simultaneous buffered downloads independently of operator uploads.
  let inFlight = 0;
  app.get<{Params:{attachmentId:string}}>(ROUTE, async (request, reply) => {
    reply.header('cache-control','private, no-store').header('referrer-policy','no-referrer');
    const parsed = querySchema.safeParse(request.query);
    const attachmentId = request.params.attachmentId;
    if (!parsed.success || !/^att_[a-f0-9]{32}$/.test(attachmentId)) return reply.code(404).send({code:'NOT_FOUND'});
    const scope = {companyId:parsed.data.companyId,accountId:parsed.data.accountId,attachmentId};
    if (!timingSafeEqual(signature(deps.secret,scope),Buffer.from(parsed.data.signature,'hex'))) {
      return reply.code(404).send({code:'NOT_FOUND'});
    }
    if (inFlight >= 2) return reply.header('retry-after','1').code(429).send({code:'RATE_LIMITED',retryable:true});
    inFlight++;
    try {
      const result = await deps.db.query<{
        s3_key:string; original_name:string; mime_type:string; byte_size:string; sha256:string;
      }>(
        `SELECT a.s3_key,a.original_name,a.mime_type,a.byte_size,a.sha256
           FROM ${table('attachments')} a
           JOIN ${table('media_assets')} m ON m.company_id=a.company_id AND m.storage_key=a.s3_key
           JOIN ${table('messages')} msg ON msg.company_id=a.company_id AND msg.id=a.message_id AND msg.direction='in'
           JOIN ${table('conversations')} c ON c.company_id=a.company_id AND c.id=a.conversation_id
           JOIN ${table('connections')} n ON n.company_id=a.company_id AND n.id=a.connection_id AND n.binding_epoch=a.binding_epoch
           JOIN ${table('connection_routes')} r ON r.company_id=a.company_id AND r.connection_id=a.connection_id AND r.crm_account_id=$2
           JOIN ${table('crm_accounts')} crm ON crm.company_id=r.company_id AND crm.id=r.crm_account_id AND crm.state='active'
          WHERE a.company_id=$1 AND a.id=$3 AND a.storage_state='verified' AND m.state='ready'
            AND NOT a.group_archive_only AND n.state IN ('active','degraded')
            AND ${table('channel_crm_import_allowed')}(a.company_id,a.connection_id,a.binding_epoch,a.external_chat_id,c.chat_kind)`,
        [scope.companyId,scope.accountId,attachmentId],
      );
      const asset = result.rows[0];
      if (!asset) return reply.code(404).send({code:'NOT_FOUND'});
      const size = Number(asset.byte_size);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES) throw new MediaError(503,'UPSTREAM_UNAVAILABLE',true);
      const bytes = await deps.storage.get(asset.s3_key,{maxBytes:size,timeoutMs:15000});
      if (!bytes || bytes.byteLength !== size || sha256Hex(bytes) !== asset.sha256) {
        throw new MediaError(503,'UPSTREAM_UNAVAILABLE',true);
      }
      return reply.header('content-type',asset.mime_type)
        .header('content-disposition',`attachment; filename*=UTF-8''${encodeURIComponent(sanitizeFileName(asset.original_name))
          .replace(/[!'()*]/g,(char)=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`)
        .header('x-content-type-options','nosniff').header('content-length',size).send(Buffer.from(bytes));
    } catch {
      // Storage/DB errors may contain signed URLs; expose only a stable code.
      return reply.code(503).send({code:'UPSTREAM_UNAVAILABLE',retryable:true});
    } finally { inFlight--; }
  });
}
