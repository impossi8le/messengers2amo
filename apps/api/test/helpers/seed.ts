import { withTransaction, type Db } from '../../src/platform/db.ts';
import { createPasswordRecord, type Role } from '../../src/platform/auth.ts';

export type SeedStaff = {
  id: string;
  password: string;
  role: Role;
  workshopId?: string | null;
  withAccess?: boolean;
};

export type SeedCompany = {
  companyId: string;
  workshops?: string[];
  staff: SeedStaff[];
};

export async function seedCompany(db: Db, seed: SeedCompany): Promise<void> {
  await db.query('INSERT INTO companies (id, display_name) VALUES ($1, $2)', [seed.companyId, seed.companyId]);
  for (const workshopId of seed.workshops ?? []) {
    await db.query('INSERT INTO workshops (company_id, id, display_name) VALUES ($1, $2, $3)', [
      seed.companyId,
      workshopId,
      workshopId,
    ]);
  }
  for (const member of seed.staff) {
    await db.query('INSERT INTO staff (company_id, id, display_name) VALUES ($1, $2, $3)', [
      seed.companyId,
      member.id,
      member.id,
    ]);
    const record = await createPasswordRecord(member.password);
    await db.query(
      `INSERT INTO staff_credentials (company_id, staff_id, salt, password_hash, algorithm)
       VALUES ($1, $2, $3, $4, 'scrypt')`,
      [seed.companyId, member.id, record.salt, record.hash],
    );
    if (member.withAccess !== false) {
      await db.query(
        `INSERT INTO staff_access (company_id, staff_id, role, workshop_id, version)
         VALUES ($1, $2, $3, $4, 0)`,
        [seed.companyId, member.id, member.role, member.workshopId ?? null],
      );
    }
  }
}

export async function seedConnection(
  db: Db,
  input: {
    companyId: string;
    id: string;
    channelMode?: string;
    state?: string;
    version?: number;
    workshopId?: string | null;
    ownerId?: string;
    credentialRef?: string;
    permissions?: { staffId: string; canRead: boolean; canSend: boolean }[];
  },
): Promise<void> {
  const state = input.state ?? 'setup';
  // The circular deferred FK is only satisfiable inside one transaction.
  await withTransaction(db, async (tx) => {
    await tx.query(
      `INSERT INTO connections
         (company_id, id, channel_mode, binding_epoch, credentials_version, state, version,
          capabilities, ingress_enabled, send_enabled, health, credential_ref)
       VALUES ($1,$2,$3,0,1,$4,$5,$6::jsonb,false,false,$7::jsonb,$8)`,
      [
        input.companyId,
        input.id,
        input.channelMode ?? 'telegram_bot',
        state,
        input.version ?? 0,
        JSON.stringify({
          textReply: 'unknown',
          mediaReply: 'unknown',
          readReceipts: 'unknown',
          deliveryReceipts: 'unknown',
          messageEditing: 'unknown',
          messageDeletion: 'unknown',
        }),
        JSON.stringify({ checkedAt: new Date().toISOString(), lastInboundAt: null, lastSuccessAt: null, errorCode: null }),
        input.credentialRef ?? null,
      ],
    );
    await tx.query(
      `INSERT INTO connection_identities (company_id, connection_id, binding_epoch) VALUES ($1,$2,0)`,
      [input.companyId, input.id],
    );
  });
  if (input.workshopId) {
    await db.query(
      `INSERT INTO crm_accounts (company_id, id) VALUES ($1,$2)`,
      [input.companyId, `acc_${input.id}`],
    );
    await db.query(
      `INSERT INTO crm_sources (company_id, id, account_id, external_id, origin_code)
       VALUES ($1,$2,$3,$4,$5)`,
      [input.companyId, `src_${input.id}`, `acc_${input.id}`, `ext_${input.id}`, 'technical'],
    );
    await db.query(
      `INSERT INTO connection_routes
         (company_id, connection_id, workshop_id, crm_account_id, funnel_id, default_owner_id, technical_source_id, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0)`,
      [
        input.companyId,
        input.id,
        input.workshopId,
        `acc_${input.id}`,
        'funnel_1',
        input.ownerId ?? 'owner_missing',
        `src_${input.id}`,
      ],
    );
  }
  for (const permission of input.permissions ?? []) {
    await db.query(
      `INSERT INTO channel_permissions (company_id, connection_id, staff_id, can_read, can_send)
       VALUES ($1,$2,$3,$4,$5)`,
      [input.companyId, input.id, permission.staffId, permission.canRead, permission.canSend],
    );
  }
}

export async function insertStaff(db: Db, companyId: string, staffId: string): Promise<void> {
  await db.query('INSERT INTO staff (company_id, id, display_name) VALUES ($1,$2,$3)', [companyId, staffId, staffId]);
}
