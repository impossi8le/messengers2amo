import { test } from 'node:test';
import assert from 'node:assert/strict';
import {createTestDb} from './helpers/db.ts';
import {seedCompany,seedConnection} from './helpers/seed.ts';
import {recordTelegramUpdate} from '../src/telegram/inbox.ts';
import {drainTelegramInbox} from '../src/telegram/processor.ts';
import {createCaptureFileProjection} from '../src/integrations/amocrm/capture-files.ts';

async function fixture(options:{uploadFails?:boolean;linkFails?:boolean;bytes?:string;fileName?:string;mime?:string;size?:number;native?:boolean;opaque?:boolean}={}) {
 const context=await createTestDb(); const {db,schema}=context;
 await seedCompany(db,{companyId:'c1',workshops:['w'],staff:[{id:'admin',role:'admin',password:'synthetic-password'}]});
 await seedConnection(db,{companyId:'c1',id:'conn',state:'active',workshopId:'w',ownerId:'admin'});
 await db.query("UPDATE crm_accounts SET state='active'");
 await db.query("UPDATE connection_routes SET alert_staff_id='admin'");
 await db.query("INSERT INTO channel_policies(company_id,connection_id,crm_projection_enabled,private_import_enabled,group_default) VALUES ('c1','conn',true,true,'deny')");
 await recordTelegramUpdate(db,{companyId:'c1',connectionId:'conn',bindingEpoch:0},{update_id:1,message:{message_id:55,
   chat:{id:42,type:'private'},document:{file_id:'f',file_name:options.fileName??'Счёт.txt',mime_type:options.mime??'text/plain',file_size:options.size??4}}});
 await drainTelegramInbox(db,{schema});
 const job=(await db.query("SELECT payload FROM outbox_jobs WHERE job_kind='amocrm.projection'")).rows[0].payload;
 let downloads=0,uploads=0,links=0,linked=false;
  const projected:Array<{text?:string;attachment?:unknown}>=[];
 const project=createCaptureFileProjection({db,schema,resolveBotToken:()=> '123:synthetic',
   ...(options.native?{ensureBinding:async()=>({projected:true,leadId:'77'}),fileUrl:()=> 'https://app.test/original'}:{}),
   projectMessage:async(input)=>{projected.push(input);if(options.native){assert.equal(linked,true,'original must be stored and linked before native import');assert.ok(input.attachment);assert.equal(input.text,'');}
    else assert.equal(input.text,'Счёт.txt');return {projected:true,reason:'lead_capture_only',leadId:'77'};},
  fetch:async()=>++downloads%2===1?new Response(JSON.stringify({ok:true,result:{file_id:'f',file_path:'documents/f.txt',file_size:4}})):new Response(options.bytes??'safe'),
   files:{upload:async(input)=>{uploads++;assert.equal(input.fileName,'Счёт.txt');assert.equal(input.mimeType,options.opaque?'application/octet-stream':'text/plain');assert.equal(Buffer.from(input.bytes).toString(),'safe');if(options.uploadFails)throw new Error('secret-provider-url');return {uuid:'11111111-1111-4111-8111-111111111111'};},
   isLinked:async()=>linked,link:async()=>{links++;if(options.linkFails){options.linkFails=false;throw new Error('lost_link_response');}linked=true;}}});
  return {...context,project,job,projected,counts:()=>({downloads,uploads,links})};
}

test('capture attaches the original file to its lead once without S3 or Chats',async()=>{
 const ctx=await fixture();try{
  await ctx.project(ctx.job);await ctx.project(ctx.job);
  assert.deepEqual(ctx.counts(),{downloads:2,uploads:1,links:1});
  assert.equal((await ctx.db.query('SELECT state FROM amocrm_file_deliveries')).rows[0].state,'linked');
 }finally{await ctx.close();}
});

test('lost upload outcome is durably blocked instead of duplicating a CRM file',async()=>{
 const ctx=await fixture({uploadFails:true});try{
  await assert.rejects(()=>ctx.project(ctx.job),/crm_file_upload_unknown/);
  await assert.rejects(()=>ctx.project(ctx.job),/crm_file_upload_unknown/);
  assert.equal(ctx.counts().uploads,1);
  assert.equal((await ctx.db.query('SELECT state FROM amocrm_file_deliveries')).rows[0].state,'unknown');
 }finally{await ctx.close();}
});

test('link retry reuses uploaded UUID and revoked policy prevents further file calls',async()=>{
 const ctx=await fixture({linkFails:true});try{
  await assert.rejects(()=>ctx.project(ctx.job),/lost_link_response/);
  await ctx.project(ctx.job);
  assert.deepEqual(ctx.counts(),{downloads:2,uploads:1,links:2});
  await ctx.db.query('UPDATE channel_policies SET crm_projection_enabled=false');
  await ctx.project(ctx.job);
  assert.equal(ctx.counts().uploads,1);
 }finally{await ctx.close();}
});

test('permanently rejected metadata and spoofed bytes raise one safe manual-review alert across retries',async()=>{
  for(const scenario of ['oversized','invalid_mime','spoofed_bytes']){
  const ctx=await fixture({fileName:'CANARY-private-name.txt',
   ...(scenario==='spoofed_bytes'?{bytes:'MZ\u0000\u0001'}:{}),
   ...(scenario==='oversized'?{size:20971521}:{}),
    ...(scenario==='invalid_mime'?{mime:'not a mime type'}:{})});
  try{
   await assert.rejects(()=>ctx.project(ctx.job),/crm_file_rejected/);
   await assert.rejects(()=>ctx.project(ctx.job),/crm_file_rejected/);
   const alerts=(await ctx.db.query('SELECT kind,recipient_staff_id,error_code,conversation_id,external_message_id,dedupe_key FROM channel_alerts')).rows;
   assert.equal(alerts.length,1,`${scenario} must notify once, even after redelivery`);
   assert.equal(alerts[0].kind,'manual_review');assert.equal(alerts[0].recipient_staff_id,'admin');
   assert.equal(alerts[0].conversation_id,ctx.job.conversationId);assert.equal(alerts[0].external_message_id,'55');
   assert.equal(alerts[0].error_code,null,'a known rejection is not misrepresented as an unknown upload outcome');
   assert.ok(!JSON.stringify(alerts).includes('CANARY')&&!JSON.stringify(alerts).includes('synthetic'));
   assert.equal(ctx.counts().uploads,0);assert.equal(ctx.counts().links,0);
   assert.equal((await ctx.db.query('SELECT count(*)::int AS n FROM amocrm_file_deliveries')).rows[0].n,0);
  }finally{await ctx.close();}
 }
});

test('native attachment import follows persistent original storage without a filename-only message',async()=>{
 const ctx=await fixture({native:true});try{
  await ctx.project(ctx.job);
  assert.equal(ctx.projected.length,1);
  assert.deepEqual(ctx.projected[0]!.attachment,{type:'file',url:'https://app.test/original',fileName:'Счёт.txt',sizeBytes:4});
  await ctx.project(ctx.job);assert.deepEqual(ctx.counts(),{downloads:2,uploads:1,links:1});
 }finally{await ctx.close();}
});

test('unknown valid file formats are persisted as download-only opaque originals',async()=>{
 const ctx=await fixture({mime:'application/x-custom-format',opaque:true});try{
  await ctx.project(ctx.job);
  assert.equal(ctx.counts().uploads,1);
  assert.equal((await ctx.db.query('SELECT mime_type,state FROM amocrm_file_deliveries')).rows[0].mime_type,'application/octet-stream');
 }finally{await ctx.close();}
});
