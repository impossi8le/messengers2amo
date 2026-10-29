import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type StoredObjectMeta = {
  key: string;
  sizeBytes: number;
  sha256: string;
};

export type PresignedMethod = 'PUT' | 'GET' | 'HEAD' | 'DELETE';

export type PresignedUrl = {
  url: string;
  key: string;
  method: PresignedMethod;
  expiresAt: string;
};

export type PresignPutOptions = {
  contentType: string;
  maxBytes: number;
  ttlSeconds: number;
};

export type ObjectReadOptions = { maxBytes: number; timeoutMs: number };

/**
 * Storage abstraction. Implementations must never expose object bytes or signed
 * URLs in logs; callers treat returned URLs as secrets.
 */
export interface ObjectStorage {
  put(key: string, body: Uint8Array, contentType: string): Promise<StoredObjectMeta>;
  get(key: string, options?: ObjectReadOptions): Promise<Uint8Array | null>;
  head(key: string): Promise<StoredObjectMeta | null>;
  presignPut(key: string, options: PresignPutOptions): Promise<PresignedUrl>;
  presignGet(key: string, ttlSeconds: number): Promise<PresignedUrl>;
  /** Returns null for unknown, tampered or expired links. */
  resolvePresigned(url: string): Promise<{ key: string; method: PresignedMethod } | null>;
  remove(key: string): Promise<void>;
}

export function sha256Hex(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

type InMemoryRecord = {
  body: Uint8Array;
  contentType: string;
  meta: StoredObjectMeta;
};

type GrantRecord = {
  key: string;
  method: PresignedMethod;
  expiresAtMs: number;
};

export class InMemoryObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, InMemoryRecord>();
  private readonly grants = new Map<string, GrantRecord>();
  private readonly secret: string;
  private readonly now: () => number;

  constructor(secret = 'in-memory-storage-secret', now: () => number = Date.now) {
    this.secret = secret;
    this.now = now;
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<StoredObjectMeta> {
    const copy = Uint8Array.from(body);
    const meta: StoredObjectMeta = { key, sizeBytes: copy.byteLength, sha256: sha256Hex(copy) };
    this.objects.set(key, { body: copy, contentType, meta });
    return meta;
  }

  async get(key: string, options?: ObjectReadOptions): Promise<Uint8Array | null> {
    const record = this.objects.get(key);
    if (record && options && record.body.byteLength > options.maxBytes) throw new Error('object_read_too_large');
    return record ? Uint8Array.from(record.body) : null;
  }

  async head(key: string): Promise<StoredObjectMeta | null> {
    return this.objects.get(key)?.meta ?? null;
  }

  async presignPut(key: string, options: PresignPutOptions): Promise<PresignedUrl> {
    return this.issue(key, 'PUT', options.ttlSeconds, { contentType: options.contentType, maxBytes: options.maxBytes });
  }

  async presignGet(key: string, ttlSeconds: number): Promise<PresignedUrl> {
    return this.issue(key, 'GET', ttlSeconds);
  }

  async resolvePresigned(url: string): Promise<{ key: string; method: PresignedMethod } | null> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const token = parsed.searchParams.get('token');
    const key = parsed.searchParams.get('key');
    const method = parsed.searchParams.get('method');
    const expires = parsed.searchParams.get('exp');
    if (!token || !key || !expires || (method !== 'PUT' && method !== 'GET' && method !== 'HEAD' && method !== 'DELETE')) return null;
    const expected = this.sign(key, method, expires);
    const actual = Buffer.from(token, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (actual.length !== expectedBuf.length || !timingSafeEqual(actual, expectedBuf)) return null;
    const grant = this.grants.get(token);
    if (!grant) return null;
    if (grant.expiresAtMs <= this.now()) {
      this.grants.delete(token);
      return null;
    }
    if (grant.key !== key || grant.method !== method) return null;
    return { key, method };
  }

  async remove(key: string): Promise<void> {
    this.objects.delete(key);
  }

  private issue(key: string, method: PresignedMethod, ttlSeconds: number, extra: Record<string, unknown> = {}): PresignedUrl {
    const expiresAtMs = this.now() + Math.max(1, ttlSeconds) * 1000;
    const token = this.sign(key, method, String(expiresAtMs));
    this.grants.set(token, { key, method, expiresAtMs });
    const params = new URLSearchParams({
      key,
      method,
      token,
      exp: String(expiresAtMs),
      ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])),
    });
    return {
      url: `memory://bucket/${encodeURIComponent(key)}?${params.toString()}`,
      key,
      method,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  private sign(key: string, method: PresignedMethod, marker: string): string {
    return createHmac('sha256', this.secret).update(`${method}\n${key}\n${marker}`).digest('hex');
  }
}

