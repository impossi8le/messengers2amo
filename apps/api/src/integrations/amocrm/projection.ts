// Adapter between the durable outbox queue and the CRM projection domain.
//
// The queue stores an untyped jsonb payload, so this module is the boundary that
// decides whether a job is mappable at all. A job it cannot map is refused before
// any CRM call: the alternative — projecting nothing and reporting success — would
// close the job while the customer's message never reached the deal.

import { AmocrmApiError } from './client.ts';
import type { AmocrmSync, CrmEventInput, InboundMessageInput } from './sync.ts';

/** The two domain operations a queued projection may perform. */
export type ProjectionSync = Pick<AmocrmSync, 'projectInboundMessage' | 'applyCrmEvent'>;

export type ProjectionDispatcher = (payload: unknown) => Promise<unknown>;

function refuse(): never {
  throw new AmocrmApiError(0, 'invalid_projection_payload');
}

function requiredId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) refuse();
  return value;
}

function optionalText(value: unknown): string {
  if (typeof value !== 'string') refuse();
  return value;
}

function optionalNullableText(value: unknown): string | null {
  if (value === null) return null;
  return optionalText(value);
}

function occurredAtOf(value: unknown): Date {
  if (typeof value !== 'string') refuse();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) refuse();
  return parsed;
}

function readMessage(record: Record<string, unknown>): InboundMessageInput {
  const direction = record.direction;
  if (direction !== 'in' && direction !== 'out') refuse();
  const input: InboundMessageInput = {
    companyId: requiredId(record.companyId),
    accountId: requiredId(record.accountId),
    conversationId: requiredId(record.conversationId),
    providerMessageId: requiredId(record.providerMessageId),
    direction,
  };
  if (record.text !== undefined) input.text = optionalText(record.text);
  if (record.phone !== undefined) input.phone = optionalNullableText(record.phone);
  if (record.email !== undefined) input.email = optionalNullableText(record.email);
  if (record.senderName !== undefined) {
    const value = optionalText(record.senderName);
    if (!value.trim() || value.length > 257 || /[\u0000-\u001f\u007f]/.test(value)) refuse();
    input.senderName = value;
  }
  if (record.senderUsername !== undefined) {
    const value = optionalText(record.senderUsername);
    if (!/^[a-zA-Z0-9_]{1,32}$/.test(value)) refuse();
    input.senderUsername = value;
  }
  if (record.occurredAt !== undefined) input.occurredAt = occurredAtOf(record.occurredAt);
  return input;
}

function readEvent(record: Record<string, unknown>): CrmEventInput {
  const payload = record.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) refuse();
  return {
    companyId: requiredId(record.companyId),
    accountId: requiredId(record.accountId),
    kind: requiredId(record.kind),
    payload: payload as Record<string, unknown>,
  };
}

/**
 * The payload the inbound path writes into `outbox_jobs`. Kept next to the parser
 * so the producer and the consumer cannot drift apart unnoticed.
 */
export function buildMessageJob(input: InboundMessageInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    op: 'message',
    companyId: input.companyId,
    accountId: input.accountId,
    conversationId: input.conversationId,
    providerMessageId: input.providerMessageId,
    direction: input.direction,
  };
  if (input.text !== undefined) payload.text = input.text;
  if (input.phone !== undefined) payload.phone = input.phone;
  if (input.email !== undefined) payload.email = input.email;
  if (input.senderName !== undefined) payload.senderName = input.senderName;
  if (input.senderUsername !== undefined) payload.senderUsername = input.senderUsername;
  payload.occurredAt = input.occurredAt ? input.occurredAt.toISOString() : new Date().toISOString();
  return payload;
}

export function createProjectionDispatcher(deps: {
  sync: ProjectionSync;
  /** Resolve private attachments immediately before import, outside the CRM transaction. */
  prepareMessage?: (input: InboundMessageInput) => Promise<InboundMessageInput>;
}): ProjectionDispatcher {
  return async (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) refuse();
    const record = payload as Record<string, unknown>;
    if (record.op === 'message') {
      const input = readMessage(record);
      return deps.sync.projectInboundMessage(deps.prepareMessage ? await deps.prepareMessage(input) : input);
    }
    if (record.op === 'event') return deps.sync.applyCrmEvent(readEvent(record));
    refuse();
  };
}
