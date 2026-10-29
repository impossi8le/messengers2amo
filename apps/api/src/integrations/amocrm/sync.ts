import { createHash, randomBytes } from 'node:crypto';
import type { Db, Tx } from '../../platform/db.ts';
import { withTransaction } from '../../platform/db.ts';
import { writeAudit } from '../../platform/audit.ts';
import { qualified } from './store.ts';
import { RateLimitError } from './oauth.ts';
import { raiseAlert } from '../../channels/alerts.ts';

export type CrmContact = { id: string; name?: string };

/** A lead the contact already has open. Final stages are excluded by the adapter. */
export type CrmLead = { id: string; updatedAt: string | null };

/**
 * 8XXXXXXXXXX and +7XXXXXXXXXX are the same Russian number. Anything that is not a
 * plain 11-digit Russian number is returned untouched: guessing at foreign formats
 * is how contacts get merged wrongly.
 */
export function normalizeRuPhone(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length === 11 && digits.startsWith('8')) return `+7${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith('7')) return `+${digits}`;
  return raw;
}

/**
 * The most recently updated open lead wins. The id breaks ties so two retries of the
 * same message cannot bind different deals.
 */
export function pickNewestLead(leads: readonly CrmLead[]): string | null {
  let best: CrmLead | null = null;
  for (const lead of leads) {
    if (!best) {
      best = lead;
      continue;
    }
    const candidate = lead.updatedAt ?? '';
    const current = best.updatedAt ?? '';
    if (candidate > current || (candidate === current && lead.id < best.id)) best = lead;
  }
  return best?.id ?? null;
}

export type CrmMessageAttachment = {
  type: 'picture' | 'file' | 'video' | 'voice' | 'audio';
  url: string;
  fileName: string;
  sizeBytes: number;
};

export type AmocrmSyncClient = {
  linkChat(input: { companyId: string; accountId: string; contactId: string; chatId: string }): Promise<void>;
  importMessage(input: {
    companyId: string; accountId: string; conversationId: string; messageId: string;
    text: string; occurredAt: Date; silent: boolean; sourceId?: string | null;
    attachment?: CrmMessageAttachment;
    senderName?: string;
    senderUsername?: string;
    senderAvatarUrl?: string;
  }): Promise<{ messageId: string }>;
  findContacts(input: {
    companyId: string;
    accountId: string;
    phone?: string | null;
    email?: string | null;
  }): Promise<CrmContact[]>;
  createContact(input: {
    companyId: string;
    accountId: string;
    conversationId: string;
    intentKey: string;
    /** Contact name; falls back to the phone when the channel profile has none. */
    name?: string | null;
    phone?: string | null;
    email?: string | null;
  }): Promise<{ id: string }>;
  createChat(input: {
    companyId: string;
    accountId: string;
    conversationId: string;
    intentKey: string;
    externalChatId?: string | null;
    chatName?: string | null;
    senderUsername?: string;
    senderAvatarUrl?: string;
    sourceId?: string | null;
  }): Promise<{ chatId: string }>;
  createLead(input: {
    companyId: string;
    accountId: string;
    conversationId: string;
    intentKey: string;
    /** Pipeline and stage from the channel binding; absent means the account default. */
    pipelineId?: string | null;
    statusId?: string | null;
    contactId?: string | null;
    name?: string | null;
    /** Explicit REST-only capture while the native chat channel is being registered. */
    destination?: 'unsorted' | 'stage';
  }): Promise<{ id: string }>;
  /** Open leads already attached to the contact; empty means a new deal is needed. */
  findOpenLeads(input: { companyId: string; accountId: string; contactId: string }): Promise<CrmLead[]>;
  findContactByIntentKey?(input: { companyId: string; accountId: string; intentKey: string }): Promise<CrmContact | null>;
  findLeadByIntentKey?(input: { companyId: string; accountId: string; intentKey: string }): Promise<{ id: string } | null>;
};

export type SyncDeps = {
  db: Db;
  schema?: string;
  client: AmocrmSyncClient;
  now?: () => number;
  /** Explicit legacy stage mode; production defaults to unassigned native Unsorted. */
  newLeadDestination?: 'unsorted' | 'stage';
  /** Explicit opt-in; never enabled as an automatic fallback for a broken chat. */
  captureOnly?: boolean;
};

export type InboundMessageInput = {
  companyId: string;
  accountId: string;
  conversationId: string;
  providerMessageId: string;
  direction: 'in' | 'out';
  text?: string;
  /** Ephemeral download grant, resolved at dispatch; never written into the job. */
  attachment?: CrmMessageAttachment;
  phone?: string | null;
  email?: string | null;
  occurredAt?: Date | null;
  /** Normalized display identity from a private messenger chat; never used to match contacts. */
  senderName?: string;
  senderUsername?: string;
  /** Ephemeral scoped profile-image URL; never persisted into projection jobs. */
  senderAvatarUrl?: string;
};

export type ProjectionResult = {
  projected: boolean;
  reason?: string;
  bindingId?: string;
  contactId?: string | null;
  leadId?: string | null;
  ambiguous?: boolean;
  ambiguityId?: string;
  creationUnknown?: boolean;
};

export type CrmEventInput = {
  companyId: string;
  accountId: string;
  kind: string;
  payload: Record<string, unknown>;
};

type ConversationGate = {
  connection_id: string;
  binding_epoch: string;
  external_chat_id: string;
  chat_kind: 'private' | 'group' | 'unknown';
  allowed: boolean;
};

type IntentInput = {
  companyId: string;
  accountId: string;
  conversationId: string;
  entityKind: 'contact' | 'lead' | 'chat';
  intentKey: string;
};

type IntentClaim = {
  id: string;
  state: string;
  externalId: string | null;
  /** True when this caller moved the intent to `dispatching` and owns the external call. */
  claimed: boolean;
};

function digest(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex').slice(0, 24);
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${digest(...parts)}`;
}

export class AmocrmSync {
  private readonly db: Db;
  private readonly schema: string | undefined;
  private readonly client: AmocrmSyncClient;
  private readonly newLeadDestination: 'unsorted' | 'stage';
  private readonly captureOnly: boolean;

