import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchRemoteObject, isPrivateAddress, pinnedRequest, resolveSafeRemoteUrl, SsrfError, type RemoteFetchPolicy } from '../src/media/ssrf.ts';

type TransportCall = { url: URL; address?: string; hostHeader?: string };

/**
 * A transport that behaves like a real HTTP client: when it is only given a URL it
 * resolves the hostname itself (a second, uncontrolled DNS answer). When it is given
 * a validated address it connects to exactly that address.
 */
function rebindingTransport(answers: string[], payloads: Record<string, string>, calls: TransportCall[]) {
  let lookups = 0;
  return async (input: URL | string, init: Record<string, unknown> = {}) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const address = typeof init.address === 'string' ? init.address : undefined;
    const hostHeader = typeof init.hostHeader === 'string' ? init.hostHeader : undefined;
    calls.push({ url, address, hostHeader });
    let target = address;
    if (!target) {
      // A plain client sees only the hostname and asks DNS again.
      target = answers[Math.min(lookups, answers.length - 1)];
      lookups += 1;
    }
    const body = payloads[target ?? ''];
    if (body === undefined) throw new Error(`no route to ${target}`);
    return new Response(Buffer.from(body), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  };
}

/**
 * Every textual form that embeds a private IPv4 address inside IPv6. The dotted
 * suffix is only one of them; hex groups and NAT64 are equally routable.
 */
const PRIVATE_V6_FORMS: Array<[string, string]> = [
  ['::ffff:127.0.0.1', 'IPv4-mapped, dotted'],
  ['::ffff:7f00:1', 'IPv4-mapped, hex lowercase'],
  ['::FFFF:7F00:1', 'IPv4-mapped, hex uppercase'],
  ['0:0:0:0:0:ffff:7f00:1', 'IPv4-mapped, fully expanded'],
  ['0000:0000:0000:0000:0000:ffff:7f00:0001', 'IPv4-mapped, expanded with leading zeros'],
  ['::ffff:7f00:0001', 'IPv4-mapped, compressed with leading zeros'],
  ['::127.0.0.1', 'IPv4-compatible, dotted'],
  ['::7f00:1', 'IPv4-compatible, hex'],
  ['::ffff:0:127.0.0.1', 'IPv4-translated, dotted'],
  ['::ffff:0:7f00:1', 'IPv4-translated, hex'],
  ['::ffff:0000:7f00:1', 'IPv4-translated, leading zeros'],
  ['64:ff9b::127.0.0.1', 'NAT64, dotted'],
  ['64:ff9b::7f00:1', 'NAT64, hex'],
  ['64:FF9B::7F00:1', 'NAT64, uppercase hex'],
  ['::ffff:a9fe:a9fe', 'metadata endpoint, IPv4-mapped hex'],
  ['::ffff:169.254.169.254', 'metadata endpoint, IPv4-mapped dotted'],
  ['64:ff9b::a9fe:a9fe', 'metadata endpoint via NAT64, hex'],
];

test('every IPv6 form that embeds a private IPv4 address is rejected', () => {
  for (const [address, form] of PRIVATE_V6_FORMS) {
    assert.equal(isPrivateAddress(address), true, `${address} (${form}) must be private`);
  }
});

test('IPv6 forms that embed a public IPv4 address stay allowed', () => {
  for (const address of ['::ffff:8.8.8.8', '::ffff:808:808', '::ffff:0:808:808', '64:ff9b::808:808', '2001:4860:4860::8888']) {
    assert.equal(isPrivateAddress(address), false, `${address} must stay public`);
  }
});

test('a hostname resolving to a private IPv4-mapped IPv6 address is refused', async () => {
  for (const address of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '::7f00:1', '::ffff:0:7f00:1', '64:ff9b::7f00:1']) {
    await assert.rejects(
      resolveSafeRemoteUrl('https://cdn.example.com/a.bin', {
        allowedHosts: ['cdn.example.com'],
        resolve: async () => [address],
      }),
      (error: unknown) => error instanceof SsrfError && /resolved_private_address/.test(error.message),
      `${address} must not be reachable through the pinned connection`,
    );
  }
});

