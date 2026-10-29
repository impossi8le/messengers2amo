export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type SendMessageInput = {
  chatId: string;
  text: string;
  replyToMessageId?: string;
};

export type TransportOutcome =
  | { outcome: 'sent'; providerMessageId: string }
  | { outcome: 'failed'; code: string }
  | { outcome: 'rate_limited'; retryAfterSeconds: number }
  | { outcome: 'unknown'; reason: 'timeout' | 'network' | 'http_5xx' | 'malformed' };

export type TelegramTransport = {
  sendMessage: (input: SendMessageInput) => Promise<TransportOutcome>;
};

export type TransportOptions = {
  fetch: FetchLike;
  apiBase: string;
  botToken: string;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

function parseBody(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Telegram Bot API adapter for one logical send. Exactly one HTTPS request is
 * made: no redirects, no internal retries, and no follow-up on ambiguity.
 */
export function createTelegramTransport(options: TransportOptions): TelegramTransport {
  const base = new URL(options.apiBase);
  if (base.protocol !== 'https:') throw new Error('telegram_api_base_must_be_https');
  if (!options.botToken) throw new Error('telegram_bot_token_required');
  const endpoint = `${base.toString().replace(/\/+$/, '')}/bot${options.botToken}/sendMessage`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async sendMessage(input: SendMessageInput): Promise<TransportOutcome> {
      const body: Record<string, unknown> = {
        chat_id: input.chatId,
        text: input.text,
      };
      if (input.replyToMessageId) {
        body.reply_parameters = { message_id: Number(input.replyToMessageId), allow_sending_without_reply: false };
      }

      const signal = AbortSignal.timeout(timeoutMs);
      let response: Response;
      let raw: string;
      try {
        response = await options.fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          redirect: 'error',
          signal,
        });
        raw = await response.text();
      } catch (error) {
        if (signal.aborted || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))) {
          return { outcome: 'unknown', reason: 'timeout' };
        }
        return { outcome: 'unknown', reason: 'network' };
      }

      if (response.status >= 500) return { outcome: 'unknown', reason: 'http_5xx' };

      const parsed = parseBody(raw);
      if (response.status === 429) {
        const parameters = parsed?.parameters;
        const retryAfter =
          parameters && typeof parameters === 'object' ? (parameters as Record<string, unknown>).retry_after : undefined;
        if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
          return { outcome: 'rate_limited', retryAfterSeconds: retryAfter };
        }
        return { outcome: 'failed', code: 'rate_limit_unconfirmed' };
      }

      if (!parsed) return { outcome: 'unknown', reason: 'malformed' };

      if (response.ok && parsed.ok === true) {
        const result = parsed.result;
        const messageId =
          result && typeof result === 'object' ? (result as Record<string, unknown>).message_id : undefined;
        if (typeof messageId === 'number' || typeof messageId === 'string') {
          return { outcome: 'sent', providerMessageId: String(messageId) };
        }
        return { outcome: 'unknown', reason: 'malformed' };
      }

      if (parsed.ok === false) {
        const code = parsed.error_code;
        return { outcome: 'failed', code: typeof code === 'number' ? `provider_${code}` : 'provider_rejected' };
      }

      return { outcome: 'unknown', reason: 'malformed' };
    },
  };
}
