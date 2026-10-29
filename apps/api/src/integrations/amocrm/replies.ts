import { withTransaction, type Db } from '../../platform/db.ts';
import { acceptSendCommandInTransaction } from '../../telegram/send.ts';
import { writeAudit } from '../../platform/audit.ts';
import { raiseAlert } from '../../channels/alerts.ts';
import { authorizeCrmChannelSend } from './directory-access.ts';
import type { CrmOwnerResolver } from './directory-owner.ts';
import {outboundScopeAllowed,type OutboundPolicy} from '../../platform/outbound-policy.ts';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Consume authenticated v2 chat replies. No provider call happens in this drain. */
export async function drainAmocrmReplies(
  db: Db,
  input: { schema: string; outboundEnabled: boolean;outboundPolicy?:OutboundPolicy; limit?: number;resolveOwner?:CrmOwnerResolver },
) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(input.schema)) throw new Error('INVALID_SCHEMA');
  const result = { processed: 0, queued: 0, review: 0 };
  if (!input.outboundEnabled) return result;
  const policy=input.outboundPolicy??{mode:'all'};
  if(policy.mode==='off')return result;
  const pilot=policy.mode==='pilot'?policy:null;
  const table = (name: string) => `"${input.schema}"."${name}"`;
  for (let i = 0; i < (input.limit ?? 50); i++) {
    const processed = await withTransaction(db, async (tx) => {
      const pending = await tx.query<{
        id: string;
        company_id: string;
        connection_id: string;
        binding_epoch: string;
        payload: unknown;
        received_at:Date;
      }>(
        `SELECT e.id,e.company_id,e.connection_id,e.binding_epoch,e.payload,e.received_at FROM ${table('inbox_events')} e
          JOIN ${table('connections')} c ON c.company_id=e.company_id AND c.id=e.connection_id AND c.binding_epoch=e.binding_epoch
         WHERE e.state='pending' AND e.kind='chats.message'
           AND c.channel_mode='telegram_bot' AND c.send_enabled=true AND c.state IN ('active','degraded')
           AND ($1::text IS NULL OR (e.company_id=$1 AND e.connection_id=$2 AND e.binding_epoch=$3::bigint
             AND e.received_at>=$5::timestamptz AND EXISTS (
               SELECT 1 FROM ${table('conversations')} pc JOIN ${table('crm_bindings')} pb
                 ON pb.company_id=pc.company_id AND pb.conversation_id=pc.id AND pb.state='bound'
               WHERE pc.company_id=e.company_id AND pc.connection_id=e.connection_id AND pc.binding_epoch=e.binding_epoch
                 AND pc.id=$4 AND (pc.id=e.payload#>>'{message,conversation,client_id}' OR pc.external_chat_id=e.payload#>>'{message,conversation,client_id}')
                 AND pb.chat_id=e.payload#>>'{message,conversation,id}')))
         ORDER BY e.received_at,e.id LIMIT 1 FOR UPDATE OF e SKIP LOCKED`,
        [pilot?.companyId??null,pilot?.connectionId??null,pilot?.bindingEpoch??null,pilot?.conversationId??null,pilot?.activatedAfter??null],
      );
      const event = pending.rows[0];
      if (!event) return null;
      const payload = record(event.payload);
      const envelope = record(payload?.message);
      const message = record(envelope?.message);
      const conversation = record(envelope?.conversation);
      const messageId = typeof message?.id === 'string' ? message.id : null;
      const clientId = typeof conversation?.client_id === 'string' ? conversation.client_id : null;
      const chatId = typeof conversation?.id === 'string' ? conversation.id : null;
      const routes = await tx.query<{
        conversation_id: string;
        external_chat_id: string;
        work_item_id: string;
        default_owner_id: string;
        account_id: string;
        allowed: boolean;
      }>(
        `SELECT c.id AS conversation_id,c.external_chat_id,w.id AS work_item_id,r.default_owner_id,b.account_id,
                ${table('channel_crm_import_allowed')}(c.company_id,c.connection_id,c.binding_epoch,c.external_chat_id,c.chat_kind) AS allowed
           FROM ${table('conversations')} c
           JOIN ${table('crm_bindings')} b ON b.company_id=c.company_id AND b.conversation_id=c.id AND b.state='bound'
           JOIN ${table('connection_routes')} r ON r.company_id=c.company_id AND r.connection_id=c.connection_id AND r.crm_account_id=b.account_id
           JOIN ${table('work_items')} w ON w.company_id=c.company_id AND w.conversation_id=c.id AND w.state NOT IN ('resolved','cancelled')
           JOIN ${table('amocrm_channels')} ch ON ch.company_id=c.company_id AND ch.connection_id=c.connection_id AND ch.binding_epoch=c.binding_epoch AND ch.account_id=b.account_id AND ch.state='connected'
          WHERE c.company_id=$1 AND c.connection_id=$2 AND c.binding_epoch=$3
            AND (c.id=$4 OR c.external_chat_id=$4) AND b.chat_id=$5 AND ch.amojo_account_id=$6 LIMIT 2`,
        [
          event.company_id,
          event.connection_id,
          event.binding_epoch,
          clientId,
          chatId,
          String(payload?.account_id ?? ''),
        ],
      );
      const route = routes.rows.length === 1 ? routes.rows[0] : null;
      if(route&&!outboundScopeAllowed(policy,{companyId:event.company_id,connectionId:event.connection_id,bindingEpoch:Number(event.binding_epoch),
        conversationId:route.conversation_id,createdAt:event.received_at}))return null;
      let state = 'processed';
      let outcome: 'queued' | 'review' | 'echo' = 'review';
      let actorId=route?.default_owner_id;
      let authorized=false;
      let replyToMessageId:string|undefined;
      let quoteValid=true;
      const quote=record(record(message?.reply_to)?.message);
      if(message?.reply_to){
        const target=typeof quote?.id==='string'?quote.id:null;
        if(route&&target){
          const reference=(await tx.query<{actual_provider_message_id:string|null}>(
            `SELECT actual_provider_message_id FROM ${table('amocrm_message_links')}
              WHERE company_id=$1 AND account_id=$2 AND conversation_id=$3 AND amo_message_id=$4`,
            [event.company_id,route.account_id,route.conversation_id,target])).rows[0];
          if(reference?.actual_provider_message_id&&/^[1-9][0-9]*$/.test(reference.actual_provider_message_id))replyToMessageId=reference.actual_provider_message_id;
          else quoteValid=false;
        }else quoteValid=false;
      }
      if (route && messageId) {
        const echo = await tx.query(
          `SELECT 1 FROM ${table('amocrm_message_links')} WHERE company_id=$1 AND account_id=$2 AND amo_message_id=$3`,
          [event.company_id, route.account_id, messageId],
        );
        if (echo.rows.length) outcome = 'echo';
        if(outcome!=='echo') {
          const sender=record(envelope?.sender);
          const access=await authorizeCrmChannelSend(tx,input.schema,{companyId:event.company_id,connectionId:event.connection_id,
            conversationId:route.conversation_id,senderId:typeof sender?.id==='string'?sender.id:null,resolveOwner:input.resolveOwner});
          authorized=access.allowed;
          actorId=access.staffId??actorId;
        }
      }
      if (
        outcome !== 'echo' &&
        route?.allowed &&
        authorized && actorId &&
        messageId &&
        message?.type === 'text' &&
        typeof message.text === 'string' &&
        message.text.length > 0 &&
        message.text.length <= 4096 &&
        quoteValid && !message.forwards &&
        !message.media &&
        !message.markup
      ) {
        const command = await acceptSendCommandInTransaction(
          tx,
          {
            companyId: event.company_id,
            connectionId: event.connection_id,
            bindingEpoch: Number(event.binding_epoch),
          },
          {
            commandType: 'crm.reply',
            idempotencyKey: `amocrm:${route.account_id}:${messageId}`,
            actorId,
            workItemId: route.work_item_id,
            conversationId: route.conversation_id,
            content: { text: message.text,...(replyToMessageId?{replyToMessageId}:{}) },
            deadlineSeconds: 3600,
          },
        );
        await tx.query(
          `INSERT INTO ${table('amocrm_message_links')}(company_id,account_id,conversation_id,provider_message_id,amo_message_id,direction,operation_id)
          VALUES ($1,$2,$3,$4,$5,'out',$6) ON CONFLICT DO NOTHING`,
          [event.company_id, route.account_id, route.conversation_id, `crm:${messageId}`, messageId,command.operationId],
        );
        await writeAudit(tx, {
          companyId: event.company_id,
          eventName: 'crm.reply_queued',
          subjectId: command.operationId,
          actorId,
          diagnosticCode: 'chats_v2',
        });
        outcome = 'queued';
      }
      if (outcome === 'review') {
        state = 'quarantined';
        if(!quoteValid)await writeAudit(tx,{companyId:event.company_id,eventName:'crm.reply_rejected',subjectId:event.id,
          actorId:actorId??null,diagnosticCode:'quote_target_missing'});
        await raiseAlert(
          tx,
          { schema: input.schema },
          {
            companyId: event.company_id,
            connectionId: event.connection_id,
            kind: 'manual_review',
            dedupeKey: `crm_reply_review:${event.id}`,
            errorCode: quoteValid?'OUTCOME_UNKNOWN':null,
            conversationId: route?.conversation_id,
            externalMessageId: messageId,
          },
        );
      }
      await tx.query(
        `UPDATE ${table('inbox_events')} SET state=$3,processed_at=clock_timestamp() WHERE company_id=$1 AND id=$2`,
        [event.company_id, event.id, state],
      );
      return outcome;
    });
    if (!processed) break;
    result.processed++;
    if (processed === 'queued') result.queued++;
    if (processed === 'review') result.review++;
  }
  return result;
}
