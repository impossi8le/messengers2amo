import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import { countRows } from './helpers/attention.ts';
import { withTransaction, type Db } from '../src/platform/db.ts';
import { AmocrmWorkflow, AmocrmWorkflowError, type WorkflowClient } from '../src/integrations/amocrm/workflow.ts';

const FIXED = 1_800_000_000_000;

type ClientState = {
  calls: string[];
  contactOwnerRef: string | null;
  lead: { id: string; responsibleUserId: string | null } | null;
  readError: Error | null;
  pushError: Error | null;
  pushes: Array<{ contactId: string; ownerRef: string }>;
};

function fakeClient(overrides: Partial<ClientState> = {}): { client: WorkflowClient; state: ClientState } {
  const state: ClientState = {
    calls: [],
    contactOwnerRef: null,
    lead: null,
    readError: null,
    pushError: null,
    pushes: [],
    ...overrides,
  };
  const client: WorkflowClient = {
    async readResponsible(input) {
      state.calls.push('readResponsible');
      if (state.readError) throw state.readError;
      assert.ok(input.contactId, 'readResponsible needs the bound contact');
      return { contactOwnerRef: state.contactOwnerRef, lead: state.lead };
    },
    async setContactOwner(input) {
      state.calls.push('setContactOwner');
      if (state.pushError) throw state.pushError;
      state.pushes.push({ contactId: input.contactId, ownerRef: input.ownerRef });
    },
  };
  return { client, state };
}

type SeedOptions = {
  staff?: Array<{ id: string; capacity: number }>;
  workItems?: Array<{ id: string; conversationId: string; ownerId: string | null; version?: number }>;
  leadId?: string | null;
  contactId?: string | null;
  withBinding?: boolean;
  activeCount?: number;
};

/**
 * Seeds company, CRM account, connection, conversations, work items, CRM binding
 * and staff access/sessions: exactly what one workflow test needs.
 */
async function seedWorkflow(db: Db, schema: string, options: SeedOptions = {}) {
  const companyId = 'c1';
  const accountId = 'acc1';
  const connectionId = 'conn1';
  const staff = options.staff ?? [
    { id: 'admin', capacity: 10 },
    { id: 's1', capacity: 10 },
    { id: 's2', capacity: 10 },
  ];
  const workItems = options.workItems ?? [
    { id: 'wi1', conversationId: 'conv1', ownerId: 's1', version: 1 },
  ];
  const q = (sql: string) => sql.replaceAll('__S__', `"${schema}"`);

  await withTransaction(db, async (tx) => {
    await tx.query(q(`INSERT INTO __S__.companies (id, display_name) VALUES ($1,$2)`), [companyId, companyId]);
    for (const member of staff) {
      await tx.query(q(`INSERT INTO __S__.staff (company_id,id,display_name,capacity,active_count) VALUES ($1,$2,$3,$4,$5)`), [
        companyId,
        member.id,
        member.id,
        member.capacity,
        member.id === 's1' ? (options.activeCount ?? workItems.filter((item) => item.ownerId === 's1').length) : 0,
      ]);
    }
    await tx.query(
      q(`INSERT INTO __S__.connections
           (company_id,id,channel_mode,binding_epoch,credentials_version,state,version,capabilities)
         VALUES ($1,$2,'telegram_bot',1,1,'active',0,'{}'::jsonb)`),
      [companyId, connectionId],
    );
    await tx.query(q(`INSERT INTO __S__.connection_identities (company_id,connection_id,binding_epoch) VALUES ($1,$2,1)`), [
      companyId,
      connectionId,
    ]);
    await tx.query(
      q(`INSERT INTO __S__.crm_accounts (company_id,id,external_account_id,state) VALUES ($1,$2,'amojo-1','active')`),
      [companyId, accountId],
    );
    for (const item of workItems) {
      await tx.query(
        q(`INSERT INTO __S__.conversations (company_id,id,connection_id,binding_epoch,external_chat_id,chat_kind)
           VALUES ($1,$2,$3,1,$4,'private')`),
        [companyId, item.conversationId, connectionId, `chat-${item.conversationId}`],
      );
      await tx.query(
        q(`INSERT INTO __S__.work_items (company_id,id,conversation_id,state,owner_id,assignment_version)
           VALUES ($1,$2,$3,$4,$5,$6)`),
        [companyId, item.id, item.conversationId, item.ownerId ? 'assigned' : 'queued', item.ownerId, item.version ?? 1],
      );
    }
    if (options.withBinding !== false) {
      for (const item of workItems) {
        await tx.query(
          q(`INSERT INTO __S__.crm_bindings (company_id,id,account_id,conversation_id,state,contact_id,chat_id,lead_id)
             VALUES ($1,$2,$3,$4,$5,$6,'chat-1',$7)`),
          [
            companyId,
            `bind-${item.id}`,
            accountId,
            item.conversationId,
            options.contactId === null ? 'pending' : 'bound',
            options.contactId === null ? null : (options.contactId ?? 'contact-1'),
            options.leadId === undefined ? 'lead-1' : options.leadId,
          ],
        );
      }
    }
    for (const member of staff) {
      await tx.query(
        q(`INSERT INTO __S__.staff_access (company_id,staff_id,role,version) VALUES ($1,$2,$3,1)`),
        [companyId, member.id, member.id === 'admin' ? 'admin' : 'send'],
      );
      await tx.query(
        q(`INSERT INTO __S__.staff_sessions (company_id,id,staff_id,epoch,expires_at)
           VALUES ($1,$2,$3,1, now() + interval '1 day')`),
        [companyId, `sess-${member.id}`, member.id],
      );
    }
  });

  return { companyId, accountId, connectionId, conversationId: workItems[0]!.conversationId, workItemId: workItems[0]!.id };
}

