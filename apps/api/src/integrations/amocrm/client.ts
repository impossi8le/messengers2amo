import { createRequire } from 'node:module';
import { AuthRevokedError, RateLimitError } from './oauth.ts';
import {
  deadlineOptions,
  fetchBounded,
  HttpDeadlineError,
  HttpResponseTooLargeError,
  type DeadlineOptions,
} from './deadline.ts';

type ProtocolModule = {
  signChatsRequest: (options: {
    method: string;
    urlPath: string;
    date: string;
    rawBody?: Uint8Array;
    channelSecret: string;
    contentType?: string;
  }) => Record<string, string>;
};

// The signed-request primitive is owned by packages/amocrm-protocol and is
// imported, never reimplemented. createRequire keeps the runtime import exact.
const require = createRequire(import.meta.url);
const protocol = require('../../../../../packages/amocrm-protocol/src/index.mjs') as ProtocolModule;

export class AmocrmApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.name = 'AmocrmApiError';
    this.status = status;
    this.code = code;
  }
}

export class AuthRequiredError extends Error {
  readonly code = 'amocrm_auth_required';
  constructor(message = 'amocrm_auth_required') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export type AmocrmClientOptions = {
  accountDomain: string;
  getAccessToken: () => Promise<string>;
  fetch: typeof fetch;
  channelSecret?: string | null;
  apiBase?: string;
  chatsBase?: string;
  now?: () => number;
  maxPages?: number;
  /** Deadline for one HTTP call, headers and body included. */
  timeoutMs?: number;
  /** Hard cap on a response body. */
  maxResponseBytes?: number;
};

export type AccountInfo = { id: number; amojo_id: string | null; name?: string };

function parseRetryAfter(header: string | null, now: number): number {
  if (!header) return 1000;
  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds) && String(seconds) === header.trim()) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return 1000;
}

function safePath(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw new Error('invalid_api_path');
  }
  return path;
}

export class AmocrmClient {
  private readonly options: AmocrmClientOptions;
  private readonly apiBase: string;
  private readonly chatsBase: string;
  private readonly deadline: DeadlineOptions;

  constructor(options: AmocrmClientOptions) {
    this.options = options;
    this.apiBase = (options.apiBase ?? `https://${options.accountDomain}`).replace(/\/$/, '');
    this.chatsBase = (options.chatsBase ?? 'https://amojo.amocrm.ru').replace(/\/$/, '');
    this.deadline = deadlineOptions({ timeoutMs: options.timeoutMs, maxResponseBytes: options.maxResponseBytes });
  }

  /** One bounded call; maps transport failures onto the client's error vocabulary. */
  private async bounded(url: string, init: RequestInit) {
    try {
      return await fetchBounded(this.options.fetch, url, init, this.deadline);
    } catch (error) {
      if (error instanceof HttpDeadlineError) throw new AmocrmApiError(0, 'timeout');
      if (error instanceof HttpResponseTooLargeError) throw new AmocrmApiError(0, 'response_too_large');
      throw new AmocrmApiError(0, 'network_error');
    }
  }

