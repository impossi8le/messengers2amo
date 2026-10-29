import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { addGroupConversation, seedWorkshopBase } from './helpers/workshops.ts';
import { GroupPolicyService } from '../src/workshops/groups.ts';
import { ingestWebhook } from '../src/channels/inbox.ts';
import type { ChannelAdapter } from '../src/channels/types.ts';

function policyFor(db: Parameters<typeof seedWorkshopBase>[0], schema: string): GroupPolicyService {
  return new GroupPolicyService({ db, schema });
}

test('groups are denied by default and an unknown chat kind is always denied', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const base = await seedWorkshopBase(db, schema);
    const policy = policyFor(db, schema);

    const group = await policy.decide({
      companyId: 'c1',
      connectionId: 'connA',
      bindingEpoch: 1,
      externalChatId: 'group-1',
      chatKind: 'group',
    });
    assert.equal(group.allowed, false);
    assert.equal(group.decision, 'group_default_deny');
    assert.equal(group.archiveOnly, false);
    assert.equal(group.ruleVersion, null);

    const unknown = await policy.decide({
      companyId: 'c1',
      connectionId: 'connA',
      bindingEpoch: 1,
      externalChatId: 'group-1',
      chatKind: 'unknown',
    });
    assert.equal(unknown.allowed, false);
    assert.equal(unknown.decision, 'unknown_chat_kind');

    const privateChat = await policy.decide({
      companyId: 'c1',
      connectionId: 'connA',
      bindingEpoch: 1,
      externalChatId: base.externalChatId,
      chatKind: 'private',
    });
    assert.equal(privateChat.allowed, true);
    assert.equal(privateChat.decision, 'private_allowed');
    assert.equal(privateChat.reason, 'allowed');
  } finally {
    await close();
  }
});

test('an explicit allow rule is bound to the immutable chat id, not to the name', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const base = await seedWorkshopBase(db, schema);
    const policy = policyFor(db, schema);
    await addGroupConversation(db, schema, {
      companyId: 'c1',
      connectionId: 'connA',
      bindingEpoch: 1,
      conversationId: 'convG1',
      externalChatId: 'group-1',
    });
    await addGroupConversation(db, schema, {
      companyId: 'c1',
      connectionId: 'connA',
      bindingEpoch: 1,
      conversationId: 'convG2',
      externalChatId: 'group-2',
    });

    const rule = await policy.setRule({
      companyId: 'c1',
      connectionId: 'connA',
      bindingEpoch: 1,
      externalChatId: 'group-1',
      decision: 'allow_crm',
      displayName: 'Sales team',
    });
    assert.equal(rule.decision, 'allow_crm');
    assert.equal(rule.version, 1);

    const allowed = await policy.decide({
      companyId: 'c1',
      connectionId: 'connA',
      bindingEpoch: 1,
      externalChatId: 'group-1',
      chatKind: 'group',
    });
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.decision, 'group_allowed');
    assert.equal(allowed.ruleVersion, 1);

    // Renaming the group (or the rule label) changes nothing.
    await db.query(`UPDATE "${schema}".conversations SET display_name='Renamed' WHERE id='convG1'`);
    await db.query(`UPDATE "${schema}".channel_group_rules SET display_name='Renamed' WHERE external_chat_id='group-1'`);
    const afterRename = await policy.decide({
      companyId: 'c1',
      connectionId: 'connA',
      bindingEpoch: 1,
      externalChatId: 'group-1',
      chatKind: 'group',
    });
    assert.equal(afterRename.allowed, true);

    // A different group with the same name inherits nothing.
    await db.query(`UPDATE "${schema}".conversations SET display_name='Sales team' WHERE id='convG2'`);
    const sameName = await policy.decide({
      companyId: 'c1',
      connectionId: 'connA',
      bindingEpoch: 1,
      externalChatId: 'group-2',
      chatKind: 'group',
    });
    assert.equal(sameName.allowed, false);
    assert.equal(sameName.decision, 'group_default_deny');
  } finally {
    await close();
  }
});

