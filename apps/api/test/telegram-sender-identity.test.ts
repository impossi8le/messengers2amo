import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { seedAmocrm } from './helpers/amocrm.ts';
import { recordTelegramUpdate } from '../src/telegram/inbox.ts';
import { drainTelegramInbox } from '../src/telegram/processor.ts';
import { AmocrmSync, type AmocrmSyncClient, type InboundMessageInput } from '../src/integrations/amocrm/sync.ts';
import { buildMessageJob, createProjectionDispatcher } from '../src/integrations/amocrm/projection.ts';

test('sender identity survives the durable projection job round trip', async () => {
  let received: InboundMessageInput | undefined;
  const input = { companyId: 'c1', accountId: 'acc1', conversationId: 'conv1', providerMessageId: '1', direction: 'in' as const,
    text: 'hello', senderName: 'Иван Петров', senderUsername: 'ivan_test' };
  const job = buildMessageJob(input);
  assert.equal(job.senderName, 'Иван Петров');
  await createProjectionDispatcher({ sync: { async projectInboundMessage(value) { received = value; return { projected: true }; },
    async applyCrmEvent() { return { action: 'ignored' }; } } })(job);
  assert.equal((received as unknown as Record<string, unknown>).senderName, 'Иван Петров');
  assert.equal((received as unknown as Record<string, unknown>).senderUsername, 'ivan_test');
});

test('private Telegram profiles are normalized into archived content and projection jobs, group authors are not', async () => {
  const ctx = await createTestDb();
  try {
    const seed = await seedAmocrm(ctx.db, ctx.schema);
    await ctx.db.query("INSERT INTO workshops(company_id,id,display_name) VALUES ('c1','w1','Workshop')");
    await ctx.db.query("INSERT INTO staff(company_id,id,display_name) VALUES ('c1','owner1','Owner')");
    await ctx.db.query("INSERT INTO crm_sources(company_id,id,account_id,external_id,origin_code) VALUES ('c1','src1','acc1','src1','chat')");
    await ctx.db.query("INSERT INTO connection_routes(company_id,connection_id,workshop_id,crm_account_id,funnel_id,default_owner_id,technical_source_id,version) VALUES ('c1','conn1','w1','acc1','100','owner1','src1',1)");
    for (const [id, type] of [[10, 'private'], [11, 'group']] as const) {
      await recordTelegramUpdate(ctx.db, { companyId: seed.companyId, connectionId: seed.connectionId, bindingEpoch: seed.epoch },
        { update_id: id, message: { message_id: id, date: 1793020000, chat: { id, type },
          from: { id: 999, first_name: '  Иван\n ', last_name: ' Петров  ', username: 'ivan_test' }, text: 'hello' } });
    }
    await drainTelegramInbox(ctx.db, { schema: ctx.schema });
    const rows = (await ctx.db.query(`SELECT c.chat_kind,v.content FROM message_versions v JOIN messages m ON m.company_id=v.company_id AND m.id=v.message_id
      JOIN conversations c ON c.company_id=m.company_id AND c.id=m.conversation_id ORDER BY c.chat_kind`)).rows;
    const personal = rows.find((r) => r.chat_kind === 'private')!.content;
    const group = rows.find((r) => r.chat_kind === 'group')!.content;
    assert.equal(personal.senderName, 'Иван Петров'); assert.equal(personal.senderUsername, 'ivan_test');
    assert.equal(group.senderName, undefined); assert.equal(group.senderUsername, undefined);
    const job = (await ctx.db.query("SELECT payload FROM outbox_jobs WHERE job_kind='amocrm.projection'")).rows[0]!.payload;
    assert.equal(job.senderName, 'Иван Петров'); assert.equal(job.senderUsername, 'ivan_test');
  } finally { await ctx.close(); }
});

test('profile labels never rename a contact matched by its existing phone identity', async () => {
  const ctx = await createTestDb();
  try {
    const seed = await seedAmocrm(ctx.db, ctx.schema);
    let created = 0;
    const client: AmocrmSyncClient = {
      async findContacts() { return [{ id: 'existing-1', name: 'Existing CRM name' }]; }, async findOpenLeads() { return []; },
      async createContact() { created++; return { id: 'unexpected' }; },
      async createChat() { return { chatId: 'chat-1' }; }, async linkChat(input) { assert.equal(input.contactId, 'existing-1'); },
      async createLead() { return { id: 'lead-1' }; }, async importMessage(input) { return { messageId: input.messageId }; },
    };
    const result = await new AmocrmSync({ db: ctx.db, schema: ctx.schema, client }).projectInboundMessage({ ...seed,
      providerMessageId: 'profile-match', direction: 'in', text: 'hello', phone: '+79990000000', senderName: 'New Telegram name' });
    assert.equal(result.contactId, 'existing-1'); assert.equal(created, 0);
  } finally { await ctx.close(); }
});

test('new private contacts and Chats use a profile name, then username, then the existing external-id fallback', async () => {
  for (const profile of [{ senderName: 'Иван Петров', senderUsername: 'ivan_test', expected: 'Иван Петров' },
    { senderUsername: 'ivan_test', expected: '@ivan_test' }, { expected: 'chat-1' }]) {
    const ctx = await createTestDb();
    try {
      const seed = await seedAmocrm(ctx.db, ctx.schema);
      let contactName: unknown; let chatName: unknown; let contacts = 0; const importedNames:string[]=[];
      const client: AmocrmSyncClient = {
        async findContacts() { throw new Error('no identifier: do not search by profile name'); }, async findOpenLeads() { return []; },
        async createContact(input) { contactName = input.name; contacts++; assert.equal(input.phone, null); assert.equal(input.email, null); return { id: 'contact-1' }; },
        async createChat(input) { chatName = input.chatName; return { chatId: 'chat-1' }; }, async linkChat() {},
        async createLead() { return { id: 'lead-1' }; }, async importMessage(input) { importedNames.push(input.senderName??''); return { messageId: input.messageId }; },
      };
      const sync = new AmocrmSync({ db: ctx.db, schema: ctx.schema, client });
      const input = { ...seed, providerMessageId: 'first', direction: 'in' as const, text: 'hello', ...profile };
      await sync.projectInboundMessage(input);
      assert.equal(contactName, profile.expected); assert.equal(chatName, profile.expected);
      assert.equal(importedNames[0],profile.expected,'the import must preserve the same identity as contact/chat creation');
      await sync.projectInboundMessage({ ...input, providerMessageId: 'second', senderName: 'Different name' });
      assert.equal(contacts, 1, 'existing contact data is never overwritten by later sender profiles');
      assert.equal(importedNames[1],'Different name','returning messages must retain their real sender profile');
    } finally { await ctx.close(); }
  }
});