function workflow(db: Db, schema: string, client: WorkflowClient): AmocrmWorkflow {
  return new AmocrmWorkflow({ db, schema, client, now: () => FIXED });
}

// --- 1. Explicit, configurable source of truth -------------------------------

test('the assignment policy defaults to platform and is changed explicitly with audit', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedWorkflow(db, schema);
    const { client } = fakeClient();
    const flow = workflow(db, schema, client);

    assert.deepEqual(await flow.getPolicy(fx.companyId), { sourceOfTruth: 'platform', version: 0 });

    const updated = await flow.setPolicy({
      companyId: fx.companyId,
      actorId: 'admin',
      sourceOfTruth: 'crm',
      expectedVersion: 0,
    });
    assert.deepEqual(updated, { sourceOfTruth: 'crm', version: 1 });
    assert.deepEqual(await flow.getPolicy(fx.companyId), { sourceOfTruth: 'crm', version: 1 });
    assert.equal(
      await countRows(db, schema, 'audit_events', "event_name='amocrm.assignment_policy_changed'", []),
      1,
    );

    await assert.rejects(
      flow.setPolicy({ companyId: fx.companyId, actorId: 'admin', sourceOfTruth: 'platform', expectedVersion: 0 }),
      (error: unknown) => error instanceof AmocrmWorkflowError && error.code === 'VERSION_CONFLICT',
    );
    assert.deepEqual(await flow.getPolicy(fx.companyId), { sourceOfTruth: 'crm', version: 1 });
  } finally {
    await close();
  }
});

// --- 2. CRM assignment change never replaces the local assignee --------------

