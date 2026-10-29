import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCrmFilesClient } from '../src/integrations/amocrm/files-client.ts';
import { AmocrmApiError } from '../src/integrations/amocrm/client.ts';

const scope = { companyId: 'synthetic-company', accountId: 'synthetic-account' };
const uuid = '367b9f38-5f01-4cea-947e-dfab47aea522';
const otherUuid = '50ca4b6b-0b88-4ece-9f89-d48961579ae0';
const origin = 'https://drive-b.amocrm.ru';
const uploadUrl = `${origin}/v1.0/sessions/upload/synthetic.part.1`;
const session = { session_id: 1, max_file_size: 20 * 1024 * 1024, max_part_size: 3, upload_url: uploadUrl };
const input = { ...scope, fileName: 'Счёт 42.txt', mimeType: 'text/plain', bytes: Buffer.from('abcdefg') };
const linkInput = { ...scope, leadId: '12345', fileUuid: uuid };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
type Call = { url: string; init: RequestInit };
function fixture(reply: (call: Call, index: number) => Response | Promise<Response>, timeoutMs = 500) {
  const calls: Call[] = [];
  const client = createCrmFilesClient({ accountDomain: 'synthetic.amocrm.ru', timeoutMs,
    getAccessToken: async (actual) => { assert.deepEqual(actual, scope); return 'synthetic-access-token'; },
    fetch: async (url, init) => {
      const call = { url: String(url), init: init ?? {} }; calls.push(call);
      assert.equal(init?.redirect, 'error');
      return reply(call, calls.length);
    } });
  return { client, calls };
}

test('uploads sequential byte chunks, preserves metadata and returns the completed file UUID', async () => {
  const { client, calls } = fixture((call, index) => {
    assert.equal(new Headers(call.init.headers).get('authorization'), 'Bearer synthetic-access-token');
    if (index === 1) { assert.equal(call.url, 'https://synthetic.amocrm.ru/api/v4/account?with=drive_url'); return json({ drive_url: origin }); }
    if (index === 2) {
      assert.equal(call.url, `${origin}/v1.0/sessions`);
      assert.equal(call.init.method, 'POST');
      assert.deepEqual(JSON.parse(String(call.init.body)), { file_name: input.fileName, file_size: 7, content_type: 'text/plain', with_preview: true });
      return json(session);
    }
    assert.equal(call.init.method, 'POST');
    assert.equal(Buffer.from(call.init.body as Uint8Array).toString(), ['abc', 'def', 'g'][index - 3]);
    return index === 5 ? json({ uuid, size: 7, session_id: 1 }) : json({ session_id: 1, next_url: `${origin}/v1.0/sessions/upload/part${index}` });
  });
  assert.deepEqual(await client.upload(input), { uuid });
  assert.equal(calls.length, 5);
});

test('accepts the documented amoCRM upload shard returned by another drive origin',async()=>{
  const {client,calls}=fixture((_call,index)=>index===1?json({drive_url:'https://drive-a.amocrm.ru'}):
    index===2?json({...session,max_part_size:100}):json({uuid,size:7,session_id:1}));
  assert.deepEqual(await client.upload(input),{uuid});
  assert.equal(calls[1]!.url,'https://drive-a.amocrm.ru/v1.0/sessions');
  assert.equal(calls[2]!.url,uploadUrl);
});

test('accepts the live drive upload path for initial and subsequent chunks',async()=>{
  const {client,calls}=fixture((_call,index)=>index===1?json({drive_url:'https://drive-a.amocrm.ru'}):
    index===2?json({...session,upload_url:`${origin}/upload/synthetic.part.1`}):
    index===5?json({uuid,size:7,session_id:1}):json({session_id:1,next_url:`${origin}/upload/part${index}`}));
  assert.deepEqual(await client.upload(input),{uuid});
  assert.equal(calls[2]!.url,`${origin}/upload/synthetic.part.1`);
  assert.equal(calls.length,5);
});

