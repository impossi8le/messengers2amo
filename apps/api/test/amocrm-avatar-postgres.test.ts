import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {createTestDb} from './helpers/db.ts';
import {seedAmocrm,insertChannel} from './helpers/amocrm.ts';
import {crmAvatarUrl,registerCrmAvatarRoutes} from '../src/media/crm-avatar-access.ts';

test('avatar SQL authorizes the real connected private route and revokes provider access with the channel',async()=>{
 const ctx=await createTestDb();const app=Fastify();let calls=0;
 try{
  const seed=await seedAmocrm(ctx.db,ctx.schema,{conversationId:'11111111-1111-4111-8111-111111111111',externalChatId:'42'});
  await ctx.db.query("INSERT INTO workshops(company_id,id,display_name) VALUES ('c1','w1','Workshop')");
  await ctx.db.query("INSERT INTO staff(company_id,id,display_name) VALUES ('c1','owner1','Owner')");
  await ctx.db.query("INSERT INTO crm_sources(company_id,id,account_id,external_id,origin_code) VALUES ('c1','src1','acc1','src1','chat')");
  await ctx.db.query("INSERT INTO connection_routes(company_id,connection_id,workshop_id,crm_account_id,funnel_id,default_owner_id,technical_source_id,version) VALUES ('c1','conn1','w1','acc1','100','owner1','src1',1)");
  await insertChannel(ctx.db,ctx.schema,seed,'synthetic-encrypted-channel');
  const jpeg=Buffer.from([255,216,255,224,0,16,255,217]);
  registerCrmAvatarRoutes(app,{db:ctx.db,schema:ctx.schema,secret:'synthetic-signing',resolveBotToken:()=> '123:synthetic',fetch:async(url)=>{
   calls++;const path=String(url);
   if(path.endsWith('/getUserProfilePhotos'))return Response.json({ok:true,result:{total_count:1,photos:[[{file_id:'avatar',file_size:jpeg.length}]]}});
   if(path.endsWith('/getFile'))return Response.json({ok:true,result:{file_id:'avatar',file_path:'photos/avatar.jpg',file_size:jpeg.length}});
   return new Response(jpeg);
  }});
  const url=new URL(crmAvatarUrl({...seed,bindingEpoch:seed.epoch,baseUrl:'https://app.test',secret:'synthetic-signing'}));
  const response=await app.inject({method:'GET',url:url.pathname+url.search});
  assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.rawPayload,jpeg);assert.equal(calls,3);
  await ctx.db.query('DELETE FROM amocrm_channels');
  assert.equal((await app.inject({method:'GET',url:url.pathname+url.search})).statusCode,404);
  assert.equal(calls,3,'a revoked channel must not fetch a Telegram profile');
 }finally{await app.close();await ctx.close();}
});
