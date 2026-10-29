/**
 * Typed channel errors.
 * Messages never contain tokens, phone numbers or message text.
 * Written without TypeScript parameter properties: Node runs these files with
 * type stripping only, which rejects `constructor(readonly x: T)`.
 */

export class WebhookVerificationError extends Error {
  readonly code = 'WEBHOOK_VERIFICATION_FAILED';
  readonly reason: string;
  constructor(reason: string) {
    super(`webhook verification failed: ${reason}`);
    this.name = 'WebhookVerificationError';
    this.reason = reason;
  }
}

export class WebhookPayloadError extends Error {
  readonly code = 'WEBHOOK_PAYLOAD_INVALID';
  readonly reason: string;
  constructor(reason: string) {
    super(`webhook payload invalid: ${reason}`);
    this.name = 'WebhookPayloadError';
    this.reason = reason;
  }
}

/**
 * Raised when a send is not in the adapter's allowlist of confirmed capabilities.
 * This is a deliberate refusal, never a silent best-effort attempt.
 */
export class CapabilityNotAllowedError extends Error {
  readonly code = 'CAPABILITY_NOT_ALLOWED';
  readonly channelMode: string;
  readonly capability: string;
  readonly state: string;
  constructor(channelMode: string, capability: string, state: string) {
    super(`capability ${capability} is ${state} for ${channelMode}`);
    this.name = 'CapabilityNotAllowedError';
    this.channelMode = channelMode;
    this.capability = capability;
    this.state = state;
  }
}

export class PayloadTooLargeError extends Error {
  readonly code = 'PAYLOAD_TOO_LARGE';
  readonly field: string;
  readonly limit: number;
  constructor(field: string, limit: number) {
    super(`${field} exceeds the documented limit of ${limit}`);
    this.name = 'PayloadTooLargeError';
    this.field = field;
    this.limit = limit;
  }
}

export class OutboxJobNotFoundError extends Error {
  readonly code = 'OUTBOX_JOB_NOT_FOUND';
  readonly jobId: string;
  constructor(jobId: string) {
    super(`outbox job not found: ${jobId}`);
    this.name = 'OutboxJobNotFoundError';
    this.jobId = jobId;
  }
}
