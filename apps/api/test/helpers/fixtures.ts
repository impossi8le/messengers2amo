import type { Db } from '../../src/platform/db.ts';
import { withTransaction } from '../../src/platform/db.ts';

export type TenantFixture = {
  companyId: string;
  staffId: string;
  connectionId: string;
  bindingEpoch: number;
  conversationId: string;
  messageId: string;
  externalChatId: string;
  externalMessageId: string;
  workItemId: string;
};

export type SeedOptions = {
  companyId?: string;
  staffId?: string;
  connectionId?: string;
  conversationId?: string;
  messageId?: string;
  workItemId?: string;
  externalChatId?: string;
  externalMessageId?: string;
  canRead?: boolean;
};

/**
 * Seeds one complete tenant slice required by media/attachment foreign keys.
 * All statements share one transaction so DEFERRABLE constraints resolve at commit.
 */
export function sessionIdFor(companyId: string, staffId: string): string {
  return `sess_${staffId}_${companyId}`;
}

/** Adds a staff member with a server-side session and an explicit channel permission. */
export async function seedStaff(
  db: Db,
  schema: string,
  input: {
    companyId: string;
    staffId: string;
    connectionId: string;
    canRead: boolean;
    canSend?: boolean;
    role?: 'read' | 'send' | 'manage' | 'admin';
  },
): Promise<void> {
  await withTransaction(db, async (tx) => {
    const q = (sql: string, params: unknown[] = []) => tx.query(sql.replaceAll('__S__', `"${schema}"`), params);
    await q(`INSERT INTO __S__.staff (company_id, id, display_name, capacity) VALUES ($1,$2,$3,10)`, [
      input.companyId,
      input.staffId,
      input.staffId,
    ]);
    await q(
      `INSERT INTO __S__.channel_permissions (company_id,connection_id,staff_id,can_read,can_send)
       VALUES ($1,$2,$3,$4,$5)`,
      [input.companyId, input.connectionId, input.staffId, input.canRead, input.canSend ?? false],
    );
    await q(`INSERT INTO __S__.staff_access (company_id,staff_id,role,version) VALUES ($1,$2,$3,1)`, [
      input.companyId,
      input.staffId,
      input.role ?? 'read',
    ]);
    await q(
      `INSERT INTO __S__.staff_sessions (company_id,id,staff_id,epoch,expires_at)
       VALUES ($1,$2,$3,1, now() + interval '10 years')`,
      [input.companyId, sessionIdFor(input.companyId, input.staffId), input.staffId],
    );
  });
}

export async function seedTenant(db: Db, schema: string, options: SeedOptions = {}): Promise<TenantFixture> {
  const companyId = options.companyId ?? 'c1';
  const staffId = options.staffId ?? 's1';
  const connectionId = options.connectionId ?? 'conn1';
  const conversationId = options.conversationId ?? 'conv1';
  const messageId = options.messageId ?? 'msg1';
  const workItemId = options.workItemId ?? 'wi1';
  const externalChatId = options.externalChatId ?? 'chat-1';
  const externalMessageId = options.externalMessageId ?? 'ext-msg-1';

  await withTransaction(db, async (tx) => {
    const q = (sql: string, params: unknown[] = []) =>
      tx.query(sql.replaceAll('__S__', `"${schema}"`), params);
    await q(`INSERT INTO __S__.companies (id, display_name) VALUES ($1,$2)`, [companyId, companyId]);
    await q(`INSERT INTO __S__.staff (company_id, id, display_name, capacity) VALUES ($1,$2,$3,10)`, [
      companyId,
      staffId,
      staffId,
    ]);
    await q(
      `INSERT INTO __S__.connections
         (company_id,id,channel_mode,binding_epoch,credentials_version,state,version,capabilities)
       VALUES ($1,$2,'telegram_bot',1,1,'active',0,'{}'::jsonb)`,
      [companyId, connectionId],
    );
    await q(`INSERT INTO __S__.connection_identities (company_id,connection_id,binding_epoch) VALUES ($1,$2,1)`, [
      companyId,
      connectionId,
    ]);
    await q(
      `INSERT INTO __S__.conversations
         (company_id,id,connection_id,binding_epoch,external_chat_id,chat_kind)
       VALUES ($1,$2,$3,1,$4,'private')`,
      [companyId, conversationId, connectionId, externalChatId],
    );
    await q(
      `INSERT INTO __S__.messages
         (company_id,id,conversation_id,direction,provider_message_id,current_content_version)
       VALUES ($1,$2,$3,'in',$4,0)`,
      [companyId, messageId, conversationId, externalMessageId],
    );
    await q(
      `INSERT INTO __S__.message_versions (company_id,message_id,content_version,content)
       VALUES ($1,$2,0,'{"kind":"text"}'::jsonb)`,
      [companyId, messageId],
    );
    await q(
      `INSERT INTO __S__.channel_permissions (company_id,connection_id,staff_id,can_read,can_send)
       VALUES ($1,$2,$3,$4,true)`,
      [companyId, connectionId, staffId, options.canRead ?? true],
    );
    await q(`INSERT INTO __S__.staff_access (company_id,staff_id,role,version) VALUES ($1,$2,'send',1)`, [
      companyId,
      staffId,
    ]);
    await q(
      `INSERT INTO __S__.staff_sessions (company_id,id,staff_id,epoch,expires_at)
       VALUES ($1,$2,$3,1, now() + interval '10 years')`,
      [companyId, sessionIdFor(companyId, staffId), staffId],
    );
    await q(
      `INSERT INTO __S__.work_items (company_id,id,conversation_id,state,owner_id)
       VALUES ($1,$2,$3,'assigned',$4)`,
      [companyId, workItemId, conversationId, staffId],
    );
  });

  return {
    companyId,
    staffId,
    connectionId,
    bindingEpoch: 1,
    conversationId,
    messageId,
    externalChatId,
    externalMessageId,
    workItemId,
  };
}
