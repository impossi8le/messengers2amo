import type { Db } from '../../src/platform/db.ts';
import { withTransaction } from '../../src/platform/db.ts';

export type AttentionFixture = {
  companyId: string;
  conversationId: string;
  workItemId: string;
  staffId: string;
};

export type SeedAttentionOptions = {
  companyId?: string;
  connectionId?: string;
  conversationId?: string;
  workItemId?: string;
  capacity?: number;
  staff?: Array<{ id: string; capacity: number }>;
};

/**
 * Seeds the minimal tenant slice for attention/assignment work: company, connection,
 * one conversation, one queued work item without an owner, and staff rows.
 */
export async function seedAttention(db: Db, schema: string, options: SeedAttentionOptions = {}): Promise<AttentionFixture> {
  const companyId = options.companyId ?? 'c1';
  const connectionId = options.connectionId ?? 'conn1';
  const conversationId = options.conversationId ?? 'conv1';
  const workItemId = options.workItemId ?? 'wi1';
  const staff = options.staff ?? [{ id: 's1', capacity: options.capacity ?? 5 }];
  const q = (sql: string) => sql.replaceAll('__S__', `"${schema}"`);

  // One transaction: current_connection_identity is DEFERRABLE INITIALLY DEFERRED.
  await withTransaction(db, async (tx) => {
    await tx.query(q(`INSERT INTO __S__.companies (id, display_name) VALUES ($1,$2)`), [companyId, companyId]);
    for (const member of staff) {
      await tx.query(q(`INSERT INTO __S__.staff (company_id, id, display_name, capacity) VALUES ($1,$2,$3,$4)`), [
        companyId,
        member.id,
        member.id,
        member.capacity,
      ]);
    }
    await tx.query(
      q(`INSERT INTO __S__.connections
           (company_id,id,channel_mode,binding_epoch,credentials_version,state,version,capabilities)
         VALUES ($1,$2,'telegram_bot',1,1,'active',0,'{}'::jsonb)`),
      [companyId, connectionId],
    );
    await tx.query(
      q(`INSERT INTO __S__.connection_identities (company_id,connection_id,binding_epoch) VALUES ($1,$2,1)`),
      [companyId, connectionId],
    );
    await tx.query(
      q(`INSERT INTO __S__.conversations
           (company_id,id,connection_id,binding_epoch,external_chat_id,chat_kind)
         VALUES ($1,$2,$3,1,$4,'private')`),
      [companyId, conversationId, connectionId, `chat-${conversationId}`],
    );
    await tx.query(
      q(`INSERT INTO __S__.work_items (company_id,id,conversation_id,state,owner_id)
         VALUES ($1,$2,$3,'queued',NULL)`),
      [companyId, workItemId, conversationId],
    );
  });

  return { companyId, conversationId, workItemId, staffId: staff[0]?.id ?? 's1' };
}

/** Inserts an inbound message plus its initial content version. */
export async function seedInboundMessage(
  db: Db,
  schema: string,
  input: { companyId: string; conversationId: string; messageId: string; content?: unknown; contentVersion?: number },
): Promise<void> {
  const q = (sql: string) => sql.replaceAll('__S__', `"${schema}"`);
  const contentVersion = input.contentVersion ?? 0;
  // current_message_version is DEFERRABLE INITIALLY DEFERRED, so message and its
  // first version must be written in one transaction.
  await withTransaction(db, async (tx) => {
    await tx.query(
      q(`INSERT INTO __S__.messages
           (company_id,id,conversation_id,direction,provider_message_id,current_content_version)
         VALUES ($1,$2,$3,'in',$4,$5)`),
      [input.companyId, input.messageId, input.conversationId, `ext-${input.messageId}`, contentVersion],
    );
    await tx.query(
      q(`INSERT INTO __S__.message_versions (company_id,message_id,content_version,content) VALUES ($1,$2,$3,$4::jsonb)`),
      [input.companyId, input.messageId, contentVersion, JSON.stringify(input.content ?? { kind: 'text', text: 'hello' })],
    );
  });
}

/** Appends a new content version and points the message at it. */
export async function seedEdit(
  db: Db,
  schema: string,
  input: { companyId: string; messageId: string; contentVersion: number; content: unknown },
): Promise<void> {
  const q = (sql: string) => sql.replaceAll('__S__', `"${schema}"`);
  await db.query(
    q(`INSERT INTO __S__.message_versions (company_id,message_id,content_version,content) VALUES ($1,$2,$3,$4::jsonb)`),
    [input.companyId, input.messageId, input.contentVersion, JSON.stringify(input.content)],
  );
  await db.query(q(`UPDATE __S__.messages SET current_content_version=$3 WHERE company_id=$1 AND id=$2`), [
    input.companyId,
    input.messageId,
    input.contentVersion,
  ]);
}

/** Creates an accepted send operation bound to a snapshot with an explicit state. */
export async function seedSendOperation(
  db: Db,
  schema: string,
  input: {
    companyId: string;
    operationId: string;
    workItemId: string;
    conversationId: string;
    connectionId?: string;
    snapshotId: string | null;
    actorId: string;
    state?: string;
  },
): Promise<void> {
  const q = (sql: string) => sql.replaceAll('__S__', `"${schema}"`);
  await db.query(
    q(`INSERT INTO __S__.send_operations
         (company_id,id,work_item_id,conversation_id,connection_id,binding_epoch,snapshot_id,actor_id,
          command_type,idempotency_key,payload_fingerprint,state,coverage,content,deadline)
       VALUES ($1,$2,$3,$4,$5,1,$6,$7,'reply',$8,$9,$10,'unconfirmed','{"text":"ok"}'::jsonb, now() + interval '1 hour')`),
    [
      input.companyId,
      input.operationId,
      input.workItemId,
      input.conversationId,
      input.connectionId ?? 'conn1',
      input.snapshotId,
      input.actorId,
      `idem-${input.operationId}`,
      'a'.repeat(64),
      input.state ?? 'sent',
    ],
  );
}

export async function countRows(db: Db, schema: string, table: string, where: string, params: unknown[]): Promise<number> {
  const { rows } = await db.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM "${schema}"."${table}" WHERE ${where}`,
    params,
  );
  return rows[0]?.c ?? 0;
}
