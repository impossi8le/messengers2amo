import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { seedWorkshopBase } from './helpers/workshops.ts';
import { WorkshopService } from '../src/workshops/service.ts';
import { dispatchSend, enqueueSend } from '../src/channels/outbox.ts';
import type { ChannelAdapter } from '../src/channels/types.ts';

function serviceFor(db: Parameters<typeof seedWorkshopBase>[0], schema: string): WorkshopService {
  return new WorkshopService({ db, schema });
}

test('a workshop is a business unit separate from a department', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const base = await seedWorkshopBase(db, schema);
    const service = serviceFor(db, schema);

    const created = await service.createWorkshop({
      companyId: base.companyId,
      id: 'wC',
      displayName: 'Workshop C',
    });
    assert.deepEqual(created, { companyId: 'c1', id: 'wC', displayName: 'Workshop C' });

    const listed = await service.listWorkshops(base.companyId);
    assert.deepEqual(listed.map((workshop) => workshop.id), ['wA', 'wB', 'wC']);

    // Creating a workshop never creates a department: the two identities are separate.
    const departments = await db.query<{ id: string }>(
      `SELECT id FROM "${schema}".departments ORDER BY id`,
    );
    assert.deepEqual(departments.rows.map((row) => row.id), ['deptA']);

    // A staff member can be assigned to several workshops, independently of the
    // single department membership used for queueing.
    await service.assignStaff({ companyId: base.companyId, workshopId: 'wA', staffId: base.staff.noSend });
    await service.assignStaff({ companyId: base.companyId, workshopId: 'wC', staffId: base.staff.noSend });
    assert.deepEqual(
      (await service.listWorkshopStaff(base.companyId, 'wA')).map((member) => member.staffId),
      ['agent1'],
    );
    assert.deepEqual(
      (await service.listWorkshopStaff(base.companyId, 'wC')).map((member) => member.staffId),
      ['agent1'],
    );

    const memberships = await db.query<{ staff_id: string; department_id: string }>(
      `SELECT staff_id, department_id FROM "${schema}".staff_memberships ORDER BY staff_id`,
    );
    assert.deepEqual(memberships.rows, [
      { staff_id: 'agent1', department_id: 'deptA' },
      { staff_id: 'owner1', department_id: 'deptA' },
    ]);

    // A workshop that still has members is not deleted implicitly: the membership
    // must be revoked first, so staff are never orphaned by a silent cascade.
    await assert.rejects(
      () => service.deleteWorkshop('c1', 'wC'),
      (error: unknown) => /foreign key/i.test(String((error as { message?: string }).message)),
    );
    await service.unassignStaff({ companyId: 'c1', workshopId: 'wC', staffId: base.staff.noSend });
    assert.deepEqual(await service.listWorkshopStaff('c1', 'wC'), []);

    // Update and delete act on the workshop only; the department is untouched.
    const renamed = await service.createWorkshop({ companyId: 'c1', id: 'wC', displayName: 'Workshop C (renamed)' });
    assert.equal(renamed.displayName, 'Workshop C (renamed)');
    assert.equal(await service.deleteWorkshop('c1', 'wC'), true);
    assert.equal(await service.getWorkshop('c1', 'wC'), null);
    assert.equal(await service.deleteWorkshop('c1', 'wC'), false);
    const departmentsAfter = await db.query<{ id: string }>(`SELECT id FROM "${schema}".departments ORDER BY id`);
    assert.deepEqual(departmentsAfter.rows.map((row) => row.id), ['deptA']);
  } finally {
    await close();
  }
});

