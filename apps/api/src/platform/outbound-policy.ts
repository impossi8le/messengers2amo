export type OutboundPolicy =
 | {mode:'off'}
 | {mode:'all'}
 | {mode:'pilot';companyId:string;connectionId:string;bindingEpoch:number;conversationId:string;activatedAfter:string};

export type OutboundScope = {
 companyId:string;connectionId:string;bindingEpoch:number;conversationId:string;createdAt:Date|string;
};

/** The master switch wins even over an otherwise valid pilot configuration. */
export function readOutboundPolicy(env:NodeJS.ProcessEnv):OutboundPolicy {
 const enabled=['1','true','yes'].includes((env.OUTBOUND_ENABLED??'').toLowerCase());
 if(!enabled)return {mode:'off'};
 if(env.OUTBOUND_MODE==='all')return {mode:'all'};
 if(env.OUTBOUND_MODE!=='pilot')throw new Error('outbound_mode_required');
 const required=(name:string)=>{
  const value=env[name]?.trim();
  if(!value||value.length>256||/[\u0000-\u001f\u007f]/.test(value))throw new Error('outbound_pilot_scope_invalid');
  return value;
 };
 const epoch=required('OUTBOUND_PILOT_BINDING_EPOCH');
 if(!/^(0|[1-9][0-9]*)$/.test(epoch)||!Number.isSafeInteger(Number(epoch)))throw new Error('outbound_pilot_scope_invalid');
 const rawDate=required('OUTBOUND_PILOT_ACTIVATED_AFTER');
 const date=new Date(rawDate);
 if(!/(?:Z|[+-]\d\d:\d\d)$/.test(rawDate)||!Number.isFinite(date.getTime()))throw new Error('outbound_pilot_scope_invalid');
 return {mode:'pilot',companyId:required('OUTBOUND_PILOT_COMPANY_ID'),connectionId:required('OUTBOUND_PILOT_CONNECTION_ID'),
  bindingEpoch:Number(epoch),conversationId:required('OUTBOUND_PILOT_CONVERSATION_ID'),activatedAfter:date.toISOString()};
}

export function outboundConnectionAllowed(policy:OutboundPolicy,scope:{companyId:string;connectionId:string}):boolean {
 return policy.mode==='all'||(policy.mode==='pilot'&&policy.companyId===scope.companyId&&policy.connectionId===scope.connectionId);
}

export function outboundScopeAllowed(policy:OutboundPolicy,scope:OutboundScope):boolean {
 if(!outboundConnectionAllowed(policy,scope))return false;
 if(policy.mode==='all')return true;
 if(policy.mode!=='pilot')return false;
 const createdAt=new Date(scope.createdAt).getTime();
 return policy.bindingEpoch===scope.bindingEpoch&&policy.conversationId===scope.conversationId&&
  Number.isFinite(createdAt)&&createdAt>=Date.parse(policy.activatedAfter);
}
