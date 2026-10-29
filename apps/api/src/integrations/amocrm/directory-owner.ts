import { pickNewestLead,type AmocrmSyncClient } from './sync.ts';
import type { WorkflowClient } from './workflow.ts';

export type CrmOwnerResolver=(input:{companyId:string;accountId:string;conversationId:string;contactId:string;leadId:string|null})=>Promise<string|null>;

/** Read current deal ownership; this never assigns anyone or writes into CRM. */
export function createCrmOwnerResolver(deps:{findOpenLeads:AmocrmSyncClient['findOpenLeads'];readResponsible:WorkflowClient['readResponsible']}):CrmOwnerResolver {
  return async(input)=>{
    const leadId=input.leadId??pickNewestLead(await deps.findOpenLeads(input));
    if(!leadId)return null;
    const result=await deps.readResponsible({...input,leadId});
    return result.lead?.id===leadId?result.lead.responsibleUserId:null;
  };
}
