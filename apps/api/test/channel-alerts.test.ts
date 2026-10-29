// RT07: channel alerts.
//
// A channel alert is a stored, tenant-scoped, deduplicated event that the
// administrator who owns the channel (`connection_routes.alert_staff_id`) must
// hear about. These tests pin the guarantees that make it usable:
//
//   * it reaches the personal notification feed, and only that recipient;
//   * a repeated trigger produces one alert, not several;
//   * a channel without a recipient skips cleanly instead of failing;
//   * it never carries PII or provider error text;
//   * revoked access disables the channel and leaves the `unknown` send rules alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createTestApp, cookieFromResponse } from './helpers/app.ts';
import { seedCompany, seedConnection } from './helpers/seed.ts';
import { seedConnection as seedChannelConnection, fakeFetch } from './helpers/channel-fixtures.ts';
import { createMaxAdapter } from '../src/channels/max.ts';
import { dispatchSend, enqueueSend } from '../src/channels/outbox.ts';
import { disableChannelAndAlert, raiseAlert } from '../src/channels/alerts.ts';
import { raiseChannelAlert, resolveAlertRecipient } from '../src/repo/alerts.ts';
import { withTransaction, type Db } from '../src/platform/db.ts';
import { createOAuth } from '../src/integrations/amocrm/oauth.ts';
import { createTokenCipher } from '../src/integrations/amocrm/crypto.ts';
import { createFakeFetch } from './helpers/amocrm.ts';
import { registerChannel } from '../src/integrations/amocrm/store.ts';

const PASSWORD = 'correct horse battery staple';

test('only a real lifecycle transition to disabled alerts; activation and command replay do not', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    await seedAlertFixture(db, schema);
    const cookie = await login(app, 'c1', 'boss');
    for (const [key, version, state] of [
      ['enable', 0, 'active'],
      ['disable', 1, 'disabled'],
      ['disable', 1, 'disabled'],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v2/operator/connections/conn1/lifecycle',
        headers: { cookie },
        payload: { idempotencyKey: key, expectedVersion: version, desiredState: state },
      });
      assert.equal(response.statusCode, 202, response.body);
      assert.equal((await readAlerts(db, schema, 'c1')).length, state === 'active' ? 0 : 1);
    }
  } finally {
    await close();
  }
});

test('transient refresh failures alert only after three failures and alert each configured channel', async () => {
  const { db, schema, close } = await createTestApp();
  try {
    await seedAlertFixture(db, schema);
    const cipher = createTokenCipher('test-refresh-alert-key-material');
    for (const [connectionId, scopeId] of [
      ['conn1', 'scope1'],
      ['conn2', 'scope2'],
    ]) {
      await registerChannel(db, schema, {
        companyId: 'c1',
        accountId: 'acc_conn1',
        connectionId: connectionId!,
        scopeId: scopeId!,
        channelCode: 'test',
        secretEnc: cipher.encrypt('test-channel-secret'),
        bindingEpoch: 0,
        amojoAccountId: 'amojo1',
      });
    }
    const http = createFakeFetch((call) =>
      JSON.parse(call.body!).grant_type === 'authorization_code'
        ? {
            status: 200,
            body: {
              access_token: 'test-access',
              refresh_token: 'test-refresh',
              expires_in: 60,
              token_type: 'Bearer',
            },
          }
        : { status: 503, body: { error: 'unavailable' } },
    );
    const oauth = createOAuth({
      db,
      schema,
      cipher,
      fetch: http,
      config: {
        clientId: 'client1',
        clientSecret: 'test-secret',
        redirectUri: 'https://example.test/callback',
        accountDomain: 'example.amocrm.ru',
      },
    });
    const { state } = await oauth.authorizationUrl({ companyId: 'c1', accountId: 'acc_conn1' });
    await oauth.complete({ companyId: 'c1', code: 'test-code', state });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await assert.rejects(() => oauth.refresh({ companyId: 'c1', accountId: 'acc_conn1', force: true }));
      assert.equal((await readAlerts(db, schema, 'c1')).length, attempt < 3 ? 0 : 2);
    }
    await assert.rejects(() => oauth.refresh({ companyId: 'c1', accountId: 'acc_conn1', force: true }));
    assert.equal(
      (await readAlerts(db, schema, 'c1')).length,
      2,
      'each recipient is alerted once per credential generation',
    );
  } finally {
    await close();
  }
});

