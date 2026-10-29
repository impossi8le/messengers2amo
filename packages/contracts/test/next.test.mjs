import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
const base=JSON.parse(readFileSync(new URL('../schema/v1.json',import.meta.url)));
const extensionPath=new URL('../schema/v2.json',import.meta.url);
const extended=existsSync(extensionPath)?JSON.parse(readFileSync(extensionPath)):null;
const ajv=new Ajv2020({strict:true,allErrors:true});addFormats(ajv);ajv.addSchema(base);
if(extended)ajv.addSchema(extended);
const valid=(name,value)=>extended?.$defs?.[name]?ajv.compile({$ref:extended.$id+'#/$defs/'+name})(value):false;
const at='2026-10-21T12:00:00Z';
const envelope=(kind,payload)=>({schemaVersion:2,eventId:'evt-1',connectionId:'conn-1',bindingEpoch:1,providerEventKey:'provider-key-1',occurredAt:at,receivedAt:at,kind,payload});
const native={conversationId:'conv-1',messageId:'message-1',providerMessageId:'provider-1',contentVersion:1,content:{kind:'text',text:'Synthetic reply'},authorKind:'unknown',coverage:'unconfirmed'};
const receipt={conversationId:'conv-1',messageId:'message-1',providerMessageId:'provider-1',operationId:null,attemptId:null,observedAt:at,evidenceKey:'evidence-1'};
test('Published v1 definitions remain byte-equivalent for compatibility',()=>{
 const expected=JSON.parse(readFileSync(new URL('./fixtures/v1-definition-hashes.json',import.meta.url)));
 for(const [name,hash]of Object.entries(expected))assert.equal(createHash('sha256').update(JSON.stringify(base.$defs[name])).digest('hex'),hash,name);
});
test('Native outbound is a distinct v2 fact and cannot fabricate attention coverage',()=>{
 assert.equal(valid('EventEnvelope',envelope('message.outbound_observed',native)),true);
 assert.equal(valid('EventEnvelope',envelope('message.outbound_observed',{...native,coverage:'confirmed'})),false);
 assert.equal(valid('EventEnvelope',envelope('message.outbound_observed',{...native,obligationId:'ob-1'})),false);
 assert.equal(valid('EventEnvelope',{...envelope('message.outbound_observed',native),schemaVersion:1}),false);
});
test('Delivery and read facts are distinct and retain message and attempt correlation',()=>{
 for(const kind of ['message.delivery_observed','message.read_observed']){
  assert.equal(valid('EventEnvelope',envelope(kind,{...receipt,status:kind==='message.delivery_observed'?'delivered':'read'})),true,kind);
  const missing={...receipt,status:kind==='message.delivery_observed'?'delivered':'read'};delete missing.messageId;
  assert.equal(valid('EventEnvelope',envelope(kind,missing)),false);
 }
 assert.equal(valid('EventEnvelope',envelope('message.delivery_observed',native)),false);
});
test('Failed delivery is explicit and locally sent receipts identify their attempt',()=>{
 assert.equal(valid('EventEnvelope',envelope('message.delivery_observed',{...receipt,status:'failed'})),true);
 assert.equal(valid('EventEnvelope',envelope('message.read_observed',{...receipt,status:'failed'})),false);
 assert.equal(valid('EventEnvelope',envelope('message.delivery_observed',{...receipt,status:'delivered',operationId:'operation-1',attemptId:null})),false);
 assert.equal(valid('EventEnvelope',envelope('message.delivery_observed',{...receipt,status:'delivered',operationId:'operation-1',attemptId:'attempt-1'})),true);
});
test('Connection projections distinguish lifecycle/health and never expose credential values',()=>{
 const connection={channelMode:'telegram_bot',capabilities:Object.fromEntries(['textReply','mediaReply','readReceipts','deliveryReceipts','messageEditing','messageDeletion'].map(k=>[k,'unknown'])),id:'conn-1',state:'auth_required',version:3,bindingEpoch:1,credentialsVersion:2,ingressEnabled:false,sendEnabled:false,health:{checkedAt:at,lastInboundAt:null,lastSuccessAt:null,errorCode:'AUTH_REQUIRED'}};
 assert.equal(valid('ConnectionProjection',connection),true);
 assert.equal(valid('ConnectionProjection',{...connection,token:'canary-secret'}),false);
 assert.equal(valid('ConnectionProjection',{...connection,state:'online'}),false);
 const command={idempotencyKey:'request-1',expectedVersion:3,desiredState:'paused'};
 assert.equal(valid('ConnectionLifecycleRequest',command),true);
 assert.equal(valid('ConnectionLifecycleRequest',{...command,credential:'canary-secret'}),false);
 const setup={idempotencyKey:'request-1',channelMode:'telegram_bot',credentialRef:'credref_internal-1'};
 assert.equal(valid('ConnectionSetupRequest',setup),true);
 assert.equal(valid('ConnectionSetupRequest',{...setup,credentialRef:'https://host.test/?token=secret'}),false);
});
test('CRM command needs stable binding and cannot claim actor or snapshot coverage',()=>{
 const ingress={crmEventId:'crm-event-1',crmBindingId:'binding-1',idempotencyKey:'request-1',text:'Synthetic reply',coverage:'unconfirmed'};
 assert.equal(valid('CrmOutboundCommand',ingress),true);
 assert.equal(valid('CrmOutboundCommand',{...ingress,actor:'admin'}),false);
 assert.equal(valid('CrmOutboundCommand',{...ingress,coverage:'confirmed'}),false);
 const binding={id:'binding-1',conversationId:'conv-1',crmAccountId:'crm-account-1',contactId:'contact-1',leadId:null,chatId:'crm-chat-1',version:1,state:'bound'};
 assert.equal(valid('CrmBinding',binding),true);
 assert.equal(valid('CrmBinding',{...binding,conversationId:''}),false);
});
test('Media contracts bind generated private resources without public provider URLs',()=>{
 const upload={idempotencyKey:'request-1',displayName:'test.txt',mimeType:'text/plain',sizeBytes:12};
 assert.equal(valid('MediaUploadRequest',upload),true);
 assert.equal(valid('MediaUploadRequest',{...upload,sizeBytes:-1}),false);
 assert.equal(valid('MediaUploadRequest',{...upload,storageKey:'../../secret'}),false);
 const grant={mediaId:'media-1',expiresAt:at,downloadPath:'/api/v2/media/media-1/content'};
 assert.equal(valid('MediaAccessGrant',grant),true);
 assert.equal(valid('MediaAccessGrant',{...grant,downloadPath:'https://provider.test/?token=secret'}),false);
});
test('Staff capacity is an explicit projection, never a promise of successful claim',()=>{
 const staff={id:'staff-1',availability:'available',departmentIds:['dept-1'],capacity:3,activeCount:1,version:1};
 assert.equal(valid('StaffAvailability',staff),true);
 assert.equal(valid('StaffAvailability',{...staff,capacity:-1}),false);
 assert.equal(valid('StaffAvailability',{...staff,departmentIds:['dept-1','dept-1']}),false);
});
test('Notification hints carry versions and resync semantics without message content',()=>{
 const hint={schemaVersion:2,notificationId:'notice-1',kind:'work_item.changed',workItemId:'work-1',resourceVersion:3,cursor:'cursor-1',resyncRequired:false};
 assert.equal(valid('Notification',hint),true);
 assert.equal(valid('Notification',{...hint,text:'private-message'}),false);
 assert.equal(valid('Notification',{...hint,resourceVersion:-1}),false);
});
test('HTTP v2 mapping covers minimal project boundaries and every ref resolves',()=>{
 const apiPath=new URL('../schema/api.v2.json',import.meta.url);
 assert.ok(existsSync(apiPath),'v2 route map is implemented');
 const api=JSON.parse(readFileSync(apiPath));
 assert.equal(api.openapi,'3.1.1');
 for(const path of ['/api/v2/operator/work-items','/api/v2/operator/connections/{id}/health','/api/v2/operator/connections/{id}/lifecycle','/api/v2/operator/connections','/api/v2/internal/crm/outbound','/api/v2/internal/crm/bindings','/api/v2/operator/media/uploads','/api/v2/operator/media/{id}/access','/api/v2/operator/staff/availability','/api/v2/operator/notifications'])assert.ok(api.paths[path],path);
 const visit=value=>{if(!value||typeof value!=='object')return;if(value.$ref){const parts=value.$ref.split('#/$defs/');assert.ok(['v1.json','v2.json'].includes(parts[0]),value.$ref);assert.ok((parts[0]==='v1.json'?base:extended).$defs[parts[1]],value.$ref);}Object.values(value).forEach(visit);};visit(api);
});

