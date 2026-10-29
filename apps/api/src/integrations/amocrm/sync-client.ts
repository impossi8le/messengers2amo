// amoCRM adapter for the CRM projection contract (AmocrmSyncClient).
//
// The projection domain owns intent claiming, idempotency and the ambiguous-outcome
// rules; this module is the only place that turns its four operations into amoCRM
// requests. Failures are never swallowed: an upstream problem must reach the caller
// so the intent can be marked `creation_unknown` instead of being retried blindly.
//
// REST and Chats payloads follow the official API reference. Account permissions
// and the end-to-end appearance in the native chat still need live acceptance.

import { createHash } from 'node:crypto';
import {
  AmocrmApiError,
  AmocrmClient,
  AuthRequiredError,
  type AmocrmClientOptions,
} from './client.ts';
import { AuthRevokedError } from './oauth.ts';
import type { AmocrmSyncClient, CrmContact, CrmLead } from './sync.ts';

export type ChatScope = { scopeId: string; channelSecret: string };

export type AmocrmSyncClientOptions = {
  accountDomain: string;
  /** Resolves the OAuth access token of the account that owns the conversation. */
  getAccessToken: (input: { companyId: string; accountId: string }) => Promise<string>;
  fetch: typeof fetch;
  apiBase?: string;
  chatsBase?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /**
   * Registered Chats API channel of the account. Without it createChat has nowhere
   * to post and refuses instead of inventing a scope.
   */
  getChatScope?: (input: { companyId: string; accountId: string; conversationId: string }) => Promise<ChatScope | null>;
};

type CallInit = { method?: string; body?: unknown };