type AlertRow = {
  id: string;
  company_id: string;
  connection_id: string;
  kind: string;
  dedupe_key: string;
  recipient_staff_id: string;
  error_code: string | null;
  connection_state: string | null;
  conversation_id: string | null;
  external_message_id: string | null;
  created_at: Date;
};

type Notification = {
  id: string;
  kind: string;
  workItemId: string;
  conversationId: string;
  attentionSeq: number | null;
  createdAt: string;
  hint: string;
  channelAlert: {
    connectionId: string;
    alertKind: string;
    errorCode: string | null;
    connectionState: string | null;
  } | null;
};

type NotificationList = {
  items: Notification[];
  page: { nextCursor: string | null };
  hints: {
    replyRequiredCount: number;
    overdueCount: number;
    unknownSendCount: number;
    channelAlertCount: number;
  };
};

type Fixture = { companyId: string; schema: string; db: Db };

async function login(app: FastifyInstance, companyId: string, staffId: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v2/auth/login',
    payload: { companyId, staffId, password: PASSWORD },
  });
  assert.equal(response.statusCode, 200, response.body);
  return cookieFromResponse(response);
}

async function listNotifications(
  app: FastifyInstance,
  cookie: string,
  query = '',
): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url: `/api/v2/operator/notifications${query}`, headers: { cookie } });
}

async function readAlerts(db: Db, schema: string, companyId: string): Promise<AlertRow[]> {
  const { rows } = await db.query<AlertRow>(
    `SELECT id, company_id, connection_id, kind, dedupe_key, recipient_staff_id,
            error_code, connection_state, conversation_id, external_message_id, created_at
       FROM "${schema}".channel_alerts
      WHERE company_id = $1
      ORDER BY created_at, id`,
    [companyId],
  );
  return rows;
}

/**
 * One company, two workshops and two staff members. `conn1` is routed to `ws1`
 * and alerts `s1`; `conn2` is routed to `ws2` and alerts `s2`.
 */
async function seedAlertFixture(db: Db, schema: string): Promise<Fixture> {
  const companyId = 'c1';
  await seedCompany(db, {
    companyId,
    workshops: ['ws1', 'ws2'],
    staff: [
      { id: 's1', password: PASSWORD, role: 'manage', workshopId: 'ws1' },
      { id: 's2', password: PASSWORD, role: 'manage', workshopId: 'ws2' },
      { id: 'boss', password: PASSWORD, role: 'admin', workshopId: null },
    ],
  });
  await seedConnection(db, { companyId, id: 'conn1', state: 'active', workshopId: 'ws1', ownerId: 's1' });
  await seedConnection(db, { companyId, id: 'conn2', state: 'active', workshopId: 'ws2', ownerId: 's2' });
  await db.query(
    `UPDATE connection_routes SET alert_staff_id = 's1' WHERE company_id = $1 AND connection_id = 'conn1'`,
    [companyId],
  );
  await db.query(
    `UPDATE connection_routes SET alert_staff_id = 's2' WHERE company_id = $1 AND connection_id = 'conn2'`,
    [companyId],
  );
  return { companyId, schema, db };
}

/**
 * A connection with a complete route and an alert recipient.
 *
 * The route has three foreign keys besides the connection: the workshop, the CRM
 * account with its technical source, and the default owner. All of them must
 * exist before a route row can be written, so the fixture provisions them.
 */
