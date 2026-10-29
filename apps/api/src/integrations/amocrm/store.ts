import { randomBytes } from 'node:crypto';
import type { Db, Tx } from '../../platform/db.ts';

export type SqlRunner = Db | Tx;

/**
 * Test schemas are addressed explicitly; production uses the connection's
 * search_path. Every identifier is a compile-time constant, never user input.
 */
export function qualified(schema: string | undefined | null, name: string): string {
  return schema ? `"${schema}".${name}` : name;
}

export type StoredCredentials = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType: string;
  accountDomain: string;
};

export type AccountRow = {
  company_id: string;
  id: string;
  external_account_id: string | null;
  credential_ref: string | null;
  state: 'setup' | 'active' | 'disabled' | 'revoked';
  version: string;
};

export async function loadAccount(
  db: SqlRunner,
  schema: string | undefined,
  companyId: string,
  accountId: string,
  options: { forUpdate?: boolean } = {},
): Promise<AccountRow | null> {
  const { rows } = await db.query<AccountRow>(
    `SELECT company_id, id, external_account_id, credential_ref, state, version
       FROM ${qualified(schema, 'crm_accounts')}
      WHERE company_id=$1 AND id=$2${options.forUpdate ? ' FOR UPDATE' : ''}`,
    [companyId, accountId],
  );
  return rows[0] ?? null;
}

export async function writeAccountCredentials(
  db: SqlRunner,
  schema: string | undefined,
  input: { companyId: string; accountId: string; envelope: string; state: 'active' | 'revoked' | 'disabled' },
): Promise<void> {
  await db.query(
    `INSERT INTO ${qualified(schema, 'crm_accounts')}(company_id,id,credential_ref,state,version)
     VALUES ($1,$2,$3,$4,1)
     ON CONFLICT (company_id,id) DO UPDATE
       SET credential_ref=EXCLUDED.credential_ref,
             state=EXCLUDED.state,
             refresh_failure_count=0,
           version=crm_accounts.version+1`,
    [input.companyId, input.accountId, input.envelope, input.state],
  );
}

export async function setAccountState(
  db: SqlRunner,
  schema: string | undefined,
  companyId: string,
  accountId: string,
  state: 'active' | 'revoked' | 'disabled',
): Promise<void> {
  await db.query(
    `UPDATE ${qualified(schema, 'crm_accounts')}
        SET state=$3, version=version+1
      WHERE company_id=$1 AND id=$2`,
    [companyId, accountId, state],
  );
}

export async function recordOauthAudit(
  db: SqlRunner,
  schema: string | undefined,
  input: { companyId: string; accountId: string; event: string; detail?: string | null },
): Promise<void> {
  await db.query(
    `INSERT INTO ${qualified(schema, 'amocrm_oauth_audit')}(company_id,id,account_id,event,detail)
     VALUES ($1,$2,$3,$4,$5)`,
    [input.companyId, `oa_${randomBytes(10).toString('hex')}`, input.accountId, input.event, input.detail ?? null],
  );
}

export type ChannelRow = {
  company_id: string;
  account_id: string;
  scope_id: string;
  channel_code: string | null;
  secret_enc: string;
  connection_id: string;
  binding_epoch: string;
  amojo_account_id: string;
  state: 'connected' | 'disabled';
};

export async function loadChannelByScope(
  db: SqlRunner,
  schema: string | undefined,
  scopeId: string,
): Promise<ChannelRow | null> {
  const { rows } = await db.query<ChannelRow>(
    `SELECT company_id, account_id, scope_id, channel_code, secret_enc,
            connection_id, binding_epoch, amojo_account_id, state
       FROM ${qualified(schema, 'amocrm_channels')}
      WHERE scope_id=$1`,
    [scopeId],
  );
  return rows[0] ?? null;
}

/**
 * The CRM account a company projects into. Without one an inbound message is
 * archived but produces no projection job: a job that cannot be dispatched would
 * only burn retries and end up in `failed`.
 */