  constructor(deps: SyncDeps) {
    this.db = deps.db;
    this.schema = deps.schema;
    this.client = deps.client;
    this.newLeadDestination = deps.newLeadDestination ?? 'unsorted';
    this.captureOnly = deps.captureOnly ?? false;
  }

  private q(name: string): string {
    return qualified(this.schema, name);
  }

  private async gate(tx: Tx | Db, companyId: string, conversationId: string): Promise<ConversationGate | null> {
    const { rows } = await tx.query<ConversationGate>(
      `SELECT c.connection_id, c.binding_epoch, c.external_chat_id, c.chat_kind,
              ${this.q('channel_crm_import_allowed')}($1, c.connection_id, c.binding_epoch, c.external_chat_id, c.chat_kind) AS allowed
         FROM ${this.q('conversations')} c
        WHERE c.company_id=$1 AND c.id=$2`,
      [companyId, conversationId],
    );
    return rows[0] ?? null;
  }

  /**
   * Routing settings of the connection: the funnel and stage a new deal starts in,
   * and whether a Russian number is normalised before the contact search. A
   * connection without a route projects into the account defaults.
   */
  private async routeSettings(
    runner: Tx | Db,
    companyId: string,
    connectionId: string,
  ): Promise<{ funnelId: string | null; statusId: string | null; normalizePhone: boolean; sourceId: string | null }> {
    const { rows } = await runner.query<{ funnel_id: string; status_id: string | null; normalize_phone: boolean; external_id: string }>(
      `SELECT r.funnel_id, r.status_id, r.normalize_phone, s.external_id
         FROM ${this.q('connection_routes')} r
         JOIN ${this.q('crm_sources')} s ON s.company_id=r.company_id AND s.id=r.technical_source_id AND s.account_id=r.crm_account_id
        WHERE r.company_id=$1 AND r.connection_id=$2`,
      [companyId, connectionId],
    );
    const row = rows[0];
    return {
      funnelId: row?.funnel_id ?? null,
      statusId: row?.status_id ?? null,
      normalizePhone: row?.normalize_phone ?? false,
      sourceId: row?.external_id ?? null,
    };
  }

  private async ensureIntent(
    tx: Tx,
    input: {
      companyId: string;
      accountId: string;
      conversationId: string;
      entityKind: 'contact' | 'lead' | 'chat';
      intentKey: string;
    },
  ): Promise<{ id: string; state: string; externalId: string | null; created: boolean }> {
    const id = stableId('ci', input.companyId, input.accountId, input.entityKind, input.intentKey);
    const inserted = await tx.query(
      `INSERT INTO ${this.q('crm_create_intents')}
         (company_id,id,account_id,conversation_id,intent_key,entity_kind,state)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')
       ON CONFLICT (company_id,account_id,entity_kind,intent_key) DO NOTHING`,
      [input.companyId, id, input.accountId, input.conversationId, input.intentKey, input.entityKind],
    );
    const { rows } = await tx.query<{ id: string; state: string; external_id: string | null }>(
      `SELECT id, state, external_id FROM ${this.q('crm_create_intents')}
        WHERE company_id=$1 AND account_id=$2 AND entity_kind=$3 AND intent_key=$4`,
      [input.companyId, input.accountId, input.entityKind, input.intentKey],
    );
    const row = rows[0];
    if (!row) throw new Error('intent_missing');
    return { id: row.id, state: row.state, externalId: row.external_id, created: (inserted.rowCount ?? 0) > 0 };
  }

  private async markIntent(
    tx: Tx,
    companyId: string,
    intentId: string,
    state: 'created' | 'failed' | 'creation_unknown' | 'dispatching',
    externalId?: string | null,
  ): Promise<void> {
    await tx.query(
      `UPDATE ${this.q('crm_create_intents')} SET state=$3, external_id=COALESCE($4, external_id)
        WHERE company_id=$1 AND id=$2`,
      [companyId, intentId, state, externalId ?? null],
    );
  }

  /**
   * Claims an intent in its own transaction. The `dispatching` marker (and the
   * intent row itself) must be durable before the external call: if the
   * projection transaction later rolls back, a retry has to see that a creation
   * may already have happened instead of creating a second CRM entity.
   */
  private async claimIntent(input: IntentInput): Promise<IntentClaim> {
    return withTransaction(this.db, async (tx) => {
      const intent = await this.ensureIntent(tx, input);
      if (intent.state === 'created' || intent.state === 'creation_unknown' || intent.state === 'dispatching') {
        return { id: intent.id, state: intent.state, externalId: intent.externalId, claimed: false };
      }
      await this.markIntent(tx, input.companyId, intent.id, 'dispatching');
      return { id: intent.id, state: 'dispatching', externalId: intent.externalId, claimed: true };
    });
  }

  /** Records the external outcome in its own transaction so it survives a rollback. */
  private async recordIntentOutcome(
    companyId: string,
    intentId: string,
    state: 'created' | 'failed' | 'creation_unknown',
    externalId?: string | null,
  ): Promise<void> {
    await withTransaction(this.db, (tx) => this.markIntent(tx, companyId, intentId, state, externalId));
  }

  /**
   * Returns the usable lead id or null when the saved id is tombstoned. A merged
   * lead resolves to its replacement; a deleted lead is never reused.
   */
  private async resolveLeadTombstone(
    tx: Tx | Db,
    companyId: string,
    accountId: string,
    externalId: string,
  ): Promise<string | null> {
    const { rows } = await tx.query<{ observation: string; replacement_external_id: string | null }>(
      `SELECT observation, replacement_external_id FROM ${this.q('crm_entity_tombstones')}
        WHERE company_id=$1 AND account_id=$2 AND entity_type='lead' AND external_id=$3`,
      [companyId, accountId, externalId],
    );
    const row = rows[0];
    if (!row) return externalId;
    if (row.observation === 'merged' && row.replacement_external_id) return row.replacement_external_id;
    return null;
  }

