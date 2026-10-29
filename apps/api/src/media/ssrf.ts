import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

export class SsrfError extends Error {
  readonly code = 'SSRF_BLOCKED';
  constructor(reason: string) {
    super(reason);
    this.name = 'SsrfError';
  }
}

export type RemoteFetchPolicy = {
  /** Exact hostnames permitted for remote fetch. Empty list disables remote fetch. */
  allowedHosts: readonly string[];
  /** HTTPS is mandatory by default. */
  allowHttp?: boolean;
  /** Injectable resolver for tests; defaults to DNS lookup. */
  resolve?: (host: string) => Promise<string[]>;
  maxBytes?: number;
  timeoutMs?: number;
};

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function inV4Range(value: number, base: string, prefix: number): boolean {
  const baseValue = ipv4ToInt(base);
  if (baseValue === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === (baseValue & mask) >>> 0;
}

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function isPrivateV4(value: number): boolean {
  return BLOCKED_V4.some(([base, prefix]) => inV4Range(value, base, prefix));
}

/**
 * Parses any RFC 4291 textual IPv6 form into eight 16-bit groups: compressed
 * (`::`), fully expanded, uppercase, leading zeros, and a dotted IPv4 tail.
 * Returns null for anything that is not a well-formed IPv6 address.
 */
function parseIpv6Groups(address: string): number[] | null {
  let text = address;
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);

  const firstDoubleColon = text.indexOf('::');
  if (firstDoubleColon !== -1 && text.indexOf('::', firstDoubleColon + 1) !== -1) return null;

  const parseSide = (side: string): number[] | null => {
    if (side.length === 0) return [];
    const parts = side.split(':');
    const groups: number[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      if (part.includes('.')) {
        // A dotted IPv4 tail is only valid as the final component.
        if (index !== parts.length - 1) return null;
        const value = ipv4ToInt(part);
        if (value === null) return null;
        groups.push((value >>> 16) & 0xffff, value & 0xffff);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
        groups.push(Number.parseInt(part, 16));
      }
    }
    return groups;
  };

  let groups: number[];
  if (firstDoubleColon === -1) {
    const all = parseSide(text);
    if (all === null) return null;
    groups = all;
  } else {
    const left = parseSide(text.slice(0, firstDoubleColon));
    const right = parseSide(text.slice(firstDoubleColon + 2));
    if (left === null || right === null) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groups = [...left, ...new Array<number>(missing).fill(0), ...right];
  }
  return groups.length === 8 ? groups : null;
}

/**
 * Returns the IPv4 address embedded in an IPv6 address, for every form where
 * the IPv4 part is what the connection would actually reach. Numeric parsing is
 * required: `::ffff:7f00:1` is 127.0.0.1 just as much as `::ffff:127.0.0.1`.
 */
function embeddedIpv4(groups: readonly number[]): number | null {
  const isZero = (from: number, to: number): boolean => {
    for (let index = from; index < to; index += 1) {
      if (groups[index] !== 0) return false;
    }
    return true;
  };
  const last32 = ((groups[6]! << 16) | groups[7]!) >>> 0;
  // ::/96 IPv4-compatible (also covers :: and ::1).
  if (isZero(0, 6)) return last32;
  // ::ffff:0:0/96 IPv4-mapped.
  if (isZero(0, 5) && groups[5] === 0xffff) return last32;
  // ::ffff:0:0:0/96 IPv4-translated (RFC 2765).
  if (isZero(0, 4) && groups[4] === 0xffff && groups[5] === 0) return last32;
  // 64:ff9b::/96 NAT64 well-known prefix.
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && isZero(2, 6)) return last32;
  // 2002::/16 6to4 embeds the IPv4 address in groups 1-2.
  if (groups[0] === 0x2002) return ((groups[1]! << 16) | groups[2]!) >>> 0;
  return null;
}

/** True for loopback, link-local, private, CGNAT, multicast and reserved ranges. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4ToInt(address);
    if (value === null) return true;
    return isPrivateV4(value);
  }
  if (family === 6) {
    const groups = parseIpv6Groups(address);
    // An IPv6 address this parser cannot understand is not safe to connect to.
    if (groups === null) return true;
    const first = groups[0]!;
    // fe80::/10 link-local.
    if ((first & 0xffc0) === 0xfe80) return true;
    // fc00::/7 unique local.
    if ((first & 0xfe00) === 0xfc00) return true;
    // ff00::/8 multicast is never a valid unicast target.
    if ((first & 0xff00) === 0xff00) return true;
    const embedded = embeddedIpv4(groups);
    if (embedded !== null) return isPrivateV4(embedded);
    return false;
  }
  return true;
}

async function defaultResolve(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/**
 * Validates a remote URL before any request is made. Denies non-allowlisted
 * hosts, non-HTTPS schemes, private literal addresses and hosts whose DNS
 * answers resolve to private addresses (DNS rebinding pre-check).
 */
