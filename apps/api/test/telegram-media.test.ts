import { test } from 'node:test';
import assert from 'node:assert/strict';
import { telegramMediaOf, downloadTelegramMedia, TelegramMediaError } from '../src/telegram/media.ts';

const token = '123:synthetic-token';
const json = (value: unknown) => new Response(JSON.stringify(value));
const metadata = (extra: Record<string,unknown> = {}) => json({ok:true,result:{file_id:'f1',file_path:'documents/test.txt',...extra}});

test('normalizes the largest photo and preserves document metadata without provider URLs', () => {
  assert.deepEqual(telegramMediaOf({photo:[{file_id:'small',file_size:1},{file_id:'large',file_size:20}],caption:'Caption'}),{
    type:'picture',fileId:'large',fileName:'photo.jpg',mimeType:'image/jpeg',sizeBytes:20,
  });
  assert.deepEqual(telegramMediaOf({document:{file_id:'doc',file_name:'../folder/test.txt',mime_type:'text/plain'}}),{
    type:'file',fileId:'doc',fileName:'_folder_test.txt',mimeType:'text/plain',sizeBytes:null,
  });
  assert.equal(telegramMediaOf({document:{file_id:'bad',file_size:-1}}),null);
});

test('downloads only from Telegram with bounded bodies and no redirects', async () => {
  const calls: {url:string;init?:RequestInit}[]=[];
  const bytes=await downloadTelegramMedia({botToken:token,fileId:'f1',fetch:async(url,init)=>{
    calls.push({url:String(url),init});
    return calls.length===1?metadata({file_size:4}):new Response('safe');
  }});
  assert.equal(Buffer.from(bytes).toString(),'safe');
  assert.equal(calls[0]!.url,`https://api.telegram.org/bot${token}/getFile`);
  assert.equal(calls[1]!.url,`https://api.telegram.org/file/bot${token}/documents/test.txt`);
  assert.equal(calls[0]!.init?.body,JSON.stringify({file_id:'f1'}));
  assert.ok(calls.every((call)=>call.init?.redirect==='error' && call.init.signal instanceof AbortSignal));
});

test('rejects forged paths, mismatching file identity, invalid metadata and credential-bearing errors', async () => {
  for (const extra of [{file_path:'../file'},{file_path:'/tmp/file'},{file_path:'https://evil.test/a'},
    {file_path:'a/%2e%2e/b'},{file_path:'a/./b'},{file_path:'a?token=x'}, {file_id:'another'}, {file_size:-1}]) {
    let calls=0;
    await assert.rejects(()=>downloadTelegramMedia({botToken:token,fileId:'f1',fetch:async()=>{calls++;return metadata(extra);}}),
      (error:unknown)=>error instanceof TelegramMediaError && error.code==='telegram_media_invalid');
    assert.equal(calls,1);
  }
  await assert.rejects(()=>downloadTelegramMedia({botToken:token,fileId:'f1',fetch:async()=>{throw new Error(`https://provider/${token}`);}}),
    (error:unknown)=>error instanceof TelegramMediaError && !String(error.stack).includes(token) && !error.cause);
});

test('enforces declared and actual download size, cancels an oversized stream, checks truncation', async () => {
  let calls=0;
  await assert.rejects(()=>downloadTelegramMedia({botToken:token,fileId:'f1',maxBytes:4,fetch:async()=>{calls++;return metadata({file_size:5});}}),
    /telegram_media_too_large/);
  assert.equal(calls,1);
  let cancelled=false;
  calls=0;
  await assert.rejects(()=>downloadTelegramMedia({botToken:token,fileId:'f1',maxBytes:4,fetch:async()=>{
    calls++;return calls===1?metadata():new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(5));},cancel(){cancelled=true;}}));
  }}),/telegram_media_too_large/);
  assert.equal(cancelled,true);
  calls=0;
  await assert.rejects(()=>downloadTelegramMedia({botToken:token,fileId:'f1',fetch:async()=>++calls===1?metadata({file_size:4}):new Response('a')}),/telegram_media_invalid/);
});

test('deadline covers a stalled response body even when an injected fetch ignores the signal', async () => {
  const start=Date.now();
  await assert.rejects(()=>downloadTelegramMedia({botToken:token,fileId:'f1',timeoutMs:30,
    fetch:async()=>new Response(new ReadableStream({start(){}}))}),/telegram_media_unavailable/);
  assert.ok(Date.now()-start<1000);
});