  /**
   * Projects one messenger message into the CRM mapping. The channel policy is
   * evaluated first: a denied group/unknown chat produces no CRM rows and no
   * outbound call at all.
   */
  async ensureInboundBinding(input:InboundMessageInput):Promise<ProjectionResult>{
    return this.projectInboundMessage(input,{bindingOnly:true});
  }

  async projectInboundMessage(input: InboundMessageInput,options:{bindingOnly?:boolean}={}): Promise<ProjectionResult> {
    if (input.direction !== 'in') return { projected: false, reason: 'outbound_projection_ignored' };
    const gate = await this.gate(this.db, input.companyId, input.conversationId);
    if (!gate) return { projected: false, reason: 'conversation_not_found' };
    if (!gate.allowed) return { projected: false, reason: 'crm_import_denied' };
    if (!options.bindingOnly&&!input.attachment && !input.text) throw new Error('crm_message_content_missing');

    const route = await this.routeSettings(this.db, input.companyId, gate.connection_id);
    if (this.captureOnly && !route.funnelId) throw new Error('lead_capture_route_missing');
    // The search and the contact both work on the normalised number, so a client
    // who typed 8XXXXXXXXXX matches the +7XXXXXXXXXX record created earlier.
    const phone = route.normalizePhone ? normalizeRuPhone(input.phone) : (input.phone ?? null);

    const result: ProjectionResult = await withTransaction(this.db, async (tx) => {
      // Policy may have been revoked between the pre-check and this write.
      const currentGate = await this.gate(tx, input.companyId, input.conversationId);
      if (!currentGate || !currentGate.allowed) return { projected: false, reason: 'crm_import_denied' };
      const bindingId = stableId('bind', input.companyId, input.accountId, input.conversationId);
      await tx.query(
        `INSERT INTO ${this.q('crm_bindings')}(company_id,id,account_id,conversation_id,state)
         VALUES ($1,$2,$3,$4,'pending')
         ON CONFLICT (company_id,account_id,conversation_id) DO NOTHING`,
        [input.companyId, bindingId, input.accountId, input.conversationId],
      );

      const proposedMessageId = stableId('m', input.companyId, input.conversationId, input.providerMessageId);
      const insertedMessage=await tx.query<{id:string}>(
        `INSERT INTO ${this.q('messages')}
           (company_id,id,conversation_id,direction,provider_message_id,current_content_version,created_at)
         VALUES ($1,$2,$3,$4,$5,1,COALESCE($6,now()))
         ON CONFLICT (company_id,conversation_id,provider_message_id) DO NOTHING RETURNING id`,
        [
          input.companyId,
          proposedMessageId,
          input.conversationId,
          input.direction,
          input.providerMessageId,
          input.occurredAt ?? null,
        ],
      );
      const messageId=insertedMessage.rows[0]?.id ?? (await tx.query<{id:string}>(
        `SELECT id FROM ${this.q('messages')} WHERE company_id=$1 AND conversation_id=$2 AND provider_message_id=$3`,
        [input.companyId,input.conversationId,input.providerMessageId],
      )).rows[0]?.id;
      if (!messageId) throw new Error('projection_message_missing');
      await tx.query(
        `INSERT INTO ${this.q('message_versions')}(company_id,message_id,content_version,content)
         VALUES ($1,$2,1,$3)
         ON CONFLICT DO NOTHING`,
        [input.companyId, messageId, JSON.stringify({ text: input.text ?? '' })],
      );

      const binding = await tx.query<{ id: string; state: string; contact_id: string | null; lead_id: string | null; chat_id: string | null }>(
        `SELECT id, state, contact_id, lead_id, chat_id FROM ${this.q('crm_bindings')}
          WHERE company_id=$1 AND account_id=$2 AND conversation_id=$3 FOR UPDATE`,
        [input.companyId, input.accountId, input.conversationId],
      );
      const row = binding.rows[0];
      if (!row) throw new Error('binding_missing');
      if (this.captureOnly && row.chat_id) throw new Error('lead_capture_native_chat_exists');

      let contactId: string | null = row.contact_id;
      let boundChatId = row.chat_id;
      const senderLabel = currentGate.chat_kind === 'private' ? input.senderName?.trim() ||
        (input.senderUsername && /^[a-zA-Z0-9_]{1,32}$/.test(input.senderUsername) ? `@${input.senderUsername}` : null) : null;
      if (row.state !== 'bound') {
        // Without a phone or an email there is nothing to match on: the search is
        // skipped instead of being refused upstream or matching a random contact.
        const hasIdentifier = Boolean(phone?.trim() || input.email?.trim());
        const candidates = row.contact_id ? [{ id: row.contact_id }] : hasIdentifier
          ? await this.client.findContacts({
              companyId: input.companyId,
              accountId: input.accountId,
              phone,
              email: input.email ?? null,
            })
          : [];
        if (candidates.length > 1) {
          // Equal names/phones are never merged automatically.
          const ambiguityId = stableId(
            'amb',
            input.companyId,
            input.accountId,
            input.conversationId,
            'multiple_candidates',
          );
          await tx.query(
            `INSERT INTO ${this.q('amocrm_ambiguous_matches')}
               (company_id,id,account_id,conversation_id,reason,candidates)
             VALUES ($1,$2,$3,$4,'multiple_candidates',$5)
             ON CONFLICT (company_id,account_id,conversation_id,reason) DO NOTHING`,
            [input.companyId, ambiguityId, input.accountId, input.conversationId, JSON.stringify(candidates)],
          );
          return { projected: true, ambiguous: true, ambiguityId, contactId: null, leadId: null };
        }
        if (candidates.length === 1) {
          contactId = candidates[0]!.id;
        } else {
          const contactIntent = await this.claimIntent({
            companyId: input.companyId,
            accountId: input.accountId,
            conversationId: input.conversationId,
            entityKind: 'contact',
            intentKey: `contact:${input.conversationId}`,
          });
          if (contactIntent.state === 'created' && contactIntent.externalId) {
            contactId = contactIntent.externalId;
          } else if (!contactIntent.claimed) {
            // A previous attempt may have reached CRM; never create a second contact.
            return { projected: true, creationUnknown: true, contactId: null, leadId: null, bindingId: row.id };
          } else {
            try {
              const created = await this.client.createContact({
                companyId: input.companyId,
                accountId: input.accountId,
                conversationId: input.conversationId,
                intentKey: `contact:${input.conversationId}`,
                name: hasIdentifier ? null : senderLabel || currentGate.external_chat_id,
                phone,
                email: input.email ?? null,
              });
              await this.recordIntentOutcome(input.companyId, contactIntent.id, 'created', created.id);
              contactId = created.id;
            } catch (error) {
              await this.recordIntentOutcome(
                input.companyId,
                contactIntent.id,
                error instanceof RateLimitError ? 'failed' : 'creation_unknown',
              );
              throw error;
            }
          }
        }

        if (this.captureOnly) {
          await tx.query(
            `UPDATE ${this.q('crm_bindings')} SET contact_id=$3, version=version+1
             WHERE company_id=$1 AND id=$2 AND contact_id IS DISTINCT FROM $3`,
            [input.companyId, row.id, contactId],
          );
          const lead = await this.ensureLead(tx, {
            companyId: input.companyId, accountId: input.accountId,
            conversationId: input.conversationId, existingLeadId: row.lead_id,
            contactId, pipelineId: route.funnelId, statusId: route.statusId,
            destination: route.statusId === null ? 'unsorted' : 'stage',
            name: `Telegram: ${(input.text ?? 'Новое обращение').slice(0, 100)}`,
          });
          // A REST capture is not a chat binding or a successful message import.
          return { projected: !lead.creationUnknown, reason: 'lead_capture_only',
            bindingId: row.id, contactId, leadId: lead.leadId, creationUnknown: lead.creationUnknown };
        }

        const chatIntent = await this.claimIntent({
          companyId: input.companyId,
          accountId: input.accountId,
          conversationId: input.conversationId,
          entityKind: 'chat',
          intentKey: `chat:${input.conversationId}`,
        });
        let chatId: string | null = chatIntent.state === 'created' ? chatIntent.externalId : null;
        if (!chatId && !chatIntent.claimed) {
          // A previous attempt may have reached CRM; never create a second chat.
          return { projected: true, creationUnknown: true, contactId, leadId: null, bindingId: row.id };
        }
        if (!chatId) {
          try {
            const created = await this.client.createChat({
              companyId: input.companyId,
              accountId: input.accountId,
              conversationId: input.conversationId,
              intentKey: `chat:${input.conversationId}`,
              externalChatId: currentGate.external_chat_id,
              chatName: !hasIdentifier && senderLabel ? senderLabel : currentGate.external_chat_id,
              senderUsername: currentGate.chat_kind === 'private' ? input.senderUsername : undefined,
              senderAvatarUrl: currentGate.chat_kind === 'private' ? input.senderAvatarUrl : undefined,
              sourceId: route.sourceId,
            });
            await this.recordIntentOutcome(input.companyId, chatIntent.id, 'created', created.chatId);
            chatId = created.chatId;
          } catch (error) {
            await this.recordIntentOutcome(
              input.companyId,
              chatIntent.id,
              error instanceof RateLimitError ? 'failed' : 'creation_unknown',
            );
            throw error;
          }
        }
        if (contactId && chatId) {
          await this.client.linkChat({ companyId: input.companyId, accountId: input.accountId, contactId, chatId });
        }
        boundChatId = chatId;
        await tx.query(
          `UPDATE ${this.q('crm_bindings')}
              SET contact_id=$3, chat_id=$4, state='bound', version=version+1
            WHERE company_id=$1 AND account_id=$2 AND conversation_id=$5 AND state<>'bound'`,
          [input.companyId, input.accountId, contactId, chatId, input.conversationId],
        );
      }

      // A returning client belongs in the deal that is already open, not in a fresh
      // one per conversation. A closed deal is never reopened: that is a new sale,
      // and reviving it would distort the funnel's cycle analytics.
      let existingLeadId = row.lead_id ?? null;
      let previousLeadId: string | null = null;
      if (contactId) {
        const openLeads = await this.client.findOpenLeads({
          companyId: input.companyId,
          accountId: input.accountId,
          contactId,
        });
        const chosen = pickNewestLead(openLeads);
        if (existingLeadId && !openLeads.some((lead)=>lead.id===existingLeadId)) {
          previousLeadId=existingLeadId;
          existingLeadId=null;
          await tx.query(`UPDATE ${this.q('crm_bindings')} SET lead_id=NULL,version=version+1 WHERE company_id=$1 AND account_id=$2 AND conversation_id=$3`,[input.companyId,input.accountId,input.conversationId]);
        }
        if (!existingLeadId && chosen) {
          existingLeadId = chosen;
          // The choice is recorded rather than inferred: later there must be a way to
          // tell why this message landed in that particular deal.
          await writeAudit(tx, {
            companyId: input.companyId,
            eventName: 'crm.lead_reused',
            subjectId: chosen,
            actorId: null,
            diagnosticCode: `open=${openLeads.length}`,
          });
        }
      }

      const useUnsorted = this.newLeadDestination === 'unsorted' && route.statusId === null && !existingLeadId;
      const lead = useUnsorted ? { leadId: null, creationUnknown: false } : await this.ensureLead(tx, {
        companyId: input.companyId,
        accountId: input.accountId,
        conversationId: input.conversationId,
        existingLeadId,
        contactId,
        pipelineId: route.funnelId,
        statusId: route.statusId,
        previousLeadId,
      });
      if (lead.creationUnknown) {
        return {
          projected: true,
          bindingId: row.id,
          contactId,
          leadId: null,
          ambiguous: false,
          creationUnknown: true,
        };
      }
      if(options.bindingOnly)return {projected:true,bindingId:row.id,contactId,leadId:lead.leadId,ambiguous:false};
      const alreadyImported = await tx.query(
        `SELECT 1 FROM ${this.q('amocrm_message_links')}
          WHERE company_id=$1 AND account_id=$2 AND conversation_id=$3 AND provider_message_id=$4`,
        [input.companyId, input.accountId, input.conversationId, input.providerMessageId],
      );
      if (alreadyImported.rows.length === 0) {
        if (!boundChatId) throw new Error('chat_binding_missing');
        // Chats API deduplicates msgid+conversation_id. A retry after a lost
        // response uses this same id, even if the local transaction rolled back.
        const imported = await this.client.importMessage({
          companyId: input.companyId, accountId: input.accountId,
          conversationId: input.conversationId,
          messageId: stableId('import', input.companyId, input.accountId, input.conversationId, input.providerMessageId),
          text: input.text ?? '', occurredAt: input.occurredAt ?? new Date(),
          ...(input.attachment ? { attachment: input.attachment } : {}),
          senderName: senderLabel ?? currentGate.external_chat_id,
          senderUsername: currentGate.chat_kind === 'private' ? input.senderUsername : undefined,
          senderAvatarUrl: currentGate.chat_kind === 'private' ? input.senderAvatarUrl : undefined,
          silent: !useUnsorted, sourceId: route.sourceId,
        });
        await tx.query(
          `INSERT INTO ${this.q('amocrm_message_links')}
            (company_id,account_id,conversation_id,provider_message_id,amo_message_id,direction,actual_provider_message_id,message_id)
           VALUES ($1,$2,$3,$4,$5,'in',$4,(SELECT id FROM ${this.q('messages')} WHERE company_id=$1 AND conversation_id=$3 AND provider_message_id=$4 AND direction='in')) ON CONFLICT DO NOTHING`,
          [input.companyId,input.accountId,input.conversationId,input.providerMessageId,imported.messageId],
        );
      }
      return { projected: true, bindingId: row.id, contactId, leadId: lead.leadId, ambiguous: false };
    });
    if (result.ambiguous || result.creationUnknown) {
      await raiseAlert(this.db, { schema: this.schema ?? 'public' }, {
        companyId: input.companyId, connectionId: gate.connection_id,
        kind: 'manual_review', dedupeKey: `crm_review:${input.accountId}:${input.conversationId}:${input.providerMessageId}`,
        errorCode: 'OUTCOME_UNKNOWN', conversationId: input.conversationId,
        externalMessageId: input.providerMessageId,
      });
    }
    return result;
  }

