import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCrmOwnerResolver } from '../src/integrations/amocrm/directory-owner.ts';
const input={companyId:'c1',accountId:'acc1',conversationId:'conv1',contactId:'77',leadId:null};
test('owner authorization finds the newest current deal after Unsorted acceptance, without assigning anyone',async()=>{
  const calls:unknown[]=[];
  const resolve=createCrmOwnerResolver({findOpenLeads:async(scope)=>{calls.push(scope);return[{id:'10',updatedAt:'2026-10-01T00:00:00Z'},{id:'20',updatedAt:'2026-10-26T00:00:00Z'}];},
    readResponsible:async(scope)=>{calls.push(scope);return {contactOwnerRef:'integration-admin',lead:{id:scope.leadId!,responsibleUserId:'manager1'}};}});
  assert.equal(await resolve(input),'manager1');
  assert.equal(calls.length,2);assert.equal((calls[1] as {leadId:string}).leadId,'20');
});
test('an unassigned Unsorted request cannot inherit the integration admins contact ownership',async()=>{
  let reads=0;const resolve=createCrmOwnerResolver({findOpenLeads:async()=>[],readResponsible:async()=>{reads++;return{contactOwnerRef:'admin',lead:null};}});
  assert.equal(await resolve(input),null);assert.equal(reads,0);
});
test('a bound deal is read directly, and a missing/mismatching lead cannot authorize a manager',async()=>{
  let searches=0;
  const resolve=createCrmOwnerResolver({findOpenLeads:async()=>{searches++;return[];},readResponsible:async()=>({contactOwnerRef:'admin',lead:{id:'other',responsibleUserId:'manager1'}})});
  assert.equal(await resolve({...input,leadId:'20'}),null);assert.equal(searches,0);
});
