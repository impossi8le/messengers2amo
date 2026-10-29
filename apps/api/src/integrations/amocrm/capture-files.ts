import type { InboundMessageInput, ProjectionResult } from './sync.ts';
import type { CrmFilesClient } from './files-client.ts';
import type { Db } from '../../platform/db.ts';
import { downloadTelegramMedia, type TelegramMediaReference } from '../../telegram/media.ts';
import { defaultLimits, isAllowedMimeType, normalizeMimeType, sanitizeFileName } from '../../media/policy.ts';
import { checkContentType } from '../../media/sniff.ts';
import { sha256Hex } from '../../media/storage.ts';
import { raiseAlert } from '../../channels/alerts.ts';
import { logEvent } from '../../platform/logger.ts';

type Message = {id:string;content:Record<string,unknown>;connection_id:string;credential_ref:string|null;allowed:boolean};
type Delivery = {lead_id:string;file_uuid:string|null;state:string;byte_size?:string;mime_type?:string};

/** Explicit REST capture path: files belong to the actual bound lead, without
 * claiming to have created a Chats message or an S3 archive. */
export function createCaptureFileProjection(deps: {
  db:Db; schema:string;
  projectMessage:(input:InboundMessageInput)=>Promise<ProjectionResult>;
  ensureBinding?:(input:InboundMessageInput)=>Promise<ProjectionResult>;
  fileUrl?:(input:{companyId:string;accountId:string;messageId:string})=>string;
  files:CrmFilesClient;
  resolveBotToken:(input:{companyId:string;connectionId:string;credentialRef:string|null})=>string|null;
  fetch?:typeof fetch;
}) {
 if (!/^[a-z_][a-z0-9_]{0,62}$/.test(deps.schema)) throw new Error('INVALID_SCHEMA');
 const q=(name:string)=>`"${deps.schema}"."${name}"`;
 const load=async(input:InboundMessageInput)=>{
  const rows=await deps.db.query<Message>(
   `SELECT m.id,v.content,c.connection_id,n.credential_ref,
      ${q('channel_crm_import_allowed')}(c.company_id,c.connection_id,c.binding_epoch,c.external_chat_id,c.chat_kind) AS allowed
    FROM ${q('messages')} m
    JOIN ${q('message_versions')} v ON v.company_id=m.company_id AND v.message_id=m.id AND v.content_version=m.current_content_version
    JOIN ${q('conversations')} c ON c.company_id=m.company_id AND c.id=m.conversation_id
    JOIN ${q('connections')} n ON n.company_id=c.company_id AND n.id=c.connection_id AND n.binding_epoch=c.binding_epoch AND n.channel_mode='telegram_bot' AND n.state IN ('active','degraded')
    JOIN ${q('connection_routes')} r ON r.company_id=c.company_id AND r.connection_id=c.connection_id AND r.crm_account_id=$4
    JOIN ${q('crm_accounts')} a ON a.company_id=r.company_id AND a.id=r.crm_account_id AND a.state='active'
    WHERE m.company_id=$1 AND m.conversation_id=$2 AND m.provider_message_id=$3 AND m.direction='in'`,
   [input.companyId,input.conversationId,input.providerMessageId,input.accountId]);
  return rows.rows[0];
 };
 return async(input:InboundMessageInput):Promise<ProjectionResult>=>{
  if(input.direction!=='in')return deps.projectMessage(input);
  const message=await load(input);
  if(!message?.allowed)return {projected:false,reason:'crm_import_denied'};
  if(message.content.kind!=='attachment')return deps.projectMessage(input);
  const reject=async():Promise<never>=>{
   await raiseAlert(deps.db,{schema:deps.schema},{companyId:input.companyId,connectionId:message.connection_id,
    kind:'manual_review',dedupeKey:`crm_file_rejected:${message.id}`,errorCode:null,
    conversationId:input.conversationId,externalMessageId:input.providerMessageId});
   throw new Error('crm_file_rejected');
  };
  const media=message.content.telegramMedia as TelegramMediaReference|undefined;
  const declaredMime=typeof media?.mimeType==='string'?normalizeMimeType(media.mimeType):null;
  const recognized=Boolean(declaredMime&&isAllowedMimeType(declaredMime,defaultLimits().allowedMimeTypes));
  const mime=recognized?declaredMime!:'application/octet-stream';
  if(!media||typeof media.fileId!=='string'||!media.fileId||media.fileId.length>1024||
     typeof media.fileName!=='string'||!declaredMime||
     (media.sizeBytes!==null&&(!Number.isSafeInteger(media.sizeBytes)||media.sizeBytes<0||media.sizeBytes>20*1024*1024))) {
   return reject();
  }
  const fileName=sanitizeFileName(media.fileName);
  const scope=[input.companyId,input.accountId,message.id];
  let delivery=(await deps.db.query<Delivery>(`SELECT lead_id,file_uuid,state,byte_size,mime_type FROM ${q('amocrm_file_deliveries')} WHERE company_id=$1 AND account_id=$2 AND message_id=$3`,scope)).rows[0];
  const unknown=async():Promise<never>=>{
   await raiseAlert(deps.db,{schema:deps.schema},{companyId:input.companyId,connectionId:message.connection_id,
    kind:'manual_review',dedupeKey:`crm_file:${message.id}`,errorCode:'OUTCOME_UNKNOWN',conversationId:input.conversationId,externalMessageId:input.providerMessageId});
   throw new Error('crm_file_upload_unknown');
  };
  if(delivery&&['uploading','unknown'].includes(delivery.state))return unknown();
  let bytes:Uint8Array|undefined;
  if(!delivery||delivery.state==='pending'){
   const token=deps.resolveBotToken({companyId:input.companyId,connectionId:message.connection_id,credentialRef:message.credential_ref});
   if(!token)throw new Error('crm_media_credentials_unavailable');
   bytes=await downloadTelegramMedia({botToken:token,fileId:media.fileId,fetch:deps.fetch});
   if(recognized&&!checkContentType(bytes,mime,fileName).ok)return reject();
  }
  const caption=typeof message.content.text==='string'?message.content.text:'';
  const result=await (deps.ensureBinding??deps.projectMessage)({...input,text:caption||fileName});
  if(!result.projected||!result.leadId||result.creationUnknown||result.ambiguous)return result;
  const leadId=result.leadId;
  if(delivery&&delivery.lead_id!==leadId)throw new Error('crm_file_lead_conflict');
  if(!delivery){
   await deps.db.query(`INSERT INTO ${q('amocrm_file_deliveries')}(company_id,account_id,message_id,lead_id,original_name,mime_type,byte_size,sha256)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,[...scope,leadId,fileName,mime,bytes!.byteLength,sha256Hex(bytes!)]);
   delivery=(await deps.db.query<Delivery>(`SELECT lead_id,file_uuid,state,byte_size,mime_type FROM ${q('amocrm_file_deliveries')} WHERE company_id=$1 AND account_id=$2 AND message_id=$3`,scope)).rows[0];
  }
  if(!delivery||delivery.lead_id!==leadId)throw new Error('crm_file_lead_conflict');
  const projectFile=()=>deps.fileUrl?deps.projectMessage({...input,text:caption,attachment:{type:recognized?media.type:'file',
    url:deps.fileUrl({companyId:input.companyId,accountId:input.accountId,messageId:message.id}),fileName,sizeBytes:Number(delivery!.byte_size)}}):Promise.resolve(result);
  if(delivery.state==='linked')return projectFile();
  if(delivery.state==='pending'){
   const claimed=await deps.db.query(`UPDATE ${q('amocrm_file_deliveries')} SET state='uploading',updated_at=now()
    WHERE company_id=$1 AND account_id=$2 AND message_id=$3 AND state='pending' RETURNING message_id`,scope);
   if(!claimed.rowCount)return unknown();
   try{
    if(!(await load(input))?.allowed)throw new Error('crm_import_denied');
    const file=await deps.files.upload({companyId:input.companyId,accountId:input.accountId,fileName,mimeType:mime!,bytes:bytes!});
    await deps.db.query(`UPDATE ${q('amocrm_file_deliveries')} SET state='uploaded',file_uuid=$4,updated_at=now()
     WHERE company_id=$1 AND account_id=$2 AND message_id=$3 AND state='uploading'`,[...scope,file.uuid]);
    delivery={...delivery,state:'uploaded',file_uuid:file.uuid};
   }catch(error){
    const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
    const status=error&&typeof error==='object'&&'status' in error?Number(error.status):null;
    logEvent('warn','amocrm.file_upload.unconfirmed',{companyId:input.companyId,messageId:message.id,
     code:/^[a-zA-Z0-9_]{1,64}$/.test(code)?code:'upload_error',status:Number.isFinite(status)?status:null});
    await deps.db.query(`UPDATE ${q('amocrm_file_deliveries')} SET state='unknown',updated_at=now() WHERE company_id=$1 AND account_id=$2 AND message_id=$3 AND state='uploading'`,scope);
    return unknown();
   }
  }
  if(!delivery.file_uuid)return unknown();
  if(!(await load(input))?.allowed)throw new Error('crm_import_denied');
  const linkScope={companyId:input.companyId,accountId:input.accountId,leadId,fileUuid:delivery.file_uuid};
  if(!await deps.files.isLinked(linkScope))await deps.files.link(linkScope);
  if(!await deps.files.isLinked(linkScope))throw new Error('crm_file_link_not_confirmed');
  await deps.db.query(`UPDATE ${q('amocrm_file_deliveries')} SET state='linked',updated_at=now() WHERE company_id=$1 AND account_id=$2 AND message_id=$3 AND file_uuid=$4`,[...scope,delivery.file_uuid]);
  return projectFile();
 };
}
