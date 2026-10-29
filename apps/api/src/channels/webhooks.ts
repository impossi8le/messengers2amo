import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from '../app.ts';
import { logEvent } from '../platform/logger.ts';
import { InboxConflictError } from '../telegram/inbox.ts';
import { WebhookPayloadError, WebhookVerificationError } from './errors.ts';
import { ingestWebhook, type ConnectionScope } from './inbox.ts';
import { createMaxAdapter } from './max.ts';
import type { ChannelAdapter, ChannelMode, RawInbound } from './types.ts';
import { createVkAdapter } from './vk.ts';
import { createWhatsAppCloudAdapter } from './whatsapp-cloud.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Exact bytes of a channel webhook body, captured before JSON parsing. */
    channelRawBody?: Buffer;
  }
}

const CHANNEL_PREFIXES = ['/webhooks/whatsapp/', '/webhooks/max/', '/webhooks/vk/'];
const MAX_WEBHOOK_BYTES = 1024 * 1024;

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function isChannelWebhook(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return CHANNEL_PREFIXES.some((prefix) => path.startsWith(prefix));
}

type ConnectionRow = {
  company_id: string;
  binding_epoch: string;
  channel_mode: string;
};

/**
 * Resolves the connection only after the request has been authenticated. A
 * connection that exists but belongs to another channel is reported exactly
 * like a missing one, so the route cannot be used to enumerate connections.
 */
async function resolveScope(
  deps: AppDeps,
  connectionId: string,
  expected: ChannelMode,
): Promise<ConnectionScope | 'not_found' | 'ambiguous'> {
  const { rows } = await deps.db.query<ConnectionRow>(
    'SELECT company_id, binding_epoch, channel_mode FROM connections WHERE id = $1',
    [connectionId],
  );
  if (rows.length === 0) return 'not_found';
  if (rows.length > 1) return 'ambiguous';
  const row = rows[0];
  if (!row) return 'not_found';
  // A provider event can never be applied to a connection of another channel.
  if (row.channel_mode !== expected) return 'not_found';
  return { companyId: row.company_id, connectionId, bindingEpoch: Number(row.binding_epoch) };
}

function rawInbound(request: FastifyRequest): RawInbound {
  return {
    body: request.channelRawBody ?? Buffer.alloc(0),
    headers: request.headers,
    receivedAt: new Date(),
  };
}

async function handleInbound(
  deps: AppDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  name: string,
  expected: ChannelMode,
  adapter: ChannelAdapter,
): Promise<FastifyReply> {
  const raw = rawInbound(request);

  // Verification precedes any database access and any parsing side effect.
  const verified = adapter.verifyInbound(raw);
  if (!verified.ok) {
    if (verified.reason === 'malformed') {
      return reply.code(400).send({ error: 'invalid_update' });
    }
    logEvent('warn', `${name}.webhook.rejected`, {
      correlationId: request.correlationId,
      reason: verified.reason,
    });
    return reply.code(401).send({ error: 'unauthorized' });
  }

  const connectionId = (request.params as { connectionId?: string }).connectionId ?? '';
  const scope = await resolveScope(deps, connectionId, expected);
  if (scope === 'not_found') return reply.code(404).send({ error: 'connection_not_found' });
  if (scope === 'ambiguous') return reply.code(409).send({ error: 'ambiguous_connection' });

  try {
    const result = await ingestWebhook({
      db: deps.db,
      schema: deps.operator?.schema ?? 'public',
      adapter,
      connection: scope,
      raw,
    });
    if (result.handshake) {
      return reply.code(200).type('text/plain').send(result.handshake.response);
    }
    const duplicate = result.accepted === 0 && result.duplicates > 0;
    logEvent('info', `${name}.webhook.stored`, {
      correlationId: request.correlationId,
      connectionId,
      accepted: result.accepted,
      duplicates: result.duplicates,
    });
    return reply.code(200).send({
      ok: true,
      duplicate,
      accepted: result.accepted,
      duplicates: result.duplicates,
    });
  } catch (error) {
    if (error instanceof InboxConflictError) {
      logEvent('warn', `${name}.webhook.conflict`, {
        correlationId: request.correlationId,
        connectionId,
        reason: 'payload_changed',
      });
      return reply.code(409).send({ error: 'payload_conflict' });
    }
    if (error instanceof WebhookPayloadError) {
      return reply.code(400).send({ error: 'invalid_update' });
    }
    if (error instanceof WebhookVerificationError) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    // No ACK is produced when durable storage failed.
    throw error;
  }
}

