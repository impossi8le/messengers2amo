// amoCRM assignment workflow (#12).
//
// Ownership is split into two facts that never overwrite each other:
//   * work_items.owner_id            — the local operator assignment (platform),
//   * crm_contact_owners.crm_owner_ref — the observed CRM responsible user.
//
// Which side wins a disagreement is an explicit, per-company policy. A disagreement
// is always recorded as an open conflict; the policy only decides who wins, never
// whether the operator learns about it.

import { createHash, randomBytes } from 'node:crypto';
import type { Db, Tx } from '../../platform/db.ts';
import { withTransaction } from '../../platform/db.ts';
import { writeAudit } from '../../platform/audit.ts';
import { qualified } from './store.ts';
import { AssignmentError, transferWorkItem } from '../../repo/assignment.ts';

export type SourceOfTruth = 'crm' | 'platform';

export type WorkflowClient = {
  /** Reads the current CRM responsible user for the bound contact and its lead. */
  readResponsible(input: {
    companyId: string;
    accountId: string;
    conversationId: string;
    contactId: string;
    leadId: string | null;
  }): Promise<{ contactOwnerRef: string | null; lead: { id: string; responsibleUserId: string | null } | null }>;
  /** Writes the responsible user for the bound contact. */
  setContactOwner(input: {
    companyId: string;
    accountId: string;
    conversationId: string;
    contactId: string;
    ownerRef: string;
  }): Promise<void>;
};

export type WorkflowDeps = {
  db: Db;
  schema?: string;
  client: WorkflowClient;
  now?: () => number;
  /**
   * amoCRM account domain used to link the operator to the bound lead/contact card.
   * When absent the binding is still reported, but no card link is produced.
   */
  accountDomain?: string | null;
};

export type AssignmentPolicy = { sourceOfTruth: SourceOfTruth; version: number };

export type SyncStatus = 'ok' | 'lead_missing' | 'failed';

export type SyncState = {
  status: SyncStatus;
  errorCode: string | null;
  lastAttemptAt: number;
  lastSuccessAt: number | null;
  result: Record<string, unknown>;
};

export type SyncResult = {
  status: SyncStatus;
  replayed: boolean;
  leadId: string | null;
  crmOwnerRef: string | null;
  errorCode: string | null;
};

export type BindingSummary = {
  accountId: string;
  contactId: string | null;
  leadId: string | null;
  chatId: string | null;
  state: string;
};

export type Diagnostics = {
  sync: SyncState | null;
  leadMissing: boolean;
  projection: { desiredOwnerRef: string | null; projectedOwnerRef: string | null; state: string } | null;
  openConflicts: number;
  /** The conversation's CRM binding, so the operator can open the linked card. */
  binding: BindingSummary | null;
  /** Card URL derived from the binding and the configured account domain. */
  cardUrl: string | null;
};

export class AmocrmWorkflowError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(statusCode: number, code: string) {
    super(code);
    this.name = 'AmocrmWorkflowError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const COMMAND_ACCESS_REVOKED = 'amocrm.revoke_staff_access';

function digest(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${digest(...parts).slice(0, 24)}`;
}

function isSerializationFailure(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === '40001' || code === '40P01';
}

/**
 * Builds the amoCRM card URL from the binding. The lead is the operator-facing
 * card; a conversation bound only to a contact links to the contact instead.
 * Anything else (no ids, no confirmed domain) yields null rather than a guess.
 */
export function buildCrmCardUrl(input: {
  accountDomain: string | null | undefined;
  leadId: string | null;
  contactId: string | null;
}): string | null {
  const raw = input.accountDomain?.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '') ?? '';
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(raw)) return null;
  if (input.leadId) return `https://${raw}/leads/detail/${encodeURIComponent(input.leadId)}`;
  if (input.contactId) return `https://${raw}/contacts/detail/${encodeURIComponent(input.contactId)}`;
  return null;
}

export class AmocrmWorkflow {
  private readonly db: Db;
  private readonly schema: string | undefined;
  private readonly client: WorkflowClient;
  private readonly now: () => number;
  private readonly accountDomain: string | null;

  constructor(deps: WorkflowDeps) {
    this.db = deps.db;
    this.schema = deps.schema;
    this.client = deps.client;
    this.now = deps.now ?? (() => Date.now());
    this.accountDomain = deps.accountDomain ?? null;
  }