test('exclude and archive_only decisions never allow CRM projection', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await seedWorkshopBase(db, schema);
    const policy = policyFor(db, schema);

    const excluded = await policy.setRule({
      companyId: 'c1',
      connectionId: 'connA',
      bindingEpoch: 1,
      externalChatId: 'group-x',
      decision: 'exclude',
    });
    const excludeDecision = await policy.decide({
      companyId: 'c1',
      connectionId: 'connA',
      bindingEpoch: 1,
      externalChatId: 'group-x',
      chatKind: 'group',
    });
    assert.equal(excludeDecision.allowed, false);
    assert.equal(excludeDecision.decision, 'group_excluded');
    assert.equal(excludeDecision.archiveOnly, false);

    const archiveOnly = await policy.setRule({
      companyId: 'c1',
      connectionId: 'connA',
      bindingEpoch: 1,
      externalChatId: 'group-y',
      decision: 'archive_only',
    });
    assert.equal(archiveOnly.decision, 'archive_only');
    const archiveDecision = await policy.decide({
      companyId: 'c1',
      connectionId: 'connA',
      bindingEpoch: 1,
      externalChatId: 'group-y',
      chatKind: 'group',
    });
    assert.equal(archiveDecision.allowed, false);
    assert.equal(archiveDecision.decision, 'archive_only');
    assert.equal(archiveDecision.archiveOnly, true);

    // A changed decision is a new version of the same immutable identity.
    const changed = await policy.setRule({
      companyId: 'c1',
      connectionId: 'connA',
      bindingEpoch: 1,
      externalChatId: 'group-x',
      decision: 'allow_crm',
    });
    assert.equal(changed.version, 2);
  } finally {
    await close();
  }
});

test('the group identity cannot be rewritten in place', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await seedWorkshopBase(db, schema);
    const policy = policyFor(db, schema);
    await policy.setRule({
      companyId: 'c1',
      connectionId: 'connA',
      bindingEpoch: 1,
      externalChatId: 'group-1',
      decision: 'allow_crm',
    });

    await assert.rejects(
      () =>
        db.query(
          `UPDATE "${schema}".channel_group_rules SET external_chat_id='group-2' WHERE external_chat_id='group-1'`,
        ),
      (error: unknown) => /immutable_identity/.test(String((error as { message?: string }).message)),
    );
  } finally {
    await close();
  }
});

test('the group filter runs before any CRM projection job is created', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    await seedWorkshopBase(db, schema);
    const projections: string[] = [];
    const adapter: ChannelAdapter = {
      channelMode: 'max_bot',
      capabilities: () => ({
        textReply: 'unknown',
        mediaReply: 'unknown',
        readReceipts: 'unknown',
        deliveryReceipts: 'unknown',
        messageEditing: 'unknown',
        messageDeletion: 'unknown',
      }),
      send: async () => ({ status: 'failed', errorCode: 'not_used', retryable: false }),
      verifyInbound: () => ({ ok: true }),
      parseInbound: () => ({
        events: [
          {
            kind: 'message.received',
            providerEventKey: 'evt-group',
            externalChatId: 'group-1',
            chatKind: 'group',
            providerMessageId: 'pm-1',
            content: { kind: 'text', text: 'hello group' },
            occurredAt: new Date().toISOString(),
          },
        ],
      }),
    };
    const result = await ingestWebhook({
      db,
      schema,
      adapter,
      connection: { companyId: 'c1', connectionId: 'connA', bindingEpoch: 1 },
      raw: { body: Buffer.from('{}'), headers: {} },
      onCrmProjection: (payload) => projections.push(payload.messageId),
    });
    assert.equal(result.accepted, 1);
    assert.equal(result.crmProjections, 0);
    assert.deepEqual(projections, []);
    const jobs = await db.query(`SELECT count(*)::int AS c FROM "${schema}".outbox_jobs`);
    assert.equal(jobs.rows[0].c, 0);
    const conversations = await db.query<{ chat_kind: string }>(
      `SELECT chat_kind FROM "${schema}".conversations WHERE external_chat_id='group-1'`,
    );
    assert.equal(conversations.rows[0]?.chat_kind, 'group');
  } finally {
    await close();
  }
});