test('assignment.changed from CRM stores the CRM owner and leaves the local assignee untouched', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedWorkflow(db, schema);
    const { client } = fakeClient();
    const flow = workflow(db, schema, client);

    const result = await flow.applyCrmAssignmentChanged({
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
      crmOwnerRef: 'amo-user-777',
    });
    assert.equal(result.action, 'recorded');
    assert.equal(result.conflictId, null);

    const { rows: owners } = await db.query<{ crm_owner_ref: string }>(
      `SELECT crm_owner_ref FROM "${schema}".crm_contact_owners WHERE company_id=$1 AND conversation_id=$2`,
      [fx.companyId, fx.conversationId],
    );
    assert.equal(owners[0]!.crm_owner_ref, 'amo-user-777');

    const { rows: items } = await db.query<{ owner_id: string; assignment_version: string }>(
      `SELECT owner_id, assignment_version FROM "${schema}".work_items WHERE id=$1`,
      [fx.workItemId],
    );
    assert.equal(items[0]!.owner_id, 's1', 'CRM owner must not overwrite the local assignee');
    assert.equal(Number(items[0]!.assignment_version), 1);
  } finally {
    await close();
  }
});

test('a CRM change that disagrees with a platform-owned assignment is recorded as a conflict, not silently applied', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedWorkflow(db, schema);
    const { client } = fakeClient();
    const flow = workflow(db, schema, client);

    // Platform owns assignment: the local assignee is the intended CRM owner too.
    await db.query(
      `INSERT INTO "${schema}".staff_crm_refs (company_id,account_id,staff_id,crm_user_ref) VALUES ($1,$2,'s1','amo-user-111')`,
      [fx.companyId, fx.accountId],
    );
    const conflict = await flow.applyCrmAssignmentChanged({
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
      crmOwnerRef: 'amo-user-999',
    });
    assert.equal(conflict.action, 'conflict');
    assert.equal(conflict.winner, 'platform');
    assert.ok(conflict.conflictId);

    const { rows } = await db.query<{
      crm_owner_ref: string;
      platform_owner_id: string;
      winner: string;
      state: string;
      policy: string;
    }>(
      `SELECT crm_owner_ref, platform_owner_id, winner, state, policy
         FROM "${schema}".crm_assignment_conflicts WHERE id=$1`,
      [conflict.conflictId],
    );
    assert.equal(rows[0]!.crm_owner_ref, 'amo-user-999');
    assert.equal(rows[0]!.platform_owner_id, 's1');
    assert.equal(rows[0]!.winner, 'platform');
    assert.equal(rows[0]!.policy, 'platform');
    assert.equal(rows[0]!.state, 'open');

    // The CRM fact is still recorded as an observation; the local assignee is not changed.
    const { rows: owners } = await db.query<{ crm_owner_ref: string }>(
      `SELECT crm_owner_ref FROM "${schema}".crm_contact_owners WHERE company_id=$1 AND conversation_id=$2`,
      [fx.companyId, fx.conversationId],
    );
    assert.equal(owners[0]!.crm_owner_ref, 'amo-user-999');
    const { rows: items } = await db.query<{ owner_id: string }>(
      `SELECT owner_id FROM "${schema}".work_items WHERE id=$1`,
      [fx.workItemId],
    );
    assert.equal(items[0]!.owner_id, 's1');
    assert.equal(
      await countRows(db, schema, 'audit_events', "event_name='amocrm.assignment_conflict'", []),
      1,
    );
  } finally {
    await close();
  }
});

// --- 3. Platform assignment change is projected to CRM with audit ------------

