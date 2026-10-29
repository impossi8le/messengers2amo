/**
 * Channel adapter contract.
 *
 * Design rules encoded here:
 * - A capability is only `supported` when the provider documents it and this
 *   adapter implements it. Everything else is `unknown` (or `unsupported` when
 *   the provider explicitly has no such feature).
 * - `send()` reports only what the provider API confirmed. Delivery/read are
 *   separate inbound facts and can never be derived from an HTTP 200.
 * - Verification happens on raw bytes, before any parsing or persistence.
 */

export type CapabilityState = 'supported' | 'unsupported' | 'unknown';

export const CAPABILITY_NAMES = [
  'textReply',
  'mediaReply',
  'readReceipts',
  'deliveryReceipts',
  'messageEditing',
  'messageDeletion',
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

export type CapabilityProfile = Record<CapabilityName, CapabilityState>;

export type ChannelMode =
  | 'telegram_bot'
  | 'telegram_personal'
  | 'telegram_business'
  | 'whatsapp_cloud'
  | 'whatsapp_qr'
  | 'max_bot'
  | 'vk_community';

export type InboundHeaders = Record<string, string | string[] | undefined>;

export type RawInbound = {
  /** Untouched request body. Signatures are computed over exactly these bytes. */
  body: Buffer;
  headers: InboundHeaders;
  receivedAt?: Date;
};

export type VerifyResult = { ok: true } | { ok: false; reason: 'signature_invalid' | 'secret_invalid' | 'malformed' };

export type ChatKind = 'private' | 'group' | 'unknown';

export type NormalizedContent =
  | { kind: 'text'; text: string }
  | { kind: 'attachment'; mediaId: string; caption: string }
  | { kind: 'unsupported'; providerType: string };

export type ReceiptStatus = 'delivered' | 'failed' | 'read';

export type NormalizedEvent =
  | {
      kind: 'message.received';
      providerEventKey: string;
      occurredAt: string;
      externalChatId: string;
      chatKind: ChatKind;
      providerMessageId: string;
      content: NormalizedContent;
    }
  | {
      kind: 'message.delivery_observed' | 'message.read_observed';
      providerEventKey: string;
      occurredAt: string;
      externalChatId: string | null;
      chatKind: ChatKind;
      providerMessageId: string;
      status: ReceiptStatus;
    };

export type InboundParseResult = {
  events: NormalizedEvent[];
  /** Provider handshake that must be answered verbatim (VK confirmation). */
  handshake?: { type: 'confirmation'; response: string };
};

export type SendContent =
  | { kind: 'text'; text: string }
  | { kind: 'attachment'; mediaId: string; caption: string };

export type SendRequest = {
  externalChatId: string;
  idempotencyKey: string;
  content: SendContent;
};

export type SendOutcome =
  | { status: 'sent'; providerMessageId: string }
  | { status: 'failed'; errorCode: string; retryable: boolean }
  | { status: 'unknown'; errorCode: string };

export type FetchLike = typeof fetch;

export type AdapterDeps = {
  fetch?: FetchLike;
  now?: () => Date;
};

export interface ChannelAdapter {
  readonly channelMode: ChannelMode;
  capabilities(): CapabilityProfile;
  verifyInbound(raw: RawInbound): VerifyResult;
  parseInbound(raw: RawInbound): InboundParseResult;
  send(request: SendRequest): Promise<SendOutcome>;
}