  private async ensureLead(
    tx: Tx,
    input: {
      companyId: string;
      accountId: string;
      conversationId: string;
      existingLeadId: string | null;
      contactId: string | null;
      pipelineId: string | null;
      statusId: string | null;
      previousLeadId?: string | null;
      destination?: 'unsorted' | 'stage';
      name?: string;
    },
  ): Promise<{ leadId: string | null; creationUnknown: boolean }> {
    // The key carries the contact and the funnel, not just the conversation: the same
    // client writing from two channels must land in one deal, not one deal per chat.
    const intentKey = `lead:${input.conversationId}:${input.contactId ?? 'none'}:${input.pipelineId ?? 'default'}${input.previousLeadId ? `:after:${input.previousLeadId}` : ''}`;
    let leadId = input.existingLeadId;
    if (leadId) {
      // A lead deleted or merged in CRM must never be reused from a stale binding.
      leadId = await this.resolveLeadTombstone(tx, input.companyId, input.accountId, leadId);
    }
    let creationUnknown = false;
    if (!leadId) {
      const intent = await this.claimLeadIntent({
        companyId: input.companyId,
        accountId: input.accountId,
        conversationId: input.conversationId,
        entityKind: 'lead',
        intentKey,
      });
      if (intent.state === 'created' && intent.externalId) {
        leadId = intent.externalId;
      } else if (intent.claimed) {
        try {
          const created = await this.client.createLead({
            companyId: input.companyId,
            accountId: input.accountId,
            conversationId: input.conversationId,
            intentKey,
            contactId: input.contactId,
            pipelineId: input.pipelineId,
            statusId: input.statusId,
            ...(input.destination ? { destination: input.destination } : {}),
            ...(input.name ? { name: input.name } : {}),
          });
          await this.recordIntentOutcome(input.companyId, intent.id, 'created', created.id);
          leadId = created.id;
        } catch (error) {
          await this.recordIntentOutcome(
            input.companyId,
            intent.id,
            error instanceof RateLimitError ? 'failed' : 'creation_unknown',
          );
          throw error;
        }
      } else {
        // The outcome of an earlier attempt is unknown: reconciliation or manual
        // review decides, never a second createLead call.
        creationUnknown = true;
      }
    }
    if (!leadId) return { leadId: null, creationUnknown };
    await tx.query(
      `INSERT INTO ${this.q('conversation_leads')}
         (company_id,id,account_id,conversation_id,lead_id,link_state)
       VALUES ($1,$2,$3,$4,$5,'active')
       ON CONFLICT (company_id,account_id,conversation_id,lead_id) DO NOTHING`,
      [
        input.companyId,
        stableId('cl', input.companyId, input.accountId, input.conversationId, leadId),
        input.accountId,
        input.conversationId,
        leadId,
      ],
    );
    await tx.query(
      `UPDATE ${this.q('crm_bindings')} SET lead_id=$3, version=version+1
        WHERE company_id=$1 AND account_id=$2 AND conversation_id=$4 AND lead_id IS NULL`,
      [input.companyId, input.accountId, leadId, input.conversationId],
    );
    return { leadId, creationUnknown: false };
  }