test('a platform assignment change is pushed to the CRM projection and audited', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedWorkflow(db, schema, { staff: [
      { id: 'admin', capacity: 10 },
      { id: 's1', capacity: 10 },
      { id: 's2', capacity: 10 },
    ] });
    await db.query(
      `INSERT INTO "${schema}".staff_crm_refs (company_id,account_id,staff_id,crm_user_ref) VALUES ($1,$2,'s2','amo-user-888')`,
      [fx.companyId, fx.accountId],
    );
    const { client, state } = fakeClient();
    const flow = workflow(db, schema, client);

    await flow.transferTo({ companyId: fx.companyId, workItemId: fx.workItemId, actorId: 'admin', toStaffId: 's2' });

    const result = await flow.projectOwnerChange({
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
      actorId: 'admin',
      requestKey: 'project-1',
    });
    assert.equal(result.projected, true);
    assert.equal(result.ownerRef, 'amo-user-888');
    assert.deepEqual(state.pushes, [{ contactId: 'contact-1', ownerRef: 'amo-user-888' }]);

    const { rows } = await db.query<{ desired_owner_ref: string; projected_owner_ref: string; state: string }>(
      `SELECT desired_owner_ref, projected_owner_ref, state FROM "${schema}".crm_owner_projections
        WHERE company_id=$1 AND account_id=$2 AND conversation_id=$3`,
      [fx.companyId, fx.accountId, fx.conversationId],
    );
    assert.equal(rows[0]!.desired_owner_ref, 'amo-user-888');
    assert.equal(rows[0]!.projected_owner_ref, 'amo-user-888');
    assert.equal(rows[0]!.state, 'applied');
    assert.equal(
      await countRows(db, schema, 'audit_events', "event_name='amocrm.owner_projection_applied'", []),
      1,
    );
  } finally {
    await close();
  }
});

test('an unconfirmed staff-to-CRM mapping blocks projection instead of guessing an owner', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedWorkflow(db, schema);
    const { client, state } = fakeClient();
    const flow = workflow(db, schema, client);

    const result = await flow.projectOwnerChange({
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
      actorId: 'admin',
      requestKey: 'project-unmapped',
    });
    assert.equal(result.projected, false);
    assert.equal(result.reason, 'crm_user_mapping_missing');
    assert.equal(state.pushes.length, 0, 'no CRM write without a confirmed mapping');
    const { rows } = await db.query<{ state: string; error_code: string }>(
      `SELECT state, error_code FROM "${schema}".crm_owner_projections WHERE conversation_id=$1`,
      [fx.conversationId],
    );
    assert.equal(rows[0]!.state, 'failed');
    assert.equal(rows[0]!.error_code, 'crm_user_mapping_missing');
  } finally {
    await close();
  }
});

test('with CRM as the source of truth the platform never overwrites the CRM owner', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedWorkflow(db, schema);
    await db.query(
      `INSERT INTO "${schema}".staff_crm_refs (company_id,account_id,staff_id,crm_user_ref) VALUES ($1,$2,'s1','amo-user-111')`,
      [fx.companyId, fx.accountId],
    );
    const { client, state } = fakeClient();
    const flow = workflow(db, schema, client);
    await flow.setPolicy({ companyId: fx.companyId, actorId: 'admin', sourceOfTruth: 'crm', expectedVersion: 0 });

    const result = await flow.projectOwnerChange({
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
      actorId: 'admin',
      requestKey: 'project-crm-wins',
    });
    assert.equal(result.projected, false);
    assert.equal(result.reason, 'crm_source_of_truth');
    assert.equal(state.pushes.length, 0, 'CRM wins: no write back into CRM');

    const { rows } = await db.query<{ state: string; error_code: string; projected_owner_ref: string | null }>(
      `SELECT state, error_code, projected_owner_ref FROM "${schema}".crm_owner_projections
        WHERE conversation_id=$1`,
      [fx.conversationId],
    );
    assert.equal(rows[0]!.state, 'failed');
    assert.equal(rows[0]!.error_code, 'crm_source_of_truth');
    assert.equal(rows[0]!.projected_owner_ref, null);

    // The opposite policy lets the same change through.
    await flow.setPolicy({ companyId: fx.companyId, actorId: 'admin', sourceOfTruth: 'platform', expectedVersion: 1 });
    const allowed = await flow.projectOwnerChange({
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
      actorId: 'admin',
      requestKey: 'project-platform-wins',
    });
    assert.equal(allowed.projected, true);
    assert.deepEqual(state.pushes, [{ contactId: 'contact-1', ownerRef: 'amo-user-111' }]);
  } finally {
    await close();
  }
});