  private q(name: string): string {
    return qualified(this.schema, name);
  }

  private at(ms: number): Date {
    return new Date(ms);
  }

  // --- 1. Explicit, versioned source-of-truth policy -------------------------

  async getPolicy(companyId: string): Promise<AssignmentPolicy> {
    const { rows } = await this.db.query<{ source_of_truth: SourceOfTruth; version: string }>(
      `SELECT source_of_truth, version FROM ${this.q('crm_assignment_policy')} WHERE company_id=$1`,
      [companyId],
    );
    const row = rows[0];
    // Absence of a row is the documented default, not an unknown state.
    return row ? { sourceOfTruth: row.source_of_truth, version: Number(row.version) } : { sourceOfTruth: 'platform', version: 0 };
  }

  async setPolicy(input: {
    companyId: string;
    actorId: string;
    sourceOfTruth: SourceOfTruth;
    expectedVersion: number;
  }): Promise<AssignmentPolicy> {
    return withTransaction(this.db, async (tx) => {
      const updated = await tx.query<{ source_of_truth: SourceOfTruth; version: string }>(
        `UPDATE ${this.q('crm_assignment_policy')}
            SET source_of_truth=$3, version=version+1, updated_by=$4, updated_at=now()
          WHERE company_id=$1 AND version=$2
          RETURNING source_of_truth, version`,
        [input.companyId, input.expectedVersion, input.sourceOfTruth, input.actorId],
      );
      let row = updated.rows[0];
      if (!row) {
        const exists = await tx.query(`SELECT 1 FROM ${this.q('crm_assignment_policy')} WHERE company_id=$1`, [
          input.companyId,
        ]);
        if ((exists.rowCount ?? 0) > 0 || input.expectedVersion !== 0) {
          throw new AmocrmWorkflowError(409, 'VERSION_CONFLICT');
        }
        const inserted = await tx.query<{ source_of_truth: SourceOfTruth; version: string }>(
          `INSERT INTO ${this.q('crm_assignment_policy')}(company_id,source_of_truth,version,updated_by)
           VALUES ($1,$2,1,$3)
           RETURNING source_of_truth, version`,
          [input.companyId, input.sourceOfTruth, input.actorId],
        );
        row = inserted.rows[0]!;
      }
      await writeAudit(tx, {
        companyId: input.companyId,
        eventName: 'amocrm.assignment_policy_changed',
        subjectId: input.companyId,
        actorId: input.actorId,
        diagnosticCode: input.sourceOfTruth,
      });
      return { sourceOfTruth: row.source_of_truth, version: Number(row.version) };
    });
  }

  // --- 2. CRM-originated owner changes --------------------------------------