  /**
   * Claims the lead intent in its own transaction. A `created` intent whose lead
   * was deleted in CRM is retired and replaced instead of being reused.
   */
  private async claimLeadIntent(input: IntentInput): Promise<IntentClaim> {
    return withTransaction(this.db, async (tx) => {
      const intent = await this.ensureIntent(tx, input);
      if (intent.state === 'created' && intent.externalId) {
        const resolved = await this.resolveLeadTombstone(tx, input.companyId, input.accountId, intent.externalId);
        if (resolved) {
          return { id: intent.id, state: 'created', externalId: resolved, claimed: false };
        }
        await tx.query(
          `UPDATE ${this.q('crm_create_intents')} SET state='failed', external_id=NULL
            WHERE company_id=$1 AND id=$2`,
          [input.companyId, intent.id],
        );
        await this.markIntent(tx, input.companyId, intent.id, 'dispatching');
        return { id: intent.id, state: 'dispatching', externalId: null, claimed: true };
      }
      if (intent.state === 'creation_unknown' || intent.state === 'dispatching') {
        return { id: intent.id, state: intent.state, externalId: intent.externalId, claimed: false };
      }
      await this.markIntent(tx, input.companyId, intent.id, 'dispatching');
      return { id: intent.id, state: 'dispatching', externalId: intent.externalId, claimed: true };
    });
  }