test('rejects unsafe drive origins before sending credentials or bytes outside the account', async () => {
  for (const drive_url of ['http://drive.amocrm.ru', 'https://evil.example', 'https://drive.amocrm.ru.evil.example',
    'https://user:pass@drive.amocrm.ru', 'https://drive.amocrm.ru:444', 'https://drive.amocrm.ru/path', 'https://drive.amocrm.ru/#fragment']) {
    const { client, calls } = fixture(() => json({ drive_url }));
    await assert.rejects(() => client.upload(input), /files_invalid_response/);
    assert.equal(calls.length, 1);
  }
});

test('refuses unsafe initial and next upload URLs before their request', async () => {
  for (const unsafe of ['https://evil.example/v1.0/sessions/upload/token', `${origin}/v1.0/files/token`,
    `${origin}/v1.0/sessions/upload/token#fragment`, `${origin}/v1.0/sessions/upload/token?query=secret`,
    'https://drive-c.amocrm.ru.evil.example/v1.0/sessions/upload/token', `${origin}/v1.0/sessions/upload/%2e%2e/files`]) {
    for (const initial of [true, false]) {
      const { client, calls } = fixture((_call, index) => index === 1 ? json({ drive_url: origin }) :
        index === 2 ? json({ ...session, upload_url: initial ? unsafe : uploadUrl }) : json({ session_id: 1, next_url: unsafe }));
      await assert.rejects(() => client.upload(input), /files_invalid_response/);
      assert.equal(calls.length, initial ? 2 : 3);
    }
  }
});

test('403 and unknown upload errors have safe codes, no body or URL leakage and no retry', async () => {
  const { client, calls } = fixture((_call, index) => index === 1 ? json({ drive_url: origin }) : json({ detail: 'CANARY-provider-secret' }, 403));
  await assert.rejects(() => client.upload(input), (error: unknown) => error instanceof AmocrmApiError && error.status === 403 && error.code === 'files_http_403');
  assert.equal(calls.length, 2);
  const broken = fixture((_call, index) => { if (index === 1) return json({ drive_url: origin }); throw new Error('https://secret.example/?token=CANARY'); });
  await assert.rejects(() => broken.client.upload(input), /files_network_error/);
  assert.equal(broken.calls.length, 2);
});

test('oversized input and invalid sessions do not send byte chunks', async () => {
  const tooLarge = fixture(() => { throw new Error('must not send'); });
  await assert.rejects(() => tooLarge.client.upload({ ...input, bytes: new Uint8Array(20 * 1024 * 1024 + 1) }), /files_invalid_input/);
  assert.equal(tooLarge.calls.length, 0);
  for (const invalid of [{ ...session, session_id: 0 }, { ...session, max_part_size: 0 }, { ...session, max_part_size: 1.5 },
    { ...session, max_file_size: 6 }, { ...session, max_file_size: '999' }, { ...session, max_part_size: 1 }]) {
    const { client, calls } = fixture((_call, index) => index === 1 ? json({ drive_url: origin }) : json(invalid));
    await assert.rejects(() => client.upload({ ...input, bytes: new Uint8Array(5000) }), /files_invalid_response/);
    assert.equal(calls.length, 2);
  }
});

test('rejects prematurely completed, wrong-session and incomplete final uploads', async () => {
  for (const malformed of [{ uuid }, { session_id: 2, next_url: uploadUrl }, {}, { session_id: 1, next_url: uploadUrl }]) {
    const { client, calls } = fixture((_call, index) => index === 1 ? json({ drive_url: origin }) : index === 2 ? json(session) : json(malformed));
    await assert.rejects(() => client.upload(input), /files_invalid_response/);
    assert.ok(calls.length <= 3, 'a repeated upload URL is not reused');
  }
  const { client } = fixture((_call, index) => index === 1 ? json({ drive_url: origin }) : index === 2 ? json({ ...session, max_part_size: 10 }) : json({ uuid: 'bad-uuid' }));
  await assert.rejects(() => client.upload(input), /files_invalid_response/);
});

