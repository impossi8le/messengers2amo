import { withTransaction, type Db } from '../../src/platform/db.ts';

export type WorkshopBase = {
  companyId: string;
  workshops: { a: string; b: string };
  departmentId: string;
  staff: { owner: string; noSend: string; outsider: string };
  connections: { a: string; b: string };
  accounts: { a: string; b: string };
  sources: { a: string; b: string };
  conversations: { a: string; b: string };
  bindingEpoch: number;
  /** Both connections deliberately expose the same external chat id. */
  externalChatId: string;
};

/**
 * Two workshops in one company with separate connections, CRM accounts and
 * technical sources. Routes are intentionally not inserted: tests create them
 * through the service under test.
 */
export async function seedWorkshopBase(db: Db, schema: string): Promise<WorkshopBase> {
  const s = `"${schema}".`;
  const externalChatId = 'chat-shared';
  await withTransaction(db, async (tx) => {
    await tx.query(`INSERT INTO ${s}companies(id,display_name) VALUES ('c1','Company 1')`);
    await tx.query(
      `INSERT INTO ${s}workshops(company_id,id,display_name) VALUES ('c1','wA','Workshop A'),('c1','wB','Workshop B')`,
    );
    await tx.query(
      `INSERT INTO ${s}departments(company_id,id,display_name) VALUES ('c1','deptA','Department A')`,
    );
    await tx.query(
      `INSERT INTO ${s}staff(company_id,id,display_name,capacity)
       VALUES ('c1','owner1','Owner',10),('c1','agent1','Agent',10),('c1','outsider','Outsider',10)`,
    );
    await tx.query(
      `INSERT INTO ${s}staff_memberships(company_id,staff_id,department_id)
       VALUES ('c1','owner1','deptA'),('c1','agent1','deptA')`,
    );
    await tx.query(
      `INSERT INTO ${s}crm_accounts(company_id,id,external_account_id,state)
       VALUES ('c1','accA','amojo-a','active'),('c1','accB','amojo-b','active')`,
    );
    await tx.query(
      `INSERT INTO ${s}crm_sources(company_id,id,account_id,external_id,origin_code)
       VALUES ('c1','srcA','accA','ext-a','technical:connA'),('c1','srcB','accB','ext-b','technical:connB')`,
    );
    await tx.query(
      `INSERT INTO ${s}connections
         (company_id,id,channel_mode,binding_epoch,credentials_version,state,version,capabilities)
       VALUES ('c1','connA','telegram_bot',1,1,'active',0,'{}'::jsonb),
              ('c1','connB','telegram_bot',1,1,'active',0,'{}'::jsonb)`,
    );
    await tx.query(
      `INSERT INTO ${s}connection_identities(company_id,connection_id,binding_epoch)
       VALUES ('c1','connA',1),('c1','connB',1)`,
    );
    await tx.query(
      `INSERT INTO ${s}conversations
         (company_id,id,connection_id,binding_epoch,external_chat_id,chat_kind)
       VALUES ('c1','convA','connA',1,$1,'private'),('c1','convB','connB',1,$1,'private')`,
      [externalChatId],
    );
    await tx.query(
      `INSERT INTO ${s}channel_policies
         (company_id,connection_id,crm_projection_enabled,private_import_enabled,group_default)
       VALUES ('c1','connA',true,true,'deny'),('c1','connB',true,true,'deny')`,
    );
    await tx.query(
      `INSERT INTO ${s}channel_permissions(company_id,connection_id,staff_id,can_read,can_send)
       VALUES ('c1','connA','owner1',true,true),
              ('c1','connA','agent1',true,false),
              ('c1','connB','owner1',true,true)`,
    );
  });
  return {
    companyId: 'c1',
    workshops: { a: 'wA', b: 'wB' },
    departmentId: 'deptA',
    staff: { owner: 'owner1', noSend: 'agent1', outsider: 'outsider' },
    connections: { a: 'connA', b: 'connB' },
    accounts: { a: 'accA', b: 'accB' },
    sources: { a: 'srcA', b: 'srcB' },
    conversations: { a: 'convA', b: 'convB' },
    bindingEpoch: 1,
    externalChatId,
  };
}

/** Adds a group conversation without touching policies or rules. */
export async function addGroupConversation(
  db: Db,
  schema: string,
  input: { companyId: string; connectionId: string; bindingEpoch: number; conversationId: string; externalChatId: string },
): Promise<void> {
  await db.query(
    `INSERT INTO "${schema}".conversations
       (company_id,id,connection_id,binding_epoch,external_chat_id,chat_kind)
     VALUES ($1,$2,$3,$4,$5,'group')`,
    [input.companyId, input.conversationId, input.connectionId, input.bindingEpoch, input.externalChatId],
  );
}
