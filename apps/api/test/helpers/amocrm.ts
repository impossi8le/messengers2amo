import { createHmac } from 'node:crypto';
import { withTransaction, type Db } from '../../src/platform/db.ts';

export type RecordedCall = { url: string; method: string; headers: Record<string, string>; body: string | null };

export type FakeResponseInit = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};

export type FakeFetch = typeof fetch & { calls: RecordedCall[] };

/**
 * Deterministic fetch double. Every call is recorded verbatim; nothing leaves
 * the process. The handler decides the response per call.
 */
export function createFakeFetch(
  handler: (call: RecordedCall) => FakeResponseInit | Promise<FakeResponseInit>,
): FakeFetch {
  const calls: RecordedCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = String(value);
    }
    const body = typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : null;
    const call: RecordedCall = { url, method: (init?.method ?? 'GET').toUpperCase(), headers, body };
    calls.push(call);
    const result = await handler(call);
    const responseHeaders = new Headers(result.headers ?? {});
    const payload = result.body === undefined ? '' : JSON.stringify(result.body);
    if (!responseHeaders.has('content-type') && result.body !== undefined) {
      responseHeaders.set('content-type', 'application/json');
    }
    return new Response(payload, { status: result.status ?? 200, headers: responseHeaders });
  };
  return Object.assign(impl as unknown as typeof fetch, { calls });
}

export function signedWebhook(secret: string, raw: string): string {
  return createHmac('sha1', secret).update(Buffer.from(raw, 'utf8')).digest('hex');
}

export type Seeded = {
  companyId: string;
  accountId: string;
  connectionId: string;
  epoch: number;
  scopeId: string;
  channelSecret: string;
  conversationId: string;
};

export async function seedAmocrm(
  db: Db,
  schema: string,
  options: {
    companyId?: string;
    accountId?: string;
    connectionId?: string;
    scopeId?: string;
    channelSecret?: string;
    conversationId?: string;
    externalChatId?: string;
    chatKind?: 'private' | 'group' | 'unknown';
    credentialRef?: string | null;
    accountState?: 'setup' | 'active' | 'disabled' | 'revoked';
    projectionEnabled?: boolean;
    privateImportEnabled?: boolean;
    groupDecision?: 'allow_crm' | 'exclude' | 'archive_only' | null;
  } = {},
): Promise<Seeded> {
  const companyId = options.companyId ?? 'c1';
  const accountId = options.accountId ?? 'acc1';
  const connectionId = options.connectionId ?? 'conn1';
  const epoch = 1;
  const scopeId = options.scopeId ?? 'scope-test';
  const channelSecret = options.channelSecret ?? 'test-channel-secret';
  const conversationId = options.conversationId ?? 'conv1';
  const externalChatId = options.externalChatId ?? 'chat-1';
  const s = `"${schema}".`;
  // Connection and identity reference each other through a deferred FK,
  // so the fixture must be written in one transaction.
  await withTransaction(db, async (tx) => {

    await tx.query(`INSERT INTO ${s}companies(id, display_name) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [companyId, 'Test']);
    await tx.query(
      `INSERT INTO ${s}crm_accounts(company_id,id,external_account_id,credential_ref,state)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (company_id,id) DO UPDATE SET state=EXCLUDED.state`,
      [companyId, accountId, 'amojo-1', options.credentialRef ?? null, options.accountState ?? 'active'],
    );
    await tx.query(
      `INSERT INTO ${s}connections(company_id,id,channel_mode,binding_epoch,credentials_version,state,version,capabilities)
       VALUES ($1,$2,'telegram_bot',$3,1,'active',1,'{}') ON CONFLICT DO NOTHING`,
      [companyId, connectionId, epoch],
    );
    await tx.query(
      `INSERT INTO ${s}connection_identities(company_id,connection_id,binding_epoch,external_identity_ref)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [companyId, connectionId, epoch, 'identity-1'],
    );
    await tx.query(
      `INSERT INTO ${s}conversations(company_id,id,connection_id,binding_epoch,external_chat_id,chat_kind,display_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [companyId, conversationId, connectionId, epoch, externalChatId, options.chatKind ?? 'private', 'Chat'],
    );
    await tx.query(
      `INSERT INTO ${s}channel_policies(company_id,connection_id,crm_projection_enabled,private_import_enabled,group_default)
       VALUES ($1,$2,$3,$4,'deny') ON CONFLICT DO NOTHING`,
      [companyId, connectionId, options.projectionEnabled ?? true, options.privateImportEnabled ?? true],
    );
    if (options.groupDecision) {
      await tx.query(
        `INSERT INTO ${s}channel_group_rules(company_id,connection_id,binding_epoch,external_chat_id,decision)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [companyId, connectionId, epoch, externalChatId, options.groupDecision],
      );
    }

  });
  return { companyId, accountId, connectionId, epoch, scopeId, channelSecret, conversationId };
}

export async function insertChannel(
  db: Db,
  schema: string,
  seed: Seeded,
  secretEnc: string,
): Promise<void> {
  const s = `"${schema}".`;
  await db.query(
    `INSERT INTO ${s}amocrm_channels(company_id,account_id,scope_id,channel_code,secret_enc,connection_id,binding_epoch,amojo_account_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (company_id,scope_id) DO UPDATE SET secret_enc=EXCLUDED.secret_enc`,
    [seed.companyId, seed.accountId, seed.scopeId, 'testchannel', secretEnc, seed.connectionId, seed.epoch, 'amojo-1'],
  );
}
