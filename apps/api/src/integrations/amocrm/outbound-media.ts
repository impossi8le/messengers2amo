import {createHash} from 'node:crypto';
import type {Db} from '../../platform/db.ts';
import type {CrmFilesClient} from './files-client.ts';
import type {AmoDriveReader} from './drive-reader.ts';
import {normalizeMimeType,sanitizeFileName} from '../../media/policy.ts';
import {sniffContent} from '../../media/sniff.ts';

export type OutboundMediaReference={url:string;fileName:string;mimeType:string;sizeBytes:number|null;
 type:'photo'|'document'|'video'|'audio'|'voice'|'animation'|'sticker'|'video_note'};
export type OutboundFile={bytes:Uint8Array;fileName:string;mimeType:string};
type Asset={state:string;account_id:string;lead_id:string;file_uuid:string|null;original_name:string;mime_type:string;byte_size:string|null;sha256:string|null};
const DRIVE=/^drive(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.amocrm\.ru$/;
const MAX_BYTES=20*1024*1024;

export function isCrmAttachmentUrl(raw: string): boolean {
 try {
  const url=new URL(raw);
  return raw.length<=8192&&url.protocol==='https:'&&!url.port&&!url.username&&!url.password&&!url.hash&&
   (DRIVE.test(url.hostname)||url.hostname==='amojo.amocrm.ru'||url.hostname==='hb.ru-msk.vkcloud-storage.ru');
 } catch { return false; }
}

export class OutboundMediaError extends Error {
 readonly code:string;
 constructor(code='outbound_media_unavailable'){super(code);this.name='OutboundMediaError';this.code=code;}
}

/** Fetches only authenticated CRM attachment origins, never an arbitrary manager URL. */
export async function downloadCrmAttachment(input:{url:string;expectedBytes:number|null;getAccessToken:()=>Promise<string>;
 fetch:typeof fetch;timeoutMs?:number;allowedHosts?:readonly string[]}):Promise<Uint8Array>{
 let url:URL;try{url=new URL(input.url);}catch{throw new OutboundMediaError('outbound_media_url_invalid');}
 const cdn=new Set(input.allowedHosts??['amojo.amocrm.ru','hb.ru-msk.vkcloud-storage.ru']);
 const allowed=(candidate:URL)=>candidate.protocol==='https:'&&!candidate.port&&!candidate.username&&!candidate.password&&!candidate.hash&&
  (DRIVE.test(candidate.hostname)||cdn.has(candidate.hostname));
 if(!allowed(url)||input.url.length>8192||input.expectedBytes!==null&&(!Number.isSafeInteger(input.expectedBytes)||input.expectedBytes<0||input.expectedBytes>MAX_BYTES))throw new OutboundMediaError('outbound_media_url_invalid');
 const controller=new AbortController();let expire!:(error:Error)=>void;
 const deadline=new Promise<never>((_,reject)=>{expire=reject;});
 const timer=setTimeout(()=>{controller.abort();expire(new OutboundMediaError('outbound_media_timeout'));},input.timeoutMs??15000);
 let response:Response|undefined;
 try{
  const token=DRIVE.test(url.hostname)?await Promise.race([input.getAccessToken(),deadline]):null;
  response=await Promise.race([input.fetch(url.toString(),{method:'GET',headers:token?{authorization:`Bearer ${token}`}:{},redirect:'manual',signal:controller.signal}),deadline]);
  if([301,302,303,307,308].includes(response.status)){
   const location=response.headers.get('location');void response.body?.cancel().catch(()=>{});
   if(!location)throw new OutboundMediaError('outbound_media_url_invalid');
   url=new URL(location,url);if(!allowed(url))throw new OutboundMediaError('outbound_media_url_invalid');
   response=await Promise.race([input.fetch(url.toString(),{method:'GET',redirect:'error',signal:controller.signal}),deadline]);
  }
  if(response.status!==200)throw new OutboundMediaError();
  const length=response.headers.get('content-length');
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_BYTES))throw new OutboundMediaError('outbound_media_too_large');
  const reader=response.body?.getReader();if(!reader)throw new OutboundMediaError();
  const parts:Uint8Array[]=[];let size=0;
  try{for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;size+=part.value.byteLength;
   if(size>MAX_BYTES)throw new OutboundMediaError('outbound_media_too_large');parts.push(part.value);}}
  catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  if(input.expectedBytes!==null&&input.expectedBytes!==size)throw new OutboundMediaError('outbound_media_size_mismatch');
  return new Uint8Array(Buffer.concat(parts,size));
 }catch(error){if(error instanceof OutboundMediaError)throw error;throw new OutboundMediaError();}
 finally{clearTimeout(timer);void response?.body?.cancel().catch(()=>{});}
}

