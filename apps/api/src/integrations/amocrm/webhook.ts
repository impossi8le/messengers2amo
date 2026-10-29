import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../platform/db.ts';
import { logEvent } from '../../platform/logger.ts';
import type { TokenCipher } from './crypto.ts';
import { loadChannelByScope, qualified, type ChannelRow } from './store.ts';

type ProtocolModule = {
  verifyChatsWebhook: (options: { rawBody: Uint8Array; signature: string; channelSecret: string }) => boolean;
};

const require = createRequire(import.meta.url);
const protocol = require('../../../../../packages/amocrm-protocol/src/index.mjs') as ProtocolModule;

const MAX_WEBHOOK_BYTES = 1024 * 1024;

export type AmocrmWebhookDeps = {
  db: Db;
  schema?: string;
  cipher: TokenCipher;
};

declare module 'fastify' {
  interface FastifyRequest {
    amocrmRawBody?: Buffer;
    amocrmChannel?: ChannelRow;
  }
}

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function headerValue(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

/** amoCRM's webhook signing example trims the HTTP body's outer whitespace.
 * Preserve every byte inside the JSON; never parse/re-serialize before HMAC. */
function trimJsonWhitespace(raw: Buffer): Buffer {
  const whitespace = (byte: number) => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
  let start = 0, end = raw.length;
  while (start < end && whitespace(raw[start]!)) start++;
  while (end > start && whitespace(raw[end - 1]!)) end--;
  return raw.subarray(start, end);
}

function eventIdentity(payload: Record<string, unknown>, raw: Buffer): { key: string; kind: string } {
  const message = payload.message;
  const nested=message && typeof message==='object' ? (message as Record<string,unknown>).message : null;
  if (nested && typeof nested==='object' && typeof (nested as Record<string,unknown>).id==='string') {
    return {key:`chats.message:${(nested as Record<string,unknown>).id}`,kind:'chats.message'};
  }
  if (message && typeof message === 'object' && typeof (message as Record<string, unknown>).id === 'string') {
    return { key: `chats.message:${(message as Record<string, unknown>).id as string}`, kind: 'chats.message' };
  }
  const chat = payload.chat;
  if (chat && typeof chat === 'object' && typeof (chat as Record<string, unknown>).id === 'string') {
    return { key: `chats.chat:${(chat as Record<string, unknown>).id as string}`, kind: 'chats.chat' };
  }
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 32);
  return { key: `chats.event:${digest}`, kind: 'chats.event' };
}

/**
 * Registers the amoCRM Chats webhook. The signature is verified in preParsing,
 * before Fastify parses JSON, allowing only the vendor's outer-whitespace trim.
 * The durable inbox
 * write is awaited before the 200, because amoCRM does not redeliver.
 */
export function registerAmocrmWebhook(app: FastifyInstance, deps: AmocrmWebhookDeps): void {
  app.addHook('preParsing', async (request, reply, payload) => {
    if (!request.url.startsWith('/webhooks/amocrm/')) return payload;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of payload as AsyncIterable<Buffer | string>) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > MAX_WEBHOOK_BYTES) throw httpError('payload_too_large', 413);
      chunks.push(buffer);
    }
    const raw = Buffer.concat(chunks);
    request.amocrmRawBody = raw;

    // Unknown/disabled scopes and bad signatures must be indistinguishable:
    // identical status and body, otherwise probing scope ids enumerates connections.
    let signatureMatchesTrimmed: boolean | undefined;
    const reject = (reason: string) => {
      logEvent('warn', 'amocrm.webhook.rejected', {
        reason,
        scopeId: /^[a-zA-Z0-9_.-]{1,160}$/.test(scopeId) ? scopeId : 'invalid_scope_format',
        signaturePresent: Boolean(headerValue(request.headers['x-signature'])),
        signatureLength: headerValue(request.headers['x-signature'])?.length ?? 0,
        signatureMatchesTrimmed,
        bodyBytes: raw.byteLength,
      });
      reply.code(401).send({ error: 'invalid_signature' });
      return Readable.from(Buffer.alloc(0));
    };

    const scopeId = (request.params as { scopeId?: string } | undefined)?.scopeId ?? '';
    const channel = await loadChannelByScope(deps.db, deps.schema, scopeId);
    if (!channel || channel.state !== 'connected') return reject(!channel ? 'unknown_scope' : 'disabled_scope');

    let secret: string;
    try {
      secret = deps.cipher.decrypt(channel.secret_enc);
    } catch {
      throw httpError('channel_secret_unavailable', 503);
    }
    const signature = headerValue(request.headers['x-signature']);
    if (!signature || !protocol.verifyChatsWebhook({ rawBody: raw, signature, channelSecret: secret })) {
      if (signature) signatureMatchesTrimmed = protocol.verifyChatsWebhook({
        rawBody: trimJsonWhitespace(raw), signature, channelSecret: secret,
      });
      if (!signatureMatchesTrimmed) return reject(signature ? 'signature_invalid' : 'signature_missing');
    }
    request.amocrmChannel = channel;
    return Readable.from(raw);
  });

  app.post('/webhooks/amocrm/:scopeId', async (request, reply) => {
    const channel = request.amocrmChannel;
    const raw = request.amocrmRawBody;
    if (!channel || !raw) return reply.code(401).send({ error: 'invalid_signature' });

    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.code(400).send({ error: 'invalid_payload' });
    }
    const payload = body as Record<string, unknown>;
    const accountId = payload.account_id;
    if (accountId !== undefined && String(accountId) !== channel.amojo_account_id) {
      return reply.code(403).send({ error: 'scope_mismatch' });
    }

    const { key, kind } = eventIdentity(payload, raw);
    const occurredAt =
      typeof payload.time === 'number'
        ? new Date(payload.time * 1000)
        : typeof (payload.message as Record<string, unknown> | undefined)?.date === 'number'
          ? new Date(((payload.message as Record<string, unknown>).date as number) * 1000)
          : null;

    let inserted: number;
    try {
      const result = await deps.db.query(
        `INSERT INTO ${qualified(deps.schema, 'inbox_events')}
           (company_id,id,connection_id,binding_epoch,provider_event_key,payload_major,kind,payload,occurred_at)
         VALUES ($1,$2,$3,$4,$5,2,$6,$7,$8)
         ON CONFLICT (company_id,connection_id,binding_epoch,provider_event_key)
           WHERE provider_event_key IS NOT NULL
         DO NOTHING`,
        [
          channel.company_id,
          `evt_${randomBytes(12).toString('hex')}`,
          channel.connection_id,
          Number(channel.binding_epoch),
          key,
          kind,
          JSON.stringify(payload),
          occurredAt,
        ],
      );
      inserted = result.rowCount ?? 0;
    } catch {
      // Without a durable row there must be no acknowledgement.
      return reply.code(503).send({ error: 'storage_unavailable' });
    }
    return reply.code(200).send({ status: inserted === 0 ? 'duplicate' : 'accepted' });
  });
}