test('a connection route carries workshop, funnel, default owner, technical source and version', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const base = await seedWorkshopBase(db, schema);
    const service = serviceFor(db, schema);

    const route = await service.setConnectionRoute({
      companyId: base.companyId,
      connectionId: base.connections.a,
      workshopId: base.workshops.a,
      crmAccountId: base.accounts.a,
      funnelId: 'funnel-1',
      defaultOwnerId: base.staff.owner,
      technicalSourceId: base.sources.a,
    });
    assert.equal(route.companyId, 'c1');
    assert.equal(route.connectionId, 'connA');
    assert.equal(route.workshopId, 'wA');
    assert.equal(route.crmAccountId, 'accA');
    assert.equal(route.funnelId, 'funnel-1');
    assert.equal(route.defaultOwnerId, 'owner1');
    assert.equal(route.technicalSourceId, 'srcA');
    assert.equal(route.version, 1);

    const updated = await service.setConnectionRoute({
      companyId: base.companyId,
      connectionId: base.connections.a,
      workshopId: base.workshops.a,
      crmAccountId: base.accounts.a,
      funnelId: 'funnel-2',
      defaultOwnerId: base.staff.noSend,
      technicalSourceId: base.sources.a,
    });
    assert.equal(updated.funnelId, 'funnel-2');
    assert.equal(updated.defaultOwnerId, 'agent1');
    assert.equal(updated.version, 2);

    const loaded = await service.getConnectionRoute(base.companyId, base.connections.a);
    assert.equal(loaded?.funnelId, 'funnel-2');
    assert.equal(loaded?.version, 2);

    // The route view exposes the read/send rights that belong to it.
    await service.setChannelPermission({
      companyId: 'c1',
      connectionId: 'connA',
      staffId: base.staff.owner,
      canRead: true,
      canSend: true,
    });
    const described = await service.describeRoute('c1', 'connA');
    assert.equal(described?.route.workshopId, 'wA');
    assert.deepEqual(described?.permissions, [
      { staffId: 'agent1', canRead: true, canSend: false },
      { staffId: 'owner1', canRead: true, canSend: true },
    ]);
  } finally {
    await close();
  }
});

test('read and send permissions are separate and a route without send permission does not send', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const base = await seedWorkshopBase(db, schema);
    const service = serviceFor(db, schema);
    await service.setConnectionRoute({
      companyId: base.companyId,
      connectionId: base.connections.a,
      workshopId: base.workshops.a,
      crmAccountId: base.accounts.a,
      funnelId: 'funnel-1',
      defaultOwnerId: base.staff.owner,
      technicalSourceId: base.sources.a,
    });
    await service.assignStaff({ companyId: base.companyId, workshopId: 'wA', staffId: base.staff.owner });
    await service.assignStaff({ companyId: base.companyId, workshopId: 'wA', staffId: base.staff.noSend });

    assert.deepEqual(
      await service.authorizeRead({ companyId: 'c1', connectionId: 'connA', staffId: 'agent1' }),
      { allowed: true, reason: 'allowed' },
    );
    assert.deepEqual(
      await service.authorizeSend({ companyId: 'c1', connectionId: 'connA', staffId: 'agent1' }),
      { allowed: false, reason: 'send_denied' },
    );
    assert.deepEqual(
      await service.authorizeSend({ companyId: 'c1', connectionId: 'connA', staffId: 'owner1' }),
      { allowed: true, reason: 'allowed' },
    );
    // Not a member of the routed workshop at all.
    assert.deepEqual(
      await service.authorizeSend({ companyId: 'c1', connectionId: 'connA', staffId: 'outsider' }),
      { allowed: false, reason: 'workshop_mismatch' },
    );
    // Member of the workshop but with no channel_permissions row.
    await service.assignStaff({ companyId: 'c1', workshopId: 'wA', staffId: 'outsider' });
    assert.deepEqual(
      await service.authorizeSend({ companyId: 'c1', connectionId: 'connA', staffId: 'outsider' }),
      { allowed: false, reason: 'permission_missing' },
    );
    // No route at all.
    assert.deepEqual(
      await service.authorizeSend({ companyId: 'c1', connectionId: 'connB', staffId: 'owner1' }),
      { allowed: false, reason: 'route_missing' },
    );
  } finally {
    await close();
  }
});

