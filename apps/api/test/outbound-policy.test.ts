import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readOutboundPolicy,outboundScopeAllowed} from '../src/platform/outbound-policy.ts';

test('master switch off wins and enabled sends require an explicit mode',()=>{
 assert.deepEqual(readOutboundPolicy({OUTBOUND_MODE:'all'}),{mode:'off'});
 assert.deepEqual(readOutboundPolicy({OUTBOUND_ENABLED:'false',OUTBOUND_MODE:'pilot'}),{mode:'off'});
 assert.throws(()=>readOutboundPolicy({OUTBOUND_ENABLED:'true'}),/outbound_mode_required/);
 assert.throws(()=>readOutboundPolicy({OUTBOUND_ENABLED:'true',OUTBOUND_MODE:'typo'}),/outbound_mode_required/);
 assert.deepEqual(readOutboundPolicy({OUTBOUND_ENABLED:'true',OUTBOUND_MODE:'all'}),{mode:'all'});
});

test('pilot requires a complete exact scope and a timestamp with timezone',()=>{
 const env={OUTBOUND_ENABLED:'true',OUTBOUND_MODE:'pilot',OUTBOUND_PILOT_COMPANY_ID:'c',OUTBOUND_PILOT_CONNECTION_ID:'n',
  OUTBOUND_PILOT_BINDING_EPOCH:'0',OUTBOUND_PILOT_CONVERSATION_ID:'v',OUTBOUND_PILOT_ACTIVATED_AFTER:'2026-10-28T15:00:00Z'};
 const policy=readOutboundPolicy(env);
 assert.equal(policy.mode,'pilot');
 for(const [name,value] of [['OUTBOUND_PILOT_BINDING_EPOCH','-1'],['OUTBOUND_PILOT_BINDING_EPOCH','1.5'],
  ['OUTBOUND_PILOT_BINDING_EPOCH','9007199254740992'],['OUTBOUND_PILOT_CONNECTION_ID',''],
  ['OUTBOUND_PILOT_ACTIVATED_AFTER','2026-10-28'],['OUTBOUND_PILOT_ACTIVATED_AFTER','not-a-date']]){
  assert.throws(()=>readOutboundPolicy({...env,[name!]:value}),/outbound_pilot_scope_invalid/);
 }
 const scope={companyId:'c',connectionId:'n',bindingEpoch:0,conversationId:'v',createdAt:'2026-10-28T15:00:00Z'};
 assert.equal(outboundScopeAllowed(policy,scope),true);
 for(const changed of [{companyId:'other'},{connectionId:'other'},{bindingEpoch:1},{conversationId:'other'},
  {createdAt:'2026-10-28T14:59:59Z'},{createdAt:'invalid'}])assert.equal(outboundScopeAllowed(policy,{...scope,...changed}),false);
});