test('a failed CRM write leaves a failed projection, is audited and is visible in diagnostics', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedWorkflow(db, schema);
    await db.query(
      `INSERT INTO "${schema}".staff_crm_refs (company_id,account_id,staff_id,crm_user_ref) VALUES ($1,$2,'s1','amo-user-111')`,
      [fx.companyId, fx.accountId],
    );
    const { client, state } = fakeClient({ pushError: new Error('amocrm_unreachable') });
    const flow = workflow(db, schema, client);

    const result = await flow.projectOwnerChange({
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
      actorId: 'admin',
      requestKey: 'project-fail-1',
    });
    assert.equal(result.projected, false);
    assert.equal(result.reason, 'upstream_unavailable');
    assert.deepEqual(state.calls, ['setContactOwner'], 'the failure is the CRM write, not a chat send');

    const { rows } = await db.query<{
      state: string;
      error_code: string;
      desired_owner_ref: string;
      projected_owner_ref: string | null;
    }>(
      `SELECT state, error_code, desired_owner_ref, projected_owner_ref
         FROM "${schema}".crm_owner_projections
        WHERE company_id=$1 AND account_id=$2 AND conversation_id=$3`,
      [fx.companyId, fx.accountId, fx.conversationId],
    );
    assert.equal(rows[0]!.state, 'failed');
    assert.equal(rows[0]!.error_code, 'upstream_unavailable');
    assert.equal(rows[0]!.desired_owner_ref, 'amo-user-111');
    assert.equal(rows[0]!.projected_owner_ref, null);
    assert.equal(
      await countRows(db, schema, 'audit_events', "event_name='amocrm.owner_projection_failed'", []),
      1,
    );

    const diagnostics = await flow.getDiagnostics({
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
    });
    assert.equal(diagnostics.projection?.state, 'failed');

    // A later explicit retry with a new key recovers the projection.
    const { client: healthy } = fakeClient();
    const retry = workflow(db, schema, healthy);
    const recovered = await retry.projectOwnerChange({
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
      actorId: 'admin',
      requestKey: 'project-fail-2',
    });
    assert.equal(recovered.projected, true);
    assert.equal(recovered.ownerRef, 'amo-user-111');
    const after = await retry.getDiagnostics({
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
    });
    assert.equal(after.projection?.state, 'applied');
    assert.equal(after.projection?.projectedOwnerRef, 'amo-user-111');
  } finally {
    await close();
  }
});

test('two concurrent projections of the same change write the owner to CRM once', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedWorkflow(db, schema);
    await db.query(
      `INSERT INTO "${schema}".staff_crm_refs (company_id,account_id,staff_id,crm_user_ref) VALUES ($1,$2,'s1','amo-user-111')`,
      [fx.companyId, fx.accountId],
    );
    // The write yields once so a second caller can run while the first is between
    // its claim and its acknowledgement; no timers or sleeps are involved.
    const pushes: string[] = [];
    const calls: string[] = [];
    const client: WorkflowClient = {
      async readResponsible() {
        throw new Error('not used');
      },
      async setContactOwner(write) {
        calls.push('setContactOwner');
        await new Promise<void>((resolve) => setImmediate(resolve));
        pushes.push(write.ownerRef);
      },
    };
    const state = { calls, pushes };
    const flow = workflow(db, schema, client);

    const input = {
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
      actorId: 'admin',
      requestKey: 'project-race-1',
    };
    const [first, second] = await Promise.all([
      flow.projectOwnerChange(input),
      flow.projectOwnerChange(input),
    ]);

    assert.deepEqual(first, { projected: true, ownerRef: 'amo-user-111' });
    assert.deepEqual(second, { projected: true, ownerRef: 'amo-user-111' });
    assert.deepEqual(
      state.calls.filter((call) => call === 'setContactOwner'),
      ['setContactOwner'],
      'a concurrent duplicate must not issue a second CRM write',
    );
    assert.deepEqual(state.pushes, ['amo-user-111']);

    const { rows } = await db.query<{
      state: string;
      desired_owner_ref: string;
      projected_owner_ref: string;
      version: string;
      last_request_key: string;
    }>(
      `SELECT state, desired_owner_ref, projected_owner_ref, version, last_request_key
         FROM "${schema}".crm_owner_projections
        WHERE company_id=$1 AND account_id=$2 AND conversation_id=$3`,
      [fx.companyId, fx.accountId, fx.conversationId],
    );
    assert.equal(rows.length, 1, 'one projection row per conversation');
    assert.equal(rows[0]!.state, 'applied');
    assert.equal(rows[0]!.desired_owner_ref, 'amo-user-111');
    assert.equal(rows[0]!.projected_owner_ref, 'amo-user-111');
    assert.equal(rows[0]!.last_request_key, 'project-race-1');
    // One claim (v1) plus one applied transition (v2); the duplicate adds nothing.
    assert.equal(Number(rows[0]!.version), 2);
    assert.equal(
      await countRows(db, schema, 'audit_events', "event_name='amocrm.owner_projection_applied'", []),
      1,
    );
  } finally {
    await close();
  }
});

