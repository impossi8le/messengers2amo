import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createAmoDriveReader} from '../src/integrations/amocrm/drive-reader.ts';

const uuid='c719cc09-322f-44a0-84b1-82aabea3dd46',bytes=Buffer.from('original fixture bytes');
const input={companyId:'c',accountId:'a',fileUuid:uuid,byteSize:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
function fixture(options:{target?:string;body?:Uint8Array;size?:number}={}){
 const calls:{url:string;init:RequestInit}[]=[];
 const reader=createAmoDriveReader({accountDomain:'example.amocrm.ru',getAccessToken:async scope=>{assert.deepEqual(scope,{companyId:'c',accountId:'a'});return 'synthetic-oauth';},fetch:async(url,init)=>{
  calls.push({url:String(url),init:init??{}});
  if(String(url).includes('/api/v4/account'))return Response.json({drive_url:'https://drive-a.amocrm.ru'});
  if(String(url).includes('/v1.0/files/'))return Response.json({uuid,size:options.size??bytes.length,_links:{download:{href:'https://drive-b.amocrm.ru/download-ticket'}}});
  if(String(url).includes('drive-b.'))return new Response(null,{status:302,headers:{location:options.target??'https://hb.ru-msk.vkcloud-storage.ru/original?signed=ticket'}});
  return new Response(Buffer.from(options.body??bytes));
 }});
 return {reader,calls};
}

test('fresh drive download is tenant scoped and redirect never receives OAuth',async()=>{
 const {reader,calls}=fixture();assert.deepEqual(await reader.download(input),new Uint8Array(bytes));
 assert.equal(calls.length,4);
 assert.equal(new Headers(calls[2]!.init.headers).get('authorization'),'Bearer synthetic-oauth');
 assert.equal(new Headers(calls[3]!.init.headers).get('authorization'),null);
 assert.equal(calls[2]!.init.redirect,'manual');assert.equal(calls[3]!.init.redirect,'error');
});

test('foreign redirects, wrong bytes and changed metadata fail closed',async()=>{
 for(const options of [{target:'https://attacker.test/original'},{target:'https://127.0.0.1/original'},
  {target:'http://hb.ru-msk.vkcloud-storage.ru/original'},{body:Buffer.from('bad')},{size:1}]){
  const {reader,calls}=fixture(options);await assert.rejects(()=>reader.download(input),/files_/);
  assert.ok(calls.every(call=>!call.url.includes('attacker.test')&&!call.url.includes('127.0.0.1')));
 }
});

test('oversized references never request credentials and a stalled read has one deadline',async()=>{
 let calls=0;
 const reader=createAmoDriveReader({accountDomain:'example.amocrm.ru',getAccessToken:async()=>{calls++;return 'synthetic';},
  timeoutMs:20,fetch:async()=>new Promise(()=>{})});
 await assert.rejects(()=>reader.download({...input,byteSize:21*1024*1024}),/files_invalid_reference/);assert.equal(calls,0);
 await assert.rejects(()=>reader.download(input),/files_read_timeout/);assert.equal(calls,1);
});