  /**
   * Records `assignment.changed` from amoCRM. The CRM owner is stored as an external
   * observation; the local assignee is never rewritten. If the platform holds a
   * different confirmed CRM user for the current assignee, an open conflict is
   * written instead of silently picking a side.
   */
  async applyCrmAssignmentChanged(input: {
    companyId: string;
    accountId: string;
    conversationId: string;
    crmOwnerRef: string;
  }): Promise<{ action: 'recorded' | 'conflict'; conflictId: string | null; winner: SourceOfTruth }> {
    return withTransaction(this.db, async (tx) => {
      await tx.query(
        `INSERT INTO ${this.q('crm_contact_owners')}(company_id,conversation_id,crm_owner_ref,version,observed_at)
         VALUES ($1,$2,$3,0,clock_timestamp())
         ON CONFLICT (company_id,conversation_id) DO UPDATE
           SET crm_owner_ref=EXCLUDED.crm_owner_ref,
               version=${this.q('crm_contact_owners')}.version+1,
               observed_at=clock_timestamp()`,
        [input.companyId, input.conversationId, input.crmOwnerRef],
      );

      const policy = await this.readPolicyTx(tx, input.companyId);
      const { rows } = await tx.query<{ owner_id: string | null }>(
        `SELECT owner_id FROM ${this.q('work_items')}
          WHERE company_id=$1 AND conversation_id=$2 AND state NOT IN ('resolved','cancelled')`,
        [input.companyId, input.conversationId],
      );
      const platformOwnerId = rows[0]?.owner_id ?? null;

      let desiredCrmRef: string | null = null;
      if (platformOwnerId) {
        const mapping = await tx.query<{ crm_user_ref: string }>(
          `SELECT crm_user_ref FROM ${this.q('staff_crm_refs')}
            WHERE company_id=$1 AND account_id=$2 AND staff_id=$3`,
          [input.companyId, input.accountId, platformOwnerId],
        );
        desiredCrmRef = mapping.rows[0]?.crm_user_ref ?? null;
      }

      if (!desiredCrmRef || desiredCrmRef === input.crmOwnerRef) {
        await writeAudit(tx, {
          companyId: input.companyId,
          eventName: 'amocrm.assignment_changed',
          subjectId: input.conversationId,
          actorId: null,
          diagnosticCode: 'recorded',
        });
        return { action: 'recorded', conflictId: null, winner: policy.sourceOfTruth };
      }

      // A real disagreement: record it. The same disagreement observed twice is one row.
      const conflictId = stableId(
        'conf',
        input.companyId,
        input.accountId,
        input.conversationId,
        input.crmOwnerRef,
        platformOwnerId ?? 'none',
      );
      const inserted = await tx.query(
        `INSERT INTO ${this.q('crm_assignment_conflicts')}
           (company_id,id,account_id,conversation_id,crm_owner_ref,platform_owner_id,desired_crm_owner_ref,policy,winner)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
         ON CONFLICT (company_id,id) DO NOTHING
         RETURNING id`,
        [
          input.companyId,
          conflictId,
          input.accountId,
          input.conversationId,
          input.crmOwnerRef,
          platformOwnerId,
          desiredCrmRef,
          policy.sourceOfTruth,
        ],
      );
      if ((inserted.rowCount ?? 0) > 0) {
        await writeAudit(tx, {
          companyId: input.companyId,
          eventName: 'amocrm.assignment_conflict',
          subjectId: conflictId,
          actorId: null,
          diagnosticCode: policy.sourceOfTruth,
        });
      }
      return { action: 'conflict', conflictId, winner: policy.sourceOfTruth };
    });
  }

  private async readPolicyTx(tx: Tx, companyId: string): Promise<AssignmentPolicy> {
    const { rows } = await tx.query<{ source_of_truth: SourceOfTruth; version: string }>(
      `SELECT source_of_truth, version FROM ${this.q('crm_assignment_policy')} WHERE company_id=$1`,
      [companyId],
    );
    const row = rows[0];
    return row ? { sourceOfTruth: row.source_of_truth, version: Number(row.version) } : { sourceOfTruth: 'platform', version: 0 };
  }

  // --- 3. Platform assignment -> CRM projection -----------------------------

  /** Transfers a work item; the projection to CRM is a separate, explicit step. */
  async transferTo(input: {
    companyId: string;
    workItemId: string;
    actorId: string;
    toStaffId: string | null;
    requestKey?: string;
  }): Promise<void> {
    const { rows } = await this.db.query<{ assignment_version: string }>(
      `SELECT assignment_version FROM ${this.q('work_items')} WHERE company_id=$1 AND id=$2`,
      [input.companyId, input.workItemId],
    );
    const current = rows[0];
    if (!current) throw new AmocrmWorkflowError(404, 'WORK_ITEM_NOT_FOUND');
    await transferWorkItem(this.db, { schema: this.schema ?? 'public' }, {
      companyId: input.companyId,
      workItemId: input.workItemId,
      actorId: input.actorId,
      toStaffId: input.toStaffId,
      toDepartmentId: null,
      expectedVersion: Number(current.assignment_version),
      requestKey: input.requestKey ?? `wf-transfer:${randomBytes(10).toString('hex')}`,
    });
  }