test('the workflow never sends chat messages while applying CRM changes or resyncing', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedWorkflow(db, schema);
    const { client, state } = fakeClient({
      contactOwnerRef: 'amo-user-1',
      lead: { id: 'lead-1', responsibleUserId: 'amo-user-1' },
    });
    const flow = workflow(db, schema, client);

    await flow.applyCrmAssignmentChanged({
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
      crmOwnerRef: 'amo-user-1',
    });
    assert.deepEqual(state.calls, [], 'a CRM assignment change writes nothing back to CRM or the chat');

    await flow.syncConversation({
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
      actorId: 'admin',
      requestKey: 'noreply-1',
    });
    assert.deepEqual(state.calls, ['readResponsible'], 'a resync only reads the CRM');
  } finally {
    await close();
  }
});

// --- 4. Missing lead is a visible state, not an error ------------------------

test('a conversation without a CRM lead reports crm_lead_missing instead of failing', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedWorkflow(db, schema, { leadId: null });
    const { client, state } = fakeClient({ contactOwnerRef: 'amo-user-555' });
    const flow = workflow(db, schema, client);

    const result = await flow.syncConversation({
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
      actorId: 'admin',
      requestKey: 'sync-1',
    });
    assert.equal(result.status, 'lead_missing');
    assert.equal(result.replayed, false);
    assert.equal(result.leadId, null);
    assert.equal(result.errorCode, 'crm_lead_missing');
    assert.equal(result.crmOwnerRef, 'amo-user-555', 'the contact owner is still observed');
    assert.equal(state.calls.filter((call) => call === 'readResponsible').length, 1);

    const diagnostics = await flow.getDiagnostics({
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
    });
    assert.equal(diagnostics.sync?.status, 'lead_missing');
    assert.equal(diagnostics.sync?.errorCode, 'crm_lead_missing');
    assert.equal(diagnostics.leadMissing, true);
  } finally {
    await close();
  }
});

// --- 4b. Linked CRM card -----------------------------------------------------

test('diagnostics expose the linked CRM card built from the conversation binding', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedWorkflow(db, schema);
    const { client } = fakeClient();
    const flow = new AmocrmWorkflow({
      db,
      schema,
      client,
      now: () => FIXED,
      accountDomain: 'p14lenrem.amocrm.ru',
    });

    const diagnostics = await flow.getDiagnostics({
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
    });
    assert.deepEqual(diagnostics.binding, {
      accountId: 'acc1',
      contactId: 'contact-1',
      leadId: 'lead-1',
      chatId: 'chat-1',
      state: 'bound',
    });
    assert.equal(diagnostics.cardUrl, 'https://p14lenrem.amocrm.ru/leads/detail/lead-1');

    // Without a configured domain the card is not linked, but the binding stays visible.
    const noDomain = new AmocrmWorkflow({ db, schema, client, now: () => FIXED });
    const plain = await noDomain.getDiagnostics({
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
    });
    assert.equal(plain.cardUrl, null);
    assert.deepEqual(plain.binding, diagnostics.binding);
  } finally {
    await close();
  }
});