test('Native attachment observations use the same content DTO as read history',()=>{
 assert.equal(valid('EventEnvelope',envelope('message.outbound_observed',{...native,content:{kind:'attachment',mediaId:'media-1',caption:''}})),true);
 assert.equal(valid('EventEnvelope',envelope('message.outbound_observed',{...native,text:'unstructured duplicate'})),false);
});
test('One attachment operation has one externally correlatable effect',()=>{
 const command={idempotencyKey:'key-1',snapshotId:'snap-1',expectedAssignmentVersion:1,selectedObligations:[],mediaIds:['media-1'],caption:'',deadline:at};
 assert.equal(valid('AttachmentReplyRequest',command),true);
 assert.equal(valid('AttachmentReplyRequest',{...command,mediaIds:['media-1','media-2']}),false);
 assert.equal(valid('AttachmentReplyRequest',{...command,recipient:'injected'}),false);
});
test('Every v2 DTO compiles strictly and internal CRM endpoints require adapter identity',()=>{
 assert.ok(extended);
 for(const name of Object.keys(extended.$defs))assert.doesNotThrow(()=>ajv.compile({$ref:extended.$id+'#/$defs/'+name}),name);
 const api=JSON.parse(readFileSync(new URL('../schema/api.v2.json',import.meta.url)));
 for(const path of ['/api/v2/internal/crm/outbound','/api/v2/internal/crm/bindings'])for(const op of Object.values(api.paths[path]))assert.deepEqual(op.security,[{adapterService:[]}]);
});

