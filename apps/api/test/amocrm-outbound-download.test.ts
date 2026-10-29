import {test} from 'node:test';
import assert from 'node:assert/strict';
import {downloadCrmAttachment} from '../src/integrations/amocrm/outbound-media.ts';

test('attachment download never forwards OAuth to CDN or follows a redirect to an arbitrary host',async()=>{
  const calls:Array<{host:string;auth:unknown}>=[];
  const result=await downloadCrmAttachment({url:'https://drive-b.amocrm.ru/download/synthetic',expectedBytes:4,getAccessToken:async()=>'synthetic-secret',
    fetch:async(url,init)=>{const host=new URL(url).hostname;calls.push({host,auth:(init?.headers as Record<string,string>|undefined)?.authorization});
      return host==='drive-b.amocrm.ru'?new Response(null,{status:302,headers:{location:'https://hb.ru-msk.vkcloud-storage.ru/synthetic'}}):new Response('test');}});
  assert.equal(Buffer.from(result).toString(),'test');assert.equal(calls[0]!.auth,'Bearer synthetic-secret');assert.equal(calls[1]!.auth,undefined);
  let n=0;await assert.rejects(()=>downloadCrmAttachment({url:'https://amojo.amocrm.ru/attachments/a',expectedBytes:4,getAccessToken:async()=>{throw Error('no OAuth');},
    fetch:async()=>{n++;return new Response(null,{status:302,headers:{location:'http://127.0.0.1/internal'}});}}),/outbound_media_url_invalid/);
  assert.equal(n,1);
});

test('attachment download enforces expected sizes and declared maximum before consuming a large body',async()=>{
  for(const expectedBytes of [0,3])await assert.rejects(()=>downloadCrmAttachment({url:'https://amojo.amocrm.ru/attachments/a',expectedBytes,getAccessToken:async()=>'',fetch:async()=>new Response('test')}),/outbound_media_size_mismatch/);
  await assert.rejects(()=>downloadCrmAttachment({url:'https://amojo.amocrm.ru/attachments/a',expectedBytes:null,getAccessToken:async()=>'',fetch:async()=>new Response('x',{headers:{'content-length':String(20*1024*1024+1)}})}),/outbound_media_too_large/);
});