function positiveInt(value: string | null | undefined, code: string): number | null {
  if (value === null || value === undefined) return null;
  if (!/^[1-9][0-9]*$/.test(value)) throw new AmocrmApiError(0, code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new AmocrmApiError(0, code);
  return parsed;
}

function embeddedList(payload: unknown, key: string): unknown[] {
  if (!payload || typeof payload !== 'object') return [];
  const embedded = (payload as { _embedded?: unknown })._embedded;
  if (!embedded || typeof embedded !== 'object') return [];
  const list = (embedded as Record<string, unknown>)[key];
  return Array.isArray(list) ? list : [];
}

/** Only normalized display metadata; transport credentials never belong in a chat profile. */
function profileFields(input: {senderUsername?:string;senderAvatarUrl?:string}):Record<string,string> {
  const fields:Record<string,string>={};
  if(input.senderUsername&&/^[a-zA-Z0-9_]{1,32}$/.test(input.senderUsername))fields.profile_link=`https://t.me/${input.senderUsername}`;
  if(input.senderAvatarUrl){
    let url:URL;
    try{url=new URL(input.senderAvatarUrl);}catch{throw new AmocrmApiError(0,'invalid_sender_avatar');}
    if(url.protocol!=='https:'||url.username||url.password||url.hash||url.hostname==='api.telegram.org'||url.toString().length>2048)
      throw new AmocrmApiError(0,'invalid_sender_avatar');
    fields.avatar=url.toString();
  }
  return fields;
}

function entityId(payload: unknown, key: string, code: string): string {
  for (const entry of embeddedList(payload, key)) {
    if (!entry || typeof entry !== 'object') continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return String(id);
  }
  throw new AmocrmApiError(200, code);
}

/**
 * Stage ids a lead can still be worked in. amoCRM types a stage as 0 for a working
 * one and 1/2 for won and lost; anything we cannot place in that map is treated as
 * closed, because reusing a stage we do not understand is worse than a new deal.
 */
function openStageIds(payload: unknown): Set<string> {
  const open = new Set<string>();
  for (const pipeline of embeddedList(payload, 'pipelines')) {
    if (!pipeline || typeof pipeline !== 'object') continue;
    const embedded = (pipeline as { _embedded?: unknown })._embedded;
    if (!embedded || typeof embedded !== 'object') continue;
    const statuses = (embedded as Record<string, unknown>).statuses;
    if (!Array.isArray(statuses)) continue;
    for (const status of statuses) {
      if (!status || typeof status !== 'object') continue;
      const { id, type } = status as { id?: unknown; type?: unknown };
      if (typeof id !== 'number' || !Number.isSafeInteger(id)) continue;
      if (type === 0) open.add(String(id));
    }
  }
  return open;
}

function leadOf(entry: unknown, openStages: Set<string>): CrmLead | null {
  if (!entry || typeof entry !== 'object') return null;
  const { id, status_id, updated_at } = entry as { id?: unknown; status_id?: unknown; updated_at?: unknown };
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null;
  if (!openStages.has(String(status_id))) return null;
  const updatedAt =
    typeof updated_at === 'number' && Number.isFinite(updated_at)
      ? new Date(updated_at * 1000).toISOString()
      : null;
  return { id: String(id), updatedAt };
}

function contactOf(entry: unknown): CrmContact | null {
  if (!entry || typeof entry !== 'object') return null;
  const { id, name } = entry as { id?: unknown; name?: unknown };
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null;
  return typeof name === 'string' && name.length > 0 ? { id: String(id), name } : { id: String(id) };
}

export function createAmocrmSyncClient(options: AmocrmSyncClientOptions): AmocrmSyncClient {
  // A client per call keeps the token bound to the company/account that owns the
  // conversation; the account itself is identified by the domain and the token.
  function clientFor(input: { companyId: string; accountId: string }, channelSecret?: string): AmocrmClient {
    const clientOptions: AmocrmClientOptions = {
      accountDomain: options.accountDomain,
      getAccessToken: () => options.getAccessToken(input),
      fetch: options.fetch,
      apiBase: options.apiBase,
      chatsBase: options.chatsBase,
      channelSecret,
      timeoutMs: options.timeoutMs,
      maxResponseBytes: options.maxResponseBytes,
    };
    return new AmocrmClient(clientOptions);
  }

  async function call<T>(client: AmocrmClient, path: string, init: CallInit = {}): Promise<T> {
    try {
      return await client.request<T>(path, init);
    } catch (error) {
      // An expired token is still an upstream HTTP failure for the projection layer;
      // it must not look like a different kind of outcome.
      if (error instanceof AuthRequiredError) throw new AmocrmApiError(401, 'http_401');
      throw error;
    }
  }

  return {
    async linkChat(input) {
      const contactId = positiveInt(input.contactId, 'invalid_contact_id');
      if (!contactId || !input.chatId) throw new AmocrmApiError(0, 'chat_binding_missing');
      const payload = await call<unknown>(clientFor(input), '/api/v4/contacts/chats', {
        method: 'POST', body: [{ contact_id: contactId, chat_id: input.chatId }],
      });
      const matched = embeddedList(payload, 'chats').some((entry) => {
        const row = entry as { contact_id?: unknown; chat_id?: unknown } | null;
        return row?.contact_id === contactId && row.chat_id === input.chatId;
      });
      if (!matched) throw new AmocrmApiError(200, 'invalid_chat_link_response');
    },

    async importMessage(input) {
      const scope = await options.getChatScope?.(input);
      if (!scope) throw new AmocrmApiError(0, 'chat_scope_missing');
      const timestamp = input.occurredAt.getTime();
      if ((!input.text && !input.attachment) || !input.messageId || !input.conversationId || !Number.isFinite(timestamp)) {
        throw new AmocrmApiError(0, 'invalid_message_payload');
      }
      let message: Record<string, unknown> = { type: 'text', text: input.text };
      if (input.attachment) {
        const attachment = input.attachment;
        let url: URL;
        try { url = new URL(attachment.url); } catch { throw new AmocrmApiError(0, 'invalid_message_attachment'); }
        if (!['picture','file','video','voice','audio'].includes(attachment.type) ||
            url.protocol !== 'https:' || url.username || url.password || url.hash ||
            !attachment.fileName || !Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes < 0) {
          throw new AmocrmApiError(0, 'invalid_message_attachment');
        }
        message = { type: attachment.type, text: input.text, media: attachment.url,
          file_name: attachment.fileName, file_size: attachment.sizeBytes };
      }
      const payload: Record<string, unknown> = {
        timestamp: Math.floor(timestamp / 1000), msec_timestamp: timestamp,
        msgid: input.messageId, conversation_id: input.conversationId,
        sender: { id: `peer:${input.conversationId}`, name: input.senderName?.trim() ||
          (input.senderUsername && /^[a-zA-Z0-9_]{1,32}$/.test(input.senderUsername) ? `@${input.senderUsername}` : 'Клиент'), ...profileFields(input) },
        message, silent: input.silent,
      };
      if (input.sourceId) payload.source = { external_id: input.sourceId };
      const result = await clientFor(input, scope.channelSecret).chats<{ new_message?: { msgid?: unknown } }>(scope.scopeId, '', {
        method: 'POST', body: { event_type: 'new_message', payload },
      });
      const messageId = result?.new_message?.msgid;
      if (typeof messageId !== 'string' || !messageId) throw new AmocrmApiError(200, 'invalid_message_response');
      return { messageId };
    },
    async findContacts(input) {
      const term = input.phone?.trim() || input.email?.trim() || '';
      if (!term) {
        // An empty search would return the first page of every contact, and the caller
        // would read that as "no match" and create a duplicate.
        throw new AmocrmApiError(0, 'contact_query_missing');
      }
      const payload = await call<unknown>(
        clientFor(input),
        `/api/v4/contacts?query=${encodeURIComponent(term)}`,
      );
      const contacts: CrmContact[] = [];
      for (const entry of embeddedList(payload, 'contacts')) {
        const contact = contactOf(entry);
        if (contact) contacts.push(contact);
      }
      return contacts;
    },

    async findOpenLeads(input) {
      const client = clientFor(input);
      const contactId=positiveInt(input.contactId,'invalid_contact_id');
      if (!contactId) throw new AmocrmApiError(0,'invalid_contact_id');
      // The documented contact relation is authoritative; an unsupported leads
      // filter may otherwise be ignored upstream and return another client's deal.
      const contact=await call<{id?:unknown}>(client,`/api/v4/contacts/${contactId}?with=leads`);
      if (contact?.id!==contactId) throw new AmocrmApiError(200,'invalid_contact_response');
      const ids=embeddedList(contact,'leads').map((entry)=>{
        const id=(entry as {id?:unknown}|null)?.id;
        if (typeof id!=='number' || !Number.isSafeInteger(id) || id<=0) throw new AmocrmApiError(200,'invalid_contact_lead');
        return id;
      });
      if (ids.length>100) throw new AmocrmApiError(0,'contact_lead_limit_exceeded');
      if (ids.length===0) return [];
      // Which stages are final is account-specific, so it is read from the pipeline
      // metadata instead of assuming the built-in 142/143 ids.
      const openStages = openStageIds(await call<unknown>(client, '/api/v4/leads/pipelines'));
      const leads: CrmLead[] = [];
      for (let offset=0;offset<ids.length;offset+=8) {
        const entries=await Promise.all(ids.slice(offset,offset+8).map((id)=>call<unknown>(client,`/api/v4/leads/${id}`)));
        for (const entry of entries) {
          const lead = leadOf(entry, openStages);
          if (lead) leads.push(lead);
        }
      }
      return leads;
    },

    async createContact(input) {
      const name = input.name?.trim() || input.phone?.trim() || '';
      if (!name) throw new AmocrmApiError(0, 'contact_identity_missing');
      const fields: Record<string, unknown>[] = [];
      if (input.phone?.trim()) {
        fields.push({ field_code: 'PHONE', values: [{ value: input.phone.trim(), enum_code: 'WORK' }] });
      }
      if (input.email?.trim()) {
        fields.push({ field_code: 'EMAIL', values: [{ value: input.email.trim(), enum_code: 'WORK' }] });
      }
      const body: Record<string, unknown> = { name };
      if (fields.length > 0) body.custom_fields_values = fields;
      const payload = await call<unknown>(clientFor(input), '/api/v4/contacts', {
        method: 'POST',
        body: [body],
      });
      return { id: entityId(payload, 'contacts', 'invalid_contact_response') };
    },

    async createLead(input) {
      const body: Record<string, unknown> = { name: input.name?.trim() || 'Новая сделка' };
      const pipelineId = positiveInt(input.pipelineId, 'invalid_pipeline_id');
      const statusId = positiveInt(input.statusId, 'invalid_status_id');
      if (pipelineId !== null) body.pipeline_id = pipelineId;
      if (statusId !== null) body.status_id = statusId;
      const contactId = positiveInt(input.contactId, 'invalid_contact_id');
      if (input.destination === 'unsorted') {
        if (pipelineId === null || statusId !== null) throw new AmocrmApiError(0, 'invalid_unsorted_route');
        const timestamp = Math.floor(Date.now() / 1000);
        const sourceUid = createHash('sha256')
          .update(JSON.stringify([input.companyId, input.accountId, input.intentKey])).digest('hex');
        const payload = await call<unknown>(clientFor(input), '/api/v4/leads/unsorted/forms', {
          method: 'POST',
          body: [{
            source_uid: sourceUid, source_name: 'Messengers2amo · Telegram',
            pipeline_id: pipelineId, created_at: timestamp,
            metadata: {
              form_id: 'messengers2amo-telegram', form_name: 'Messengers2amo Telegram',
              form_page: 'https://messengers.example.com', form_sent_at: timestamp,
            },
            _embedded: { leads: [{ name: body.name }],
              ...(contactId !== null ? { contacts: [{ id: contactId }] } : {}) },
          }],
        });
        const item = embeddedList(payload, 'unsorted')[0];
        return { id: entityId(item, 'leads', 'invalid_unsorted_response') };
      }
      if (contactId !== null) body._embedded = { contacts: [{ id: contactId }] };
      const payload = await call<unknown>(clientFor(input), '/api/v4/leads', {
        method: 'POST',
        body: [body],
      });
      return { id: entityId(payload, 'leads', 'invalid_lead_response') };
    },

    async createChat(input) {
      const scope = await options.getChatScope?.(input);
      if (!scope) throw new AmocrmApiError(0, 'chat_scope_missing');
      const externalChatId = input.externalChatId?.trim();
      if (!externalChatId) throw new AmocrmApiError(0, 'chat_identity_missing');
      const client = clientFor(input, scope.channelSecret);
      let payload: unknown;
      try {
        payload = await client.chats<unknown>(scope.scopeId, '/chats', {
          method: 'POST',
          body: {
            conversation_id: input.conversationId,
            user: { id: `peer:${input.conversationId}`, name: input.chatName?.trim() || externalChatId, ...profileFields(input) },
            ...(input.sourceId ? { source: { external_id: input.sourceId } } : {}),
          },
        });
      } catch (error) {
        if (error instanceof AuthRevokedError) throw new AmocrmApiError(401, 'http_401');
        throw error;
      }
      const id = (payload as { id?: unknown } | null)?.id;
      if (typeof id !== 'string' || id.length === 0) throw new AmocrmApiError(200, 'invalid_chat_response');
      return { chatId: id };
    },
  };
}