  /** Reads a bounded body, mapping deadline/size failures onto client errors. */
  private async readJson(response: Awaited<ReturnType<AmocrmClient['bounded']>>, status: number): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      if (error instanceof HttpDeadlineError) throw new AmocrmApiError(0, 'timeout');
      if (error instanceof HttpResponseTooLargeError) throw new AmocrmApiError(0, 'response_too_large');
      throw new AmocrmApiError(status, 'invalid_json');
    }
  }

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** One HTTP call, no hidden retries. Callers own requeue policy. */
  async request<T = unknown>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const method = (init.method ?? 'GET').toUpperCase();
    const url = `${this.apiBase}${safePath(path)}`;
    const token = await this.options.getAccessToken();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    };
    let body: string | undefined;
    if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      headers['content-type'] = 'application/json';
    }
    const response = await this.bounded(url, { method, headers, body });
    if (response.status === 429) {
      response.close();
      throw new RateLimitError(parseRetryAfter(response.headers.get('retry-after'), this.now));
    }
    if (response.status === 401) {
      response.close();
      throw new AuthRequiredError();
    }
    if (response.status < 200 || response.status >= 300) {
      response.close();
      throw new AmocrmApiError(response.status, `http_${response.status}`);
    }
    if (response.status === 204) {
      response.close();
      return undefined as T;
    }
    const payload = await this.readJson(response, response.status);
    if (payload === undefined) throw new AmocrmApiError(response.status, 'invalid_json');
    return payload as T;
  }

  async getAccount(options: { withAmojoId?: boolean } = {}): Promise<AccountInfo> {
    const suffix = options.withAmojoId === false ? '' : '?with=amojo_id';
    const body = await this.request<{ id: number; name?: string; amojo_id?: string | number | null }>(
      `/api/v4/account${suffix}`,
    );
    if (!body || typeof body.id !== 'number') throw new AmocrmApiError(200, 'invalid_account_response');
    const amojo = body.amojo_id === undefined || body.amojo_id === null ? null : String(body.amojo_id);
    return { id: body.id, amojo_id: amojo, name: body.name };
  }

  /**
   * Follows amoCRM's `_links.next.href` chain. The next URL must stay on the
   * configured account host; anything else is rejected instead of fetched.
   */
  async paginate<T = unknown>(path: string, options: { limitPages?: number } = {}): Promise<T[]> {
    const maxPages = options.limitPages ?? this.options.maxPages ?? 50;
    const collected: T[] = [];
    let next: string | null = `${this.apiBase}${safePath(path)}`;
    let page = 0;
    while (next) {
      page += 1;
      if (page > maxPages) throw new AmocrmApiError(0, 'pagination_limit_exceeded');
      const token = await this.options.getAccessToken();
      const response = await this.bounded(next, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      if (response.status === 429) {
        response.close();
        throw new RateLimitError(parseRetryAfter(response.headers.get('retry-after'), this.now));
      }
      if (response.status === 401) {
        response.close();
        throw new AuthRequiredError();
      }
      if (response.status < 200 || response.status >= 300) {
        response.close();
        throw new AmocrmApiError(response.status, `http_${response.status}`);
      }
      const parsed = await this.readJson(response, response.status);
      if (!parsed || typeof parsed !== 'object') throw new AmocrmApiError(response.status, 'invalid_json');
      const payload = parsed as {
        _embedded?: Record<string, unknown>;
        _links?: { next?: { href?: string } };
      };
      const embedded = payload._embedded ?? {};
      for (const value of Object.values(embedded)) {
        if (Array.isArray(value)) collected.push(...(value as T[]));
      }
      const href = payload._links?.next?.href;
      if (href === undefined) {
        next = null;
      } else {
        const resolved = new URL(href, this.apiBase);
        if (resolved.origin !== new URL(this.apiBase).origin) throw new AmocrmApiError(0, 'pagination_host_mismatch');
        next = resolved.toString();
      }
    }
    return collected;
  }

  /**
   * Signed Chats API call. The body is serialized once, signed, and the exact
   * same bytes are sent. There are no retries here.
   */
  async chats<T = unknown>(
    scopeId: string,
    pathSuffix: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const secret = this.options.channelSecret;
    if (!secret) throw new AmocrmApiError(0, 'channel_secret_missing');
    const method = (init.method ?? 'POST').toUpperCase();
    const path = safePath(`/v2/origin/custom/${encodeURIComponent(scopeId)}${pathSuffix}`);
    const rawBody = method === 'GET' ? Buffer.alloc(0) : Buffer.from(JSON.stringify(init.body ?? {}), 'utf8');
    const date = new Date(this.now).toUTCString();
    const signed = protocol.signChatsRequest({
      method,
      urlPath: path,
      date,
      rawBody,
      channelSecret: secret,
    });
    const response = await this.bounded(`${this.chatsBase}${path}`, {
      method,
      headers: signed,
      body: method === 'GET' ? undefined : rawBody,
    });
    if (response.status === 429) {
      response.close();
      throw new RateLimitError(parseRetryAfter(response.headers.get('retry-after'), this.now));
    }
    if (response.status === 401 || response.status === 403) {
      response.close();
      throw new AuthRevokedError();
    }
    if (response.status < 200 || response.status >= 300) {
      response.close();
      throw new AmocrmApiError(response.status, `http_${response.status}`);
    }
    if (response.status === 204) {
      response.close();
      return undefined as T;
    }
    const payload = await this.readJson(response, response.status);
    if (payload === undefined) throw new AmocrmApiError(response.status, 'invalid_json');
    return payload as T;
  }
}

export type PipelineStage = { id: string; name: string; isFinal: boolean };

export type Pipeline = { id: string; name: string; stages: PipelineStage[] };

function parsePipelines(payload: unknown): Pipeline[] {
  if (!payload || typeof payload !== 'object') throw new AmocrmApiError(200, 'invalid_pipelines_response');
  const embedded = (payload as { _embedded?: unknown })._embedded;
  if (!embedded || typeof embedded !== 'object') throw new AmocrmApiError(200, 'invalid_pipelines_response');
  const list = (embedded as Record<string, unknown>).pipelines;
  if (!Array.isArray(list)) throw new AmocrmApiError(200, 'invalid_pipelines_response');

  const pipelines: Pipeline[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, name, _embedded } = entry as { id?: unknown; name?: unknown; _embedded?: unknown };
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) continue;
    const stages: PipelineStage[] = [];
    const statuses =
      _embedded && typeof _embedded === 'object' ? (_embedded as Record<string, unknown>).statuses : undefined;
    if (Array.isArray(statuses)) {
      for (const status of statuses) {
        if (!status || typeof status !== 'object') continue;
        const { id: statusId, name: statusName, type } = status as {
          id?: unknown;
          name?: unknown;
          type?: unknown;
        };
        if (typeof statusId !== 'number' || !Number.isSafeInteger(statusId)) continue;
        stages.push({
          id: String(statusId),
          name: typeof statusName === 'string' && statusName.length > 0 ? statusName : String(statusId),
          // 0 is a working stage; 1 and 2 are won and lost.
          isFinal: type !== 0,
        });
      }
    }
    pipelines.push({
      id: String(id),
      name: typeof name === 'string' && name.length > 0 ? name : String(id),
      stages,
    });
  }
  return pipelines;
}

/** Funnels and their stages, read from the account rather than guessed or cached in the database. */
export async function fetchPipelines(client: AmocrmClient): Promise<Pipeline[]> {
  return parsePipelines(await client.request<unknown>('/api/v4/leads/pipelines'));
}

export function createAmocrmClient(options: AmocrmClientOptions): AmocrmClient {
  return new AmocrmClient(options);
}