  /** Manual resolution of a disputed match; never called automatically. */
  async resolveAmbiguity(input: {
    companyId: string;
    accountId: string;
    conversationId: string;
    contactId: string;
  }): Promise<{ bound: boolean }> {
    return withTransaction(this.db, async (tx) => {
      await tx.query(
        `UPDATE ${this.q('amocrm_ambiguous_matches')}
            SET state='resolved', resolved_contact_id=$4
          WHERE company_id=$1 AND account_id=$2 AND conversation_id=$3 AND state='open'`,
        [input.companyId, input.accountId, input.conversationId, input.contactId],
      );
      const chatIntent = await this.claimIntent({
        companyId: input.companyId,
        accountId: input.accountId,
        conversationId: input.conversationId,
        entityKind: 'chat',
        intentKey: `chat:${input.conversationId}`,
      });
      let chatId = chatIntent.state === 'created' ? chatIntent.externalId : null;
      if (!chatId && !chatIntent.claimed) {
        // A previous attempt may have reached CRM; do not create a second chat.
        throw new Error('chat_creation_unknown');
      }
      if (!chatId) {
        try {
          const created = await this.client.createChat({
            companyId: input.companyId,
            accountId: input.accountId,
            conversationId: input.conversationId,
            intentKey: `chat:${input.conversationId}`,
          });
          await this.recordIntentOutcome(input.companyId, chatIntent.id, 'created', created.chatId);
          chatId = created.chatId;
        } catch (error) {
          await this.recordIntentOutcome(
            input.companyId,
            chatIntent.id,
            error instanceof RateLimitError ? 'failed' : 'creation_unknown',
          );
          throw error;
        }
      }
      await tx.query(
        `UPDATE ${this.q('crm_bindings')}
            SET contact_id=$3, chat_id=$4, state='bound', version=version+1
          WHERE company_id=$1 AND account_id=$2 AND conversation_id=$5`,
        [input.companyId, input.accountId, input.contactId, chatId, input.conversationId],
      );
      return { bound: true };
    });
  }

