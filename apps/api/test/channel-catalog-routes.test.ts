import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTestApp,cookieFromResponse} from './helpers/app.ts';
import {seedCompany} from './helpers/seed.ts';

test('catalog requires an admin session and returns only preparation metadata',async()=>{
 const {app,db,close}=await createTestApp();
 try{
  await seedCompany(db,{companyId:'catalog-company',staff:[{id:'admin',role:'admin',password:'catalog-fixture-password'},
   {id:'manager',role:'manage',password:'catalog-fixture-password'}]});
  const url='/api/v2/operator/channels/catalog';
  assert.equal((await app.inject({method:'GET',url})).statusCode,401);
  const login=async(staffId:string)=>cookieFromResponse(await app.inject({method:'POST',url:'/api/v2/auth/login',
   payload:{companyId:'catalog-company',staffId,password:'catalog-fixture-password'}}));
  assert.equal((await app.inject({method:'GET',url,headers:{cookie:await login('manager')}})).statusCode,403);
  const response=await app.inject({method:'GET',url,headers:{cookie:await login('admin')}});
  assert.equal(response.statusCode,200,response.body);
  const data=response.json();assert.equal(data.schemaVersion,1);
  assert.ok(data.items.length>=25);
  assert.equal(data.items.find((x:{id:string})=>x.id==='telegram_bot').setupAvailable,true);
  assert.equal(data.items.find((x:{id:string})=>x.id==='signal_personal').setupAvailable,false);
  assert.equal(response.body.includes('catalog-fixture-password'),false);
  assert.equal(response.body.includes('accessToken'),false);
 }finally{await close();}
});