test('connection rights are bound to the workshop the route belongs to', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const base = await seedWorkshopBase(db, schema);
    const service = serviceFor(db, schema);
    await service.setConnectionRoute({
      companyId: base.companyId,
      connectionId: base.connections.a,
      workshopId: base.workshops.a,
      crmAccountId: base.accounts.a,
      funnelId: 'funnel-1',
      defaultOwnerId: base.staff.owner,
      technicalSourceId: base.sources.a,
    });
    // agent1 has can_read/can_send on connA but works only in workshop B.
    await service.setChannelPermission({
      companyId: 'c1',
      connectionId: 'connA',
      staffId: base.staff.noSend,
      canRead: true,
      canSend: true,
    });
    await service.assignStaff({ companyId: 'c1', workshopId: base.workshops.b, staffId: base.staff.noSend });

    assert.deepEqual(
      await service.authorizeSend({ companyId: 'c1', connectionId: 'connA', staffId: base.staff.noSend }),
      { allowed: false, reason: 'workshop_mismatch' },
    );

    await service.assignStaff({ companyId: 'c1', workshopId: base.workshops.a, staffId: base.staff.noSend });
    assert.deepEqual(
      await service.authorizeSend({ companyId: 'c1', connectionId: 'connA', staffId: base.staff.noSend }),
      { allowed: true, reason: 'allowed' },
    );
  } finally {
    await close();
  }
});

test('a route without send permission never reaches the provider adapter', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const base = await seedWorkshopBase(db, schema);
    const service = serviceFor(db, schema);
    await service.setConnectionRoute({
      companyId: base.companyId,
      connectionId: base.connections.a,
      workshopId: base.workshops.a,
      crmAccountId: base.accounts.a,
      funnelId: 'funnel-1',
      defaultOwnerId: base.staff.owner,
      technicalSourceId: base.sources.a,
    });
    await db.query(`UPDATE "${schema}".connections SET send_enabled=true WHERE id='connA'`);
    await service.assignStaff({ companyId: 'c1', workshopId: 'wA', staffId: base.staff.owner });
    await service.assignStaff({ companyId: 'c1', workshopId: 'wA', staffId: base.staff.noSend });

    let sends = 0;
    const adapter: ChannelAdapter = {
      channelMode: 'max_bot',
      capabilities: () => ({
        textReply: 'supported',
        mediaReply: 'unknown',
        readReceipts: 'unknown',
        deliveryReceipts: 'unknown',
        messageEditing: 'unknown',
        messageDeletion: 'unknown',
      }),
      verifyInbound: () => ({ ok: true }),
      parseInbound: () => ({ events: [] }),
      send: async () => {
        sends += 1;
        return { status: 'sent', providerMessageId: 'pm-1' };
      },
    };

    const dispatchFor = (_actorId: string) => async (input: {
      companyId: string;
      connectionId: string;
      actorId: string;
    }): Promise<boolean> =>
      (await service.authorizeSend({ companyId: input.companyId, connectionId: input.connectionId, staffId: input.actorId }))
        .allowed;

    const denied = await enqueueSend(db, {
      schema,
      companyId: base.companyId,
      intentKey: 'send-denied',
      payload: { connectionId: 'connA', externalChatId: base.externalChatId, content: { kind: 'text', text: 'hi' }, actorId: base.staff.noSend },
    });
    const deniedResult = await dispatchSend({
      db,
      schema,
      adapter,
      jobId: denied.jobId,
      authorize: dispatchFor(base.staff.noSend),
    });
    assert.equal(sends, 0, 'a staff member without can_send must not reach the adapter');
    assert.equal(deniedResult.outcome?.status, 'failed');
    assert.equal((deniedResult.outcome as { errorCode?: string }).errorCode, 'SEND_FORBIDDEN');
    assert.equal(deniedResult.retryScheduled, false);

    const allowed = await enqueueSend(db, {
      schema,
      companyId: base.companyId,
      intentKey: 'send-allowed',
      payload: { connectionId: 'connA', externalChatId: base.externalChatId, content: { kind: 'text', text: 'hi' }, actorId: base.staff.owner },
    });
    const allowedResult = await dispatchSend({
      db,
      schema,
      adapter,
      jobId: allowed.jobId,
      authorize: dispatchFor(base.staff.owner),
    });
    assert.equal(allowedResult.outcome?.status, 'sent');
    assert.equal(sends, 1);
  } finally {
    await close();
  }
});