  private async tombstone(
    tx: Tx,
    input: {
      companyId: string;
      accountId: string;
      entityType: 'contact' | 'lead' | 'chat' | 'message';
      externalId: string;
      observation: 'deleted' | 'merged';
      replacementExternalId?: string | null;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO ${this.q('crm_entity_tombstones')}
         (company_id,account_id,entity_type,external_id,observation,replacement_external_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (company_id,account_id,entity_type,external_id) DO UPDATE
         SET observation=EXCLUDED.observation,
             replacement_external_id=EXCLUDED.replacement_external_id,
             observed_at=now()`,
      [
        input.companyId,
        input.accountId,
        input.entityType,
        input.externalId,
        input.observation,
        input.replacementExternalId ?? null,
      ],
    );
  }

  /**
   * Applies an event that originated in CRM. It only updates local mappings and
   * never calls the CRM client, so CRM-originated changes cannot echo back.
   */
  async applyCrmEvent(input: CrmEventInput): Promise<{ action: string }> {
    const payload = input.payload;
    const id = payload.id === undefined || payload.id === null ? null : String(payload.id);
    if (!id) return { action: 'ignored' };

    return withTransaction(this.db, async (tx) => {
      switch (input.kind) {
        case 'lead.merged': {
          const target = payload.merged_into_id ?? (payload.merged_into as { id?: unknown } | undefined)?.id;
          if (target === undefined || target === null) return { action: 'ignored' };
          const replacement = String(target);
          await tx.query(
            `UPDATE ${this.q('conversation_leads')}
                SET link_state='merged', merged_into_lead_id=$4
              WHERE company_id=$1 AND account_id=$2 AND lead_id=$3 AND link_state='active'`,
            [input.companyId, input.accountId, id, replacement],
          );
          await tx.query(
            `UPDATE ${this.q('crm_bindings')} SET lead_id=$4, version=version+1
              WHERE company_id=$1 AND account_id=$2 AND lead_id=$3`,
            [input.companyId, input.accountId, id, replacement],
          );
          await this.tombstone(tx, {
            companyId: input.companyId,
            accountId: input.accountId,
            entityType: 'lead',
            externalId: id,
            observation: 'merged',
            replacementExternalId: replacement,
          });
          return { action: 'lead_merged' };
        }
        case 'lead.deleted': {
          await tx.query(
            `UPDATE ${this.q('conversation_leads')} SET link_state='deleted'
              WHERE company_id=$1 AND account_id=$2 AND lead_id=$3 AND link_state='active'`,
            [input.companyId, input.accountId, id],
          );
          await tx.query(
            `UPDATE ${this.q('crm_bindings')} SET lead_id=NULL, version=version+1
              WHERE company_id=$1 AND account_id=$2 AND lead_id=$3`,
            [input.companyId, input.accountId, id],
          );
          await this.tombstone(tx, {
            companyId: input.companyId,
            accountId: input.accountId,
            entityType: 'lead',
            externalId: id,
            observation: 'deleted',
          });
          return { action: 'lead_deleted' };
        }
        case 'contact.merged': {
          const target = payload.merged_into_id ?? (payload.merged_into as { id?: unknown } | undefined)?.id;
          const replacement = target === undefined || target === null ? null : String(target);
          if (replacement) {
            await tx.query(
              `UPDATE ${this.q('crm_bindings')} SET contact_id=$4, version=version+1
                WHERE company_id=$1 AND account_id=$2 AND contact_id=$3`,
              [input.companyId, input.accountId, id, replacement],
            );
          }
          await this.tombstone(tx, {
            companyId: input.companyId,
            accountId: input.accountId,
            entityType: 'contact',
            externalId: id,
            observation: 'merged',
            replacementExternalId: replacement,
          });
          return { action: 'contact_merged' };
        }
        case 'contact.deleted': {
          // The binding intentionally survives: archive links must outlive CRM.
          await this.tombstone(tx, {
            companyId: input.companyId,
            accountId: input.accountId,
            entityType: 'contact',
            externalId: id,
            observation: 'deleted',
          });
          return { action: 'contact_deleted' };
        }
        case 'chat.deleted': {
          await this.tombstone(tx, {
            companyId: input.companyId,
            accountId: input.accountId,
            entityType: 'chat',
            externalId: id,
            observation: 'deleted',
          });
          return { action: 'chat_deleted' };
        }
        case 'message.deleted': {
          await this.tombstone(tx, {
            companyId: input.companyId,
            accountId: input.accountId,
            entityType: 'message',
            externalId: id,
            observation: 'deleted',
          });
          await tx.query(
            `UPDATE ${this.q('messages')} SET deleted_at=now()
              WHERE company_id=$1 AND provider_message_id=$2 AND deleted_at IS NULL`,
            [input.companyId, id],
          );
          return { action: 'message_deleted' };
        }
        case 'message.created':
        case 'chats.message': {
          const message = (payload.message ?? {}) as Record<string, unknown>;
          const providerMessageId =
            typeof payload.provider_message_id === 'string'
              ? payload.provider_message_id
              : typeof message.id === 'string'
                ? message.id
                : null;
          const conversationId =
            typeof payload.conversation_id === 'string' ? payload.conversation_id : null;
          const direction = payload.direction === 'out' || message.direction === 'out' ? 'out' : 'in';
          if (!providerMessageId || !conversationId) return { action: 'ignored' };
          const inserted = await tx.query(
            `INSERT INTO ${this.q('amocrm_message_links')}
               (company_id,account_id,conversation_id,provider_message_id,amo_message_id,direction)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (company_id,account_id,conversation_id,provider_message_id) DO NOTHING`,
            [input.companyId, input.accountId, conversationId, providerMessageId, id, direction],
          );
          if ((inserted.rowCount ?? 0) === 0) return { action: 'echo_ignored' };
          return { action: 'message_linked' };
        }
        default:
          return { action: 'ignored' };
      }
    });
  }

  /** Reconciles intents whose external outcome was unknown after a crash. */
  async reconcileCreateIntents(input: {
    companyId: string;
    accountId: string;
    conversationId: string;
  }): Promise<{ reconciled: number }> {
    const { rows } = await this.db.query<{ id: string; entity_kind: string; intent_key: string }>(
      `SELECT id, entity_kind, intent_key FROM ${this.q('crm_create_intents')}
        WHERE company_id=$1 AND account_id=$2 AND conversation_id=$3
          AND state IN ('creation_unknown','dispatching','failed')`,
      [input.companyId, input.accountId, input.conversationId],
    );
    let reconciled = 0;
    for (const intent of rows) {
      if (intent.entity_kind === 'contact' && this.client.findContactByIntentKey) {
        const found = await this.client.findContactByIntentKey({
          companyId: input.companyId,
          accountId: input.accountId,
          intentKey: intent.intent_key,
        });
        if (found) {
          await this.db.query(
            `UPDATE ${this.q('crm_create_intents')} SET state='created', external_id=$3
              WHERE company_id=$1 AND id=$2`,
            [input.companyId, intent.id, found.id],
          );
          reconciled += 1;
        }
      } else if (intent.entity_kind === 'lead' && this.client.findLeadByIntentKey) {
        const found = await this.client.findLeadByIntentKey({
          companyId: input.companyId,
          accountId: input.accountId,
          intentKey: intent.intent_key,
        });
        if (found) {
          await this.db.query(
            `UPDATE ${this.q('crm_create_intents')} SET state='created', external_id=$3
              WHERE company_id=$1 AND id=$2`,
            [input.companyId, intent.id, found.id],
          );
          reconciled += 1;
        }
      }
    }
    return { reconciled };
  }
}

export const PROJECTION_JOB_KIND = 'amocrm.projection';

/** The only job kinds this worker is allowed to claim. */
const SUPPORTED_JOB_KINDS: readonly string[] = [PROJECTION_JOB_KIND];

export type OutboundQueueDeps = {
  db: Db;
  schema?: string;
  now?: () => number;
  workerId?: string;
  dispatch: (payload: unknown) => Promise<unknown>;
  maxAttempts?: number;
  /** Job kinds this queue may claim. Defaults to the CRM projection kind only. */
  jobKinds?: readonly string[];
  /** Lease duration in milliseconds. */
  leaseMs?: number;
  /** How often the lease is extended while dispatching; 0 disables the heartbeat. */
  heartbeatIntervalMs?: number;
};

export type QueueRunResult = { attempted: number; completed: number; retried: number; failed: number };

/**
 * Durable outbound projection queue. A 429 pauses the job until Retry-After;
 * the job is never dispatched twice after completion.
 */
export class OutboundQueue {
  private readonly db: Db;
  private readonly schema: string | undefined;
  private readonly now: () => number;
  private readonly workerId: string;
  private readonly dispatch: (payload: unknown) => Promise<unknown>;
  private readonly maxAttempts: number;
  private readonly jobKinds: readonly string[];
  private readonly leaseMs: number;
  private readonly heartbeatIntervalMs: number;

  constructor(deps: OutboundQueueDeps) {
    this.db = deps.db;
    this.schema = deps.schema;
    this.now = deps.now ?? (() => Date.now());
    this.workerId = deps.workerId ?? 'worker';
    this.dispatch = deps.dispatch;
    this.maxAttempts = deps.maxAttempts ?? 5;
    this.jobKinds = deps.jobKinds ?? SUPPORTED_JOB_KINDS;
    this.leaseMs = deps.leaseMs ?? 60_000;
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? Math.max(1, Math.floor(this.leaseMs / 3));
  }

  private q(name: string): string {
    return qualified(this.schema, name);
  }

  async enqueue(input: { companyId: string; intentKey: string; payload: Record<string, unknown> }): Promise<string> {
    const id = `job_${randomBytes(10).toString('hex')}`;
    await this.db.query(
      `INSERT INTO ${this.q('outbox_jobs')}(company_id,id,job_kind,intent_key,payload,state,available_at)
       VALUES ($1,$2,'${PROJECTION_JOB_KIND}',$3,$4,'pending',to_timestamp($5/1000.0))
       ON CONFLICT (company_id,job_kind,intent_key) DO NOTHING`,
      [input.companyId, id, input.intentKey, JSON.stringify(input.payload), this.now()],
    );
    return id;
  }

  async runOnce(input: { companyId?: string } = {}): Promise<QueueRunResult> {
    const nowMs = this.now();
    const job = await withTransaction(this.db, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        company_id: string;
        payload: unknown;
        attempt_count: number;
      }>(
        `SELECT id, company_id, payload, attempt_count FROM ${this.q('outbox_jobs')}
          WHERE ((state='pending' AND available_at <= to_timestamp($1/1000.0))
                 OR (state='leased' AND lease_until <= to_timestamp($1/1000.0)))
            AND ($2::text IS NULL OR company_id=$2)
            AND job_kind = ANY($3::text[])
          ORDER BY available_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
        [nowMs, input.companyId ?? null, this.jobKinds],
      );
      const row = rows[0];
      if (!row) return null;
      const leased = await tx.query<{ fence: string }>(
        `UPDATE ${this.q('outbox_jobs')}
            SET state='leased', lease_owner=$3, lease_until=to_timestamp($4/1000.0), fence=fence+1
          WHERE company_id=$1 AND id=$2
          RETURNING fence`,
        [row.company_id, row.id, this.workerId, nowMs + this.leaseMs],
      );
      return { ...row, fence: Number(leased.rows[0]!.fence) };
    });
    if (!job) return { attempted: 0, completed: 0, retried: 0, failed: 0 };

