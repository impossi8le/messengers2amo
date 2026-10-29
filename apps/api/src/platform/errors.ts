import type { FastifyReply } from 'fastify';

export type ApiErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'CAPACITY_EXCEEDED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'STALE_EPOCH'
  | 'CAPABILITY_BLOCKED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

const STATUS: Record<ApiErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  CAPACITY_EXCEEDED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  STALE_EPOCH: 409,
  CAPABILITY_BLOCKED: 422,
  UPSTREAM_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

const RETRYABLE: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>([
  'UPSTREAM_UNAVAILABLE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
]);

/**
 * Contract-shaped safe error: a stable code, the internal request id and a retry hint.
 * Never include request data, resource state or secret values here.
 */
export function sendError(
  reply: FastifyReply,
  requestId: string,
  code: ApiErrorCode,
  status = STATUS[code],
): FastifyReply {
  return reply.code(status).send({ code, requestId, retryable: RETRYABLE.has(code) });
}

export function apiErrorStatus(code: ApiErrorCode): number {
  return STATUS[code];
}
