import test from 'node:test';
import assert from 'node:assert/strict';
import {signChatsRequest,verifyChatsWebhook} from '../src/index.mjs';
const secret='test-channel-secret';
const date='Wed, 21 Oct 2026 12:00:00 GMT';
const body=Buffer.from('7b226d657373616765223a22d09fd180d0b8d0b2d0b5d182227d','hex');
const spaced=Buffer.from('200a7b226d657373616765223a22d09fd180d0b8d0b2d0b5d182227d0a','hex');
const rawSignature='5288aebcc894ebb76e644f1ef104014eebbb14b4';
function request(overrides={}){return {method:'post',urlPath:'/v2/origin/custom/scope-test',date,rawBody:body,channelSecret:secret,...overrides};}
function webhook(overrides={}){return {rawBody:body,signature:rawSignature,channelSecret:secret,...overrides};}
test('outbound POST signs literal raw UTF-8 bytes using the independently fixed canonical vector',()=>{
 assert.deepEqual(signChatsRequest(request()),{'Date':date,'Content-Type':'application/json','Content-MD5':'9d113919e3b4233fab1d74a844e4c7c8','X-Signature':'4e09a625b5e627599cb2ffc128e3b03d666009a4'});
});
test('outbound GET uses the empty-body digest without pretending supplied nonempty data was sent',()=>{
 const empty=request({method:'get'});delete empty.rawBody;
 assert.deepEqual(signChatsRequest(empty),{'Date':date,'Content-Type':'application/json','Content-MD5':'d41d8cd98f00b204e9800998ecf8427e','X-Signature':'644074ad72c623cbea177979411e2a7b734a7673'});
 assert.throws(()=>signChatsRequest(request({method:'GET',rawBody:Buffer.from('not empty')})),TypeError);
});
test('query parameters are excluded from signing while encoded path bytes are preserved',()=>{
 assert.equal(signChatsRequest(request({urlPath:'/v2/origin/custom/scope-test?a=1&b=two'}))['X-Signature'],'4e09a625b5e627599cb2ffc128e3b03d666009a4');
 assert.equal(signChatsRequest(request({urlPath:'/v2/origin/custom/scope%2Ftest?ignored=1'}))['X-Signature'],'9a2921b5a0ea202ea645bda36faa56eb052c2279');
});
test('signed whitespace is not JSON-reserialized or trimmed for outbound headers',()=>{
 const before=Buffer.from(spaced);
 const headers=signChatsRequest(request({rawBody:spaced}));
 assert.equal(headers['Content-MD5'],'b88a148f898bccfbcf6bd6deeebfa790');
 assert.equal(headers['X-Signature'],'8e91e1341a30b49710abc12f2845e3536a88867a');
 assert.deepEqual(spaced,before);
});
test('HTTP method and supplied Date independently affect outbound signature bytes',()=>{
 assert.equal(signChatsRequest(request({date:'Thu, 22 Oct 2026 12:00:00 GMT'}))['X-Signature'],'63c9ea5d400b237b7bdd226f95e29387a4f82dbc');
 assert.equal(signChatsRequest(request({method:'PATCH'}))['X-Signature'],'1fbd42067af8966717a63424f996535e8835f8f9');
});
test('raw binary and Uint8Array view boundaries are hashed without UTF-8 conversion or backing-buffer leakage',()=>{
 const binary=signChatsRequest(request({rawBody:Buffer.from([0,255,32,128])}));
 assert.equal(binary['Content-MD5'],'2598024f29172425ded8a9f0b749053f');
 assert.equal(binary['X-Signature'],'834df7fe04fdca5990f8562adceefb5397a0aa74');
 const framed=new Uint8Array([95,95,97,98,99,95,95]);
 assert.equal(signChatsRequest(request({rawBody:framed.subarray(2,5)}))['X-Signature'],'b197cb29399e7b2ff9388118f2612d9da947a578');
});
test('outbound rejects header injection, absolute/ambiguous path and noncanonical date before returning headers',()=>{
 for(const invalid of [
 {method:'POST\r\nInjected: yes'},{method:' POST '},
 {urlPath:'https://example.test/v2/a'},{urlPath:'//example.test/a'},{urlPath:'/v2/a#fragment'},{urlPath:'/v2/a\r\nInjected: yes'},{urlPath:'/v2/a path'},
 {date:'2026-10-21T12:00:00Z'},{date:'Thu, 21 Oct 2026 12:00:00 GMT'},{date:date+'\r\nInjected: yes'},{date:undefined},
 {contentType:'text/plain'},{contentType:'application/json\r\nInjected: yes'}
 ])assert.throws(()=>signChatsRequest(request(invalid)),TypeError);
});
test('payload objects and strings cannot be coerced or serialized into signed bytes',()=>{
 let inspected=0;const bad={toJSON(){inspected++;throw Error('CANARY_SECRET');},toString(){inspected++;throw Error('CANARY_SECRET');}};
 for(const rawBody of [bad,'{"message":"synthetic"}',undefined,null])assert.throws(()=>signChatsRequest(request({rawBody})),TypeError);
 assert.equal(inspected,0);
});
test('missing or invalid secret never produces an input-echoing diagnostic',()=>{
 for(const channelSecret of ['',Buffer.alloc(0),null,123,{toString(){throw Error('CANARY_SECRET');}}]){
  for(const action of [()=>signChatsRequest(request({channelSecret})),()=>verifyChatsWebhook(webhook({channelSecret}))]){
   assert.throws(action,error=>error instanceof TypeError&&!error.message.includes('CANARY_SECRET'));
  }
 }
});
test('webhook verifies the independent HMAC over raw body without Date or request-canonical fields',()=>{
 assert.equal(verifyChatsWebhook(webhook()),true);
 assert.equal(verifyChatsWebhook(webhook({signature:rawSignature.toUpperCase()})),true);
 assert.equal(verifyChatsWebhook(webhook({signature:'4e09a625b5e627599cb2ffc128e3b03d666009a4'})),false);
});
test('webhook preserves signed whitespace and does not fall back to trimmed body',()=>{
 assert.equal(verifyChatsWebhook(webhook({rawBody:spaced,signature:'dec3f30e447404af853f0eea34823f31e30f5d71'})),true);
 assert.equal(verifyChatsWebhook(webhook({rawBody:body,signature:'dec3f30e447404af853f0eea34823f31e30f5d71'})),false);
 assert.equal(verifyChatsWebhook(webhook({rawBody:spaced})),false);
});
test('tampered bytes, wrong key and equal-length digest mismatch fail closed',()=>{
 assert.equal(verifyChatsWebhook(webhook({rawBody:Buffer.from('{"message":"changed"}')})),false);
 assert.equal(verifyChatsWebhook(webhook({channelSecret:'other-synthetic-secret'})),false);
 assert.equal(verifyChatsWebhook(webhook({signature:'5288aebcc894ebb76e644f1ef104014eebbb14b0'})),false);
});
test('malformed signatures do not get trimmed, truncated, decoded from prefixes or accepted as missing',()=>{
 for(const signature of [undefined,null,12,[],Buffer.alloc(20),'',rawSignature.slice(1),rawSignature+'0','sha1='+rawSignature,' '+rawSignature,rawSignature+'\n','g'.repeat(40),'０'.repeat(40)])assert.equal(verifyChatsWebhook(webhook({signature})),false);
});
test('webhook accepts raw binary but rejects a payload object without invoking its getters',()=>{
 assert.equal(verifyChatsWebhook(webhook({rawBody:Buffer.from([0,255,32,128]),signature:'1d3fa729d53dac9ab0d371e3eeac4ecabc4c702b'})),true);
 let inspected=0;const rawBody={get message(){inspected++;throw Error('CANARY_SECRET');},toJSON(){inspected++;throw Error('CANARY_SECRET');}};
 assert.throws(()=>verifyChatsWebhook(webhook({rawBody})),TypeError);assert.equal(inspected,0);
});