    const stopHeartbeat = this.startHeartbeat(job.company_id, job.id, job.fence);
    try {
      await this.dispatch(job.payload);
      const applied = await this.finishJob(job.company_id, job.id, job.fence, 'completed');
      if (!applied) return { attempted: 1, completed: 0, retried: 0, failed: 0 };
      return { attempted: 1, completed: 1, retried: 0, failed: 0 };
    } catch (error) {
      const attempts = job.attempt_count + 1;
      if (error instanceof RateLimitError) {
        const applied = await this.finishJob(job.company_id, job.id, job.fence, 'retried', {
          availableAt: nowMs + error.retryAfterMs,
        });
        if (!applied) return { attempted: 1, completed: 0, retried: 0, failed: 0 };
        return { attempted: 1, completed: 0, retried: 1, failed: 0 };
      }
      if (attempts >= this.maxAttempts) {
        const applied = await this.finishJob(job.company_id, job.id, job.fence, 'failed');
        if (!applied) return { attempted: 1, completed: 0, retried: 0, failed: 0 };
        return { attempted: 1, completed: 0, retried: 0, failed: 1 };
      }
      const backoffMs = Math.min(2 ** attempts * 1000, 60_000);
      const applied = await this.finishJob(job.company_id, job.id, job.fence, 'retried', {
        availableAt: nowMs + backoffMs,
      });
      if (!applied) return { attempted: 1, completed: 0, retried: 0, failed: 0 };
      return { attempted: 1, completed: 0, retried: 1, failed: 0 };
    } finally {
      stopHeartbeat();
    }
  }

  /**
   * Applies the outcome of a dispatch only while this worker still owns the
   * lease and fence it acquired. A worker whose lease was taken over must not
   * overwrite the new owner's result; its outcome is kept as audit evidence.
   */
  private async finishJob(
    companyId: string,
    jobId: string,
    fence: number,
    outcome: 'completed' | 'retried' | 'failed',
    options: { availableAt?: number } = {},
  ): Promise<boolean> {
    const state = outcome === 'completed' ? 'completed' : outcome === 'failed' ? 'failed' : 'pending';
    const params: unknown[] = [companyId, jobId, fence, this.workerId];
    let sql =
      `UPDATE ${this.q('outbox_jobs')}
          SET state='${state}', lease_owner=NULL, lease_until=NULL, attempt_count=attempt_count+1`;
    if (state === 'pending') {
      sql += `, available_at=to_timestamp($5/1000.0)`;
      params.push(options.availableAt ?? this.now());
    }
    sql += ` WHERE company_id=$1 AND id=$2 AND fence=$3 AND lease_owner=$4 AND state='leased'`;
    const { rowCount } = await this.db.query(sql, params);
    if ((rowCount ?? 0) > 0) return true;
    await this.recordRejectedOutcome(companyId, jobId, fence, outcome);
    return false;
  }

  private async recordRejectedOutcome(
    companyId: string,
    jobId: string,
    fence: number,
    outcome: string,
  ): Promise<void> {
    try {
      await withTransaction(this.db, (tx) =>
        writeAudit(tx, {
          companyId,
          eventName: 'outbox.dispatch_result_rejected',
          subjectId: jobId,
          actorId: null,
          traceId: `fence:${fence}`,
          diagnosticCode: outcome,
        }),
      );
    } catch {
      // Evidence collection must never mask the dispatch outcome.
    }
  }

  /** Extends the lease while a dispatch is in flight, so long calls are not stolen. */
  private startHeartbeat(companyId: string, jobId: string, fence: number): () => void {
    if (this.heartbeatIntervalMs <= 0) return () => undefined;
    const timer = setInterval(() => {
      void this.db
        .query(
          `UPDATE ${this.q('outbox_jobs')} SET lease_until=to_timestamp($5/1000.0)
            WHERE company_id=$1 AND id=$2 AND fence=$3 AND lease_owner=$4 AND state='leased'`,
          [companyId, jobId, fence, this.workerId, this.now() + this.leaseMs],
        )
        .catch(() => undefined);
    }, this.heartbeatIntervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}
