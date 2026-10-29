import { createHash } from 'node:crypto';
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
import {
  asNumber,
  asRecord,
  asString,
  assertCapability,
  assertTextLength,
  contentForSend,
  isoTimestamp,
  parseJsonBody,
  safeEqual,
  unsupportedContent,
} from './shared.ts';
import { WebhookVerificationError } from './errors.ts';

export type VkConfig = AdapterDeps & {
  groupId: number;
  accessToken: string;
  /** Shared secret from the Callback API settings; required in this adapter. */
  secret: string;
  confirmationCode: string;
  apiBase?: string;
  apiVersion?: string;
  requestTimeoutMs?: number;
};

const TEXT_LIMIT = 9000;
const GROUP_PEER_FLOOR = 2_000_000_000;

export function createVkAdapter(config: VkConfig): ChannelAdapter {
  const channelMode: ChannelMode = 'vk_community';
  const apiBase = (config.apiBase ?? 'https://api.vk.com').replace(/\/+$/, '');
  const apiVersion = config.apiVersion ?? '5.199';
  const fetchImpl = config.fetch ?? fetch;
  const now = config.now ?? (() => new Date());
  const timeoutMs = config.requestTimeoutMs ?? 15_000;

  function capabilities(): CapabilityProfile {
    return {
      textReply: 'supported',
      mediaReply: 'unknown',
      // VK has message_read and no documented delivery receipt; neither is
      // confirmed by a pilot, so both stay unknown instead of optimistic.
      readReceipts: 'unknown',
      deliveryReceipts: 'unknown',
      messageEditing: 'unknown',
      messageDeletion: 'unknown',
    };
  }

  function verifyInbound(raw: RawInbound): VerifyResult {
    let body: Record<string, unknown>;
    try {
      body = parseJsonBody(raw);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    // The confirmation handshake is how VK proves endpoint ownership; it carries
    // no secret by design and is answered with the configured code.
    if (asString(body.type) === 'confirmation') return { ok: true };
    const provided = asString(body.secret);
    if (!provided || !safeEqual(provided, config.secret)) return { ok: false, reason: 'secret_invalid' };
    return { ok: true };
  }

  function parseInbound(raw: RawInbound): InboundParseResult {
    const verified = verifyInbound(raw);
    if (!verified.ok) throw new WebhookVerificationError(verified.reason);

    const body = parseJsonBody(raw);
    const type = asString(body.type);
    if (type === 'confirmation') {
      return { events: [], handshake: { type: 'confirmation', response: config.confirmationCode } };
    }

    const receivedAt = raw.receivedAt ?? now();
    const events: NormalizedEvent[] = [];
    if (type === 'message_new' || type === 'message_reply') {
      const object = asRecord(body.object);
      const message = object ? asRecord(object.message) : null;
      if (message) {
        const messageId = asNumber(message.id);
        const peerId = asNumber(message.peer_id);
        const eventId = asString(body.event_id);
        // `out: 1` is the echo of a message we sent ourselves; treating it as an
        // inbound message would duplicate our own history.
        const isOutgoing = asNumber(message.out) === 1;
        if (messageId !== null && peerId !== null && eventId && !isOutgoing) {
          const text = asString(message.text);
          const attachments = Array.isArray(message.attachments) ? message.attachments : [];
          const content =
            text !== null && text.length > 0
              ? ({ kind: 'text', text } as const)
              : attachments.length > 0
                ? unsupportedContent('attachment')
                : unsupportedContent('empty');
          events.push({
            kind: 'message.received',
            providerEventKey: `vk:${config.groupId}:${eventId}`,
            occurredAt: isoTimestamp(message.date, receivedAt),
            externalChatId: String(peerId),
            chatKind: peerId >= GROUP_PEER_FLOOR ? 'group' : 'private',
            providerMessageId: String(messageId),
            content,
          });
        }
      }
    }
    return { events };
  }

  async function send(request: SendRequest): Promise<SendOutcome> {
    const profile = capabilities();
    assertCapability(profile, contentForSend(request.content), channelMode);
    if (request.content.kind !== 'text') {
      return { status: 'failed', errorCode: 'CAPABILITY_NOT_ALLOWED', retryable: false };
    }
    assertTextLength(request.content.text, TEXT_LIMIT);

    const peerId = Number.parseInt(request.externalChatId, 10);
    if (!Number.isFinite(peerId)) {
      return { status: 'failed', errorCode: 'INVALID_RECIPIENT', retryable: false };
    }

    const body = {
      peer_id: peerId,
      message: request.content.text,
      // Stable per idempotency key: a VK retry with the same random_id cannot
      // create a second message.
      random_id: randomIdFor(request.idempotencyKey),
      v: apiVersion,
    };

    let response: Response;
    try {
      response = await fetchImpl(`${apiBase}/method/messages.send`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : 'unknown';
      return {
        status: 'unknown',
        errorCode: name === 'AbortError' || name === 'TimeoutError' ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
      };
    }

    if (response.status === 429) return { status: 'failed', errorCode: 'RATE_LIMITED', retryable: true };
    if (response.status >= 500) return { status: 'failed', errorCode: 'UPSTREAM_UNAVAILABLE', retryable: true };

    const parsed = await readJson(response);
    if (!response.ok) {
      return { status: 'failed', errorCode: `HTTP_${response.status}`, retryable: false };
    }

    const record = asRecord(parsed);
    const error = record ? asRecord(record.error) : null;
    if (error) {
      const code = asNumber(error.error_code) ?? 0;
      return { status: 'failed', errorCode: `VK_${code}`, retryable: isRetryableVkError(code) };
    }
    const messageId = record ? asNumber(record.response) : null;
    if (messageId === null) return { status: 'unknown', errorCode: 'NO_PROVIDER_MESSAGE_ID' };
    return { status: 'sent', providerMessageId: String(messageId) };
  }

  return { channelMode, capabilities, verifyInbound, parseInbound, send };
}

/** VK accepts a 32-bit signed integer; 0 is explicitly "no idempotency". */
export function randomIdFor(idempotencyKey: string): number {
  const digest = createHash('sha256').update(idempotencyKey, 'utf8').digest();
  const value = digest.readUInt32BE(0) & 0x7fffffff;
  return value === 0 ? 1 : value;
}

function isRetryableVkError(code: number): boolean {
  // 6 = too many requests per second, 9 = flood control, 10 = internal error.
  return code === 6 || code === 9 || code === 10;
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