async function seedRoutedChannel(
  db: Db,
  schema: string,
  options: { companyId?: string; connectionId?: string; staffId?: string; workshopId?: string },
): Promise<{ companyId: string; connectionId: string; staffId: string }> {
  const companyId = options.companyId ?? 'c1';
  const connectionId = options.connectionId ?? 'conn1';
  const staffId = options.staffId ?? 's1';
  const workshopId = options.workshopId ?? 'ws1';
  const accountId = `acc_${connectionId}`;
  const sourceId = `src_${connectionId}`;

  await db.query(`INSERT INTO companies (id, display_name) VALUES ($1,$1) ON CONFLICT DO NOTHING`, [
    companyId,
  ]);
  await db.query(
    `INSERT INTO workshops (company_id,id,display_name) VALUES ($1,$2,$2) ON CONFLICT DO NOTHING`,
    [companyId, workshopId],
  );
  await db.query(`INSERT INTO staff (company_id,id,display_name) VALUES ($1,$2,$2) ON CONFLICT DO NOTHING`, [
    companyId,
    staffId,
  ]);
  await db.query(
    `INSERT INTO crm_accounts (company_id,id,external_account_id,credential_ref,state)
     VALUES ($1,$2,'amojo-1','credref_test','active') ON CONFLICT DO NOTHING`,
    [companyId, accountId],
  );
  await db.query(
    `INSERT INTO crm_sources (company_id,id,account_id,external_id,origin_code)
     VALUES ($1,$2,$3,$4,'technical') ON CONFLICT DO NOTHING`,
    [companyId, sourceId, accountId, `ext_${connectionId}`],
  );
  await withTransaction(db, async (tx) => {
    await tx.query(
      `INSERT INTO connections
         (company_id,id,channel_mode,binding_epoch,credentials_version,state,version,capabilities,
          ingress_enabled,send_enabled,credential_ref)
       VALUES ($1,$2,'max_bot',0,1,'active',0,'{}'::jsonb,true,true,'credref_test')
       ON CONFLICT DO NOTHING`,
      [companyId, connectionId],
    );
    await tx.query(
      `INSERT INTO connection_identities (company_id,connection_id,binding_epoch)
       VALUES ($1,$2,0) ON CONFLICT DO NOTHING`,
      [companyId, connectionId],
    );
  });
  await db.query(
    `INSERT INTO connection_routes
       (company_id,connection_id,workshop_id,crm_account_id,funnel_id,default_owner_id,technical_source_id,version)
     VALUES ($1,$2,$3,$4,'funnel_1',$5,$6,0)
     ON CONFLICT (company_id,connection_id) DO UPDATE
       SET alert_staff_id = EXCLUDED.alert_staff_id`,
    [companyId, connectionId, workshopId, accountId, staffId, sourceId],
  );
  await db.query(
    `UPDATE connection_routes SET alert_staff_id = $3
      WHERE company_id = $1 AND connection_id = $2`,
    [companyId, connectionId, staffId],
  );
  return { companyId, connectionId, staffId };
}

test('a raised alert reaches the personal notification feed of its recipient', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedAlertFixture(db, schema);
    const raised = await raiseAlert(
      db,
      { schema },
      {
        companyId: fx.companyId,
        connectionId: 'conn1',
        kind: 'channel_disabled',
        dedupeKey: 'channel_disabled:conn1:1',
        errorCode: 'ACCESS_REVOKED',
        connectionState: 'disabled',
      },
    );
    assert.equal(raised, true);

    const cookie = await login(app, fx.companyId, 's1');
    const body = (await listNotifications(app, cookie)).json() as NotificationList;
    const alert = body.items.find((item) => item.kind === 'channel_alert');
    assert.ok(alert, 'the alert is visible in the personal feed');
    assert.equal(alert!.channelAlert?.connectionId, 'conn1');
    assert.equal(alert!.channelAlert?.alertKind, 'channel_disabled');
    assert.equal(alert!.channelAlert?.errorCode, 'ACCESS_REVOKED');
    assert.equal(alert!.channelAlert?.connectionState, 'disabled');
    assert.equal(body.hints.channelAlertCount, 1);
  } finally {
    await close();
  }
});

test('an alert is personal: another staff member of the same company does not see it', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedAlertFixture(db, schema);
    await raiseAlert(
      db,
      { schema },
      {
        companyId: fx.companyId,
        connectionId: 'conn1',
        kind: 'channel_disabled',
        dedupeKey: 'channel_disabled:conn1:1',
      },
    );

    const other = await login(app, fx.companyId, 's2');
    const body = (await listNotifications(app, other)).json() as NotificationList;
    assert.equal(body.items.filter((item) => item.kind === 'channel_alert').length, 0);
    assert.equal(body.hints.channelAlertCount, 0);
  } finally {
    await close();
  }
});

