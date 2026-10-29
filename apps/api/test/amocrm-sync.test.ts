import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { seedAmocrm } from './helpers/amocrm.ts';
import type { Db } from '../src/platform/db.ts';
import {
  AmocrmSync,
  OutboundQueue,
  type AmocrmSyncClient,
  type CrmContact,
  type CrmLead,
} from '../src/integrations/amocrm/sync.ts';
import { RateLimitError } from '../src/integrations/amocrm/oauth.ts';

type ClientState = {
  contacts: CrmContact[];
  createdContacts: number;
  createdChats: number;
  createdLeads: number;
  calls: string[];
  existingByIntent: CrmContact | null;
  /** Open deals the contact already has; the domain must reuse the newest. */
  openLeads: CrmLead[];
  /** The arguments of the last createLead call, so the funnel and stage are checkable. */
  lastCreateLead: Record<string, unknown> | null;
  /** Simulates a creation that reached amoCRM but whose response was lost. */
  failAfterCreate: 'contact' | 'chat' | 'lead' | null;
  imported: Array<{ messageId: string; silent: boolean }>;
};

function fakeClient(overrides: Partial<ClientState> = {}): { client: AmocrmSyncClient; state: ClientState } {
  const state: ClientState = {
    contacts: [],
    createdContacts: 0,
    createdChats: 0,
    createdLeads: 0,
    calls: [],
    existingByIntent: null,
    openLeads: [],
    lastCreateLead: null,
    imported: [],
    ...overrides,
    failAfterCreate: overrides.failAfterCreate ?? null,
  };
  const client: AmocrmSyncClient = {
    async linkChat() { state.calls.push('linkChat'); },
    async importMessage(input) {
      state.calls.push('importMessage');
      state.imported.push({ messageId: input.messageId, silent: input.silent });
      return { messageId: `amo:${input.messageId}` };
    },
    async findContacts() {
      state.calls.push('findContacts');
      return state.contacts;
    },
    async findOpenLeads() {
      state.calls.push('findOpenLeads');
      return state.openLeads;
    },
    async createContact() {
      state.calls.push('createContact');
      state.createdContacts += 1;
      if (state.failAfterCreate === 'contact') throw new Error('lost response');
      return { id: `contact-${state.createdContacts}` };
    },
    async createChat() {
      state.calls.push('createChat');
      state.createdChats += 1;
      if (state.failAfterCreate === 'chat') throw new Error('lost response');
      return { chatId: `chat-${state.createdChats}` };
    },
    async createLead(input) {
      state.calls.push('createLead');
      state.lastCreateLead = input as unknown as Record<string, unknown>;
      state.createdLeads += 1;
      if (state.failAfterCreate === 'lead') throw new Error('lost response');
      state.openLeads.push({id:`lead-${state.createdLeads}`,updatedAt:new Date().toISOString()});
      return { id: `lead-${state.createdLeads}` };
    },
    async findContactByIntentKey() {
      state.calls.push('findContactByIntentKey');
      return state.existingByIntent;
    },
  };
  return { client, state };
}