export function registerChannelWebhooks(app: FastifyInstance, deps: AppDeps): void {
  // WhatsApp signs the exact received bytes, so the raw body must be captured
  // before Fastify parses JSON. The same buffer is reused by every adapter.
  app.addHook('preParsing', async (request, _reply, payload) => {
    if (!isChannelWebhook(request.url)) return payload;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of payload as AsyncIterable<Buffer | string>) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > MAX_WEBHOOK_BYTES) throw httpError('payload_too_large', 413);
      chunks.push(buffer);
    }
    const raw = Buffer.concat(chunks);
    request.channelRawBody = raw;
    return Readable.from(raw);
  });

  app.post('/webhooks/whatsapp/:connectionId', async (request, reply) => {
    const config = deps.config.whatsapp;
    if (!config) return reply.code(503).send({ error: 'whatsapp_not_configured' });
    const adapter = createWhatsAppCloudAdapter(config);
    return handleInbound(deps, request, reply, 'whatsapp', 'whatsapp_cloud', adapter);
  });

  // Meta subscription handshake: the challenge is echoed only for the
  // configured verify token. It touches no database and reveals nothing else.
  app.get('/webhooks/whatsapp/:connectionId', async (request, reply) => {
    const config = deps.config.whatsapp;
    if (!config) return reply.code(503).send({ error: 'whatsapp_not_configured' });
    const query = request.query as Record<string, unknown>;
    if (query['hub.mode'] !== 'subscribe') {
      return reply.code(403).send({ error: 'invalid_subscription_request' });
    }
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    if (!config.verifyToken || typeof token !== 'string' || token !== config.verifyToken) {
      return reply.code(403).send({ error: 'invalid_subscription_request' });
    }
    if (typeof challenge !== 'string') {
      return reply.code(400).send({ error: 'missing_challenge' });
    }
    return reply.code(200).type('text/plain').send(challenge);
  });

  app.post('/webhooks/max/:connectionId', async (request, reply) => {
    const config = deps.config.max;
    if (!config) return reply.code(503).send({ error: 'max_not_configured' });
    const adapter = createMaxAdapter(config);
    return handleInbound(deps, request, reply, 'max', 'max_bot', adapter);
  });

  app.post('/webhooks/vk/:connectionId', async (request, reply) => {
    const config = deps.config.vk;
    if (!config) return reply.code(503).send({ error: 'vk_not_configured' });
    const adapter = createVkAdapter(config);
    return handleInbound(deps, request, reply, 'vk', 'vk_community', adapter);
  });

  // VK Callback API confirmation. The handshake carries no secret by design
  // (see the adapter's verifyInbound); any other GET is refused.
  app.get('/webhooks/vk/:connectionId', async (request, reply) => {
    const config = deps.config.vk;
    if (!config) return reply.code(503).send({ error: 'vk_not_configured' });
    const query = request.query as Record<string, unknown>;
    if (query.type !== 'confirmation') {
      return reply.code(403).send({ error: 'invalid_confirmation_request' });
    }
    const connectionId = (request.params as { connectionId?: string }).connectionId ?? '';
    const scope = await resolveScope(deps, connectionId, 'vk_community');
    if (scope === 'not_found') return reply.code(404).send({ error: 'connection_not_found' });
    if (scope === 'ambiguous') return reply.code(409).send({ error: 'ambiguous_connection' });
    return reply.code(200).type('text/plain').send(config.confirmationCode);
  });
}