test('checks existing links using bounded before_id pagination without following upstream links', async () => {
  const page = Array.from({ length: 250 }, (_, i) => ({ id: 1000 - i, file_uuid: otherUuid }));
  const { client, calls } = fixture((call, index) => {
    const url = new URL(call.url);
    assert.equal(url.pathname, '/api/v4/leads/12345/files'); assert.equal(url.searchParams.get('limit'), '250');
    if (index === 1) return json({ _embedded: { files: page }, _links: { next: { href: 'https://evil.example/ignored' } } });
    assert.equal(url.searchParams.get('before_id'), '751');
    return json({ _embedded: { files: [{ id: 750, file_uuid: uuid }] } });
  });
  assert.equal(await client.isLinked(linkInput), true); assert.equal(calls.length, 2);
  assert.equal(await fixture(() => new Response(null, { status: 204 })).client.isLinked(linkInput), false);
  assert.equal(await fixture(() => json({ _embedded: { files: [] } })).client.isLinked(linkInput), false);
});

test('malformed or non-progressing link pages fail closed instead of declaring the file absent', async () => {
  for (const files of [[{ id: 0, file_uuid: uuid }], [{ id: 1, file_uuid: 'bad' }], 'not-an-array']) {
    await assert.rejects(() => fixture(() => json({ _embedded: { files } })).client.isLinked(linkInput), /files_invalid_response/);
  }
  const page = Array.from({ length: 250 }, (_, i) => ({ id: 1000 - i, file_uuid: otherUuid }));
  const { client, calls } = fixture(() => json({ _embedded: { files: page } }));
  await assert.rejects(() => client.isLinked(linkInput), /files_invalid_response/); assert.equal(calls.length, 2);
});

test('link search stops at 100 pages rather than silently reporting an unsearched file absent', async () => {
  const { client, calls } = fixture((_call, index) => json({ _embedded: { files:
    Array.from({ length: 250 }, (_, i) => ({ id: 30000 - (index - 1) * 250 - i, file_uuid: otherUuid })),
  } }));
  await assert.rejects(() => client.isLinked(linkInput), /files_page_limit_exceeded/);
  assert.equal(calls.length, 100);
});

test('links one UUID with PUT and accepts the documented empty 202 response', async () => {
  const { client, calls } = fixture((call) => {
    assert.equal(call.url, 'https://synthetic.amocrm.ru/api/v4/leads/12345/files');
    assert.equal(call.init.method, 'PUT'); assert.deepEqual(JSON.parse(String(call.init.body)), [{ file_uuid: uuid }]);
    return new Response(null, { status: 202 });
  });
  await client.link(linkInput); assert.equal(calls.length, 1);
  for (const invalid of [{ ...linkInput, leadId: '../contacts' }, { ...linkInput, fileUuid: 'invalid' }]) {
    await assert.rejects(() => client.link(invalid), /files_invalid_input/);
  }
  assert.equal(calls.length, 1);
});

test('bounds HTTP response bodies and aborts stalled requests without hidden retries', { timeout: 2000 }, async () => {
  const large = fixture(() => new Response('x'.repeat(1024 * 1024 + 1)));
  await assert.rejects(() => large.client.upload(input), /files_response_too_large/);
  const stalled = fixture(({ init }) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(new Error('CANARY-token')), { once: true });
  }), 30);
  await assert.rejects(() => stalled.client.upload(input), /files_timeout/); assert.equal(stalled.calls.length, 1);
  const bodyStalled = fixture(({ init }) => {
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from('{'));
      init.signal!.addEventListener('abort', () => controller.error(new Error('CANARY-body-secret')), { once: true });
    } }));
  }, 30);
  await assert.rejects(() => bodyStalled.client.upload(input), /files_timeout/);
  assert.equal(bodyStalled.calls.length, 1);
});
