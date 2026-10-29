import { withTransaction, type Db } from '../../src/platform/db.ts';

export type ConnectionFixture = {
  companyId: string;
  connectionId: string;
  bindingEpoch: number;
};

/**
 * Minimal persisted connection plus its binding-epoch identity.
 * Inbox events reference (company_id, connection_id, binding_epoch), so the
 * identity row must exist before any webhook can be committed.
 */
export async function seedConnection(
  db: Db,
  schema: string,
  options: {
    channelMode?: string;
    companyId?: string;
    connectionId?: string;
    bindingEpoch?: number;
    crmProjectionEnabled?: boolean;
    privateImportEnabled?: boolean;
    /** The CRM account a projection would write into; null means the company has none. */
    crmAccountId?: string | null;
  } = {},
): Promise<ConnectionFixture> {
  const companyId = options.companyId ?? 'c1';
  const connectionId = options.connectionId ?? 'conn1';
  const bindingEpoch = options.bindingEpoch ?? 1;
  const channelMode = options.channelMode ?? 'whatsapp_cloud';
  const crmAccountId = options.crmAccountId === undefined ? 'acc1' : options.crmAccountId;

  await db.query(`INSERT INTO "${schema}".companies (id, display_name) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [
    companyId,
    'test company',
  ]);
  // A projection job only has somewhere to go when the company has an active CRM
  // account, so the fixture provisions one unless the case is about its absence.
  if (crmAccountId !== null) {
    await db.query(
      `INSERT INTO "${schema}".crm_accounts (company_id, id, external_account_id, credential_ref, state)
       VALUES ($1,$2,'amojo-1','credref_test','active') ON CONFLICT (company_id, id) DO NOTHING`,
      [companyId, crmAccountId],
    );
  }
  // connections <-> connection_identities is a circular FK pair whose constraint
  // is DEFERRABLE INITIALLY DEFERRED, so both rows must be inserted in one
  // transaction: the check happens at COMMIT.
  await withTransaction(db, async (tx) => {
    await tx.query(
      `INSERT INTO "${schema}".connections
         (company_id, id, channel_mode, binding_epoch, credentials_version, state, version, capabilities,
          ingress_enabled, send_enabled, credential_ref)
       VALUES ($1,$2,$3,$4,1,'active',0,'{}'::jsonb,true,true,'credref_test')
       ON CONFLICT DO NOTHING`,
      [companyId, connectionId, channelMode, bindingEpoch],
    );
    await tx.query(
      `INSERT INTO "${schema}".connection_identities (company_id, connection_id, binding_epoch, external_identity_ref)
       VALUES ($1,$2,$3,'external-1') ON CONFLICT DO NOTHING`,
      [companyId, connectionId, bindingEpoch],
    );
  });
  await db.query(
    `INSERT INTO "${schema}".channel_policies
       (company_id, connection_id, crm_projection_enabled, private_import_enabled, group_default)
     VALUES ($1,$2,$3,$4,'deny')
     ON CONFLICT (company_id, connection_id) DO UPDATE
       SET crm_projection_enabled = EXCLUDED.crm_projection_enabled,
           private_import_enabled = EXCLUDED.private_import_enabled`,
    [companyId, connectionId, options.crmProjectionEnabled ?? true, options.privateImportEnabled ?? true],
  );

  return { companyId, connectionId, bindingEpoch };
}

/** Give a projection test an explicit route instead of relying on the first account. */
export async function seedProjectionRoute(db: Db, schema: string, scope: ConnectionFixture, accountId = 'acc1'): Promise<void> {
  await db.query(`INSERT INTO "${schema}".workshops(company_id,id,display_name) VALUES ($1,'projection-workshop','Synthetic') ON CONFLICT DO NOTHING`,[scope.companyId]);
  await db.query(`INSERT INTO "${schema}".staff(company_id,id,display_name) VALUES ($1,'projection-owner','Synthetic') ON CONFLICT DO NOTHING`,[scope.companyId]);
  const sourceId=`source-${scope.connectionId}`;
  await db.query(`INSERT INTO "${schema}".crm_sources(company_id,id,account_id,external_id,origin_code) VALUES ($1,$2,$3,$2,'technical') ON CONFLICT DO NOTHING`,[scope.companyId,sourceId,accountId]);
  await db.query(`INSERT INTO "${schema}".connection_routes(company_id,connection_id,workshop_id,crm_account_id,funnel_id,default_owner_id,technical_source_id,version)
    VALUES ($1,$2,'projection-workshop',$3,'1','projection-owner',$4,0)`,[scope.companyId,scope.connectionId,accountId,sourceId]);
}

export async function allowGroup(
  db: Db,
  schema: string,
  fixture: ConnectionFixture,
  externalChatId: string,
  decision: 'allow_crm' | 'exclude' | 'archive_only' = 'allow_crm',
): Promise<void> {
  await db.query(
    `INSERT INTO "${schema}".channel_group_rules
       (company_id, connection_id, binding_epoch, external_chat_id, decision)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (company_id, connection_id, binding_epoch, external_chat_id) DO UPDATE SET decision = EXCLUDED.decision`,
    [fixture.companyId, fixture.connectionId, fixture.bindingEpoch, externalChatId, decision],
  );
}

export async function countRows(db: Db, schema: string, table: string): Promise<number> {
  const { rows } = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM "${schema}"."${table}"`);
  return rows[0]?.c ?? 0;
}

/** Fake fetch that never touches the network and records every call. */
export type FetchCall = { url: string; method: string; headers: Record<string, string>; body: string | null };

export function fakeFetch(
  handler: (call: FetchCall) => { status?: number; json?: unknown; body?: string; throwError?: Error },
): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [key, value] of Object.entries(rawHeaders)) headers[key.toLowerCase()] = String(value);
    const body = typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : null;
    const call: FetchCall = { url, method: init?.method ?? 'GET', headers, body };
    calls.push(call);
    const result = handler(call);
    if (result.throwError) throw result.throwError;
    const status = result.status ?? 200;
    const payload = result.body ?? JSON.stringify(result.json ?? {});
    return new Response(payload, { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: impl, calls };
}
