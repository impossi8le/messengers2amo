import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CapabilityName, CapabilityProfile, NormalizedContent, RawInbound } from './types.ts';
import { CapabilityNotAllowedError, PayloadTooLargeError, WebhookPayloadError } from './errors.ts';

/** Constant-time comparison that tolerates different lengths. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function hmacSha256Hex(secret: string, body: Buffer): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function headerValue(raw: RawInbound, name: string): string | null {
  const value = raw.headers[name.toLowerCase()] ?? raw.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function parseJsonBody(raw: RawInbound): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.body.toString('utf8'));
  } catch {
    throw new WebhookPayloadError('body_is_not_json');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WebhookPayloadError('body_is_not_an_object');
  }
  return parsed as Record<string, unknown>;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function isoTimestamp(value: unknown, fallback: Date): string {
  const seconds = asNumber(value);
  if (seconds !== null && seconds > 0) {
    // Providers mix seconds and milliseconds; 1e12 is beyond year 33658 in seconds.
    const millis = seconds > 1e12 ? seconds : seconds * 1000;
    const date = new Date(millis);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return fallback.toISOString();
}

/**
 * Refuses a send whose capability is not confirmed. This is the single gate
 * shared by every adapter, so an unimplemented feature cannot be attempted.
 */
export function assertCapability(profile: CapabilityProfile, capability: CapabilityName, channelMode: string): void {
  const state = profile[capability];
  if (state !== 'supported') {
    throw new CapabilityNotAllowedError(channelMode, capability, state);
  }
}

export function assertTextLength(text: string, limit: number): void {
  if (text.length > limit) throw new PayloadTooLargeError('text', limit);
  if (text.trim().length === 0) throw new WebhookPayloadError('text_is_empty');
}

export function contentForSend(content: { kind: 'text' } | { kind: 'attachment' }): CapabilityName {
  return content.kind === 'text' ? 'textReply' : 'mediaReply';
}

/**
 * Outbound media is only accepted when a resolver is configured. Without one the
 * adapter honestly reports mediaReply=unknown and refuses the send.
 */
export type MediaResolver = (mediaId: string) => Promise<{ link: string } | null>;

export function unsupportedContent(providerType: string): NormalizedContent {
  return { kind: 'unsupported', providerType };
}