test('Connection read projections always expose channel mode and verified capability states',()=>{
 const projection={id:'conn-1',channelMode:'telegram_bot',capabilities:Object.fromEntries(['textReply','mediaReply','readReceipts','deliveryReceipts','messageEditing','messageDeletion'].map(k=>[k,'unknown'])),state:'setup',version:0,bindingEpoch:0,credentialsVersion:0,ingressEnabled:false,sendEnabled:false,health:{checkedAt:at,lastInboundAt:null,lastSuccessAt:null,errorCode:null}};
 assert.equal(valid('ConnectionProjection',projection),true);
 for(const field of ['channelMode','capabilities']){const copy={...projection};delete copy[field];assert.equal(valid('ConnectionProjection',copy),false,field);}
});
test('CRM creation uncertainty is stored without invented contact/chat identifiers',()=>{
 const uncertain={id:'binding-1',conversationId:'conv-1',crmAccountId:'crm-account-1',contactId:null,leadId:null,chatId:null,version:1,state:'creation_unknown'};
 assert.equal(valid('CrmBinding',uncertain),true);
 assert.equal(valid('CrmBinding',{...uncertain,state:'pending'}),true);
 assert.equal(valid('CrmBinding',{...uncertain,state:'bound'}),false);
 const {state,...missingState}=uncertain;assert.equal(valid('CrmBinding',missingState),false);
 assert.equal(valid('CrmBinding',{...uncertain,state:'bound',contactId:'contact-1',chatId:'chat-1'}),true);
});
test('HTTP v2 map covers registered workshop, CRM workflow, auth, OAuth and webhook routes',()=>{
 const api=JSON.parse(readFileSync(new URL('../schema/api.v2.json',import.meta.url)));
 const expected={
  '/api/v2/operator/workshops':['get','post'],
  '/api/v2/operator/workshops/{id}/routes':['get','post'],
  '/api/v2/operator/workshops/{id}/groups':['get','post'],
  '/api/v2/operator/workshops/{id}/permissions':['get'],
  '/api/v2/operator/crm/policy':['get','post'],
  '/api/v2/operator/crm/conflicts':['get'],
  '/api/v2/operator/crm/resync':['post'],
  '/api/v2/operator/crm/diagnostics':['get'],
  '/api/v2/auth/login':['post'],
  '/api/v2/auth/logout':['post'],
  '/api/v2/integrations/amocrm/oauth/authorize':['get'],
  '/api/v2/integrations/amocrm/oauth/callback':['get'],
  '/api/v2/integrations/amocrm/oauth/revoke':['post'],
  '/webhooks/telegram/{connectionId}':['post'],
  '/webhooks/whatsapp/{connectionId}':['get','post'],
  '/webhooks/max/{connectionId}':['post'],
  '/webhooks/vk/{connectionId}':['get','post'],
  '/webhooks/amocrm/{scopeId}':['post']
 };
 for(const [path,methods] of Object.entries(expected))for(const method of methods)assert.ok(api.paths[path]?.[method],`${method} ${path}`);
 for(const path of Object.keys(expected).filter(path=>path.startsWith('/webhooks/')))for(const op of Object.values(api.paths[path]))assert.deepEqual(op.security,[],`${path} must not require a staff session`);
 for(const path of ['/api/v2/auth/login','/api/v2/integrations/amocrm/oauth/callback'])for(const op of Object.values(api.paths[path]))assert.deepEqual(op.security,[],`${path} must not require a staff session`);
});
