import {createHmac,timingSafeEqual} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import type {Db} from '../platform/db.ts';
import type {AmoDriveReader} from '../integrations/amocrm/drive-reader.ts';
import {sanitizeFileName} from './policy.ts';

type Scope={companyId:string;accountId:string;messageId:string};
const ROUTE='/api/v2/amocrm/files/:messageId/content';
const digest=(secret:string,scope:Scope)=>createHmac('sha256',secret).update(JSON.stringify(['amocrm-drive-media-v1',scope.companyId,scope.accountId,scope.messageId])).digest();

export function crmDriveMediaUrl(input:Scope&{baseUrl:string|null|undefined;secret:string}):string{
 let base:URL;try{base=new URL(input.baseUrl??'');}catch{throw new Error('crm_media_base_url_missing');}
 if(base.protocol!=='https:'||base.port||base.username||base.password||base.search||base.hash||base.pathname!=='/')throw new Error('crm_media_base_url_invalid');
 const url=new URL(ROUTE.replace(':messageId',encodeURIComponent(input.messageId)),base);
 url.search=new URLSearchParams({companyId:input.companyId,accountId:input.accountId,signature:digest(input.secret,input).toString('hex')}).toString();
 return url.toString();
}

export function registerCrmDriveMediaRoutes(app:FastifyInstance,deps:{db:Db;schema:string;reader:AmoDriveReader;secret:string}):void{
 if(!/^[a-z_][a-z0-9_]{0,62}$/.test(deps.schema))throw new Error('INVALID_SCHEMA');
 const q=(table:string)=>`"${deps.schema}"."${table}"`;
 const query=z.object({companyId:z.string().min(1).max(128),accountId:z.string().min(1).max(128),signature:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
 let inFlight=0;
 app.get<{Params:{messageId:string}}>(ROUTE,async(request,reply)=>{
  reply.header('cache-control','private, no-store').header('referrer-policy','no-referrer');
  const parsed=query.safeParse(request.query),messageId=request.params.messageId;
  if(!parsed.success||!/^[a-f0-9-]{36}$/i.test(messageId))return reply.code(404).send({code:'NOT_FOUND'});
  const scope={companyId:parsed.data.companyId,accountId:parsed.data.accountId,messageId};
  if(!timingSafeEqual(digest(deps.secret,scope),Buffer.from(parsed.data.signature,'hex')))return reply.code(404).send({code:'NOT_FOUND'});
  if(inFlight>=2)return reply.header('retry-after','1').code(429).send({code:'RATE_LIMITED'});
  inFlight++;
  try{
   const assets=(await deps.db.query<{file_uuid:string;byte_size:string;sha256:string;mime_type:string;original_name:string}>(
    `SELECT d.file_uuid,d.byte_size,d.sha256,d.mime_type,d.original_name FROM ${q('amocrm_file_deliveries')} d
     JOIN ${q('messages')} m ON m.company_id=d.company_id AND m.id=d.message_id AND m.direction='in'
     JOIN ${q('conversations')} c ON c.company_id=m.company_id AND c.id=m.conversation_id
     JOIN ${q('connections')} n ON n.company_id=c.company_id AND n.id=c.connection_id AND n.binding_epoch=c.binding_epoch AND n.state IN ('active','degraded')
     JOIN ${q('connection_routes')} r ON r.company_id=c.company_id AND r.connection_id=c.connection_id AND r.crm_account_id=d.account_id
     JOIN ${q('crm_accounts')} a ON a.company_id=d.company_id AND a.id=d.account_id AND a.state='active'
     WHERE d.company_id=$1 AND d.account_id=$2 AND d.message_id=$3 AND d.state='linked'
       AND ${q('channel_crm_import_allowed')}(c.company_id,c.connection_id,c.binding_epoch,c.external_chat_id,c.chat_kind)`,
    [scope.companyId,scope.accountId,messageId])).rows;
   if(assets.length!==1)return reply.code(404).send({code:'NOT_FOUND'});
   const asset=assets[0]!,size=Number(asset.byte_size);
   const bytes=await deps.reader.download({...scope,fileUuid:asset.file_uuid,byteSize:size,sha256:asset.sha256});
   return reply.header('content-type',asset.mime_type).header('x-content-type-options','nosniff')
    .header('content-disposition',`attachment; filename*=UTF-8''${encodeURIComponent(sanitizeFileName(asset.original_name)).replace(/[!'()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`)
    .header('content-length',size).send(Buffer.from(bytes));
  }catch{return reply.code(503).send({code:'UPSTREAM_UNAVAILABLE',retryable:true});}
  finally{inFlight--;}
 });
}
