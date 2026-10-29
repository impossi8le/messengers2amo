import type { Db,Tx } from '../../platform/db.ts';
import type { CrmOwnerResolver } from './directory-owner.ts';

/** Both intake and dispatch use the same live channel policy; no permission cache. */
export async function authorizeCrmChannelSend(db: Db|Tx,schema:string,input:{
  companyId:string;connectionId:string;conversationId:string;senderId?:string|null;staffId?:string|null;resolveOwner?:CrmOwnerResolver;
}):Promise<{allowed:boolean;staffId:string|null}> {
  if(!/^[a-z_][a-z0-9_]{0,62}$/.test(schema))throw new Error('INVALID_SCHEMA');
  const q=(table:string)=>`"${schema}"."${table}"`;
  const values=[input.companyId,input.connectionId,input.conversationId,input.senderId??null,input.staffId??null];
  const sql=`SELECT n.crm_access_enabled AS enabled,u.staff_id,u.is_active,a.role,u.crm_user_ref,r.crm_account_id AS account_id,b.contact_id,b.lead_id
     FROM ${q('connections')} n
     LEFT JOIN ${q('connection_routes')} r ON r.company_id=n.company_id AND r.connection_id=n.id
     JOIN ${q('conversations')} c ON c.company_id=n.company_id AND c.connection_id=n.id AND c.binding_epoch=n.binding_epoch AND c.id=$3
     LEFT JOIN ${q('crm_directory_users')} u ON u.company_id=n.company_id AND u.account_id=r.crm_account_id
       AND (($4::text IS NOT NULL AND u.amojo_user_ref=$4) OR ($5::text IS NOT NULL AND u.staff_id=$5))
     LEFT JOIN ${q('channel_crm_access')} a ON a.company_id=n.company_id AND a.connection_id=n.id AND a.account_id=u.account_id AND a.crm_user_ref=u.crm_user_ref
     LEFT JOIN ${q('crm_bindings')} b ON b.company_id=n.company_id AND b.account_id=r.crm_account_id AND b.conversation_id=c.id AND b.state='bound'
     WHERE n.company_id=$1 AND n.id=$2 LIMIT 2`;
  type AccessRow={enabled:boolean;staff_id:string|null;is_active:boolean|null;role:string|null;crm_user_ref:string|null;account_id:string;contact_id:string|null;lead_id:string|null};
  const {rows}=await db.query<AccessRow>(sql,values);
  if(rows.length!==1)return {allowed:false,staffId:null};
  const row=rows[0]!;
  if(!row.enabled)return {allowed:true,staffId:null};
  if(!row.is_active)return {allowed:false,staffId:row.staff_id};
  if(row.role==='supervisor')return {allowed:true,staffId:row.staff_id};
  if(row.role!=='manager'||!row.contact_id||!input.resolveOwner)return {allowed:false,staffId:row.staff_id};
  let owner:string|null;
  try{owner=await input.resolveOwner({companyId:input.companyId,accountId:row.account_id,conversationId:input.conversationId,contactId:row.contact_id,leadId:row.lead_id});}
  catch{throw new Error('crm_owner_unavailable');}
  const latest=(await db.query<AccessRow>(sql,values)).rows;
  const current=latest.length===1?latest[0]:null;
  return {allowed:Boolean(current?.is_active && current.staff_id===row.staff_id && current.account_id===row.account_id &&
    current.contact_id===row.contact_id && current.lead_id===row.lead_id &&
    (current.role==='supervisor'||(current.role==='manager'&&owner&&current.crm_user_ref===owner))),staffId:row.staff_id};
}
