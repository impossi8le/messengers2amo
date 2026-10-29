import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTestDb} from './helpers/db.ts';
import {seedSendContext} from './helpers/telegram.ts';
import {acceptSendCommand,runSendWorker} from '../src/telegram/send.ts';

test('outbound off and a mismatched pilot leave queued sends and attempts untouched',async()=>{
 const {db,close}=await createTestDb();
 try{
  const ctx=await seedSendContext(db);
  await acceptSendCommand(db,ctx,{commandType:'reply',idempotencyKey:'pilot-only',actorId:'staff-1',workItemId:'work-1',conversationId:'conv-1',content:{text:'pilot'},deadlineSeconds:3600});
  let calls=0;
  const base={companyId:ctx.companyId,connectionId:ctx.connectionId,owner:'pilot-test',leaseMs:30000,transport:{sendMessage:async()=>{calls++;return {outcome:'sent' as const,providerMessageId:'100'};}}};
  const pilot={mode:'pilot' as const,companyId:ctx.companyId,connectionId:ctx.connectionId,bindingEpoch:ctx.bindingEpoch,conversationId:'conv-1',activatedAfter:'2024-01-01T00:00:00.000Z'};
  for(const outboundPolicy of [{mode:'off' as const},{...pilot,conversationId:'other-conversation'},{...pilot,bindingEpoch:ctx.bindingEpoch+1},{...pilot,activatedAfter:'2099-01-01T00:00:00.000Z'}]){
   const result=await runSendWorker(db,{...base,outboundPolicy});
   assert.equal(result.claimed,0);
  }
  assert.equal(calls,0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM send_attempts')).rows[0].n,0);
  assert.deepEqual((await db.query('SELECT state,attempt_count FROM outbox_jobs')).rows,[{state:'pending',attempt_count:0}]);
  const sent=await runSendWorker(db,{...base,outboundPolicy:pilot});
  assert.equal(sent.sent,1);assert.equal(calls,1);
 }finally{await close();}
});

test('a pilot skips older backlog without starving a new eligible send',async()=>{
 const {db,close}=await createTestDb();
 try{
  const ctx=await seedSendContext(db);
  const command={commandType:'reply',actorId:'staff-1',workItemId:'work-1',conversationId:'conv-1',content:{text:'pilot'},deadlineSeconds:3600};
  const old=await acceptSendCommand(db,ctx,{...command,idempotencyKey:'old-backlog'});
  await db.query("UPDATE send_operations SET created_at='2020-01-01' WHERE id=$1",[old.operationId]);
  await db.query("UPDATE outbox_jobs SET created_at='2020-01-01',available_at='2020-01-01' WHERE payload->>'operationId'=$1",[old.operationId]);
  const fresh=await acceptSendCommand(db,ctx,{...command,idempotencyKey:'fresh-pilot'});
  const outboundPolicy={mode:'pilot' as const,companyId:ctx.companyId,connectionId:ctx.connectionId,bindingEpoch:ctx.bindingEpoch,conversationId:'conv-1',activatedAfter:'2024-01-01T00:00:00.000Z'};
  const result=await runSendWorker(db,{companyId:ctx.companyId,connectionId:ctx.connectionId,owner:'pilot-test',leaseMs:30000,outboundPolicy,transport:{sendMessage:async()=>({outcome:'sent',providerMessageId:'101'})}});
  assert.equal(result.sent,1);
  const rows=(await db.query('SELECT id,state FROM send_operations ORDER BY created_at')).rows;
  assert.deepEqual(rows,[{id:old.operationId,state:'accepted'},{id:fresh.operationId,state:'sent'}]);
 }finally{await close();}
});