async function count(db: Db, schema: string, table: string, where = ''): Promise<number> {
  const { rows } = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM "${schema}".${table} ${where}`);
  return rows[0]!.c;
}

function inbound(seed: { companyId: string; accountId: string; conversationId: string }, messageId = 'ext-msg-1') {
  return {
    companyId: seed.companyId,
    accountId: seed.accountId,
    conversationId: seed.conversationId,
    providerMessageId: messageId,
    direction: 'in' as const,
    text: 'private text',
    phone: '79990000000',
  };
}

test('new inbound defaults to unassigned Unsorted and repeated webhook imports one chat message', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const seed = await seedAmocrm(db, schema);
    const { client, state } = fakeClient();
    const sync = new AmocrmSync({ db, schema, client });
    const first = await sync.projectInboundMessage(inbound(seed));
    await sync.projectInboundMessage(inbound(seed));
    assert.equal(first.leadId, null);
    assert.equal(state.createdLeads, 0, 'a new request is not made into an assigned working lead');
    assert.equal(state.imported.length, 1);
    assert.equal(state.imported[0]!.silent, false, 'amoCRM receives a new Unsorted request');
    assert.equal(await count(db, schema, 'amocrm_message_links'), 1);
    assert.ok(state.calls.indexOf('linkChat') < state.calls.indexOf('importMessage'));
  } finally { await close(); }
});

test('message retry after a lost response keeps its stable Chats API message id', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const seed = await seedAmocrm(db, schema);
    const { client } = fakeClient();
    const ids: string[] = [];
    client.importMessage = async (input) => {
      ids.push(input.messageId);
      if (ids.length === 1) throw new Error('lost import response');
      return { messageId: 'amo-recovered' };
    };
    const sync = new AmocrmSync({ db, schema, client });
    await assert.rejects(() => sync.projectInboundMessage(inbound(seed)), /lost import response/);
    assert.equal(await count(db, schema, 'amocrm_message_links'), 0);
    await sync.projectInboundMessage(inbound(seed));
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1]);
    assert.equal(await count(db, schema, 'amocrm_message_links'), 1);
  } finally { await close(); }
});

test('a previously bound but now closed lead is not reopened on the next incoming message',async()=>{
  const {db,schema,close}=await createTestDb();
  try {
    const seed=await seedAmocrm(db,schema);
    await seedRouting(db,schema,seed,{statusId:'stage-1'});
    const {client,state}=fakeClient();
    const sync=new AmocrmSync({db,schema,client});
    const first=await sync.projectInboundMessage(inbound(seed,'first'));
    assert.equal(first.leadId,'lead-1');
    state.openLeads=[];
    const next=await sync.projectInboundMessage(inbound(seed,'returned'));
    assert.equal(next.leadId,'lead-2');
    assert.equal(state.createdLeads,2);
    assert.ok(String(state.lastCreateLead?.intentKey).endsWith(':after:lead-1'));
    const binding=await db.query('SELECT lead_id FROM crm_bindings WHERE conversation_id=$1',[seed.conversationId]);
    assert.equal(binding.rows[0].lead_id,'lead-2');
  } finally {await close();}
});

test('a repeated inbound event creates no duplicate contact, lead, chat or message', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const seed = await seedAmocrm(db, schema);
    const { client, state } = fakeClient();
    const sync = new AmocrmSync({ db, schema, client, newLeadDestination: 'stage' });
    const first = await sync.projectInboundMessage(inbound(seed));
    const second = await sync.projectInboundMessage(inbound(seed));
    assert.equal(first.projected, true);
    assert.equal(second.projected, true);
    assert.equal(first.contactId, second.contactId);
    assert.equal(first.leadId, second.leadId);
    assert.equal(state.createdContacts, 1);
    assert.equal(state.createdChats, 1);
    assert.equal(state.createdLeads, 1);
    assert.equal(await count(db, schema, 'crm_bindings'), 1);
    assert.equal(await count(db, schema, 'conversation_leads'), 1);
    assert.equal(await count(db, schema, 'messages'), 1);
    assert.equal(await count(db, schema, 'message_versions'), 1);
    assert.equal(await count(db, schema, 'crm_create_intents', `WHERE entity_kind='contact'`), 1);
    assert.equal(await count(db, schema, 'crm_create_intents', `WHERE entity_kind='lead'`), 1);
    assert.equal(await count(db, schema, 'crm_create_intents', `WHERE entity_kind='chat'`), 1);
  } finally {
    await close();
  }
});

test('same-name contacts are never merged automatically; a manual ambiguity is recorded', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const seed = await seedAmocrm(db, schema);
    const { client, state } = fakeClient({
      contacts: [
        { id: '100', name: 'Иван' },
        { id: '101', name: 'Иван' },
      ],
    });
    const sync = new AmocrmSync({ db, schema, client, newLeadDestination: 'stage' });
    const result = await sync.projectInboundMessage(inbound(seed));
    assert.equal(result.projected, true);
    assert.equal(result.ambiguous, true);
    assert.equal(result.contactId, null);
    assert.equal(state.createdContacts, 0, 'ambiguous match must not create a new contact');
    assert.equal(await count(db, schema, 'crm_bindings', `WHERE state='bound'`), 0);
    assert.equal(await count(db, schema, 'amocrm_ambiguous_matches'), 1);
    const { rows } = await db.query<{ candidates: unknown; state: string; reason: string }>(
      `SELECT candidates, state, reason FROM "${schema}".amocrm_ambiguous_matches`,
    );
    assert.deepEqual(rows[0]!.candidates, [{ id: '100', name: 'Иван' }, { id: '101', name: 'Иван' }]);
    assert.equal(rows[0]!.state, 'open');
    assert.equal(rows[0]!.reason, 'multiple_candidates');

    await sync.projectInboundMessage(inbound(seed));
    assert.equal(await count(db, schema, 'amocrm_ambiguous_matches'), 1, 'repeat event must not create a second dispute');

    const resolved = await sync.resolveAmbiguity({
      companyId: seed.companyId,
      accountId: seed.accountId,
      conversationId: seed.conversationId,
      contactId: '101',
    });
    assert.equal(resolved.bound, true);
    assert.equal(await count(db, schema, 'crm_bindings', `WHERE state='bound' AND contact_id='101'`), 1);
    assert.equal(await count(db, schema, 'amocrm_ambiguous_matches', `WHERE state='resolved'`), 1);
  } finally {
    await close();
  }
});

/** A connection with routing settings needs a workshop, an owner and a source to exist. */
async function seedRouting(
  db: Db,
  schema: string,
  seed: { companyId: string; accountId: string; connectionId: string },
  routing: { funnelId?: string; statusId?: string | null; normalizePhone?: boolean } = {},
): Promise<void> {
  await db.query(
    `INSERT INTO "${schema}".workshops(company_id,id,display_name) VALUES ($1,'w1','Workshop') ON CONFLICT DO NOTHING`,
    [seed.companyId],
  );
  await db.query(
    `INSERT INTO "${schema}".staff(company_id,id,display_name) VALUES ($1,'owner1','Owner') ON CONFLICT DO NOTHING`,
    [seed.companyId],
  );
  await db.query(
    `INSERT INTO "${schema}".crm_sources(company_id,id,account_id,external_id,origin_code)
     VALUES ($1,'src1',$2,'ext-src1','chat') ON CONFLICT DO NOTHING`,
    [seed.companyId, seed.accountId],
  );
  await db.query(
    `INSERT INTO "${schema}".connection_routes
       (company_id,connection_id,workshop_id,crm_account_id,funnel_id,default_owner_id,
        technical_source_id,status_id,normalize_phone,version)
     VALUES ($1,$2,'w1',$3,$4,'owner1','src1',$5,$6,1)`,
    [
      seed.companyId,
      seed.connectionId,
      seed.accountId,
      routing.funnelId ?? 'funnel-1',
      routing.statusId ?? null,
      routing.normalizePhone ?? false,
    ],
  );
}

test('explicit capture creates one routed Unsorted lead across retries and later messages without a native chat', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const seed = await seedAmocrm(db, schema);
    await seedRouting(db, schema, seed, { funnelId: '10007030' });
    const { client, state } = fakeClient();
    const sync = new AmocrmSync({ db, schema, client, captureOnly: true });
    const first = await sync.projectInboundMessage({ ...inbound(seed), phone: null, email: null });
    const retry = await sync.projectInboundMessage({ ...inbound(seed), phone: null, email: null });
    const next = await sync.projectInboundMessage({ ...inbound(seed, 'second-message'), phone: null, email: null });
    assert.equal(first.reason, 'lead_capture_only');
    assert.equal(first.leadId, retry.leadId);
    assert.equal(first.leadId, next.leadId);
    assert.equal(state.createdContacts, 1);
    assert.equal(state.createdLeads, 1);
    assert.equal(state.createdChats, 0);
    assert.equal(state.imported.length, 0);
    assert.equal(state.lastCreateLead?.pipelineId, '10007030');
    assert.equal(state.lastCreateLead?.destination, 'unsorted');
    assert.deepEqual(state.calls, ['createContact', 'createLead']);
    assert.equal(await count(db, schema, 'amocrm_message_links'), 0);
    const binding = (await db.query(`SELECT state, chat_id, contact_id, lead_id FROM "${schema}".crm_bindings`)).rows[0];
    assert.equal(binding.state, 'pending');
    assert.equal(binding.chat_id, null);
    assert.equal(binding.contact_id, first.contactId);
    assert.equal(binding.lead_id, first.leadId);
  } finally { await close(); }
});

test('capture cannot create a lead without an explicit route or when the channel policy denies import', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const seed = await seedAmocrm(db, schema);
    const { client, state } = fakeClient();
    const sync = new AmocrmSync({ db, schema, client, captureOnly: true });
    await assert.rejects(sync.projectInboundMessage(inbound(seed)), /lead_capture_route_missing/);
    await seedRouting(db, schema, seed);
    await db.query(`UPDATE "${schema}".channel_policies SET crm_projection_enabled=false`);
    const denied = await sync.projectInboundMessage(inbound(seed));
    assert.equal(denied.reason, 'crm_import_denied');
    assert.deepEqual(state.calls, []);
  } finally { await close(); }
});

test('capture retains an ambiguous lead creation outcome and never creates a duplicate on retry', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const seed = await seedAmocrm(db, schema);
    await seedRouting(db, schema, seed, { funnelId: '10007030' });
    const { client, state } = fakeClient({ failAfterCreate: 'lead' });
    const sync = new AmocrmSync({ db, schema, client, captureOnly: true });
    await assert.rejects(sync.projectInboundMessage(inbound(seed)), /lost response/);
    const result = await sync.projectInboundMessage(inbound(seed));
    assert.equal(result.creationUnknown, true);
    assert.equal(state.createdContacts, 1);
    assert.equal(state.createdLeads, 1);
    assert.equal(state.createdChats, 0);
    assert.equal(await count(db, schema, 'amocrm_message_links'), 0);
  } finally { await close(); }
});

test('a returning client lands in the deal that is already open', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const seed = await seedAmocrm(db, schema);
    await seedRouting(db, schema, seed, { funnelId: 'funnel-1', statusId: 'stage-3' });
    const { client, state } = fakeClient({
      contacts: [{ id: 'contact-existing' }],
      openLeads: [
        { id: 'lead-old', updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'lead-new', updatedAt: '2026-09-01T00:00:00.000Z' },
      ],
    });
    const sync = new AmocrmSync({ db, schema, client, newLeadDestination: 'stage' });

    const result = await sync.projectInboundMessage(inbound(seed));

    assert.equal(result.projected, true);
    assert.equal(result.leadId, 'lead-new', 'the most recently updated open deal wins');
    assert.equal(state.createdLeads, 0, 'a client who already has an open deal gets no second one');
    const { rows } = await db.query<{ lead_id: string }>(
      `SELECT lead_id FROM "${schema}".crm_bindings WHERE company_id=$1 AND conversation_id=$2`,
      [seed.companyId, seed.conversationId],
    );
    assert.equal(rows[0]!.lead_id, 'lead-new');
    assert.equal(
      await count(db, schema, 'audit_events', `WHERE event_name='crm.lead_reused' AND subject_id='lead-new'`),
      1,
      'the choice is recorded with the deal it picked',
    );
  } finally {
    await close();
  }
});

test('a client with no open deal gets one in the routed funnel and stage', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const seed = await seedAmocrm(db, schema);
    await seedRouting(db, schema, seed, { funnelId: 'funnel-9', statusId: 'stage-7' });
    const { client, state } = fakeClient({ contacts: [{ id: 'contact-existing' }], openLeads: [] });
    const sync = new AmocrmSync({ db, schema, client, newLeadDestination: 'stage' });

    const result = await sync.projectInboundMessage(inbound(seed));

    assert.equal(result.projected, true);
    assert.equal(state.createdLeads, 1, 'no open deal means a new one');
    assert.equal(state.lastCreateLead?.pipelineId, 'funnel-9', 'the routed funnel reaches the create call');
    assert.equal(state.lastCreateLead?.statusId, 'stage-7', 'the routed stage reaches the create call');
    assert.equal(state.lastCreateLead?.contactId, 'contact-existing', 'the deal is linked to the found contact');
  } finally {
    await close();
  }
});

test('CRM-originated changes never write back to amoCRM', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const seed = await seedAmocrm(db, schema);
    const { client, state } = fakeClient();
    const sync = new AmocrmSync({ db, schema, client, newLeadDestination: 'stage' });
    await sync.projectInboundMessage(inbound(seed));
    const callsAfterProjection = state.calls.length;
    const result = await sync.applyCrmEvent({
      companyId: seed.companyId,
      accountId: seed.accountId,
      kind: 'contact.updated',
      payload: { id: '100', name: 'Renamed' },
    });
    assert.equal(result.action, 'ignored');
    assert.equal(state.calls.length, callsAfterProjection, 'no outbound CRM call for a CRM-originated event');
    const leadResult = await sync.applyCrmEvent({
      companyId: seed.companyId,
      accountId: seed.accountId,
      kind: 'lead.updated',
      payload: { id: 'lead-1' },
    });
    assert.equal(leadResult.action, 'ignored');
    assert.equal(state.calls.length, callsAfterProjection);
  } finally {
    await close();
  }
});

test('CRM merge and delete keep archival links via tombstones', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const seed = await seedAmocrm(db, schema);
    const { client } = fakeClient();
    const sync = new AmocrmSync({ db, schema, client, newLeadDestination: 'stage' });
    const projected = await sync.projectInboundMessage(inbound(seed));
    assert.ok(projected.leadId);

    const merged = await sync.applyCrmEvent({
      companyId: seed.companyId,
      accountId: seed.accountId,
      kind: 'lead.merged',
      payload: { id: projected.leadId, merged_into_id: 'lead-99' },
    });
    assert.equal(merged.action, 'lead_merged');
    const { rows: links } = await db.query<{ link_state: string; merged_into_lead_id: string }>(
      `SELECT link_state, merged_into_lead_id FROM "${schema}".conversation_leads WHERE lead_id=$1`,
      [projected.leadId],
    );
    assert.equal(links[0]!.link_state, 'merged');
    assert.equal(links[0]!.merged_into_lead_id, 'lead-99');
    const { rows: bindings } = await db.query<{ lead_id: string; contact_id: string }>(
      `SELECT lead_id, contact_id FROM "${schema}".crm_bindings`,
    );
    assert.equal(bindings[0]!.lead_id, 'lead-99');
    assert.equal(await count(db, schema, 'messages'), 1, 'merge must not delete messages');
    assert.equal(await count(db, schema, 'crm_entity_tombstones', `WHERE observation='merged'`), 1);

    const deleted = await sync.applyCrmEvent({
      companyId: seed.companyId,
      accountId: seed.accountId,
      kind: 'contact.deleted',
      payload: { id: projected.contactId },
    });
    assert.equal(deleted.action, 'contact_deleted');
    assert.equal(await count(db, schema, 'crm_bindings'), 1, 'binding survives CRM deletion');
    assert.equal(await count(db, schema, 'crm_entity_tombstones', `WHERE observation='deleted'`), 1);
    assert.equal(await count(db, schema, 'messages'), 1);
  } finally {
    await close();
  }
});

test('group and unknown chats are denied before any CRM projection', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const groupSeed = await seedAmocrm(db, schema, { chatKind: 'group', externalChatId: 'group-1' });
    const unknownSeed = await seedAmocrm(db, schema, {
      companyId: 'c2',
      accountId: 'acc2',
      connectionId: 'conn2',
      conversationId: 'conv2',
      externalChatId: 'unknown-1',
      chatKind: 'unknown',
    });
    const { client, state } = fakeClient();
    const sync = new AmocrmSync({ db, schema, client, newLeadDestination: 'stage' });

    const group = await sync.projectInboundMessage({ ...inbound(groupSeed), phone: '79990000001' });
    assert.equal(group.projected, false);
    assert.equal(group.reason, 'crm_import_denied');
    const unknown = await sync.projectInboundMessage({ ...inbound(unknownSeed), phone: '79990000002' });
    assert.equal(unknown.projected, false);
    assert.equal(unknown.reason, 'crm_import_denied');
    assert.equal(state.calls.length, 0);
    assert.equal(await count(db, schema, 'crm_bindings'), 0);
    assert.equal(await count(db, schema, 'crm_create_intents'), 0);
    assert.equal(await count(db, schema, 'conversation_leads'), 0);
    assert.equal(await count(db, schema, 'messages'), 0);
    assert.equal(await count(db, schema, 'amocrm_message_links'), 0);
  } finally {
    await close();
  }
});

test('explicitly allowed group proceeds through the normal projection', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const seed = await seedAmocrm(db, schema, {
      chatKind: 'group',
      externalChatId: 'group-allowed',
      groupDecision: 'allow_crm',
    });
    const { client } = fakeClient();
    const sync = new AmocrmSync({ db, schema, client, newLeadDestination: 'stage' });
    const result = await sync.projectInboundMessage({ ...inbound(seed), phone: '79990000003' });
    assert.equal(result.projected, true);
    assert.equal(await count(db, schema, 'crm_bindings'), 1);
  } finally {
    await close();
  }
});

test('429 pauses the outbound job and a later run resumes it exactly once', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const seed = await seedAmocrm(db, schema);
    let now = 1_700_000_000_000;
    let attempts = 0;
    const queue = new OutboundQueue({
      db,
      schema,
      now: () => now,
      workerId: 'w1',
      dispatch: async () => {
        attempts += 1;
        if (attempts === 1) throw new RateLimitError(5_000, '429');
        return { ok: true };
      },
    });
    await queue.enqueue({ companyId: seed.companyId, intentKey: 'projection:conv1', payload: { conversationId: 'conv1' } });
    const first = await queue.runOnce();
    assert.equal(first.completed, 0);
    assert.equal(first.retried, 1);
    const { rows } = await db.query<{ state: string; attempt_count: number; available_at: Date }>(
      `SELECT state, attempt_count, available_at FROM "${schema}".outbox_jobs`,
    );
    assert.equal(rows[0]!.state, 'pending');
    assert.equal(rows[0]!.attempt_count, 1);
    assert.ok(rows[0]!.available_at.getTime() >= now + 5_000);

    const early = await queue.runOnce();
    assert.equal(early.attempted, 0, 'backoff must be honoured');
    assert.equal(attempts, 1);

    now += 5_000;
    const second = await queue.runOnce();
    assert.equal(second.completed, 1);
    assert.equal(attempts, 2);
    const after = await db.query<{ state: string }>(`SELECT state FROM "${schema}".outbox_jobs`);
    assert.equal(after.rows[0]!.state, 'completed');
    const again = await queue.runOnce();
    assert.equal(again.attempted, 0);
    assert.equal(attempts, 2, 'completed job must not be dispatched again');
  } finally {
    await close();
  }
});

test('an unknown creation outcome is reconciled without creating a second entity', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const seed = await seedAmocrm(db, schema);
    const { client, state } = fakeClient({ existingByIntent: { id: 'contact-existing', name: 'Иван' } });
    const sync = new AmocrmSync({ db, schema, client, newLeadDestination: 'stage' });
    await db.query(
      `INSERT INTO "${schema}".crm_create_intents(company_id,id,account_id,conversation_id,intent_key,entity_kind,state)
       VALUES ($1,'intent-1',$2,$3,'contact:conv1','contact','creation_unknown')`,
      [seed.companyId, seed.accountId, seed.conversationId],
    );
    const result = await sync.reconcileCreateIntents({
      companyId: seed.companyId,
      accountId: seed.accountId,
      conversationId: seed.conversationId,
    });
    assert.equal(result.reconciled, 1);
    assert.equal(state.createdContacts, 0, 'reconciliation must not create a duplicate');
    assert.ok(state.calls.includes('findContactByIntentKey'));
    const { rows } = await db.query<{ state: string; external_id: string }>(
      `SELECT state, external_id FROM "${schema}".crm_create_intents WHERE id='intent-1'`,
    );
    assert.equal(rows[0]!.state, 'created');
    assert.equal(rows[0]!.external_id, 'contact-existing');
    const again = await sync.reconcileCreateIntents({
      companyId: seed.companyId,
      accountId: seed.accountId,
      conversationId: seed.conversationId,
    });
    assert.equal(again.reconciled, 0);
    assert.equal(state.createdContacts, 0);
  } finally {
    await close();
  }
});

// --- Defect 1: a creation attempt must be recorded outside the projection transaction ---

test('a lost contact-creation response survives the rollback and blocks a duplicate', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const seed = await seedAmocrm(db, schema);
    const { client, state } = fakeClient({ failAfterCreate: 'contact' });
    const sync = new AmocrmSync({ db, schema, client, newLeadDestination: 'stage' });
    await assert.rejects(sync.projectInboundMessage(inbound(seed)), /lost response/);

    const { rows } = await db.query<{ state: string }>(
      `SELECT state FROM "${schema}".crm_create_intents WHERE entity_kind='contact'`,
    );
    assert.equal(rows.length, 1, 'the creation intent must survive the rolled-back projection');
    assert.equal(rows[0]!.state, 'creation_unknown');

    const retry = await sync.projectInboundMessage(inbound(seed));
    assert.equal(retry.creationUnknown, true);
    assert.equal(state.createdContacts, 1, 'retry must not create a second contact');
  } finally {
    await close();
  }
});

test('a lost chat-creation response survives the rollback and blocks a duplicate', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const seed = await seedAmocrm(db, schema);
    const { client, state } = fakeClient({ failAfterCreate: 'chat' });
    const sync = new AmocrmSync({ db, schema, client, newLeadDestination: 'stage' });
    await assert.rejects(sync.projectInboundMessage(inbound(seed)), /lost response/);

    const { rows } = await db.query<{ state: string }>(
      `SELECT state FROM "${schema}".crm_create_intents WHERE entity_kind='chat'`,
    );
    assert.equal(rows.length, 1, 'the chat intent must survive the rolled-back projection');
    assert.equal(rows[0]!.state, 'creation_unknown');
    assert.equal(
      await count(db, schema, 'crm_create_intents', `WHERE entity_kind='contact' AND state='created'`),
      1,
      'the already created contact must stay recorded',
    );

    const retry = await sync.projectInboundMessage(inbound(seed));
    assert.equal(retry.creationUnknown, true);
    assert.equal(state.createdChats, 1, 'retry must not create a second chat');
    assert.equal(state.createdContacts, 1);
  } finally {
    await close();
  }
});

test('a lost lead-creation response survives the rollback and blocks a duplicate', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const seed = await seedAmocrm(db, schema);
    const { client, state } = fakeClient({ failAfterCreate: 'lead' });
    const sync = new AmocrmSync({ db, schema, client, newLeadDestination: 'stage' });
    await assert.rejects(sync.projectInboundMessage(inbound(seed)), /lost response/);

    const { rows } = await db.query<{ state: string }>(
      `SELECT state FROM "${schema}".crm_create_intents WHERE entity_kind='lead'`,
    );
    assert.equal(rows.length, 1, 'the lead intent must survive the rolled-back projection');
    assert.equal(rows[0]!.state, 'creation_unknown');

    const retry = await sync.projectInboundMessage(inbound(seed));
    assert.equal(retry.creationUnknown, true);
    assert.equal(retry.leadId, null);
    assert.equal(state.createdLeads, 1, 'retry must not create a second lead');
  } finally {
    await close();
  }
});

// --- Defect 2: the queue must only claim its own job kinds ---

test('the outbound queue never claims jobs of other kinds', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const seed = await seedAmocrm(db, schema);
    await db.query(
      `INSERT INTO "${schema}".outbox_jobs(company_id,id,job_kind,intent_key,payload,state,available_at)
       VALUES ($1,'job-telegram','telegram.send','telegram:1',$2,'pending',now() - interval '1 minute')`,
      [seed.companyId, JSON.stringify({ chatId: 'tg-1' })],
    );
    const dispatched: unknown[] = [];
    const queue = new OutboundQueue({
      db,
      schema,
      workerId: 'crm-worker',
      dispatch: async (payload) => {
        dispatched.push(payload);
        return { ok: true };
      },
    });

    const ignored = await queue.runOnce({ companyId: seed.companyId });
    assert.equal(ignored.attempted, 0, 'a telegram.send job is not the CRM queue work');
    assert.equal(dispatched.length, 0);
    const { rows } = await db.query<{ state: string; lease_owner: string | null }>(
      `SELECT state, lease_owner FROM "${schema}".outbox_jobs WHERE id='job-telegram'`,
    );
    assert.equal(rows[0]!.state, 'pending');
    assert.equal(rows[0]!.lease_owner, null);

    await queue.enqueue({ companyId: seed.companyId, intentKey: 'projection:conv1', payload: { conversationId: 'conv1' } });
    const own = await queue.runOnce({ companyId: seed.companyId });
    assert.equal(own.completed, 1);
    assert.equal(dispatched.length, 1);
  } finally {
    await close();
  }
});

// --- Defect 3: post-dispatch updates are fenced by lease_owner + fence ---

test('a stale worker cannot overwrite the result of the current lease owner', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const seed = await seedAmocrm(db, schema);
    let now = 1_700_000_000_000;
    let rejectA: (error: Error) => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const slowDispatch = new Promise<unknown>((_resolve, reject) => {
      rejectA = reject;
    });
    const queueA = new OutboundQueue({
      db,
      schema,
      now: () => now,
      workerId: 'worker-A',
      heartbeatIntervalMs: 0,
      dispatch: async () => {
        markStarted();
        return slowDispatch;
      },
    });
    await queueA.enqueue({ companyId: seed.companyId, intentKey: 'projection:conv1', payload: { conversationId: 'conv1' } });
    const runningA = queueA.runOnce();
    await started;

    // A's 60s lease expires while it is still dispatching; B takes the job over.
    now += 61_000;
    const queueB = new OutboundQueue({
      db,
      schema,
      now: () => now,
      workerId: 'worker-B',
      dispatch: async () => ({ ok: true }),
    });
    const b = await queueB.runOnce({ companyId: seed.companyId });
    assert.equal(b.completed, 1);

    rejectA(new Error('late failure'));
    const a = await runningA;
    assert.equal(a.completed, 0);
    assert.equal(a.retried, 0);
    assert.equal(a.failed, 0);

    const { rows } = await db.query<{ state: string; lease_owner: string | null; attempt_count: number }>(
      `SELECT state, lease_owner, attempt_count FROM "${schema}".outbox_jobs`,
    );
    assert.equal(rows[0]!.state, 'completed', 'the stale worker must not resurrect the completed job');
    assert.equal(rows[0]!.lease_owner, null);
    assert.equal(rows[0]!.attempt_count, 1);

    const evidence = await db.query<{ event_name: string; diagnostic_code: string }>(
      `SELECT event_name, diagnostic_code FROM "${schema}".audit_events WHERE subject_id=(SELECT id FROM "${schema}".outbox_jobs)`,
    );
    assert.equal(evidence.rows.length, 1, 'the rejected stale attempt must be kept as evidence');
    assert.equal(evidence.rows[0]!.event_name, 'outbox.dispatch_result_rejected');
    assert.equal(evidence.rows[0]!.diagnostic_code, 'retried');
  } finally {
    await close();
  }
});

test('a long dispatch keeps extending its lease', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const seed = await seedAmocrm(db, schema);
    let leaseAtStart: number | null = null;
    let leaseAtEnd: number | null = null;
    const queue = new OutboundQueue({
      db,
      schema,
      workerId: 'worker-long',
      leaseMs: 60,
      heartbeatIntervalMs: 15,
      dispatch: async () => {
        const first = await db.query<{ lease_until: Date }>(
          `SELECT lease_until FROM "${schema}".outbox_jobs LIMIT 1`,
        );
        leaseAtStart = first.rows[0]!.lease_until.getTime();
        await new Promise((resolve) => setTimeout(resolve, 150));
        const second = await db.query<{ lease_until: Date }>(
          `SELECT lease_until FROM "${schema}".outbox_jobs LIMIT 1`,
        );
        leaseAtEnd = second.rows[0]!.lease_until.getTime();
        return { ok: true };
      },
    });
    await queue.enqueue({ companyId: seed.companyId, intentKey: 'projection:conv1', payload: { conversationId: 'conv1' } });
    const result = await queue.runOnce({ companyId: seed.companyId });
    assert.equal(result.completed, 1);
    assert.ok(leaseAtStart !== null && leaseAtEnd !== null);
    assert.ok(leaseAtEnd! > leaseAtStart!, 'the lease must be extended while dispatching');
  } finally {
    await close();
  }
});

// --- Defect 4: a tombstoned lead is never reused ---

test('a lead deleted in CRM is not reused by the next projection', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const seed = await seedAmocrm(db, schema);
    const { client, state } = fakeClient();
    const sync = new AmocrmSync({ db, schema, client, newLeadDestination: 'stage' });
    const first = await sync.projectInboundMessage(inbound(seed));
    assert.ok(first.leadId);

    const deleted = await sync.applyCrmEvent({
      companyId: seed.companyId,
      accountId: seed.accountId,
      kind: 'lead.deleted',
      payload: { id: first.leadId },
    });
    assert.equal(deleted.action, 'lead_deleted');

    const second = await sync.projectInboundMessage(inbound(seed, 'ext-msg-2'));
    assert.notEqual(second.leadId, first.leadId, 'the deleted lead id must never come back');
    assert.equal(second.leadId, 'lead-2');
    assert.equal(state.createdLeads, 2);
    const { rows } = await db.query<{ lead_id: string }>(`SELECT lead_id FROM "${schema}".crm_bindings`);
    assert.equal(rows[0]!.lead_id, 'lead-2');
  } finally {
    await close();
  }
});

test('a tombstoned lead stored on the binding is not reused either', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const seed = await seedAmocrm(db, schema);
    const { client, state } = fakeClient();
    const sync = new AmocrmSync({ db, schema, client, newLeadDestination: 'stage' });
    const first = await sync.projectInboundMessage(inbound(seed));
    assert.ok(first.leadId);

    // Simulate a delete observation that arrived while the binding still held the id.
    await db.query(
      `INSERT INTO "${schema}".crm_entity_tombstones(company_id,account_id,entity_type,external_id,observation)
       VALUES ($1,$2,'lead',$3,'deleted')`,
      [seed.companyId, seed.accountId, first.leadId],
    );

    const second = await sync.projectInboundMessage(inbound(seed, 'ext-msg-2'));
    assert.notEqual(second.leadId, first.leadId);
    assert.equal(second.leadId, 'lead-2');
    assert.equal(state.createdLeads, 2);
  } finally {
    await close();
  }
});
