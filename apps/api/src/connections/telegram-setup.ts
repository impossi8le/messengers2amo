import type { TokenCipher } from '../integrations/amocrm/crypto.ts';

const MAX_RESPONSE_BYTES = 64 * 1024; // 64KB
const ENVELOPE_PREFIX = 'chancred_v1.';

export type VerifyTelegramBotTokenInput = {
  botToken: string;
  fetch: typeof fetch;
  apiBase?: string;
  timeoutMs?: number;
};

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const parsedLength = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new Error('response_too_large');
    }
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            try {
              await reader.cancel();
            } catch {
              // ignore cancel error
            }
            throw new Error('response_too_large');
          }
          chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore lock release error
      }
    }

    return Buffer.concat(chunks).toString('utf8');
  }

  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Error('response_too_large');
  }
  return text;
}

export async function verifyTelegramBotToken(
  input: VerifyTelegramBotTokenInput,
): Promise<{ providerId: string; displayName: string }> {
  if (!input || typeof input !== 'object') {
    throw new Error('invalid_input');
  }

  if (typeof input.botToken !== 'string') {
    throw new Error('invalid_token');
  }

  const token = input.botToken.trim();
  if (token.length === 0 || token.length > 512) {
    throw new Error('invalid_token');
  }

  if (typeof input.fetch !== 'function') {
    throw new Error('invalid_fetch');
  }

  const apiBase = (input.apiBase ?? 'https://api.telegram.org').replace(/\/+$/, '');
  const url = `${apiBase}/bot${token}/getMe`;

  const timeoutMs = input.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await input.fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('request_timeout');
    }
    throw new Error('network_error');
  }

  let bodyText: string;
  try {
    bodyText = await readBoundedBody(response, MAX_RESPONSE_BYTES);
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'response_too_large') {
      throw err;
    }
    throw new Error('failed_to_read_response');
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('unauthorized');
  }

  if (!response.ok) {
    throw new Error('request_failed');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error('malformed_response');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('malformed_response');
  }

  const resObj = parsed as { ok?: unknown; result?: unknown; error_code?: unknown };
  if (resObj.ok !== true) {
    if (resObj.error_code === 401) {
      throw new Error('unauthorized');
    }
    throw new Error('request_failed');
  }

  if (!resObj.result || typeof resObj.result !== 'object') {
    throw new Error('malformed_response');
  }

  const result = resObj.result as {
    id?: unknown;
    is_bot?: unknown;
    username?: unknown;
    first_name?: unknown;
  };

  if (typeof result.id !== 'number' || !Number.isSafeInteger(result.id) || result.id <= 0) {
    throw new Error('invalid_bot_id');
  }

  if (result.is_bot !== true) {
    throw new Error('user_is_not_bot');
  }

  if (typeof result.username !== 'string' || result.username.trim().length === 0) {
    throw new Error('invalid_bot_username');
  }

  const displayName =
    typeof result.first_name === 'string' && result.first_name.trim().length > 0
      ? result.first_name.trim()
      : result.username.trim();

  return {
    providerId: String(result.id),
    displayName,
  };
}

export function encryptTelegramCredentials(
  cipher: TokenCipher,
  input: {
    companyId: string;
    connectionId: string;
    botToken: string;
    webhookSecret: string;
  },
): string {
  if (!cipher || typeof cipher.encrypt !== 'function') {
    throw new Error('invalid_cipher');
  }
  if (
    !input ||
    typeof input.companyId !== 'string' ||
    input.companyId.length === 0 ||
    typeof input.connectionId !== 'string' ||
    input.connectionId.length === 0 ||
    typeof input.botToken !== 'string' ||
    input.botToken.length === 0 ||
    typeof input.webhookSecret !== 'string'
  ) {
    throw new Error('invalid_input');
  }

  const payload = JSON.stringify({
    companyId: input.companyId,
    connectionId: input.connectionId,
    botToken: input.botToken,
    webhookSecret: input.webhookSecret,
  });

  const encrypted = cipher.encrypt(payload);
  return `${ENVELOPE_PREFIX}${encrypted}`;
}

export function decryptTelegramCredentials(
  cipher: TokenCipher,
  blob: string,
  scope: {
    companyId: string;
    connectionId: string;
  },
): {
  botToken: string;
  webhookSecret: string;
} {
  if (!cipher || typeof cipher.decrypt !== 'function') {
    throw new Error('invalid_cipher');
  }
  if (
    !scope ||
    typeof scope.companyId !== 'string' ||
    scope.companyId.length === 0 ||
    typeof scope.connectionId !== 'string' ||
    scope.connectionId.length === 0
  ) {
    throw new Error('invalid_scope');
  }
  if (typeof blob !== 'string' || !blob.startsWith(ENVELOPE_PREFIX)) {
    throw new Error('unsupported_envelope_version');
  }

  const ciphertext = blob.slice(ENVELOPE_PREFIX.length);
  if (!ciphertext) {
    throw new Error('invalid_envelope');
  }

  let plaintext: string;
  try {
    plaintext = cipher.decrypt(ciphertext);
  } catch {
    throw new Error('decryption_failed');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error('corrupted_payload');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('corrupted_payload');
  }

  const payload = parsed as Record<string, unknown>;

  if (payload.companyId !== scope.companyId || payload.connectionId !== scope.connectionId) {
    throw new Error('scope_mismatch');
  }

  if (typeof payload.botToken !== 'string' || typeof payload.webhookSecret !== 'string') {
    throw new Error('invalid_credentials_payload');
  }

  return {
    botToken: payload.botToken,
    webhookSecret: payload.webhookSecret,
  };
}

export type { TokenCipher };
