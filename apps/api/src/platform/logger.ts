import { createHash } from 'node:crypto';

const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'passwordhash',
  'secret',
  'salt',
  'token',
  'authorization',
  'cookie',
  'set-cookie',
  'setcookie',
  'access_token',
  'refresh_token',
  'client_secret',
  'bot_token',
  'webhook_secret',
  'credential_ref',
  'credentialref',
  'credential_refs',
  'api_key',
  'apikey',
  'signature',
  'session',
  'text',
  'body',
  'content',
  'phone',
  'email',
  'name',
]);

const REDACTED = '[redacted]';
const MAX_DEPTH = 6;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : redact(item, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 512) return value.slice(0, 512) + '…';
  return value;
}

export function correlationId(header: unknown): string {
  if (typeof header === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(header)) return header;
  return createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 24);
}

export type LogFields = Record<string, unknown>;

export function logEvent(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: LogFields = {},
  sink: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): void {
  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(redact(fields) as LogFields),
  };
  sink(JSON.stringify(record));
}