test('a literal bracketed IPv4-mapped IPv6 URL is refused even when allowlisted', async () => {
  await assert.rejects(
    resolveSafeRemoteUrl('https://[::ffff:7f00:1]/a.bin', {
      allowedHosts: ['[::ffff:7f00:1]'],
      resolve: async () => ['93.184.216.34'],
    }),
    (error: unknown) => error instanceof SsrfError && /private_address/.test(error.message),
  );
});

test('remote fetch connects to the validated address, not a second DNS answer', async () => {
  const calls: TransportCall[] = [];
  const policy: RemoteFetchPolicy = {
    allowedHosts: ['cdn.example.com'],
    allowHttp: true,
    // First answer passes validation; every later answer is loopback.
    resolve: async () => ['93.184.216.34'],
  };
  const transport = rebindingTransport(
    ['93.184.216.34', '127.0.0.1'],
    { '93.184.216.34': 'public-content', '127.0.0.1': 'internal-secret' },
    calls,
  );

  const bytes = await fetchRemoteObject('http://cdn.example.com/a.bin', policy, transport as never);
  assert.equal(Buffer.from(bytes).toString('utf8'), 'public-content');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.address, '93.184.216.34', 'the connection must use the validated address');
  assert.equal(calls[0]?.hostHeader, 'cdn.example.com', 'the original Host must be preserved');
});

test('a rebinding resolver cannot redirect a request to loopback', async () => {
  const calls: TransportCall[] = [];
  let answers = 0;
  const policy: RemoteFetchPolicy = {
    allowedHosts: ['cdn.example.com'],
    allowHttp: true,
    // First validation answer is public; the client's own resolution would get loopback.
    resolve: async () => {
      answers += 1;
      return answers === 1 ? ['93.184.216.34'] : ['127.0.0.1'];
    },
  };
  const transport = rebindingTransport(
    ['127.0.0.1'],
    { '93.184.216.34': 'public-content', '127.0.0.1': 'internal-secret' },
    calls,
  );

  const bytes = await fetchRemoteObject('http://cdn.example.com/a.bin', policy, transport as never);
  assert.equal(Buffer.from(bytes).toString('utf8'), 'public-content');
  assert.notEqual(calls[0]?.address, '127.0.0.1');
});

test('a streamed response without content-length is cut off at maxBytes', async () => {
  const chunk = new Uint8Array(64 * 1024).fill(7);
  const totalChunks = 512; // 32 MiB, well past the limit
  let pulled = 0;
  let cancelled = false;
  const policy: RemoteFetchPolicy = {
    allowedHosts: ['cdn.example.com'],
    maxBytes: 256 * 1024,
    resolve: async () => ['93.184.216.34'],
  };
  const transport = async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= totalChunks) {
          controller.close();
          return;
        }
        pulled += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    // No content-length: the size is only discoverable by reading.
    return new Response(body, { status: 200 });
  };

  await assert.rejects(
    fetchRemoteObject('https://cdn.example.com/big.bin', policy, transport as never),
    (error: unknown) => error instanceof SsrfError && /remote_too_large/.test(error.message),
  );
  assert.ok(pulled <= 8, `only a bounded prefix may be buffered, pulled ${pulled}`);
  assert.ok(cancelled, 'the response stream must be cancelled once the limit is exceeded');
});

test('a streamed response under the limit is returned whole', async () => {
  const chunks = [Buffer.from('abc'), Buffer.from('def'), Buffer.from('ghi')];
  const policy: RemoteFetchPolicy = {
    allowedHosts: ['cdn.example.com'],
    maxBytes: 1024,
    resolve: async () => ['93.184.216.34'],
  };
  const transport = async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const item of chunks) controller.enqueue(new Uint8Array(item));
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  };

  const bytes = await fetchRemoteObject('https://cdn.example.com/small.bin', policy, transport as never);
  assert.equal(Buffer.from(bytes).toString('utf8'), 'abcdefghi');
});

test('the real transport connects to the pinned address while keeping the Host header', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(`host=${request.headers.host}`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    // `rebind.example.com` resolves nowhere: only the pinned address can reach the
    // server, which proves the connection ignored DNS entirely.
    const controller = new AbortController();
    const response = await pinnedRequest(new URL(`http://rebind.example.com:${port}/a.bin`), {
      address: '127.0.0.1',
      hostHeader: `rebind.example.com:${port}`,
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const body = Buffer.from(await new Response(response.body).arrayBuffer()).toString('utf8');
    assert.equal(body, `host=rebind.example.com:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