test('a binding without a lead links to the contact card instead', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedWorkflow(db, schema, { leadId: null });
    const { client } = fakeClient();
    const flow = new AmocrmWorkflow({
      db,
      schema,
      client,
      now: () => FIXED,
      accountDomain: 'p14lenrem.amocrm.ru',
    });

    const diagnostics = await flow.getDiagnostics({
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
    });
    assert.equal(diagnostics.binding?.leadId, null);
    assert.equal(diagnostics.cardUrl, 'https://p14lenrem.amocrm.ru/contacts/detail/contact-1');
  } finally {
    await close();
  }
});

test('a conversation without a binding has no CRM card link', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedWorkflow(db, schema, { withBinding: false });
    const { client } = fakeClient();
    const flow = new AmocrmWorkflow({
      db,
      schema,
      client,
      now: () => FIXED,
      accountDomain: 'p14lenrem.amocrm.ru',
    });

    const diagnostics = await flow.getDiagnostics({
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
    });
    assert.equal(diagnostics.binding, null);
    assert.equal(diagnostics.cardUrl, null);
  } finally {
    await close();
  }
});

// --- 5. Access revocation returns assignments to the queue -------------------

test('revoking staff access returns their work items to the queue and is audited', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedWorkflow(db, schema, {
      workItems: [
        { id: 'wi1', conversationId: 'conv1', ownerId: 's1', version: 3 },
        { id: 'wi2', conversationId: 'conv2', ownerId: 's1', version: 1 },
        { id: 'wi3', conversationId: 'conv3', ownerId: 's2', version: 1 },
      ],
    });
    const { client } = fakeClient();
    const flow = workflow(db, schema, client);

    const result = await flow.revokeStaffAccess({
      companyId: fx.companyId,
      staffId: 's1',
      actorId: 'admin',
      requestKey: 'revoke-1',
    });
    assert.equal(result.released, 2);
    assert.deepEqual(result.workItemIds.sort(), ['wi1', 'wi2']);

    const { rows: items } = await db.query<{ id: string; owner_id: string | null; state: string; assignment_version: string }>(
      `SELECT id, owner_id, state, assignment_version FROM "${schema}".work_items ORDER BY id`,
    );
    assert.deepEqual(
      items.map((item) => [item.id, item.owner_id, item.state, Number(item.assignment_version)]),
      [
        ['wi1', null, 'queued', 4],
        ['wi2', null, 'queued', 2],
        ['wi3', 's2', 'assigned', 1],
      ],
      'only the revoked employee\'s items return to the queue',
    );

    const { rows: staff } = await db.query<{ active_count: number }>(
      `SELECT active_count FROM "${schema}".staff WHERE id='s1'`,
    );
    assert.equal(staff[0]!.active_count, 0, 'capacity slots are released');

    const { rows: access } = await db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM "${schema}".staff_access WHERE staff_id='s1'`,
    );
    assert.equal(access[0]!.c, 0, 'the access grant is withdrawn');
    const { rows: sessions } = await db.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM "${schema}".staff_sessions WHERE staff_id='s1'`,
    );
    assert.ok(sessions[0]!.revoked_at, 'sessions are revoked');

    const { rows: history } = await db.query<{ reason: string; previous_owner_id: string; owner_id: string | null }>(
      `SELECT reason, previous_owner_id, owner_id FROM "${schema}".assignment_history
        WHERE work_item_id IN ('wi1','wi2') ORDER BY work_item_id`,
    );
    assert.deepEqual(
      history.map((row) => [row.reason, row.previous_owner_id, row.owner_id]),
      [
        ['access_revoked', 's1', null],
        ['access_revoked', 's1', null],
      ],
    );
    assert.equal(
      await countRows(db, schema, 'audit_events', "event_name='amocrm.staff_access_revoked'", []),
      1,
    );

    // A replay of the same command is a no-op, not a second release.
    const replay = await flow.revokeStaffAccess({
      companyId: fx.companyId,
      staffId: 's1',
      actorId: 'admin',
      requestKey: 'revoke-1',
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.released, 2);
    assert.equal(await countRows(db, schema, 'assignment_history', "reason='access_revoked'", []), 2);
  } finally {
    await close();
  }
});

