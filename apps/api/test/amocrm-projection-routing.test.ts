import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { seedCompany, seedConnection } from './helpers/seed.ts';
import { recordTelegramUpdate } from '../src/telegram/inbox.ts';
import { drainTelegramInbox } from '../src/telegram/processor.ts';
import { AmocrmSync, type AmocrmSyncClient, type InboundMessageInput } from '../src/integrations/amocrm/sync.ts';
import { registerChannel } from '../src/integrations/amocrm/store.ts';
import { createCaptureFileProjection } from '../src/integrations/amocrm/capture-files.ts';
import { createMessageProjectionRouter } from '../src/integrations/amocrm/projection-routing.ts';

async function fixture(attachment = false) {
  const context = await createTestDb(); const { db, schema } = context;
  await seedCompany(db, { companyId: 'c1', workshops: ['w1'], staff: [{ id: 'admin', role: 'admin', password: 'synthetic-password' }] });
  await seedConnection(db, { companyId: 'c1', id: 'pilot', state: 'active', workshopId: 'w1', ownerId: 'admin' });
  await db.query("UPDATE crm_accounts SET state='active'");
  await db.query("INSERT INTO channel_policies(company_id,connection_id,crm_projection_enabled,private_import_enabled,group_default) VALUES ('c1','pilot',true,true,'deny')");
  await recordTelegramUpdate(db, { companyId: 'c1', connectionId: 'pilot', bindingEpoch: 0 }, { update_id: 1, message: {
    message_id: 55, date: 1793020000, chat: { id: 42, type: 'private' },
    ...(attachment ? { document: { file_id: 'f', file_name: 'invoice.txt', mime_type: 'text/plain', file_size: 4 } } : { text: 'pilot text' }),
  } });
  await drainTelegramInbox(db, { schema });
  const payload = (await db.query("SELECT payload FROM outbox_jobs WHERE job_kind='amocrm.projection'")).rows[0].payload;
  const job = { ...payload, occurredAt: new Date(payload.occurredAt) } as InboundMessageInput;
  const counts = { contacts: 0, leads: 0, chats: 0, imports: 0, downloads: 0, uploads: 0, links: 0, prepares: 0 };
  const imports: Array<{ text: string; silent: boolean; attachment: unknown }> = [];
  let forbidCreates = false, linked = false;
  const client: AmocrmSyncClient = {
    async findContacts() { throw new Error('must not search without phone/email'); },
    async findOpenLeads() { return [{ id: '50056949', updatedAt: '2026-10-28T10:00:00Z' }]; },
    async createContact() { assert.equal(forbidCreates, false, 'a migration must not recreate the contact'); counts.contacts++; return { id: '77' }; },
    async createLead() { assert.equal(forbidCreates, false, 'a migration must not recreate the lead'); counts.leads++; return { id: '50056949' }; },
    async createChat() { counts.chats++; return { chatId: 'native-chat' }; },
    async linkChat(input) { assert.equal(input.contactId, '77'); assert.equal(input.chatId, 'native-chat'); },
    async importMessage(input) { counts.imports++; imports.push({ text: input.text, silent: input.silent, attachment: input.attachment }); return { messageId: `amo:${input.messageId}` }; },
  };
  const native = new AmocrmSync({ db, schema, client });
  const capture = new AmocrmSync({ db, schema, client, captureOnly: true });
  const project = createMessageProjectionRouter({ db, schema, nativeProject: (input) => native.projectInboundMessage(input),
    prepareMessage: async () => { counts.prepares++; throw new Error('no_s3_available'); },
    capture: { companyId: 'c1', connectionId: 'pilot', projectMessage: (input) => capture.projectInboundMessage(input),
      wrapFiles: (projectMessage) => createCaptureFileProjection({ db, schema, projectMessage, resolveBotToken: () => '123:synthetic',
        fetch: async () => ++counts.downloads % 2 === 1
          ? new Response(JSON.stringify({ ok: true, result: { file_id: 'f', file_path: 'documents/f.txt', file_size: 4 } })) : new Response('safe'),
        files: { async upload(input) { counts.uploads++; assert.equal(input.fileName, 'invoice.txt'); assert.equal(Buffer.from(input.bytes).toString(), 'safe'); return { uuid: '11111111-1111-4111-8111-111111111111' }; },
          async isLinked(input) { assert.equal(input.leadId, '50056949'); return linked; }, async link() { counts.links++; linked = true; } },
      }),
    },
  });
  const connect = (scopeId = 'scope-pilot') => registerChannel(db, schema, { companyId: 'c1', accountId: 'acc_pilot',
    scopeId, channelCode: 'synthetic', secretEnc: 'synthetic-encrypted-envelope', connectionId: 'pilot', bindingEpoch: 0, amojoAccountId: 'synthetic-account' });
  return { ...context, job, project, connect, counts, imports, forbidCreates: () => { forbidCreates = true; } };
}

test('a connected native channel upgrades an existing capture binding without another contact or lead', async () => {
  const ctx = await fixture();
  try {
    const captured = await ctx.project(ctx.job);
    assert.equal(captured.reason, 'lead_capture_only');
    const before = (await ctx.db.query('SELECT id,contact_id,lead_id,state,chat_id FROM crm_bindings')).rows[0];
    assert.equal(before.state, 'pending'); assert.equal(before.lead_id, '50056949'); assert.equal(before.chat_id, null);
    ctx.forbidCreates(); await ctx.connect();
    const migrated = await ctx.project(ctx.job); await ctx.project(ctx.job);
    assert.equal(migrated.contactId, '77'); assert.equal(migrated.leadId, '50056949');
    assert.equal(ctx.counts.chats, 1); assert.equal(ctx.counts.imports, 1);
    assert.deepEqual(ctx.imports, [{ text: 'pilot text', silent: true, attachment: undefined }]);
    assert.equal(ctx.counts.contacts, 1); assert.equal(ctx.counts.leads, 1); assert.equal(ctx.counts.prepares, 0);
    const after = (await ctx.db.query('SELECT id,contact_id,lead_id,state,chat_id FROM crm_bindings')).rows[0];
    assert.deepEqual(after, { ...before, state: 'bound', chat_id: 'native-chat' });
  } finally { await ctx.close(); }
});

