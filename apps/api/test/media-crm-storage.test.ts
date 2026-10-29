import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S3ObjectStorage } from '../src/media/storage.ts';

function storage(fetchImpl:typeof fetch) {
  return new S3ObjectStorage({endpoint:'https://storage.example',bucket:'private',region:'test',
    accessKeyId:'synthetic-access',secretAccessKey:'synthetic-secret',forcePathStyle:true},Date.now,fetchImpl);
}

test('bounded CRM reads cancel oversized object bodies before returning bytes',async()=>{
  let cancelled=false;
  const s3=storage(async()=>new Response(new ReadableStream({
    start(c){c.enqueue(new Uint8Array(5));setTimeout(()=>{if(!cancelled)c.close();},10);},cancel(){cancelled=true;}})));
  await assert.rejects(()=>s3.get('file',{maxBytes:4,timeoutMs:1000}),/s3_get_too_large/);
  assert.equal(cancelled,true);
});

test('bounded CRM reads reject oversized declared length without reading the body',async()=>{
  let cancelled=false;
  const s3=storage(async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-length':'5'}}));
  await assert.rejects(()=>s3.get('file',{maxBytes:4,timeoutMs:1000}),/s3_get_too_large/);
  assert.equal(cancelled,true);
});

test('bounded CRM reads abort stalled fetches and bodies, even when fetch ignores the signal',{timeout:1000},async()=>{
  for(const stallBody of [false,true]) {
    let signal:AbortSignal|null=null;
    let cancelled=false;
    const s3=storage(async(_url,init)=>{
      signal=init?.signal??null;
      return stallBody?new Response(new ReadableStream({cancel(){cancelled=true;}})):new Promise<Response>(()=>{});
    });
    await assert.rejects(()=>s3.get('file',{maxBytes:4,timeoutMs:30}),/s3_get_unavailable/);
    assert.equal((signal as AbortSignal|null)?.aborted,true);
    if(stallBody) assert.equal(cancelled,true);
  }
});

test('bounded CRM reads return valid objects and preserve missing-object semantics',async()=>{
  assert.deepEqual(await storage(async()=>new Response('safe')).get('file',{maxBytes:4,timeoutMs:1000}),new Uint8Array(Buffer.from('safe')));
  assert.equal(await storage(async()=>new Response(null,{status:404})).get('missing',{maxBytes:4,timeoutMs:1000}),null);
});