export async function loadActiveAccountForCompany(
  db: SqlRunner,
  schema: string | undefined,
  companyId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM ${qualified(schema, 'crm_accounts')}
      WHERE company_id=$1 AND state='active'
      ORDER BY id
      LIMIT 1`,
    [companyId],
  );
  return rows[0]?.id ?? null;
}

/** Projection belongs to this connection's route, even with several active accounts. */
export async function loadActiveAccountForConnection(
  db: SqlRunner, schema: string | undefined,
  input: { companyId: string; connectionId: string },
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT a.id FROM ${qualified(schema,'connection_routes')} r
       JOIN ${qualified(schema,'crm_accounts')} a ON a.company_id=r.company_id AND a.id=r.crm_account_id
      WHERE r.company_id=$1 AND r.connection_id=$2 AND a.state='active'`,
    [input.companyId,input.connectionId],
  );
  return rows[0]?.id ?? null;
}

/**
 * The chat channel a projection must post through. An account normally registers
 * one channel; if it has several, the choice is deterministic rather than
 * accidental, and stays the same across retries of the same job.
 */
export async function loadChannelByAccount(
  db: SqlRunner,
  schema: string | undefined,
  input: { companyId: string; accountId: string },
): Promise<ChannelRow | null> {
  const { rows } = await db.query<ChannelRow>(
    `SELECT company_id, account_id, scope_id, channel_code, secret_enc,
            connection_id, binding_epoch, amojo_account_id, state
       FROM ${qualified(schema, 'amocrm_channels')}
      WHERE company_id=$1 AND account_id=$2 AND state='connected'
      ORDER BY scope_id
      LIMIT 1`,
    [input.companyId, input.accountId],
  );
  return rows[0] ?? null;
}

/**
 * Every channel of an account, with its connection. Used to find the connection a
 * CRM-side failure belongs to: an account may register several channels, and each
 * of them is a separate messenger connection with its own alert recipient.
 */
export async function listChannelsByAccount(
  db: SqlRunner,
  schema: string | undefined,
  input: { companyId: string; accountId: string },
): Promise<ChannelRow[]> {
  const { rows } = await db.query<ChannelRow>(
    `SELECT company_id, account_id, scope_id, channel_code, secret_enc,
            connection_id, binding_epoch, amojo_account_id, state
       FROM ${qualified(schema, 'amocrm_channels')}
      WHERE company_id=$1 AND account_id=$2
      ORDER BY scope_id`,
    [input.companyId, input.accountId],
  );
  return rows;
}

export async function registerChannel(
  db: SqlRunner,
  schema: string | undefined,
  input: {
    companyId: string;
    accountId: string;
    scopeId: string;
    channelCode: string | null;
    secretEnc: string;
    connectionId: string;
    bindingEpoch: number;
    amojoAccountId: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO ${qualified(schema, 'amocrm_channels')}
       (company_id,account_id,scope_id,channel_code,secret_enc,connection_id,binding_epoch,amojo_account_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (company_id,scope_id) DO UPDATE
       SET secret_enc=EXCLUDED.secret_enc,
           channel_code=EXCLUDED.channel_code,
           amojo_account_id=EXCLUDED.amojo_account_id`,
    [
      input.companyId,
      input.accountId,
      input.scopeId,
      input.channelCode,
      input.secretEnc,
      input.connectionId,
      input.bindingEpoch,
      input.amojoAccountId,
    ],
  );
}

/** Resolve the channel of this conversation, never the first channel of the account. */
export async function loadChannelForConversation(
  db: SqlRunner, schema: string | undefined,
  input: { companyId: string; accountId: string; conversationId: string },
): Promise<ChannelRow | null> {
  const { rows } = await db.query<ChannelRow>(
    `SELECT ch.company_id,ch.account_id,ch.scope_id,ch.channel_code,ch.secret_enc,
            ch.connection_id,ch.binding_epoch,ch.amojo_account_id,ch.state
       FROM ${qualified(schema, 'amocrm_channels')} ch
       JOIN ${qualified(schema, 'conversations')} c
         ON c.company_id=ch.company_id AND c.connection_id=ch.connection_id AND c.binding_epoch=ch.binding_epoch
      WHERE ch.company_id=$1 AND ch.account_id=$2 AND c.id=$3 AND ch.state='connected'
      ORDER BY ch.scope_id LIMIT 2`,
    [input.companyId,input.accountId,input.conversationId],
  );
  return rows.length === 1 ? rows[0]! : null;
}