// --- 6. Manual resync is idempotent ----------------------------------------

test('a manual resync with the same request key replays without a second CRM read or duplicate rows', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedWorkflow(db, schema, { leadId: 'lead-1' });
    const { client, state } = fakeClient({
      contactOwnerRef: 'amo-user-777',
      lead: { id: 'lead-1', responsibleUserId: 'amo-user-777' },
    });
    const flow = workflow(db, schema, client);

    const first = await flow.syncConversation({
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
      actorId: 'admin',
      requestKey: 'resync-1',
    });
    assert.equal(first.status, 'ok');
    assert.equal(first.replayed, false);
    assert.equal(first.leadId, 'lead-1');
    assert.equal(first.crmOwnerRef, 'amo-user-777');

    const second = await flow.syncConversation({
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
      actorId: 'admin',
      requestKey: 'resync-1',
    });
    assert.equal(second.replayed, true);
    assert.deepEqual(second, { ...first, replayed: true });
    assert.equal(
      state.calls.filter((call) => call === 'readResponsible').length,
      1,
      'a replay must not read CRM again',
    );
    assert.equal(await countRows(db, schema, 'crm_sync_state', 'company_id=$1', [fx.companyId]), 1);
    assert.equal(await countRows(db, schema, 'crm_bindings', 'company_id=$1', [fx.companyId]), 1);
    assert.equal(await countRows(db, schema, 'crm_contact_owners', 'company_id=$1', [fx.companyId]), 1);

    const fresh = await flow.syncConversation({
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
      actorId: 'admin',
      requestKey: 'resync-2',
    });
    assert.equal(fresh.replayed, false);
    assert.equal(state.calls.filter((call) => call === 'readResponsible').length, 2);
  } finally {
    await close();
  }
});

// --- 7. Sync failures are visible in diagnostics ---------------------------

test('a failed sync is stored and exposed in diagnostics without throwing', async () => {
  const { db, schema, close } = await createTestDb();
  try {
    const fx = await seedWorkflow(db, schema, { leadId: 'lead-1' });
    const { client } = fakeClient({ readError: new Error('amocrm_unreachable') });
    const flow = workflow(db, schema, client);

    const result = await flow.syncConversation({
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
      actorId: 'admin',
      requestKey: 'sync-fail-1',
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'upstream_unavailable');
    assert.equal(result.replayed, false);

    const state = await flow.getSyncState({
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
    });
    assert.equal(state?.status, 'failed');
    assert.equal(state?.errorCode, 'upstream_unavailable');
    assert.equal(state?.lastAttemptAt, FIXED);
    assert.equal(state?.lastSuccessAt, null);

    const diagnostics = await flow.getDiagnostics({
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
    });
    assert.equal(diagnostics.sync?.status, 'failed');
    assert.equal(diagnostics.sync?.errorCode, 'upstream_unavailable');
    assert.equal(diagnostics.leadMissing, false);

    // A later successful sync clears the failure.
    const { client: healthy } = fakeClient({
      contactOwnerRef: 'amo-user-1',
      lead: { id: 'lead-1', responsibleUserId: 'amo-user-1' },
    });
    const flow2 = workflow(db, schema, healthy);
    const ok = await flow2.syncConversation({
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
      actorId: 'admin',
      requestKey: 'sync-fail-2',
    });
    assert.equal(ok.status, 'ok');
    const after = await flow.getSyncState({
      companyId: fx.companyId,
      accountId: fx.accountId,
      conversationId: fx.conversationId,
    });
    assert.equal(after?.status, 'ok');
    assert.equal(after?.errorCode, null);
    assert.equal(after?.lastSuccessAt, FIXED);
  } finally {
    await close();
  }
});