test('a channel without a recipient skips the alert cleanly', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedAlertFixture(db, schema);
    // conn3 has a route but no alert recipient.
    await seedConnection(db, {
      companyId: fx.companyId,
      id: 'conn3',
      state: 'active',
      workshopId: 'ws1',
      ownerId: 's1',
    });

    const recipient = await resolveAlertRecipient(
      db,
      { schema },
      {
        companyId: fx.companyId,
        connectionId: 'conn3',
      },
    );
    assert.equal(recipient, null);

    const result = await raiseChannelAlert(
      db,
      { schema },
      {
        companyId: fx.companyId,
        connectionId: 'conn3',
        kind: 'channel_disabled',
        dedupeKey: 'channel_disabled:conn3:1',
      },
    );
    assert.equal(result.status, 'skipped_no_recipient');
    assert.equal((await readAlerts(db, schema, fx.companyId)).length, 0, 'nothing is stored');

    // The feed still answers; a missing recipient is not an error.
    const cookie = await login(app, fx.companyId, 's1');
    const response = await listNotifications(app, cookie);
    assert.equal(response.statusCode, 200, response.body);
  } finally {
    await close();
  }
});

test('the same event raises one alert, not one per attempt', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedAlertFixture(db, schema);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await raiseAlert(
        db,
        { schema },
        {
          companyId: fx.companyId,
          connectionId: 'conn1',
          kind: 'send_rejected',
          dedupeKey: 'send_rejected:job-1',
          errorCode: 'SEND_REJECTED',
        },
      );
    }
    const alerts = await readAlerts(db, schema, fx.companyId);
    assert.equal(alerts.length, 1, 'the dedupe key is unique per tenant');

    const cookie = await login(app, fx.companyId, 's1');
    const body = (await listNotifications(app, cookie)).json() as NotificationList;
    assert.equal(body.items.filter((item) => item.kind === 'channel_alert').length, 1);
    assert.equal(body.hints.channelAlertCount, 1);
  } finally {
    await close();
  }
});

test('alerts are tenant scoped: another company cannot see them', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedAlertFixture(db, schema);
    await seedCompany(db, {
      companyId: 'c2',
      staff: [{ id: 's1', password: PASSWORD, role: 'manage', workshopId: null }],
    });
    await raiseAlert(
      db,
      { schema },
      {
        companyId: fx.companyId,
        connectionId: 'conn1',
        kind: 'channel_disabled',
        dedupeKey: 'channel_disabled:conn1:1',
      },
    );

    const other = await login(app, 'c2', 's1');
    const body = (await listNotifications(app, other)).json() as NotificationList;
    assert.equal(body.items.filter((item) => item.kind === 'channel_alert').length, 0);
    assert.equal(body.hints.channelAlertCount, 0);
  } finally {
    await close();
  }
});

test('an alert payload carries no PII and no provider error text', async () => {
  const { app, db, schema, logs, close } = await createTestApp();
  try {
    const fx = await seedAlertFixture(db, schema);
    await raiseAlert(
      db,
      { schema },
      {
        companyId: fx.companyId,
        connectionId: 'conn1',
        kind: 'send_rejected',
        dedupeKey: 'send_rejected:job-1',
        errorCode: 'SEND_REJECTED',
        conversationId: 'conv-1',
        externalMessageId: 'ext-1',
      },
    );

    const alerts = await readAlerts(db, schema, fx.companyId);
    assert.equal(alerts.length, 1);
    const row = alerts[0]!;
    const serialized = JSON.stringify(row);
    for (const forbidden of ['+7', '@', 'http://', 'https://', 'Bearer', 'text']) {
      assert.ok(!serialized.includes(forbidden), `the payload must not contain ${forbidden}`);
    }
    assert.equal(row.error_code, 'SEND_REJECTED', 'our own code, not the provider text');
    assert.equal(row.conversation_id, 'conv-1');
    assert.equal(row.external_message_id, 'ext-1');

    const cookie = await login(app, fx.companyId, 's1');
    await listNotifications(app, cookie);
    const logged = logs.join('\n');
    assert.ok(!logged.includes('Bearer'), 'no token reaches the log');
    assert.ok(!logged.includes('+7'), 'no phone number reaches the log');
  } finally {
    await close();
  }
});

