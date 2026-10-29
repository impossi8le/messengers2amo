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
  headerValue,
  isoTimestamp,
  parseJsonBody,
  safeEqual,
  unsupportedContent,
} from './shared.ts';
import { WebhookVerificationError } from './errors.ts';

export type MaxConfig = AdapterDeps & {
  accessToken: string;
  /** Optional per MAX docs; when configured every request must present it. */
  webhookSecret?: string | null;
  apiBase?: string;
  requestTimeoutMs?: number;
};

/** Documented by MAX for POST /messages. */
const TEXT_LIMIT = 4000;

export function createMaxAdapter(config: MaxConfig): ChannelAdapter {
  const channelMode: ChannelMode = 'max_bot';
  const apiBase = (config.apiBase ?? 'https://platform-api2.max.ru').replace(/\/+$/, '');
  const fetchImpl = config.fetch ?? fetch;
  const now = config.now ?? (() => new Date());
  const timeoutMs = config.requestTimeoutMs ?? 15_000;

  function capabilities(): CapabilityProfile {
    return {
      textReply: 'supported',
      // Media, editing and deletion exist in the platform docs, but this adapter
      // does not implement them and no pilot has confirmed them.
      mediaReply: 'unknown',
      readReceipts: 'unknown',
      deliveryReceipts: 'unknown',
      messageEditing: 'unknown',
      messageDeletion: 'unknown',
    };
  }

  function verifyInbound(raw: RawInbound): VerifyResult {
    const expected = config.webhookSecret;
    // Fail closed: without a configured secret there is nothing to authenticate
    // a request against, so every request is unauthenticated by definition.
    if (typeof expected !== 'string' || expected.trim().length === 0) {
      return { ok: false, reason: 'secret_invalid' };
    }
    const provided = headerValue(raw, 'x-max-bot-api-secret');
    if (!provided) return { ok: false, reason: 'secret_invalid' };
    if (!safeEqual(provided, expected)) return { ok: false, reason: 'secret_invalid' };
    return { ok: true };
  }

  function parseInbound(raw: RawInbound): InboundParseResult {
    const verified = verifyInbound(raw);
    if (!verified.ok) throw new WebhookVerificationError(verified.reason);

    const body = parseJsonBody(raw);
    const receivedAt = raw.receivedAt ?? now();
    const updateType = asString(body.update_type);
    const events: NormalizedEvent[] = [];

    if (updateType === 'message_created') {
      const message = asRecord(body.message);
      const bodyRecord = message ? asRecord(message.body) : null;
      const mid = bodyRecord ? asString(bodyRecord.mid) : null;
      const recipient = message ? asRecord(message.recipient) : null;
      const chatId = recipient ? asNumber(recipient.chat_id) : null;
      if (message && bodyRecord && mid !== null && chatId !== null) {
        const chatType = asString(recipient?.chat_type) ?? 'dialog';
        const text = asString(bodyRecord.text);
        const attachments = Array.isArray(bodyRecord.attachments) ? bodyRecord.attachments : [];
        const content =
          text !== null
            ? ({ kind: 'text', text } as const)
            : attachments.length > 0
              ? unsupportedContent('attachment')
              : unsupportedContent('empty');
        events.push({
          kind: 'message.received',
          providerEventKey: `max:${mid}`,
          occurredAt: isoTimestamp(message.timestamp ?? body.timestamp, receivedAt),
          externalChatId: String(chatId),
          chatKind: chatType === 'dialog' ? 'private' : chatType === 'chat' || chatType === 'channel' ? 'group' : 'unknown',
          providerMessageId: mid,
          content,
        });
      }
    }
    // bot_started / message_callback / bot_added carry no CRM message content.
    return { events };
  }

  async function send(request: SendRequest): Promise<SendOutcome> {
    const profile = capabilities();
    assertCapability(profile, contentForSend(request.content), channelMode);
    if (request.content.kind !== 'text') {
      // Unreachable while mediaReply is unknown; kept explicit for future work.
      return { status: 'failed', errorCode: 'CAPABILITY_NOT_ALLOWED', retryable: false };
    }
    assertTextLength(request.content.text, TEXT_LIMIT);

    const chatId = Number.parseInt(request.externalChatId, 10);
    if (!Number.isFinite(chatId)) {
      return { status: 'failed', errorCode: 'INVALID_RECIPIENT', retryable: false };
    }

    let response: Response;
    try {
      response = await fetchImpl(`${apiBase}/messages?chat_id=${encodeURIComponent(String(chatId))}`, {
        method: 'POST',
        headers: {
          authorization: config.accessToken,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: request.content.text }),
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
    if (response.status === 401) return { status: 'failed', errorCode: 'AUTH_REQUIRED', retryable: false };
    if (response.status >= 500) return { status: 'failed', errorCode: 'UPSTREAM_UNAVAILABLE', retryable: true };

    const parsed = await readJson(response);
    if (!response.ok) {
      return { status: 'failed', errorCode: `HTTP_${response.status}`, retryable: false };
    }
    const message = asRecord(parsed)?.message;
    const mid = asRecord(message) ? asString(asRecord(asRecord(message)?.body)?.mid) : null;
    if (!mid) return { status: 'unknown', errorCode: 'NO_PROVIDER_MESSAGE_ID' };
    return { status: 'sent', providerMessageId: mid };
  }

  return { channelMode, capabilities, verifyInbound, parseInbound, send };
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
