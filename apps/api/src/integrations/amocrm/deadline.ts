/**
 * Bounded HTTP for upstream integrations.
 *
 * Every call gets a single deadline covering connect, response headers *and* body
 * read: a stalled upstream must not pin a worker or a connection indefinitely.
 * Bodies are read with a hard byte cap so a hostile or broken upstream cannot make
 * the process buffer unbounded data.
 */

export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export type DeadlineOptions = {
  timeoutMs: number;
  maxResponseBytes: number;
};

export function deadlineOptions(overrides: Partial<DeadlineOptions> = {}): DeadlineOptions {
  return {
    timeoutMs: overrides.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    maxResponseBytes: overrides.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  };
}

export class HttpDeadlineError extends Error {
  readonly code = 'timeout';
  constructor(message = 'upstream_deadline_exceeded') {
    super(message);
    this.name = 'HttpDeadlineError';
  }
}

export class HttpResponseTooLargeError extends Error {
  readonly code = 'response_too_large';
  constructor(message = 'upstream_response_too_large') {
    super(message);
    this.name = 'HttpResponseTooLargeError';
  }
}

export type BoundedResponse = {
  status: number;
  headers: Headers;
  /** Reads the whole body (bounded by the cap) and parses it as JSON. */
  json: () => Promise<unknown>;
  /** Releases the timer and drops any unread body. */
  close: () => void;
};

async function readBounded(response: Response, options: DeadlineOptions): Promise<Buffer> {
  const body = response.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > options.maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpResponseTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

/**
 * Performs one request with a deadline that stays armed until the body is read.
 * The caller must call `close()` once it has the body (or has decided not to read it).
 */
export async function fetchBounded(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  options: DeadlineOptions,
): Promise<BoundedResponse> {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, options.timeoutMs);
  timer.unref?.();

  const close = () => clearTimeout(timer);

  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    close();
    if (expired) throw new HttpDeadlineError();
    throw new Error('network_error');
  }

  const json = async (): Promise<unknown> => {
    try {
      const bytes = await readBounded(response, options);
      if (bytes.byteLength === 0) return null;
      try {
        return JSON.parse(bytes.toString('utf8')) as unknown;
      } catch {
        return undefined;
      }
    } catch (error) {
      if (error instanceof HttpResponseTooLargeError) throw error;
      if (expired) throw new HttpDeadlineError();
      throw error;
    } finally {
      close();
    }
  };

  return { status: response.status, headers: response.headers, json, close };
}
