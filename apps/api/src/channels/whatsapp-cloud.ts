import type {
  AdapterDeps,
  CapabilityProfile,
  ChannelAdapter,
  ChannelMode,
  InboundParseResult,
  NormalizedEvent,
  RawInbound,
  SendOutcome,
  SendRequest,
  VerifyResult,
} from './types.ts';
import { assertCapability, assertTextLength, contentForSend, headerValue, hmacSha256Hex, isoTimestamp, parseJsonBody, safeEqual, asRecord, asString, asNumber, unsupportedContent, type MediaResolver } from './shared.ts';
import { WebhookVerificationError } from './errors.ts';

export type WhatsAppCloudConfig = AdapterDeps & {
  appSecret: string;
  accessToken: string;
  phoneNumberId: string;
  apiBase?: string;
  /** Confirmed only when a real media source is wired; otherwise mediaReply stays unknown. */
  mediaResolver?: MediaResolver;
  requestTimeoutMs?: number;
};

const TEXT_LIMIT = 4096;
const SUPPORTED_INBOUND_TYPES = new Set(['text', 'image', 'document', 'audio', 'video']);

export function createWhatsAppCloudAdapter(config: WhatsAppCloudConfig): ChannelAdapter {
  const channelMode: ChannelMode = 'whatsapp_cloud';
  const apiBase = (config.apiBase ?? 'https://graph.facebook.com/v21.0').replace(/\/+$/, '');
  const fetchImpl = config.fetch ?? fetch;
  const now = config.now ?? (() => new Date());
  const timeoutMs = config.requestTimeoutMs ?? 15_000;

  function capabilities(): CapabilityProfile {
    return {
      textReply: 'supported',
      // Cloud API documents image/document/audio/video sending, but this adapter
      // can only honour it when a media source is actually wired in.
      mediaReply: config.mediaResolver ? 'supported' : 'unknown',
      readReceipts: 'supported',
      deliveryReceipts: 'supported',
      messageEditing: 'unknown',
      messageDeletion: 'unknown',
    };
  }

  function verifyInbound(raw: RawInbound): VerifyResult {
    const secret = config.appSecret;
    // Fail closed: an empty key still produces a valid-looking HMAC that anyone
    // can compute, so verification must refuse before touching the header.
    if (typeof secret !== 'string' || secret.trim().length === 0) {
      return { ok: false, reason: 'signature_invalid' };
    }
    const header = headerValue(raw, 'x-hub-signature-256');
    if (!header) return { ok: false, reason: 'signature_invalid' };
    const match = /^sha256=([a-f0-9]{64})$/i.exec(header.trim());
    if (!match || !match[1]) return { ok: false, reason: 'signature_invalid' };
    const expected = hmacSha256Hex(secret, raw.body);
    if (!safeEqual(expected, match[1].toLowerCase())) return { ok: false, reason: 'signature_invalid' };
    return { ok: true };
  }

  function parseInbound(raw: RawInbound): InboundParseResult {
    // Verification is mandatory even when the caller already ran it: parsing
    // unauthenticated input is never acceptable.
    const verified = verifyInbound(raw);
    if (!verified.ok) throw new WebhookVerificationError(verified.reason);

    const body = parseJsonBody(raw);
    const receivedAt = raw.receivedAt ?? now();
    const events: NormalizedEvent[] = [];

    const entries = Array.isArray(body.entry) ? body.entry : [];
    for (const entryRaw of entries) {
      const entry = asRecord(entryRaw);
      const changes = entry && Array.isArray(entry.changes) ? entry.changes : [];
      for (const changeRaw of changes) {
        const change = asRecord(changeRaw);
        const value = change ? asRecord(change.value) : null;
        if (!value) continue;
        const metadata = asRecord(value.metadata);
        const phoneNumberId = (metadata && asString(metadata.phone_number_id)) ?? config.phoneNumberId;

        const messages = Array.isArray(value.messages) ? value.messages : [];
        for (const messageRaw of messages) {
          const message = asRecord(messageRaw);
          const id = message && asString(message.id);
          const from = message && asString(message.from);
          if (!message || !id || !from) continue;
          const type = asString(message.type) ?? 'unknown';
          const content = normalizeContent(type, message);
          events.push({
            kind: 'message.received',
            providerEventKey: `wa:${phoneNumberId}:${id}`,
            occurredAt: isoTimestamp(message.timestamp, receivedAt),
            externalChatId: from,
            chatKind: 'private',
            providerMessageId: id,
            content,
          });
        }

        const statuses = Array.isArray(value.statuses) ? value.statuses : [];
        for (const statusRaw of statuses) {
          const status = asRecord(statusRaw);
          const id = status && asString(status.id);
          const name = status && asString(status.status);
          if (!status || !id || !name) continue;
          const normalized = normalizeStatus(name);
          if (!normalized) continue;
          events.push({
            kind: normalized === 'read' ? 'message.read_observed' : 'message.delivery_observed',
            providerEventKey: `wa-status:${phoneNumberId}:${id}:${normalized}`,
            occurredAt: isoTimestamp(status.timestamp, receivedAt),
            externalChatId: asString(status.recipient_id),
            chatKind: 'unknown',
            providerMessageId: id,
            status: normalized,
          });
        }
      }
    }
    return { events };
  }

  async function send(request: SendRequest): Promise<SendOutcome> {
    const profile = capabilities();
    assertCapability(profile, contentForSend(request.content), channelMode);

    let payload: Record<string, unknown>;
    if (request.content.kind === 'text') {
      assertTextLength(request.content.text, TEXT_LIMIT);
      payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: request.externalChatId,
        type: 'text',
        text: { body: request.content.text },
      };
    } else {
      const resolver = config.mediaResolver;
      if (!resolver) assertCapability(profile, 'mediaReply', channelMode);
      const resolved = resolver ? await resolver(request.content.mediaId) : null;
      if (!resolved) {
        return { status: 'failed', errorCode: 'MEDIA_NOT_AVAILABLE', retryable: false };
      }
      payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: request.externalChatId,
        type: 'image',
        image: {
          link: resolved.link,
          ...(request.content.caption ? { caption: request.content.caption } : {}),
        },
      };
    }

    let response: Response;
    try {
      response = await fetchImpl(`${apiBase}/${encodeURIComponent(config.phoneNumberId)}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // The request may or may not have reached the provider. Never retry blindly.
      const name = error instanceof Error ? error.name : 'unknown';
      return { status: 'unknown', errorCode: name === 'AbortError' || name === 'TimeoutError' ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE' };
    }

    if (response.status === 429) {
      return { status: 'failed', errorCode: 'RATE_LIMITED', retryable: true };
    }
    if (response.status >= 500) {
      return { status: 'failed', errorCode: 'UPSTREAM_UNAVAILABLE', retryable: true };
    }

    const parsed = await readJson(response);
    if (!response.ok) {
      const code = providerCode(parsed);
      return { status: 'failed', errorCode: code ? `WA_${code}` : `HTTP_${response.status}`, retryable: false };
    }

    const messages = asRecord(parsed)?.messages;
    const first = Array.isArray(messages) ? asRecord(messages[0]) : null;
    const providerMessageId = first ? asString(first.id) : null;
    if (!providerMessageId) {
      // A 2xx without a message id does not prove the send was accepted.
      return { status: 'unknown', errorCode: 'NO_PROVIDER_MESSAGE_ID' };
    }
    return { status: 'sent', providerMessageId };
  }

  return { channelMode, capabilities, verifyInbound, parseInbound, send };
}

function normalizeContent(type: string, message: Record<string, unknown>) {
  if (type === 'text') {
    const text = asRecord(message.text);
    const body = text ? asString(text.body) : null;
    if (body !== null) return { kind: 'text' as const, text: body };
    return unsupportedContent('text_without_body');
  }
  if (SUPPORTED_INBOUND_TYPES.has(type)) {
    const media = asRecord(message[type]);
    const id = media ? asString(media.id) : null;
    const caption = media ? asString(media.caption) : null;
    if (id) return { kind: 'attachment' as const, mediaId: id, caption: caption ?? '' };
  }
  return unsupportedContent(type);
}

function normalizeStatus(status: string): 'delivered' | 'failed' | 'read' | null {
  switch (status) {
    case 'read':
      return 'read';
    case 'delivered':
      return 'delivered';
    case 'failed':
      return 'failed';
    // `sent` and `deleted` are not delivery proofs and are not stored as receipts.
    default:
      return null;
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function providerCode(payload: unknown): string | null {
  const record = asRecord(payload);
  const error = record ? asRecord(record.error) : null;
  const code = error ? asNumber(error.code) : null;
  return code === null ? null : String(code);
}