test('disabling a channel alerts the recipient and stops ingress and sending', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedAlertFixture(db, schema);
    const result = await disableChannelAndAlert(
      db,
      { schema },
      {
        companyId: fx.companyId,
        connectionId: 'conn1',
        dedupeKey: 'access_revoked:acc1:scope-1',
        errorCode: 'ACCESS_REVOKED',
      },
    );
    assert.equal(result.disabled, true);
    assert.equal(result.alerted, true);

    const { rows } = await db.query<{ state: string; ingress_enabled: boolean; send_enabled: boolean }>(
      `SELECT state, ingress_enabled, send_enabled FROM connections WHERE company_id = $1 AND id = 'conn1'`,
      [fx.companyId],
    );
    assert.equal(rows[0]?.state, 'disabled');
    assert.equal(rows[0]?.ingress_enabled, false);
    assert.equal(rows[0]?.send_enabled, false);

    const cookie = await login(app, fx.companyId, 's1');
    const body = (await listNotifications(app, cookie)).json() as NotificationList;
    const alert = body.items.find((item) => item.kind === 'channel_alert');
    assert.ok(alert);
    assert.equal(alert!.channelAlert?.errorCode, 'ACCESS_REVOKED');
  } finally {
    await close();
  }
});

test('disabling an already disabled channel does not alert twice', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedAlertFixture(db, schema);
    await disableChannelAndAlert(
      db,
      { schema },
      {
        companyId: fx.companyId,
        connectionId: 'conn1',
        dedupeKey: 'access_revoked:acc1:scope-1',
        errorCode: 'ACCESS_REVOKED',
      },
    );
    const second = await disableChannelAndAlert(
      db,
      { schema },
      {
        companyId: fx.companyId,
        connectionId: 'conn1',
        dedupeKey: 'access_revoked:acc1:scope-1',
        errorCode: 'ACCESS_REVOKED',
      },
    );
    assert.equal(second.disabled, false, 'the state is already disabled');
    assert.equal((await readAlerts(db, schema, fx.companyId)).length, 1);
  } finally {
    await close();
  }
});

test('revoking access leaves an unknown send operation unknown', async () => {
  const { db, schema, close } = await createTestApp();
  try {
    const fx = await seedAlertFixture(db, schema);
    await db.query(
      `INSERT INTO conversations (company_id,id,connection_id,binding_epoch,external_chat_id,chat_kind)
       VALUES ($1,'conv1','conn1',0,'chat-1','private')`,
      [fx.companyId],
    );
    await db.query(
      `INSERT INTO work_items (company_id,id,conversation_id,state,owner_id)
       VALUES ($1,'wi1','conv1','assigned','s1')`,
      [fx.companyId],
    );
    await db.query(
      `INSERT INTO "${schema}".send_operations
         (company_id,id,work_item_id,conversation_id,connection_id,binding_epoch,actor_id,
          command_type,idempotency_key,payload_fingerprint,state,content,deadline)
       VALUES ($1,'op1','wi1','conv1','conn1',0,'s1','reply','key-1',$2,'unknown','{}'::jsonb,
               now() + interval '1 hour')`,
      [fx.companyId, 'c'.repeat(64)],
    );

    await disableChannelAndAlert(
      db,
      { schema },
      {
        companyId: fx.companyId,
        connectionId: 'conn1',
        dedupeKey: 'access_revoked:acc1:scope-1',
        errorCode: 'ACCESS_REVOKED',
      },
    );

    const { rows } = await db.query<{ state: string }>(
      `SELECT state FROM send_operations WHERE company_id = $1 AND id = 'op1'`,
      [fx.companyId],
    );
    assert.equal(rows[0]?.state, 'unknown', 'an unknown outcome stays unknown for a human to review');
  } finally {
    await close();
  }
});