test('scoped attachments retain one Files API original while their filename becomes a native chat message without S3', async () => {
  const ctx = await fixture(true);
  try {
    await ctx.project(ctx.job);
    ctx.forbidCreates(); await ctx.connect();
    await ctx.project(ctx.job); await ctx.project(ctx.job);
    assert.equal(ctx.counts.uploads, 1); assert.equal(ctx.counts.links, 1); assert.equal(ctx.counts.downloads, 2);
    assert.equal(ctx.counts.prepares, 0); assert.equal(ctx.counts.chats, 1); assert.equal(ctx.counts.imports, 1);
    assert.deepEqual(ctx.imports, [{ text: 'invoice.txt', silent: true, attachment: undefined }]);
    assert.equal((await ctx.db.query('SELECT state,file_uuid,lead_id FROM amocrm_file_deliveries')).rows[0].state, 'linked');
    assert.equal((await ctx.db.query('SELECT count(*)::int AS n FROM amocrm_message_links')).rows[0].n, 1);
  } finally { await ctx.close(); }
});

test('wrong CRM scope cannot upload or import a pilot attachment', async () => {
  const ctx = await fixture(true);
  try {
    await ctx.connect();
    assert.deepEqual(await ctx.project({ ...ctx.job, accountId: 'wrong-account' }), { projected: false, reason: 'crm_import_denied' });
    assert.equal(ctx.counts.uploads, 0); assert.equal(ctx.counts.imports, 0); assert.equal(ctx.counts.contacts, 0);
  } finally { await ctx.close(); }
});

test('a new captioned attachment after connection uses native text and lead Files while preserving the old capture IDs', async () => {
  const ctx = await fixture();
  try {
    await ctx.project(ctx.job); ctx.forbidCreates(); await ctx.connect();
    await recordTelegramUpdate(ctx.db, { companyId: 'c1', connectionId: 'pilot', bindingEpoch: 0 }, { update_id: 2,
      message: { message_id: 56, date: 1793020001, chat: { id: 42, type: 'private' }, caption: 'Caption preserved',
        document: { file_id: 'f', file_name: 'invoice.txt', mime_type: 'text/plain', file_size: 4 } } });
    await drainTelegramInbox(ctx.db, { schema: ctx.schema });
    const payload = (await ctx.db.query("SELECT payload FROM outbox_jobs WHERE job_kind='amocrm.projection' AND payload->>'providerMessageId'='56'")).rows[0].payload;
    const input = { ...payload, occurredAt: new Date(payload.occurredAt) };
    const result = await ctx.project(input); await ctx.project(input);
    assert.equal(result.contactId, '77'); assert.equal(result.leadId, '50056949');
    assert.deepEqual(ctx.imports, [{ text: 'Caption preserved', silent: true, attachment: undefined }]);
    assert.equal(ctx.counts.prepares, 0); assert.equal(ctx.counts.uploads, 1); assert.equal(ctx.counts.links, 1);
    assert.equal(ctx.counts.chats, 1); assert.equal(ctx.counts.contacts, 1); assert.equal(ctx.counts.leads, 1);
    const file = (await ctx.db.query('SELECT state,lead_id FROM amocrm_file_deliveries')).rows[0];
    assert.deepEqual(file, { state: 'linked', lead_id: '50056949' });
  } finally { await ctx.close(); }
});

test('disabled and ambiguous native scopes preserve capture behavior instead of choosing an arbitrary channel', async () => {
  const ctx = await fixture();
  try {
    await ctx.connect(); await ctx.db.query("UPDATE amocrm_channels SET state='disabled'");
    assert.equal((await ctx.project(ctx.job)).reason, 'lead_capture_only');
    await ctx.db.query("UPDATE amocrm_channels SET state='connected'"); await ctx.connect('second-scope');
    assert.equal((await ctx.project(ctx.job)).reason, 'lead_capture_only');
    assert.equal(ctx.counts.chats, 0); assert.equal(ctx.counts.imports, 0);
  } finally { await ctx.close(); }
});

test('non-pilot connections and companies retain the native preparation path', async () => {
  const ctx = await fixture(true);
  try {
    await ctx.db.query("INSERT INTO conversations(company_id,id,connection_id,binding_epoch,external_chat_id,chat_kind) VALUES ('c1','other-conversation','pilot',0,'99','private')");
    const calls: string[] = [];
    const route = createMessageProjectionRouter({ db: ctx.db, schema: ctx.schema,
      nativeProject: async () => { calls.push('native'); return { projected: true }; },
      prepareMessage: async (input) => { calls.push('prepare'); return input; },
      capture: { companyId: 'c1', connectionId: 'different-connection', projectMessage: async () => { throw new Error('must not capture'); },
        wrapFiles: () => async () => { throw new Error('must not capture files'); } },
    });
    await route(ctx.job); await route({ ...ctx.job, companyId: 'other-company' });
    assert.deepEqual(calls, ['prepare', 'native', 'prepare', 'native']);
  } finally { await ctx.close(); }
});
