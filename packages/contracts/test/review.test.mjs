import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
const schema=JSON.parse(readFileSync(new URL('../schema/v1.json',import.meta.url)));
const ajv=new Ajv2020({strict:true,allErrors:true});addFormats(ajv);ajv.addSchema(schema);
const validate=(name,value)=>ajv.compile({$ref:schema.$id+'#/$defs/'+name})(value);
test('WorkItem supports canonical domain states and rejects invented pending',()=>{
 const base={id:'work-1',conversationId:'conv-1',assignmentVersion:1,owner:null};
 for(const state of ['queued','assigned','in_progress','waiting_customer','resolved','cancelled']) assert.equal(validate('WorkItem',{...base,state}),true,state);
 assert.equal(validate('WorkItem',{...base,state:'pending'}),false);
});
test('Reply can deliberately cover no obligations; whitespace body cannot be sent',()=>{
 const reply={idempotencyKey:'request-1',snapshotId:'snap-1',expectedAssignmentVersion:1,selectedObligations:[],text:'Additional detail',deadline:'2026-10-21T12:00:00Z'};
 assert.equal(validate('SendReplyRequest',reply),true);
 assert.equal(validate('SendReplyRequest',{...reply,text:'  '}),false);
});
test('Duplicate coverage references cannot silently expand a snapshot',()=>{
 const snapshot={id:'snap-1',workItemId:'work-1',conversationId:'conv-1',bindingEpoch:1,assignmentVersion:1,obligationRefs:[{obligationId:'ob-1',contentVersion:2},{obligationId:'ob-1',contentVersion:2}]};
 assert.equal(validate('ComposeSnapshot',snapshot),false);
});
test('Sanitized diagnostics allow correlation and outcome without content or credentials',()=>{
 const event={schemaVersion:1,timestamp:'2026-10-21T12:00:00Z',level:'warn',event:'send.result_recorded',outcome:'unknown',errorCode:'UPSTREAM_TIMEOUT',correlation:{requestId:'req-1',operationId:'op-1',eventId:'evt-1'}};
 assert.equal(validate('DiagnosticEvent',event),true);
 for(const field of ['text','token','authorization','errorMessage','rawPayload','customerPhone']) assert.equal(validate('DiagnosticEvent',{...event,[field]:'secret-or-message'}),false,field);
 assert.equal(validate('DiagnosticEvent',{...event,correlation:{...event.correlation,eventId:'person@example.test'}}),false);
 assert.equal(validate('DiagnosticEvent',{...event,errorCode:'provider said secret text'}),false);
});
test('Epoch and secret version are separate and secrets cannot enter connection projection',()=>{
 const caps=Object.fromEntries(['textReply','mediaReply','readReceipts','deliveryReceipts','messageEditing','messageDeletion'].map(x=>[x,'unknown']));
 const connection={id:'conn-1',channelMode:'telegram_bot',bindingEpoch:2,credentialsVersion:9,capabilities:caps};
 assert.equal(validate('Connection',connection),true);
 assert.equal(validate('Connection',{...connection,token:'do-not-log'}),false);
 assert.equal(validate('Connection',{...connection,bindingEpoch:-1}),false);
});
test('API route map covers operator read and command contracts, all refs resolve',()=>{
 const api=JSON.parse(readFileSync(new URL('../schema/api.v1.json',import.meta.url)));
 for(const path of ['/api/v1/operator/work-items','/api/v1/operator/work-items/{id}','/api/v1/operator/work-items/{id}/messages','/api/v1/operator/work-items/{id}/snapshot','/api/v1/operator/work-items/{id}/reply','/api/v1/operator/work-items/{id}/claim','/api/v1/operator/work-items/{id}/transfer','/api/v1/operator/work-items/{id}/manual-coverage','/api/v1/operator/work-items/{id}/resolve','/api/v1/operator/send-operations/{id}','/api/v1/operator/connections']) assert.ok(api.paths[path],path);
 const walk=x=>{if(!x||typeof x!=='object')return;if(x.$ref){const match=x.$ref.match(/^v1.json#\/\$defs\/(.+)$/);assert.ok(match,x.$ref);assert.ok(schema.$defs[match[1]],x.$ref);}Object.values(x).forEach(walk);};walk(api);
});

test('Diagnostic duration permits finite nonnegative milliseconds, never negative or text',()=>{
 const event={schemaVersion:1,timestamp:'2026-10-21T12:00:00Z',level:'info',event:'request.completed',outcome:'succeeded',errorCode:null,correlation:{requestId:'req-1',operationId:null,eventId:null}};
 assert.equal(validate('DiagnosticEvent',{...event,durationMs:12.5}),true);
 for(const durationMs of [-1,'12',Infinity]) assert.equal(validate('DiagnosticEvent',{...event,durationMs}),false);
});
test('Only externally confirmed sent can carry confirmed attention coverage',()=>{
 const operation={id:'op-1',state:'sent',providerMessageId:'provider-1',coverage:'confirmed',selectedRefs:[{obligationId:'ob-1',contentVersion:1}],deliveryEvidence:null,readEvidence:null};
 assert.equal(validate('SendOperation',operation),true);
 for(const state of ['accepted','queued','dispatching','unknown','failed','cancelled']) assert.equal(validate('SendOperation',{...operation,state}),false,state);
});

test('Registry distinguishes account modes without promising unverified production capabilities',()=>{
 const registry=JSON.parse(readFileSync(new URL('../schema/capabilities.v1.json',import.meta.url)));
 assert.equal(validate('ChannelRegistry',registry),true);
 assert.deepEqual(registry.profiles.map(x=>x.channelMode).sort(),['telegram_bot','telegram_personal','telegram_business','whatsapp_cloud','whatsapp_qr','max_bot','vk_community'].sort());
 for(const profile of registry.profiles) for(const [capability,state] of Object.entries(profile.capabilities)) assert.equal(state,profile.channelMode==='telegram_bot'&&capability==='textReply'?'supported':'unknown');
});
test('Historical events require trusted import provenance shape; live events require attention',()=>{
 const event={schemaVersion:1,eventId:'evt-1',connectionId:'conn-1',bindingEpoch:1,providerEventKey:'provider-1',occurredAt:'2026-10-21T10:00:00Z',receivedAt:'2026-10-21T10:01:00Z',kind:'message.received',payload:{conversationId:'conv-1',externalChatId:'chat-1',providerMessageId:'msg-1',messageId:'internal-msg-1',content:{kind:'text',text:'test'},obligationId:null,contentVersion:1,sourceMode:'historical',importJobId:'import-1'}};
 assert.equal(validate('EventEnvelope',event),true);
 assert.equal(validate('EventEnvelope',{...event,payload:{...event.payload,importJobId:null}}),false);
 assert.equal(validate('EventEnvelope',{...event,payload:{...event.payload,sourceMode:'live',importJobId:null}}),false);
 assert.equal(validate('EventEnvelope',{...event,payload:{...event.payload,sourceMode:'live',importJobId:null,obligationId:'ob-1'}}),true);
 assert.equal(validate('EventEnvelope',{...event,schemaVersion:2}),false);
 assert.equal(validate('EventEnvelope',{...event,kind:'invented.event'}),false);
 assert.equal(validate('EventEnvelope',{...event,receivedAt:'not-a-timestamp'}),false);
});

test('Attention read projection identifies the exact message behind an obligation',()=>{
 const obligation={id:'ob-1',messageId:'msg-1',contentVersion:2,attentionSeq:3};
 assert.equal(validate('Obligation',obligation),true);
 const {messageId,...withoutMessage}=obligation;
 assert.equal(validate('Obligation',withoutMessage),false);
 const detail={workItem:{id:'work-1',conversationId:'conv-1',assignmentVersion:1,state:'queued',owner:null},conversation:{id:'conv-1',connectionId:'conn-1',externalChatId:'chat-1',bindingEpoch:1},outstandingObligations:[obligation]};
 assert.equal(validate('WorkItemDetail',detail),true);
 assert.equal(validate('WorkItemDetail',{...detail,outstandingObligations:[withoutMessage]}),false);
});
