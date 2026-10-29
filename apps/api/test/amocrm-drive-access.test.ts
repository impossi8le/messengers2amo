import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import Fastify from 'fastify';
import {createTestDb} from './helpers/db.ts';
import {seedCompany,seedConnection} from './helpers/seed.ts';
import {recordTelegramUpdate} from '../src/telegram/inbox.ts';
import {drainTelegramInbox} from '../src/telegram/processor.ts';
import {crmDriveMediaUrl,registerCrmDriveMediaRoutes} from '../src/media/crm-drive-access.ts';

test('drive media capability survives restart and is revoked by current tenant policy',async()=>{
 const {db,schema,close}=await createTestDb();let app=Fastify();
 const bytes=Buffer.from('persistent original'),secret='synthetic-drive-url-signing-key';let reads=0;
 const reader={download:async(input:{companyId:string;accountId:string;fileUuid:string;byteSize:number;sha256:string})=>{
  reads++;assert.equal(input.companyId,'c1');assert.equal(input.fileUuid,'11111111-1111-4111-8111-111111111111');assert.equal(input.byteSize,bytes.length);
  assert.equal(input.sha256,createHash('sha256').update(bytes).digest('hex'));return bytes;
 }};
 try{
  await seedCompany(db,{companyId:'c1',workshops:['w'],staff:[{id:'admin',role:'admin',password:'drive-fixture-password'}]});
  await seedConnection(db,{companyId:'c1',id:'conn',state:'active',workshopId:'w',ownerId:'admin'});
  await db.query("UPDATE crm_accounts SET state='active'");
  await db.query("INSERT INTO channel_policies(company_id,connection_id,crm_projection_enabled,private_import_enabled,group_default) VALUES ('c1','conn',true,true,'deny')");
  await recordTelegramUpdate(db,{companyId:'c1',connectionId:'conn',bindingEpoch:0},{update_id:1,message:{message_id:55,chat:{id:42,type:'private'},text:'fixture'}});
  await drainTelegramInbox(db,{schema});
  const messageId=(await db.query('SELECT id FROM messages')).rows[0].id,accountId=(await db.query('SELECT id FROM crm_accounts')).rows[0].id;
  await db.query(`INSERT INTO amocrm_file_deliveries(company_id,account_id,message_id,lead_id,original_name,mime_type,byte_size,sha256,file_uuid,state)
   VALUES ('c1',$1,$2,'77','Счёт.txt','text/plain',$3,$4,'11111111-1111-4111-8111-111111111111','linked')`,
   [accountId,messageId,bytes.length,createHash('sha256').update(bytes).digest('hex')]);
  const scope={companyId:'c1',accountId,messageId,secret,baseUrl:'https://app.test'};
  const url=crmDriveMediaUrl(scope),path=new URL(url).pathname+new URL(url).search;
  registerCrmDriveMediaRoutes(app,{db,schema,reader,secret});
  let response=await app.inject({method:'GET',url:path});assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.rawPayload,bytes);
  assert.match(response.headers['content-disposition'] as string,/attachment/);assert.equal(response.headers['x-content-type-options'],'nosniff');
  await app.close();app=Fastify();registerCrmDriveMediaRoutes(app,{db,schema,reader,secret});
  response=await app.inject({method:'HEAD',url:path});assert.equal(response.statusCode,200);assert.equal(response.rawPayload.length,0);assert.equal(reads,2);
  const tampered=new URL(url);tampered.searchParams.set('companyId','other');assert.equal((await app.inject({method:'GET',url:tampered.pathname+tampered.search})).statusCode,404);
  const foreign=new URL(crmDriveMediaUrl({...scope,accountId:'other'}));assert.equal((await app.inject({method:'GET',url:foreign.pathname+foreign.search})).statusCode,404);assert.equal(reads,2);
  await db.query('UPDATE channel_policies SET crm_projection_enabled=false');
  assert.equal((await app.inject({method:'GET',url:path})).statusCode,404);assert.equal(reads,2);
 }finally{await app.close();await close();}
});