test('a confirmed send rejection raises a send_rejected alert', async () => {
  const { db, schema, close } = await createTestApp();
  try {
    const fixture = await seedRoutedChannel(db, schema, { connectionId: 'conn-rejected' });
    const { jobId } = await enqueueSend(db, {
      schema,
      companyId: fixture.companyId,
      intentKey: 'idem-rejected',
      payload: {
        connectionId: fixture.connectionId,
        externalChatId: '42',
        content: { kind: 'text', text: 'hi' },
      },
    });
    // 401 is a confirmed refusal: the provider refused, and retrying cannot help.
    const { fetch } = fakeFetch(() => ({ status: 401, json: { error: 'unauthorized' } }));
    const adapter = createMaxAdapter({
      accessToken: 'token',
      webhookSecret: 'secret',
      apiBase: 'https://platform-api2.example.test',
      fetch,
    });
    const result = await dispatchSend({ db, schema, adapter, jobId });
    assert.equal(result.outcome?.status, 'failed');

    const alerts = await readAlerts(db, schema, fixture.companyId);
    assert.equal(alerts.length, 2);
    const rejection = alerts.find((alert) => alert.kind === 'send_rejected');
    assert.equal(rejection?.recipient_staff_id, 's1');
    assert.equal(rejection?.error_code, 'ACCESS_REVOKED');
    assert.equal(rejection?.connection_id, 'conn-rejected');
    const connection = await db.query<{ state: string }>(
      'SELECT state FROM connections WHERE company_id=$1 AND id=$2',
      [fixture.companyId, fixture.connectionId],
    );
    assert.equal(connection.rows[0]?.state, 'disabled');
  } finally {
    await close();
  }
});

test('an unknown send outcome raises a manual_review alert and keeps the job unknown', async () => {
  const { db, schema, close } = await createTestApp();
  try {
    const fixture = await seedRoutedChannel(db, schema, { connectionId: 'conn-unknown' });
    const { jobId } = await enqueueSend(db, {
      schema,
      companyId: fixture.companyId,
      intentKey: 'idem-unknown',
      payload: {
        connectionId: fixture.connectionId,
        externalChatId: '42',
        content: { kind: 'text', text: 'hi' },
      },
    });
    // A 200 without a provider message id is an unknown outcome, not a failure.
    const { fetch } = fakeFetch(() => ({ status: 200, json: { message: {} } }));
    const adapter = createMaxAdapter({
      accessToken: 'token',
      webhookSecret: 'secret',
      apiBase: 'https://platform-api2.example.test',
      fetch,
    });
    const result = await dispatchSend({ db, schema, adapter, jobId });
    assert.equal(result.outcome?.status, 'unknown');

    const { rows } = await db.query<{ state: string }>(`SELECT state FROM outbox_jobs WHERE id = $1`, [
      jobId,
    ]);
    assert.equal(rows[0]?.state, 'unknown', 'the unknown send rule is preserved');

    const alerts = await readAlerts(db, schema, fixture.companyId);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.kind, 'manual_review');
    assert.equal(alerts[0]!.error_code, 'OUTCOME_UNKNOWN');
  } finally {
    await close();
  }
});

test('the notification feed pages channel alerts with the other kinds', async () => {
  const { app, db, schema, close } = await createTestApp();
  try {
    const fx = await seedAlertFixture(db, schema);
    await raiseAlert(
      db,
      { schema },
      {
        companyId: fx.companyId,
        connectionId: 'conn1',
        kind: 'channel_disabled',
        dedupeKey: 'channel_disabled:conn1:1',
      },
    );
    await raiseAlert(
      db,
      { schema },
      {
        companyId: fx.companyId,
        connectionId: 'conn1',
        kind: 'send_rejected',
        dedupeKey: 'send_rejected:job-1',
      },
    );

    const cookie = await login(app, fx.companyId, 's1');
    const page = (await listNotifications(app, cookie, '?limit=1')).json() as NotificationList;
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]!.kind, 'channel_alert');
    assert.ok(page.page.nextCursor, 'a full page yields a cursor');

    const second = (
      await listNotifications(app, cookie, `?limit=1&after=${encodeURIComponent(page.page.nextCursor!)}`)
    ).json() as NotificationList;
    assert.equal(second.items.length, 1);
    assert.equal(second.items[0]!.kind, 'channel_alert');
    assert.notEqual(second.items[0]!.id, page.items[0]!.id, 'the pages do not overlap');
  } finally {
    await close();
  }
});