export type S3StorageConfig = {
  endpoint: string | null;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

const S3_UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/**
 * S3-compatible storage. Presigning is fully offline; object transfer uses the
 * injected fetch implementation so tests never touch the network.
 */
export class S3ObjectStorage implements ObjectStorage {
  private readonly config: S3StorageConfig;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: S3StorageConfig, now: () => number = Date.now, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.now = now;
    this.fetchImpl = fetchImpl;
  }

  private origin(): string {
    return (this.config.endpoint ?? `https://s3.${this.config.region}.amazonaws.com`).replace(/\/+$/, '');
  }

  private canonicalPath(key: string): string {
    const encoded = key.split('/').map(encodeRfc3986).join('/');
    if (this.config.forcePathStyle || this.config.endpoint) return `/${encodeRfc3986(this.config.bucket)}/${encoded}`;
    return `/${encoded}`;
  }

  private host(): string {
    if (this.config.forcePathStyle || this.config.endpoint) return new URL(this.origin()).host;
    return `${this.config.bucket}.s3.${this.config.region}.amazonaws.com`;
  }

  private signingKey(date: string): Buffer {
    const kDate = hmac(`AWS4${this.config.secretAccessKey}`, date);
    const kRegion = hmac(kDate, this.config.region);
    const kService = hmac(kRegion, 's3');
    return hmac(kService, 'aws4_request');
  }

  private presign(key: string, method: PresignedMethod, ttlSeconds: number, extraHeaders: Record<string, string> = {}): PresignedUrl {
    const nowMs = this.now();
    const amzDate = new Date(nowMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const date = amzDate.slice(0, 8);
    const scope = `${date}/${this.config.region}/s3/aws4_request`;
    const host = this.host();
    const expires = Math.max(1, Math.min(ttlSeconds, 604800));
    const signedHeaderNames = Object.keys(extraHeaders).map((name) => name.toLowerCase()).sort();
    const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${extraHeaders[name] ?? ''}\n`).join('');
    const params = new URLSearchParams({
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.config.accessKeyId}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expires),
      'X-Amz-SignedHeaders': signedHeaderNames.length > 0 ? signedHeaderNames.join(';') : 'host',
    });
    const canonicalQuery = [...params.entries()]
      .map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)
      .sort()
      .join('&');
    const canonicalRequest = [
      method,
      this.canonicalPath(key),
      canonicalQuery,
      canonicalHeaders || `host:${host}\n`,
      signedHeaderNames.length > 0 ? signedHeaderNames.join(';') : 'host',
      S3_UNSIGNED_PAYLOAD,
    ].join('\n');
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
    ].join('\n');
    const signature = hmac(this.signingKey(date), stringToSign).toString('hex');
    const url = `${this.origin()}${this.canonicalPath(key)}?${canonicalQuery}&X-Amz-Signature=${signature}`;
    return { url, key, method, expiresAt: new Date(nowMs + expires * 1000).toISOString() };
  }

  async presignPut(key: string, options: PresignPutOptions): Promise<PresignedUrl> {
    return this.presign(key, 'PUT', options.ttlSeconds, {
      'content-type': options.contentType,
      'x-amz-content-sha256': S3_UNSIGNED_PAYLOAD,
    });
  }

  async presignGet(key: string, ttlSeconds: number): Promise<PresignedUrl> {
    return this.presign(key, 'GET', ttlSeconds);
  }

  async resolvePresigned(url: string): Promise<{ key: string; method: PresignedMethod } | null> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const expires = Number.parseInt(parsed.searchParams.get('X-Amz-Expires') ?? '', 10);
    const amzDate = parsed.searchParams.get('X-Amz-Date') ?? '';
    const signature = parsed.searchParams.get('X-Amz-Signature') ?? '';
    const signedHeaders = parsed.searchParams.get('X-Amz-SignedHeaders') ?? '';
    if (!Number.isFinite(expires) || !/^\d{8}T\d{6}Z$/.test(amzDate)) return null;
    // Links signed with additional headers (upload links) are not download grants.
    if (signedHeaders !== 'host') return null;
    if (!/^[a-f0-9]{64}$/.test(signature)) return null;
    const signedAt = Date.parse(
      `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`,
    );
    if (!Number.isFinite(signedAt) || signedAt + expires * 1000 <= this.now()) return null;

    const scope = `${amzDate.slice(0, 8)}/${this.config.region}/s3/aws4_request`;
    const canonicalQuery = [...parsed.searchParams.entries()]
      .filter(([name]) => name !== 'X-Amz-Signature')
      .map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)
      .sort()
      .join('&');
    const canonicalRequest = [
      'GET',
      parsed.pathname,
      canonicalQuery,
      `host:${parsed.host}\n`,
      'host',
      S3_UNSIGNED_PAYLOAD,
    ].join('\n');
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
    ].join('\n');
    const expected = hmac(this.signingKey(amzDate.slice(0, 8)), stringToSign);
    const actual = Buffer.from(signature, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

    const key = decodeURIComponent(parsed.pathname.split('/').slice(this.config.forcePathStyle || this.config.endpoint ? 2 : 1).join('/'));
    return { key, method: 'GET' };
  }

  private async request(method: 'GET' | 'PUT' | 'HEAD' | 'DELETE', key: string, body?: Uint8Array, contentType?: string, signal?: AbortSignal): Promise<Response> {
    const presigned = this.presign(key, method, 300);
    const headers: Record<string, string> = {};
    if (contentType) headers['content-type'] = contentType;
    if (method === 'PUT' && body) headers['x-amz-meta-sha256'] = sha256Hex(body);
    return this.fetchImpl(presigned.url, {
      method,
      headers,
      body: body ? Buffer.from(body) : undefined,
      redirect: 'error',
      signal,
    });
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<StoredObjectMeta> {
    const response = await this.request('PUT', key, body, contentType);
    if (!response.ok) throw new Error(`s3_put_failed:${response.status}`);
    return { key, sizeBytes: body.byteLength, sha256: sha256Hex(body) };
  }

  async get(key: string, options?: ObjectReadOptions): Promise<Uint8Array | null> {
    if (!options) {
      const response = await this.request('GET', key);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`s3_get_failed:${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    }
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 ||
        !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error('s3_get_invalid_limits');
    const controller = new AbortController();
    let rejectDeadline!: (error: Error) => void;
    const deadline = new Promise<never>((_,reject) => { rejectDeadline=reject; });
    const timer = setTimeout(() => {
      controller.abort();
      rejectDeadline(new Error('s3_get_unavailable'));
    },options.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await Promise.race([this.request('GET',key,undefined,undefined,controller.signal),deadline]);
      if (!response.ok) {
        void response.body?.cancel().catch(()=>{});
        if (response.status===404) return null;
        throw new Error('s3_get_unavailable');
      }
      const length = response.headers.get('content-length');
      if (length!==null && (!/^\d+$/.test(length) || Number(length)>options.maxBytes)) {
        void response.body?.cancel().catch(()=>{});
        throw new Error('s3_get_too_large');
      }
      reader = response.body?.getReader();
      if (!reader) return new Uint8Array();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await Promise.race([reader.read(),deadline]);
        if (part.done) break;
        size += part.value.byteLength;
        if (size>options.maxBytes) throw new Error('s3_get_too_large');
        chunks.push(part.value);
      }
      return new Uint8Array(Buffer.concat(chunks,size));
    } catch (error) {
      void reader?.cancel().catch(()=>{});
      controller.abort();
      // Never propagate fetch errors containing credentials or signed URLs.
      throw new Error(error instanceof Error && error.message==='s3_get_too_large' ? 's3_get_too_large' : 's3_get_unavailable');
    } finally {
      clearTimeout(timer);
      reader?.releaseLock();
    }
  }

  async head(key: string): Promise<StoredObjectMeta | null> {
    const response = await this.request('HEAD', key);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`s3_head_failed:${response.status}`);
    return {
      key,
      sizeBytes: Number(response.headers.get('content-length') ?? 0),
      sha256: response.headers.get('x-amz-meta-sha256') ?? '',
    };
  }

  async remove(key: string): Promise<void> {
    const response = await this.request('DELETE', key);
    if (!response.ok && response.status !== 404) throw new Error(`s3_remove_failed:${response.status}`);
  }
}