export function createOutboundMediaResolver(deps:{db:Db;schema:string;files:CrmFilesClient;reader:AmoDriveReader;
 getAccessToken:(scope:{companyId:string;accountId:string})=>Promise<string>;fetch:typeof fetch;
 resolveLead?:(input:{companyId:string;accountId:string;contactId:string})=>Promise<string|null>;
}): (input:{companyId:string;conversationId:string;operationId:string;media:OutboundMediaReference})=>Promise<OutboundFile>{
 if(!/^[a-z_][a-z0-9_]{0,62}$/.test(deps.schema))throw new Error('INVALID_SCHEMA');
 const q=(name:string)=>`"${deps.schema}"."${name}"`;
 return async input=>{
  const binding=(await deps.db.query<{account_id:string;lead_id:string|null;contact_id:string}>(`SELECT b.account_id,b.lead_id,b.contact_id FROM ${q('send_operations')} o
   JOIN ${q('conversations')} c ON c.company_id=o.company_id AND c.id=o.conversation_id AND c.binding_epoch=o.binding_epoch
   JOIN ${q('connections')} n ON n.company_id=c.company_id AND n.id=c.connection_id AND n.binding_epoch=c.binding_epoch AND n.state IN ('active','degraded') AND n.send_enabled
   JOIN ${q('crm_bindings')} b ON b.company_id=c.company_id AND b.conversation_id=c.id AND b.state='bound'
   JOIN ${q('connection_routes')} r ON r.company_id=c.company_id AND r.connection_id=c.connection_id AND r.crm_account_id=b.account_id
   JOIN ${q('crm_accounts')} a ON a.company_id=b.company_id AND a.id=b.account_id AND a.state='active'
   JOIN ${q('amocrm_channels')} ch ON ch.company_id=c.company_id AND ch.account_id=b.account_id AND ch.connection_id=c.connection_id
     AND ch.binding_epoch=c.binding_epoch AND ch.state='connected'
   WHERE o.company_id=$1 AND o.id=$2 AND o.conversation_id=$3 AND o.state='dispatching'
    AND ${q('channel_crm_import_allowed')}(c.company_id,c.connection_id,c.binding_epoch,c.external_chat_id,c.chat_kind)`,
   [input.companyId,input.operationId,input.conversationId])).rows;
  if(binding.length!==1)throw new OutboundMediaError('outbound_media_scope_denied');
  const scope={companyId:input.companyId,accountId:binding[0]!.account_id};
  const leadId=binding[0]!.lead_id??await deps.resolveLead?.({...scope,contactId:binding[0]!.contact_id});
  if(!leadId||!/^[1-9][0-9]*$/.test(leadId))throw new OutboundMediaError('outbound_media_scope_denied');
  await deps.db.query(`INSERT INTO ${q('amocrm_outbound_files')}(company_id,operation_id,account_id,lead_id,original_name,mime_type)
   VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[input.companyId,input.operationId,scope.accountId,leadId,
    sanitizeFileName(input.media.fileName),normalizeMimeType(input.media.mimeType)??'application/octet-stream']);
  let asset=(await deps.db.query<Asset>(`SELECT * FROM ${q('amocrm_outbound_files')} WHERE company_id=$1 AND operation_id=$2`,[input.companyId,input.operationId])).rows[0]!;
  if(asset.account_id!==scope.accountId||asset.lead_id!==leadId)throw new OutboundMediaError('outbound_media_scope_denied');
  if(asset.state==='uploading'||asset.state==='unknown')throw new OutboundMediaError('outbound_media_upload_unknown');
  if(asset.state==='pending'){
   const bytes=await downloadCrmAttachment({url:input.media.url,expectedBytes:input.media.sizeBytes,getAccessToken:()=>deps.getAccessToken(scope),fetch:deps.fetch});
   if(bytes.byteLength===0||bytes.byteLength>(input.media.type==='photo'?10:20)*1024*1024)throw new OutboundMediaError('outbound_media_too_large');
   const detected=sniffContent(bytes)?.type;
   if(input.media.type==='photo'&&!['image/jpeg','image/png','image/webp'].includes(detected??''))throw new OutboundMediaError('outbound_media_type_invalid');
   const mime=input.media.type==='photo'?detected!:asset.mime_type;
   const sha=createHash('sha256').update(bytes).digest('hex');
   const claimed=await deps.db.query(`UPDATE ${q('amocrm_outbound_files')} SET state='uploading',byte_size=$3,sha256=$4,mime_type=$5,updated_at=now()
    WHERE company_id=$1 AND operation_id=$2 AND state='pending' RETURNING operation_id`,[input.companyId,input.operationId,bytes.byteLength,sha,mime]);
   if(claimed.rowCount!==1)throw new OutboundMediaError('outbound_media_upload_unknown');
   try{
    const result=await deps.files.upload({...scope,fileName:asset.original_name,mimeType:mime,bytes});
    await deps.db.query(`UPDATE ${q('amocrm_outbound_files')} SET state='uploaded',file_uuid=$3,updated_at=now() WHERE company_id=$1 AND operation_id=$2 AND state='uploading'`,
     [input.companyId,input.operationId,result.uuid]);
    asset={...asset,state:'uploaded',file_uuid:result.uuid,byte_size:String(bytes.byteLength),sha256:sha,mime_type:mime};
   }catch{
    await deps.db.query(`UPDATE ${q('amocrm_outbound_files')} SET state='unknown',updated_at=now() WHERE company_id=$1 AND operation_id=$2 AND state='uploading'`,[input.companyId,input.operationId]);
    throw new OutboundMediaError('outbound_media_upload_unknown');
   }
  }
  if(!asset.file_uuid||!asset.sha256||asset.byte_size===null)throw new OutboundMediaError();
  if(asset.state!=='linked'){
   const link={...scope,leadId,fileUuid:asset.file_uuid};
   if(!await deps.files.isLinked(link))await deps.files.link(link);
   if(!await deps.files.isLinked(link))throw new OutboundMediaError('outbound_media_link_unconfirmed');
   await deps.db.query(`UPDATE ${q('amocrm_outbound_files')} SET state='linked',updated_at=now() WHERE company_id=$1 AND operation_id=$2 AND file_uuid=$3`,[input.companyId,input.operationId,asset.file_uuid]);
  }
  return {bytes:await deps.reader.download({...scope,fileUuid:asset.file_uuid,byteSize:Number(asset.byte_size),sha256:asset.sha256}),
   fileName:asset.original_name,mimeType:asset.mime_type};
 };
}