test('an inbound event resolves the workshop by connection and immutable external chat id', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const base = await seedWorkshopBase(db, schema);
    const service = serviceFor(db, schema);
    await service.setConnectionRoute({
      companyId: base.companyId,
      connectionId: base.connections.a,
      workshopId: base.workshops.a,
      crmAccountId: base.accounts.a,
      funnelId: 'funnel-a',
      defaultOwnerId: base.staff.owner,
      technicalSourceId: base.sources.a,
    });
    await service.setConnectionRoute({
      companyId: base.companyId,
      connectionId: base.connections.b,
      workshopId: base.workshops.b,
      crmAccountId: base.accounts.b,
      funnelId: 'funnel-b',
      defaultOwnerId: base.staff.owner,
      technicalSourceId: base.sources.b,
    });

    // The same external chat id on two connections must not mix workshops.
    const first = await service.resolveInbound({
      companyId: base.companyId,
      connectionId: base.connections.a,
      externalChatId: base.externalChatId,
      chatKind: 'private',
    });
    const second = await service.resolveInbound({
      companyId: base.companyId,
      connectionId: base.connections.b,
      externalChatId: base.externalChatId,
      chatKind: 'private',
    });
    assert.equal(first?.workshopId, 'wA');
    assert.equal(second?.workshopId, 'wB');
    assert.equal(first?.funnelId, 'funnel-a');
    assert.equal(second?.funnelId, 'funnel-b');
    assert.equal(first?.crmImportAllowed, true);
    assert.equal(second?.crmImportAllowed, true);

    const unknown = await service.resolveInbound({
      companyId: base.companyId,
      connectionId: base.connections.a,
      externalChatId: base.externalChatId,
      chatKind: 'unknown',
    });
    assert.equal(unknown?.workshopId, 'wA');
    assert.equal(unknown?.crmImportAllowed, false);
    assert.equal(unknown?.chatDecision.reason, 'unknown_chat_kind');
  } finally {
    await close();
  }
});

test('binding a technical CRM source never overwrites the marketing origin', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const base = await seedWorkshopBase(db, schema);
    const service = serviceFor(db, schema);

    const first = await service.recordMarketingOrigin({
      companyId: base.companyId,
      accountId: base.accounts.a,
      conversationId: base.conversations.a,
      originCode: 'instagram-ad',
      sourceRef: 'campaign-1',
    });
    assert.equal(first.originCode, 'instagram-ad');

    const technical = await service.bindTechnicalSource({
      companyId: base.companyId,
      accountId: base.accounts.a,
      externalId: 'ext-a',
      originCode: 'technical:connA',
    });
    assert.equal(technical.sourceKind, 'technical_chat');
    assert.equal(technical.originCode, 'technical:connA');

    // A later technical binding may not rewrite the advertising origin.
    const second = await service.recordMarketingOrigin({
      companyId: base.companyId,
      accountId: base.accounts.a,
      conversationId: base.conversations.a,
      originCode: 'technical:connA',
    });
    assert.equal(second.originCode, 'instagram-ad');
    assert.equal(
      (await service.getMarketingOrigin(base.companyId, base.accounts.a, base.conversations.a))?.originCode,
      'instagram-ad',
    );

    const sources = await db.query<{ origin_code: string }>(
      `SELECT origin_code FROM "${schema}".crm_sources WHERE company_id='c1' AND id='srcA'`,
    );
    assert.equal(sources.rows[0]?.origin_code, 'technical:connA');
  } finally {
    await close();
  }
});
