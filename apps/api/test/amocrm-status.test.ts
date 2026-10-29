import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { seedCompany,seedConnection } from './helpers/seed.ts';
import { buildTestApp,cookieFromResponse } from './helpers/app.ts';

test('OAuth status is account-based, tenant/workshop scoped and excludes all credentials and audit details',async()=>{
  const {db,schema,close}=await createTestDb();
  const app=await buildTestApp({db,schema});
  try {
    await seedCompany(db,{companyId:'c1',workshops:['w1','w2'],staff:[
      {id:'admin',role:'admin',password:'test-password'},
      {id:'reader',role:'read',password:'test-password',workshopId:'w1'},
    ]});
    await seedCompany(db,{companyId:'c2',staff:[]});
    await seedConnection(db,{companyId:'c1',id:'con1',workshopId:'w1',ownerId:'admin'});
    await seedConnection(db,{companyId:'c1',id:'con2',workshopId:'w2',ownerId:'admin'});
    await db.query("UPDATE crm_accounts SET state='active',credential_ref='synthetic-sensitive-envelope',refresh_failure_count=2 WHERE id='acc_con1'");
    await db.query("UPDATE crm_accounts SET state='revoked',credential_ref='another-envelope' WHERE id='acc_con2'");
    await db.query("INSERT INTO crm_accounts(company_id,id,state,credential_ref) VALUES ('c2','foreign','active','foreign-secret'),('c1','no-credential','active',NULL)");
    await db.query("INSERT INTO amocrm_oauth_audit(company_id,id,account_id,event,detail,recorded_at) VALUES ('c1','audit1','acc_con1','authorized','must-not-be-exposed','2026-10-26T10:00:00Z')");
    assert.equal((await app.inject({method:'GET',url:'/api/v2/operator/amocrm/status'})).statusCode,401);
    const login=async(staffId:string)=>cookieFromResponse(await app.inject({method:'POST',url:'/api/v2/auth/login',payload:{companyId:'c1',staffId,password:'test-password'}}));
    const read=async(cookie:string)=>app.inject({method:'GET',url:'/api/v2/operator/amocrm/status',headers:{cookie}});
    const admin=await read(await login('admin'));
    assert.equal(admin.statusCode,200);
    assert.equal(admin.headers['cache-control'],'no-store');
    const session=await app.inject({method:'GET',url:'/api/v2/auth/session',headers:{cookie:await login('admin')}});
    assert.deepEqual(session.json(),{staffId:'admin',companyId:'c1',role:'admin',workshopId:null});
    assert.equal(session.headers['cache-control'],'no-store');
    assert.equal((await app.inject({method:'GET',url:'/api/v2/auth/session'})).statusCode,401);
    assert.equal(admin.json().authorizationEnabled,false);
    assert.deepEqual(admin.json().accounts.map((a:{id:string;state:string})=>[a.id,a.state]),[
      ['acc_con1','active'],['acc_con2','revoked'],['no-credential','setup'],
    ]);
    assert.equal(admin.json().accounts[0].lastAuthorizedAt,'2026-10-26T10:00:00.000Z');
    assert.equal(admin.json().accounts[0].refreshFailureCount,2);
    assert.ok(!/envelope|foreign|must-not-be-exposed|credential_ref/.test(admin.body));
    const reader=await read(await login('reader'));
    assert.deepEqual(reader.json().accounts.map((a:{id:string})=>a.id),['acc_con1']);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM crm_bindings')).rows[0].n,0,'no dialog binding is needed to show active OAuth');
  } finally {await app.close();await close();}
});
