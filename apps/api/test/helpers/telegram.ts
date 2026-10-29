import type { Db } from '../../src/platform/db.ts';
import { withTransaction } from '../../src/platform/db.ts';

export type SeedConnection = {
  companyId?: string;
  connectionId?: string;
  bindingEpoch?: number;
  channelMode?: string;
  state?: string;
  ingressEnabled?: boolean;
  sendEnabled?: boolean;
};

export async function seedCompany(db: Db, companyId = 'c1'): Promise<void> {
  await db.query('INSERT INTO companies (id, display_name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [
    companyId,
    'Test company',
  ]);
}

export async function seedConnection(db: Db, options: SeedConnection = {}): Promise<{
  companyId: string;
  connectionId: string;
  bindingEpoch: number;
}> {
  const companyId = options.companyId ?? 'c1';
  const connectionId = options.connectionId ?? 'conn-1';
  const bindingEpoch = options.bindingEpoch ?? 1;
  await seedCompany(db, companyId);
  await withTransaction(db, async (tx) => {
    await tx.query(
      `INSERT INTO connections (company_id, id, channel_mode, binding_epoch, credentials_version, state,
         version, capabilities, ingress_enabled, send_enabled)
       VALUES ($1,$2,$3,$4,1,$5,0,'{}'::jsonb,$6,$7)
       ON CONFLICT (company_id, id) DO NOTHING`,
      [
        companyId,
        connectionId,
        options.channelMode ?? 'telegram_bot',
        bindingEpoch,
        options.state ?? 'active',
        options.ingressEnabled ?? true,
        options.sendEnabled ?? true,
      ],
    );
    await tx.query(
      `INSERT INTO connection_identities (company_id, connection_id, binding_epoch, external_identity_ref)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [companyId, connectionId, bindingEpoch, 'bot:test'],
    );
  });
  return { companyId, connectionId, bindingEpoch };
}

export type SeedSendContext = {
  companyId?: string;
  connectionId?: string;
  bindingEpoch?: number;
  conversationId?: string;
  externalChatId?: string;
  workItemId?: string;
  staffId?: string;
  departmentId?: string;
};

export async function seedSendContext(db: Db, options: SeedSendContext = {}): Promise<{
  companyId: string;
  connectionId: string;
  bindingEpoch: number;
  conversationId: string;
  externalChatId: string;
  workItemId: string;
  staffId: string;
}> {
  const companyId = options.companyId ?? 'c1';
  const connectionId = options.connectionId ?? 'conn-1';
  const bindingEpoch = options.bindingEpoch ?? 1;
  const conversationId = options.conversationId ?? 'conv-1';
  const externalChatId = options.externalChatId ?? '42';
  const workItemId = options.workItemId ?? 'work-1';
  const staffId = options.staffId ?? 'staff-1';
  const departmentId = options.departmentId ?? 'dep-1';
  await seedConnection(db, { companyId, connectionId, bindingEpoch });
  await withTransaction(db, async (tx) => {
    await tx.query(
      `INSERT INTO departments (company_id, id, display_name) VALUES ($1,$2,'Dep') ON CONFLICT DO NOTHING`,
      [companyId, departmentId],
    );
    await tx.query(
      `INSERT INTO staff (company_id, id, display_name, capacity, availability)
       VALUES ($1,$2,'Staff',10,'online') ON CONFLICT DO NOTHING`,
      [companyId, staffId],
    );
    await tx.query(
      `INSERT INTO conversations (company_id, id, connection_id, binding_epoch, external_chat_id, chat_kind)
       VALUES ($1,$2,$3,$4,$5,'private') ON CONFLICT DO NOTHING`,
      [companyId, conversationId, connectionId, bindingEpoch, externalChatId],
    );
    await tx.query(
      `INSERT INTO work_items (company_id, id, conversation_id, department_id, owner_id, state)
       VALUES ($1,$2,$3,$4,$5,'assigned') ON CONFLICT DO NOTHING`,
      [companyId, workItemId, conversationId, departmentId, staffId],
    );
  });
  return { companyId, connectionId, bindingEpoch, conversationId, externalChatId, workItemId, staffId };
}

export function telegramUpdate(updateId: number, text = 'hello'): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: 100 + (updateId % 1000),
      date: 1_700_000_000 + updateId,
      chat: { id: 42, type: 'private' },
      from: { id: 42, is_bot: false, first_name: 'Customer' },
      text,
    },
  };
}

export function telegramMessageUpdate(updateId: number, messageId: number, text: string, chatId = 42): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + updateId,
      chat: { id: chatId, type: 'private' },
      from: { id: chatId, is_bot: false, first_name: 'Customer' },
      text,
    },
  };
}