  /**
   * Projects the current local assignee into the CRM responsible user. Requires a
   * confirmed staff<->CRM mapping; without one the projection fails visibly and no
   * external call is made.
   */
  async projectOwnerChange(input: {
    companyId: string;
    accountId: string;
    conversationId: string;
    actorId: string;
    requestKey: string;
  }): Promise<{ projected: boolean; reason?: string; ownerRef?: string | null; conflictId?: string | null }> {
    // Concurrent projections of the same conversation are serialized across API
    // instances with a database advisory lock, so only one of them reaches CRM.
    // A duplicate with the same request key then observes the applied row and
    // replays instead of issuing a second write.
    const lockKey = `amocrm-projection:${input.companyId}:${input.accountId}:${input.conversationId}`;
    const client = await this.db.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
      return await this.projectOwnerChangeLocked(input);
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]);
      } finally {
        client.release();
      }
    }
  }

  private async projectOwnerChangeLocked(input: {
    companyId: string;
    accountId: string;
    conversationId: string;
    actorId: string;
    requestKey: string;
  }): Promise<{ projected: boolean; reason?: string; ownerRef?: string | null; conflictId?: string | null }> {
    const context = await withTransaction(this.db, async (tx) => {
      const policy = await this.readPolicyTx(tx, input.companyId);
      const binding = await tx.query<{ contact_id: string | null }>(
        `SELECT contact_id FROM ${this.q('crm_bindings')}
          WHERE company_id=$1 AND account_id=$2 AND conversation_id=$3`,
        [input.companyId, input.accountId, input.conversationId],
      );
      const contactId = binding.rows[0]?.contact_id ?? null;
      if (!contactId) {
        await this.recordProjectionFailure(tx, input, 'crm_binding_missing');
        return { kind: 'stop' as const, reason: 'crm_binding_missing', ownerRef: null };
      }
      const items = await tx.query<{ owner_id: string | null }>(
        `SELECT owner_id FROM ${this.q('work_items')}
          WHERE company_id=$1 AND conversation_id=$2 AND state NOT IN ('resolved','cancelled')`,
        [input.companyId, input.conversationId],
      );
      const ownerId = items.rows[0]?.owner_id ?? null;
      if (!ownerId) {
        await this.recordProjectionFailure(tx, input, 'no_assignee');
        return { kind: 'stop' as const, reason: 'no_assignee', ownerRef: null };
      }
      const mapping = await tx.query<{ crm_user_ref: string }>(
        `SELECT crm_user_ref FROM ${this.q('staff_crm_refs')}
          WHERE company_id=$1 AND account_id=$2 AND staff_id=$3`,
        [input.companyId, input.accountId, ownerId],
      );
      const ownerRef = mapping.rows[0]?.crm_user_ref ?? null;
      if (!ownerRef) {
        await this.recordProjectionFailure(tx, input, 'crm_user_mapping_missing');
        return { kind: 'stop' as const, reason: 'crm_user_mapping_missing', ownerRef: null };
      }
      if (policy.sourceOfTruth === 'crm') {
        await this.recordProjectionFailure(tx, input, 'crm_source_of_truth');
        return { kind: 'stop' as const, reason: 'crm_source_of_truth', ownerRef };
      }

      const existing = await tx.query<{ state: string; projected_owner_ref: string | null; last_request_key: string | null }>(
        `SELECT state, projected_owner_ref, last_request_key FROM ${this.q('crm_owner_projections')}
          WHERE company_id=$1 AND account_id=$2 AND conversation_id=$3 FOR UPDATE`,
        [input.companyId, input.accountId, input.conversationId],
      );
      const row = existing.rows[0];
      if (row?.last_request_key === input.requestKey && row.state === 'applied' && row.projected_owner_ref === ownerRef) {
        return { kind: 'replay' as const, ownerRef };
      }

      await tx.query(
        `INSERT INTO ${this.q('crm_owner_projections')}
           (company_id,account_id,conversation_id,desired_owner_ref,state,error_code,last_request_key,version)
         VALUES ($1,$2,$3,$4,'pending',NULL,$5,1)
         ON CONFLICT (company_id,account_id,conversation_id) DO UPDATE
           SET desired_owner_ref=EXCLUDED.desired_owner_ref, state='pending', error_code=NULL,
               last_request_key=EXCLUDED.last_request_key, version=${this.q('crm_owner_projections')}.version+1,
               updated_at=now()`,
        [input.companyId, input.accountId, input.conversationId, ownerRef, input.requestKey],
      );
      return { kind: 'call' as const, contactId, ownerRef };
    });

    if (context.kind === 'stop') return { projected: false, reason: context.reason, ownerRef: context.ownerRef };
    if (context.kind === 'replay') return { projected: true, ownerRef: context.ownerRef };

    try {
      await this.client.setContactOwner({
        companyId: input.companyId,
        accountId: input.accountId,
        conversationId: input.conversationId,
        contactId: context.contactId,
        ownerRef: context.ownerRef,
      });
    } catch {
      await withTransaction(this.db, async (tx) => {
        await tx.query(
          `UPDATE ${this.q('crm_owner_projections')}
              SET state='failed', error_code='upstream_unavailable', version=version+1, updated_at=now()
            WHERE company_id=$1 AND account_id=$2 AND conversation_id=$3`,
          [input.companyId, input.accountId, input.conversationId],
        );
        await writeAudit(tx, {
          companyId: input.companyId,
          eventName: 'amocrm.owner_projection_failed',
          subjectId: input.conversationId,
          actorId: input.actorId,
          diagnosticCode: 'upstream_unavailable',
        });
      });
      return { projected: false, reason: 'upstream_unavailable', ownerRef: context.ownerRef };
    }

    await withTransaction(this.db, async (tx) => {
      await tx.query(
        `UPDATE ${this.q('crm_owner_projections')}
            SET state='applied', projected_owner_ref=$4, error_code=NULL, version=version+1, updated_at=now()
          WHERE company_id=$1 AND account_id=$2 AND conversation_id=$3`,
        [input.companyId, input.accountId, input.conversationId, context.ownerRef],
      );
      await writeAudit(tx, {
        companyId: input.companyId,
        eventName: 'amocrm.owner_projection_applied',
        subjectId: input.conversationId,
        actorId: input.actorId,
        diagnosticCode: context.ownerRef,
      });
    });
    return { projected: true, ownerRef: context.ownerRef };
  }

  private async recordProjectionFailure(
    tx: Tx,
    input: { companyId: string; accountId: string; conversationId: string },
    reason: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO ${this.q('crm_owner_projections')}
         (company_id,account_id,conversation_id,state,error_code,version)
       VALUES ($1,$2,$3,'failed',$4,1)
       ON CONFLICT (company_id,account_id,conversation_id) DO UPDATE
         SET state='failed', error_code=EXCLUDED.error_code,
             version=${this.q('crm_owner_projections')}.version+1, updated_at=now()`,
      [input.companyId, input.accountId, input.conversationId, reason],
    );
  }

  // --- 4/6/7. Manual resync, missing lead and visible sync state -------------

  /**
   * Re-reads CRM state for one conversation. Idempotent by `requestKey`: a replay
   * returns the stored outcome and performs no second CRM read.
   */
  async syncConversation(input: {
    companyId: string;
    accountId: string;
    conversationId: string;
    actorId: string;
    requestKey: string;
  }): Promise<SyncResult> {
    const claim = await this.claimSync(input);
    if (claim.kind === 'replay') return claim.result;

    if (claim.kind === 'no_binding') {
      return this.recordSyncOutcome(input, {
        status: 'failed',
        leadId: null,
        crmOwnerRef: null,
        errorCode: 'crm_binding_missing',
      });
    }

    let observed: { contactOwnerRef: string | null; lead: { id: string; responsibleUserId: string | null } | null };
    try {
      observed = await this.client.readResponsible({
        companyId: input.companyId,
        accountId: input.accountId,
        conversationId: input.conversationId,
        contactId: claim.contactId,
        leadId: claim.leadId,
      });
    } catch {
      return this.recordSyncOutcome(input, {
        status: 'failed',
        leadId: null,
        crmOwnerRef: null,
        errorCode: 'upstream_unavailable',
      });
    }

    if (observed.contactOwnerRef) {
      await this.db.query(
        `INSERT INTO ${this.q('crm_contact_owners')}(company_id,conversation_id,crm_owner_ref,version,observed_at)
         VALUES ($1,$2,$3,0,clock_timestamp())
         ON CONFLICT (company_id,conversation_id) DO UPDATE
           SET crm_owner_ref=EXCLUDED.crm_owner_ref,
               version=${this.q('crm_contact_owners')}.version+1,
               observed_at=clock_timestamp()`,
        [input.companyId, input.conversationId, observed.contactOwnerRef],
      );
    }

    const leadId = observed.lead?.id ?? null;
    return this.recordSyncOutcome(input, {
      status: leadId ? 'ok' : 'lead_missing',
      leadId,
      crmOwnerRef: observed.contactOwnerRef,
      errorCode: leadId ? null : 'crm_lead_missing',
    });
  }

  private async claimSync(input: {
    companyId: string;
    accountId: string;
    conversationId: string;
    actorId: string;
    requestKey: string;
  }): Promise<
    | { kind: 'claimed'; contactId: string; leadId: string | null }
    | { kind: 'no_binding' }
    | { kind: 'replay'; result: SyncResult }
  > {
    return withTransaction(this.db, async (tx) => {
      const binding = await tx.query<{ contact_id: string | null; lead_id: string | null }>(
        `SELECT contact_id, lead_id FROM ${this.q('crm_bindings')}
          WHERE company_id=$1 AND account_id=$2 AND conversation_id=$3`,
        [input.companyId, input.accountId, input.conversationId],
      );
      const bound = binding.rows[0];
      if (!bound?.contact_id) {
        await this.markSyncAttempt(tx, input, 'failed');
        return { kind: 'no_binding' as const };
      }
      const claimed = await tx.query(
        `INSERT INTO ${this.q('crm_sync_state')}
           (company_id,account_id,conversation_id,last_request_key,last_status,last_attempt_at)
         VALUES ($1,$2,$3,$4,'in_progress',to_timestamp($5/1000.0))
         ON CONFLICT (company_id,account_id,conversation_id) DO UPDATE
           SET last_request_key=EXCLUDED.last_request_key, last_status='in_progress',
               last_attempt_at=EXCLUDED.last_attempt_at,
               version=${this.q('crm_sync_state')}.version+1
           WHERE ${this.q('crm_sync_state')}.last_request_key IS DISTINCT FROM EXCLUDED.last_request_key
         RETURNING version`,
        [input.companyId, input.accountId, input.conversationId, input.requestKey, this.now()],
      );
      if ((claimed.rowCount ?? 0) === 0) {
        const stored = await tx.query<{
          last_status: SyncStatus | 'in_progress';
          last_error_code: string | null;
          last_result: Record<string, unknown>;
        }>(
          `SELECT last_status, last_error_code, last_result FROM ${this.q('crm_sync_state')}
            WHERE company_id=$1 AND account_id=$2 AND conversation_id=$3`,
          [input.companyId, input.accountId, input.conversationId],
        );
        const row = stored.rows[0];
        if (row && row.last_status !== 'in_progress') {
          const result = row.last_result as Partial<SyncResult>;
          return {
            kind: 'replay' as const,
            result: {
              status: row.last_status,
              replayed: true,
              leadId: (result.leadId as string | null) ?? null,
              crmOwnerRef: (result.crmOwnerRef as string | null) ?? null,
              errorCode: row.last_error_code,
            },
          };
        }
        // A concurrent call with the same key is still running: never issue a second read.
        return {
          kind: 'replay' as const,
          result: { status: 'failed', replayed: true, leadId: null, crmOwnerRef: null, errorCode: 'sync_in_progress' },
        };
      }
      return { kind: 'claimed' as const, contactId: bound.contact_id, leadId: bound.lead_id };
    });
  }

  private async markSyncAttempt(
    tx: Tx,
    input: { companyId: string; accountId: string; conversationId: string; requestKey: string },
    status: SyncStatus,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO ${this.q('crm_sync_state')}
         (company_id,account_id,conversation_id,last_request_key,last_status,last_attempt_at)
       VALUES ($1,$2,$3,$4,$5,to_timestamp($6/1000.0))
       ON CONFLICT (company_id,account_id,conversation_id) DO UPDATE
         SET last_request_key=EXCLUDED.last_request_key, last_status=EXCLUDED.last_status,
             last_attempt_at=EXCLUDED.last_attempt_at,
             version=${this.q('crm_sync_state')}.version+1`,
      [input.companyId, input.accountId, input.conversationId, input.requestKey, status, this.now()],
    );
  }

  private async recordSyncOutcome(
    input: { companyId: string; accountId: string; conversationId: string; actorId: string; requestKey: string },
    outcome: { status: SyncStatus; leadId: string | null; crmOwnerRef: string | null; errorCode: string | null },
  ): Promise<SyncResult> {
    const result: Record<string, unknown> = {
      leadId: outcome.leadId,
      crmOwnerRef: outcome.crmOwnerRef,
    };
    await withTransaction(this.db, async (tx) => {
      await tx.query(
        `UPDATE ${this.q('crm_sync_state')}
            SET last_status=$4, last_error_code=$5,
                last_success_at=CASE WHEN $4='ok' THEN to_timestamp($6/1000.0) ELSE last_success_at END,
                last_result=$7::jsonb, last_attempt_at=to_timestamp($6/1000.0), version=version+1
          WHERE company_id=$1 AND account_id=$2 AND conversation_id=$3`,
        [
          input.companyId,
          input.accountId,
          input.conversationId,
          outcome.status,
          outcome.errorCode,
          this.now(),
          JSON.stringify(result),
        ],
      );
      await writeAudit(tx, {
        companyId: input.companyId,
        eventName: outcome.status === 'ok' ? 'amocrm.sync_completed' : 'amocrm.sync_failed',
        subjectId: input.conversationId,
        actorId: input.actorId,
        diagnosticCode: outcome.errorCode ?? outcome.status,
      });
    });
    return { ...outcome, replayed: false };
  }

  async getSyncState(input: {
    companyId: string;
    accountId: string;
    conversationId: string;
  }): Promise<SyncState | null> {
    const { rows } = await this.db.query<{
      last_status: SyncStatus | 'in_progress';
      last_error_code: string | null;
      last_attempt_at: Date;
      last_success_at: Date | null;
      last_result: Record<string, unknown>;
    }>(
      `SELECT last_status, last_error_code, last_attempt_at, last_success_at, last_result
         FROM ${this.q('crm_sync_state')}
        WHERE company_id=$1 AND account_id=$2 AND conversation_id=$3`,
      [input.companyId, input.accountId, input.conversationId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      // An in-progress claim is not a terminal outcome; expose it as failed/known.
      status: row.last_status === 'in_progress' ? 'failed' : row.last_status,
      errorCode: row.last_status === 'in_progress' ? 'sync_in_progress' : row.last_error_code,
      lastAttemptAt: row.last_attempt_at.getTime(),
      lastSuccessAt: row.last_success_at ? row.last_success_at.getTime() : null,
      result: row.last_result ?? {},
    };
  }

  async getDiagnostics(input: {
    companyId: string;
    accountId: string;
    conversationId: string;
  }): Promise<Diagnostics> {
    const sync = await this.getSyncState(input);
    const projection = await this.db.query<{
      desired_owner_ref: string | null;
      projected_owner_ref: string | null;
      state: string;
    }>(
      `SELECT desired_owner_ref, projected_owner_ref, state FROM ${this.q('crm_owner_projections')}
        WHERE company_id=$1 AND account_id=$2 AND conversation_id=$3`,
      [input.companyId, input.accountId, input.conversationId],
    );
    const conflicts = await this.db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ${this.q('crm_assignment_conflicts')}
        WHERE company_id=$1 AND conversation_id=$2 AND state='open'`,
      [input.companyId, input.conversationId],
    );
    const binding = await this.db.query<{
      account_id: string;
      contact_id: string | null;
      lead_id: string | null;
      chat_id: string | null;
      state: string;
    }>(
      `SELECT account_id, contact_id, lead_id, chat_id, state FROM ${this.q('crm_bindings')}
        WHERE company_id=$1 AND account_id=$2 AND conversation_id=$3`,
      [input.companyId, input.accountId, input.conversationId],
    );
    const bound = binding.rows[0];
    const row = projection.rows[0];
    return {
      sync,
      leadMissing: sync?.status === 'lead_missing',
      projection: row
        ? { desiredOwnerRef: row.desired_owner_ref, projectedOwnerRef: row.projected_owner_ref, state: row.state }
        : null,
      openConflicts: conflicts.rows[0]?.c ?? 0,
      binding: bound
        ? {
            accountId: bound.account_id,
            contactId: bound.contact_id,
            leadId: bound.lead_id,
            chatId: bound.chat_id,
            state: bound.state,
          }
        : null,
      cardUrl: bound
        ? buildCrmCardUrl({
            accountDomain: this.accountDomain,
            leadId: bound.lead_id,
            contactId: bound.contact_id,
          })
        : null,
    };
  }

  // --- 5. Access revocation returns assignments to the queue ----------------

  /**
   * Withdraws a staff member's access. Their work items go back to the queue, their
   * capacity slots are released and every change is written to assignment history
   * and audit. A replay of the same command key returns the stored result.
   */
  async revokeStaffAccess(input: {
    companyId: string;
    staffId: string;
    actorId: string;
    requestKey: string;
  }): Promise<{ released: number; workItemIds: string[]; replayed: boolean }> {
    try {
      return await withTransaction(this.db, async (tx) => {
        const fingerprint = digest(COMMAND_ACCESS_REVOKED, input.companyId, input.staffId);
        const claim = await tx.query(
          `INSERT INTO ${this.q('workflow_commands')}
             (company_id,command_type,request_key,payload_fingerprint,result)
           VALUES ($1,$2,$3,$4,'{}'::jsonb)
           ON CONFLICT (company_id,command_type,request_key) DO NOTHING
           RETURNING request_key`,
          [input.companyId, COMMAND_ACCESS_REVOKED, input.requestKey, fingerprint],
        );
        if ((claim.rowCount ?? 0) === 0) {
          const stored = await tx.query<{ result: { released?: number; workItemIds?: string[] } }>(
            `SELECT result FROM ${this.q('workflow_commands')}
              WHERE company_id=$1 AND command_type=$2 AND request_key=$3`,
            [input.companyId, COMMAND_ACCESS_REVOKED, input.requestKey],
          );
          const result = stored.rows[0]?.result ?? {};
          return { released: result.released ?? 0, workItemIds: result.workItemIds ?? [], replayed: true };
        }

        const staff = await tx.query<{ active_count: number }>(
          `SELECT active_count FROM ${this.q('staff')} WHERE company_id=$1 AND id=$2 FOR UPDATE`,
          [input.companyId, input.staffId],
        );
        if (!staff.rows[0]) throw new AmocrmWorkflowError(404, 'STAFF_NOT_FOUND');

        const owned = await tx.query<{ id: string; assignment_version: string }>(
          `UPDATE ${this.q('work_items')}
              SET owner_id=NULL, state='queued', assignment_version=assignment_version+1
            WHERE company_id=$1 AND owner_id=$2 AND state NOT IN ('resolved','cancelled')
            RETURNING id, assignment_version`,
          [input.companyId, input.staffId],
        );

        for (const item of owned.rows) {
          await tx.query(
            `INSERT INTO ${this.q('assignment_history')}
               (company_id,id,work_item_id,previous_owner_id,owner_id,assignment_version,reason,actor_id)
             VALUES ($1,$2,$3,$4,NULL,$5,'access_revoked',$6)`,
            [input.companyId, randomBytes(12).toString('hex'), item.id, input.staffId, Number(item.assignment_version), input.actorId],
          );
        }

        await tx.query(`UPDATE ${this.q('staff')} SET active_count=0, version=version+1 WHERE company_id=$1 AND id=$2`, [
          input.companyId,
          input.staffId,
        ]);
        await tx.query(`DELETE FROM ${this.q('staff_access')} WHERE company_id=$1 AND staff_id=$2`, [
          input.companyId,
          input.staffId,
        ]);
        await tx.query(
          `UPDATE ${this.q('staff_sessions')} SET revoked_at=to_timestamp($3/1000.0)
            WHERE company_id=$1 AND staff_id=$2 AND revoked_at IS NULL`,
          [input.companyId, input.staffId, this.now()],
        );

        const workItemIds = owned.rows.map((item) => item.id).sort();
        await writeAudit(tx, {
          companyId: input.companyId,
          eventName: 'amocrm.staff_access_revoked',
          subjectId: input.staffId,
          actorId: input.actorId,
          diagnosticCode: String(workItemIds.length),
        });

        await tx.query(
          `UPDATE ${this.q('workflow_commands')} SET result=$4::jsonb
            WHERE company_id=$1 AND command_type=$2 AND request_key=$3`,
          [
            input.companyId,
            COMMAND_ACCESS_REVOKED,
            input.requestKey,
            JSON.stringify({ released: workItemIds.length, workItemIds }),
          ],
        );
        return { released: workItemIds.length, workItemIds, replayed: false };
      });
    } catch (error) {
      if (isSerializationFailure(error)) throw new AmocrmWorkflowError(409, 'SERIALIZATION_FAILURE');
      if (error instanceof AssignmentError) throw error;
      throw error;
    }
  }
}