export type ValidatedRemoteUrl = { url: URL; address: string };

export async function resolveSafeRemoteUrl(raw: string, policy: RemoteFetchPolicy): Promise<ValidatedRemoteUrl> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError('invalid_url');
  }
  const allowedScheme = policy.allowHttp === true ? ['https:', 'http:'] : ['https:'];
  if (!allowedScheme.includes(url.protocol)) throw new SsrfError('scheme_not_allowed');
  if (url.username || url.password) throw new SsrfError('credentials_not_allowed');
  if (url.port && url.port !== '443' && url.port !== '80') throw new SsrfError('port_not_allowed');

  const host = url.hostname.toLowerCase();
  if (host.length === 0) throw new SsrfError('missing_host');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new SsrfError('internal_host');
  }
  // URL keeps IPv6 literals bracketed (`[::1]`), which `isIP` does not recognise.
  const literalHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIP(literalHost) && isPrivateAddress(literalHost)) throw new SsrfError('private_address');

  if (!policy.allowedHosts.some((allowed) => allowed.toLowerCase() === host)) {
    throw new SsrfError('host_not_allowlisted');
  }

  const resolve = policy.resolve ?? defaultResolve;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new SsrfError('dns_resolution_failed');
  }
  if (addresses.length === 0) throw new SsrfError('dns_resolution_empty');
  for (const address of addresses) {
    if (isPrivateAddress(address)) throw new SsrfError('resolved_private_address');
  }
  // The first validated answer is the one the connection is pinned to.
  return { url, address: addresses[0]! };
}

/** Validates the URL and returns it; use `resolveSafeRemoteUrl` when connecting. */
export async function assertSafeRemoteUrl(raw: string, policy: RemoteFetchPolicy): Promise<URL> {
  return (await resolveSafeRemoteUrl(raw, policy)).url;
}

export type RemoteResponse = {
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
};

export type RemoteRequestOptions = {
  /** The validated address the socket must connect to. */
  address: string;
  /** The original authority, preserved as the Host header. */
  hostHeader: string;
  signal: AbortSignal;
};

export type RemoteTransport = (url: URL, options: RemoteRequestOptions) => Promise<RemoteResponse>;

function pinnedLookup(address: string) {
  const family = isIP(address);
  return (
    _hostname: string,
    options: { all?: boolean } | ((error: NodeJS.ErrnoException | null, address: string, family: number) => void),
    callback?: (error: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void,
  ): void => {
    const done = (typeof options === 'function' ? options : callback) as (
      error: NodeJS.ErrnoException | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void;
    if (typeof options !== 'function' && options.all) done(null, [{ address, family }]);
    else done(null, address, family);
  };
}

function toResponse(message: IncomingMessage): RemoteResponse {
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(message.headers)) {
    if (typeof value === 'string') headers.set(name.toLowerCase(), value);
    else if (Array.isArray(value)) headers.set(name.toLowerCase(), value.join(', '));
  }
  const body = Readable.toWeb(message) as unknown as ReadableStream<Uint8Array>;
  return {
    status: message.statusCode ?? 0,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    body,
  };
}

/**
 * Default transport: the hostname is kept for SNI and certificate verification, but
 * name resolution is replaced by the validated address, so no second DNS answer can
 * steer the connection anywhere else.
 */
export const pinnedRequest: RemoteTransport = (url, options) =>
  new Promise<RemoteResponse>((resolve, reject) => {
    const secure = url.protocol === 'https:';
    const send = secure ? httpsRequest : httpRequest;
    const request = send(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { accept: '*/*', host: options.hostHeader },
        lookup: pinnedLookup(options.address) as never,
        servername: secure ? url.hostname : undefined,
        signal: options.signal,
      },
      (message) => resolve(toResponse(message)),
    );
    request.on('error', reject);
    request.end();
  });

/**
 * Fetches a remote object only after SSRF validation. Redirects are refused
 * outright so a public host cannot bounce the request to an internal address.
 */
export async function fetchRemoteObject(
  raw: string,
  policy: RemoteFetchPolicy,
  transport: RemoteTransport = pinnedRequest,
): Promise<Uint8Array> {
  const { url, address } = await resolveSafeRemoteUrl(raw, policy);
  const maxBytes = policy.maxBytes ?? 100 * 1024 * 1024;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), policy.timeoutMs ?? 15_000);
  try {
    const response = await transport(url, { address, hostHeader: url.host, signal: controller.signal });
    if (response.status < 200 || response.status >= 300) throw new SsrfError('remote_fetch_failed');
    const length = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(length) && length > maxBytes) throw new SsrfError('remote_too_large');
    if (!response.body) throw new SsrfError('remote_fetch_failed');

    // Read incrementally: a chunked body without content-length must never be
    // buffered past the limit, so the count is enforced on every chunk.
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        throw new SsrfError('remote_too_large');
      }
      chunks.push(value);
    }
    const buffer = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}
