// Archive handoff for message attachments.
//
// Three facts are kept separate and must never be conflated:
//   1. the object is written to S3 and its bytes verified (`attachments.storage_state`);
//   2. the external archive acknowledged the index entry (`archive_handoff_jobs.state
//      = 'indexed'` plus `attachments.index_ack_ref`);
//   3. the handoff was actually delivered to the archive (`delivered_at`).
//
// Delivery stays disabled until an explicit archive contract reference exists.
// The archive itself is reached only through `ArchiveIndexPort`; this module never
// opens or writes any external database. When the index outcome is unknown, the job
// is parked as `unknown` for reconciliation instead of being retried blindly.

import { randomBytes } from 'node:crypto';
import type { Db, Tx } from '../platform/db.ts';
import { withTransaction } from '../platform/db.ts';
import { qualified } from '../integrations/amocrm/store.ts';

export type ArchiveHandoffState = 'pending' | 'leased' | 'indexed' | 'failed' | 'unknown' | 'cancelled';

export type HandoffJob = {
  id: string;
  attachmentId: string;
  state: ArchiveHandoffState;
  deliveryEnabled: boolean;
  contractRef: string | null;
};

export type IndexResult = { indexed: boolean; reason: string };

export type AttachmentLeadLink = {
  leadId: string;
  linkState: 'active' | 'deleted' | 'merged';
  mergedIntoLeadId: string | null;
};

/**
 * Adapter port for the existing archive plugin. The real contract is UNKNOWN, so
 * only this abstract boundary and a synthetic fake for tests exist.
 */
export interface ArchiveIndexPort {
  deliver(input: { companyId: string; attachmentId: string; s3Key: string; contractRef: string }): Promise<
    | { outcome: 'acknowledged'; ackRef: string }
    | { outcome: 'unknown'; reason: string }
    | { outcome: 'error'; reason: string }
  >;
}

export type ArchiveServiceDeps = {
  db: Db;
  schema: string;
  archiveIndex?: ArchiveIndexPort | null;
  contractRef?: string | null;
};

type JobRow = {
  id: string;
  attachment_id: string;
  state: ArchiveHandoffState;
  delivery_enabled: boolean;
  contract_ref: string | null;
  delivered_at: Date | null;
};

type AttachmentRow = { storage_state: string; s3_key: string | null; sha256: string | null };

function toJob(row: JobRow): HandoffJob {
  return {
    id: row.id,
    attachmentId: row.attachment_id,
    state: row.state,
    deliveryEnabled: row.delivery_enabled,
    contractRef: row.contract_ref,
  };
}

export class ArchiveService {
  private readonly db: Db;
  private readonly schema: string;
  private readonly archiveIndex: ArchiveIndexPort | null;
  private readonly contractRef: string | null;

  constructor(deps: ArchiveServiceDeps) {
    this.db = deps.db;
    this.schema = deps.schema;
    this.archiveIndex = deps.archiveIndex ?? null;
    this.contractRef = deps.contractRef ?? null;
  }

  private q(name: string): string {
    return qualified(this.schema, name);
  }

  private async loadJob(tx: Tx | Db, companyId: string, jobId: string): Promise<JobRow | null> {
    const { rows } = await tx.query<JobRow>(
      `SELECT id, attachment_id, state, delivery_enabled, contract_ref, delivered_at
         FROM ${this.q('archive_handoff_jobs')} WHERE company_id=$1 AND id=$2`,
      [companyId, jobId],
    );
    return rows[0] ?? null;
  }

  private async loadAttachment(tx: Tx | Db, companyId: string, attachmentId: string): Promise<AttachmentRow | null> {
    const { rows } = await tx.query<AttachmentRow>(
      `SELECT storage_state, s3_key, sha256 FROM ${this.q('attachments')}
        WHERE company_id=$1 AND id=$2`,
      [companyId, attachmentId],
    );
    return rows[0] ?? null;
  }

  /**
   * Creates (or returns) the index intent for a stored attachment. The job is only
   * delivery-enabled when this service knows a confirmed archive contract.
   */
  async createHandoff(input: { companyId: string; attachmentId: string }): Promise<HandoffJob> {
    const attachment = await this.loadAttachment(this.db, input.companyId, input.attachmentId);
    if (!attachment) throw new Error('ATTACHMENT_NOT_FOUND');
    if (attachment.storage_state !== 'verified' || !attachment.s3_key || !attachment.sha256) {
      throw new Error('ATTACHMENT_NOT_STORED');
    }
    const contractRef = this.contractRef;
    const intentKey = `archive:${input.attachmentId}`;
    const { rows } = await this.db.query<JobRow>(
      `INSERT INTO ${this.q('archive_handoff_jobs')}
         (company_id,id,attachment_id,intent_key,delivery_enabled,contract_ref,state)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')
       ON CONFLICT (company_id,intent_key) DO NOTHING
       RETURNING id, attachment_id, state, delivery_enabled, contract_ref, delivered_at`,
      [
        input.companyId,
        `ahj_${randomBytes(12).toString('hex')}`,
        input.attachmentId,
        intentKey,
        contractRef !== null,
        contractRef,
      ],
    );
    if (rows[0]) return toJob(rows[0]);

    // A job may already exist from ingestion, when the contract was not yet
    // confirmed. A now-confirmed contract enables that still-pending intent; an
    // indexed or unknown job is never downgraded or re-opened here.
    if (contractRef !== null) {
      const enabled = await this.db.query<JobRow>(
        `UPDATE ${this.q('archive_handoff_jobs')}
            SET delivery_enabled=true, contract_ref=$3
          WHERE company_id=$1 AND intent_key=$2 AND state='pending' AND delivery_enabled=false
          RETURNING id, attachment_id, state, delivery_enabled, contract_ref, delivered_at`,
        [input.companyId, intentKey, contractRef],
      );
      if (enabled.rows[0]) return toJob(enabled.rows[0]);
    }

    const existing = await this.db.query<JobRow>(
      `SELECT id, attachment_id, state, delivery_enabled, contract_ref, delivered_at
         FROM ${this.q('archive_handoff_jobs')} WHERE company_id=$1 AND intent_key=$2`,
      [input.companyId, intentKey],
    );
    const job = existing.rows[0];
    if (!job) throw new Error('HANDOFF_JOB_MISSING');
    return toJob(job);
  }

  /**
   * Submits the attachment to the archive index through the adapter port.
   *
   * Refusals are explicit reasons, never silent successes. An acknowledged entry
   * becomes `indexed` and records its ack reference; a timeout is recorded as
   * `unknown` and is never retried blindly; an explicit rejection is `failed`.
   * A job that is already indexed is not submitted a second time.
   */
  async indexAttachment(input: { companyId: string; jobId: string }): Promise<IndexResult> {
    const job = await this.loadJob(this.db, input.companyId, input.jobId);
    if (!job) return { indexed: false, reason: 'job_not_found' };
    if (!job.delivery_enabled || !job.contract_ref) return { indexed: false, reason: 'contract_missing' };
    if (job.state === 'indexed') return { indexed: true, reason: 'already_indexed' };
    if (job.state === 'unknown') return { indexed: false, reason: 'index_unknown' };
    if (job.state === 'failed') return { indexed: false, reason: 'index_failed' };
    if (!this.archiveIndex) return { indexed: false, reason: 'adapter_unavailable' };

    const attachment = await this.loadAttachment(this.db, input.companyId, job.attachment_id);
    if (!attachment?.s3_key || attachment.storage_state !== 'verified') {
      return { indexed: false, reason: 'attachment_not_stored' };
    }

    const outcome = await this.archiveIndex.deliver({
      companyId: input.companyId,
      attachmentId: job.attachment_id,
      s3Key: attachment.s3_key,
      contractRef: job.contract_ref,
    });
    if (outcome.outcome === 'acknowledged') {
      await this.confirmIndex({
        companyId: input.companyId,
        jobId: input.jobId,
        ackRef: outcome.ackRef,
      });
      return { indexed: true, reason: 'indexed' };
    }
    if (outcome.outcome === 'unknown') {
      await this.markIndexUnknown({
        companyId: input.companyId,
        jobId: input.jobId,
        reason: outcome.reason,
      });
      return { indexed: false, reason: 'index_unknown' };
    }
    await this.markIndexFailed(input.companyId, input.jobId);
    return { indexed: false, reason: 'index_error' };
  }

  /**
   * Records the archive acknowledgement. This is the only transition that turns a
   * stored object into an indexed one, and it requires both the contract and an
   * explicit acknowledgement reference.
   */
  async confirmIndex(input: { companyId: string; jobId: string; ackRef: string }): Promise<HandoffJob> {
    if (input.ackRef.trim().length === 0 || input.ackRef.length > 255) throw new Error('INVALID_ACK_REF');
    return withTransaction(this.db, async (tx) => {
      const job = await this.loadJob(tx, input.companyId, input.jobId);
      if (!job) throw new Error('JOB_NOT_FOUND');
      if (!job.delivery_enabled) throw new Error('CONTRACT_MISSING');
      if (job.state === 'indexed') return toJob(job);
      // An acknowledgement proves the handoff reached the archive, so the delivery
      // fact is recorded together with the index fact; neither is inferred from
      // "the object exists in S3".
      await tx.query(
        `UPDATE ${this.q('archive_handoff_jobs')}
            SET state='indexed', delivered_at=COALESCE(delivered_at, now())
          WHERE company_id=$1 AND id=$2 AND delivery_enabled`,
        [input.companyId, input.jobId],
      );
      await tx.query(
        `UPDATE ${this.q('attachments')} SET archive_status='indexed', index_ack_ref=$3
          WHERE company_id=$1 AND id=$2 AND storage_state='verified'`,
        [input.companyId, job.attachment_id, input.ackRef],
      );
      const updated = await this.loadJob(tx, input.companyId, input.jobId);
      if (!updated) throw new Error('JOB_MISSING_AFTER_UPDATE');
      return toJob(updated);
    });
  }

  /**
   * Parks a handoff whose index outcome is unknown. It is not `failed` (which would
   * invite a blind retry) and not `indexed` (which would claim an acknowledgement
   * that was never received).
   */
  async markIndexUnknown(input: { companyId: string; jobId: string; reason: string }): Promise<HandoffJob> {
    return withTransaction(this.db, async (tx) => {
      const job = await this.loadJob(tx, input.companyId, input.jobId);
      if (!job) throw new Error('JOB_NOT_FOUND');
      if (job.state === 'indexed') return toJob(job);
      await tx.query(
        `UPDATE ${this.q('archive_handoff_jobs')} SET state='unknown'
          WHERE company_id=$1 AND id=$2 AND state<>'indexed'`,
        [input.companyId, input.jobId],
      );
      await tx.query(
        `UPDATE ${this.q('attachments')} SET archive_status='unknown'
          WHERE company_id=$1 AND id=$2 AND archive_status<>'indexed'`,
        [input.companyId, job.attachment_id],
      );
      const updated = await this.loadJob(tx, input.companyId, input.jobId);
      if (!updated) throw new Error('JOB_MISSING_AFTER_UPDATE');
      return toJob(updated);
    });
  }

  /** A rejection by the archive is a definitive failure, not an unknown outcome. */
  private async markIndexFailed(companyId: string, jobId: string): Promise<void> {
    await withTransaction(this.db, async (tx) => {
      const job = await this.loadJob(tx, companyId, jobId);
      if (!job || job.state === 'indexed') return;
      await tx.query(
        `UPDATE ${this.q('archive_handoff_jobs')} SET state='failed'
          WHERE company_id=$1 AND id=$2 AND state<>'indexed'`,
        [companyId, jobId],
      );
      await tx.query(
        `UPDATE ${this.q('attachments')} SET archive_status='failed'
          WHERE company_id=$1 AND id=$2 AND archive_status<>'indexed'`,
        [companyId, job.attachment_id],
      );
    });
  }

  // --- attachment ↔ lead links ----------------------------------------------------

  /**
   * Links an attachment to a CRM lead. One attachment can belong to several active
   * deals, so this is a link table, not a single scalar on the attachment.
   */
  async linkAttachmentToLead(input: {
    companyId: string;
    attachmentId: string;
    accountId: string;
    leadId: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.q('attachment_lead_links')}
         (company_id,attachment_id,account_id,lead_id,link_state)
       VALUES ($1,$2,$3,$4,'active')
       ON CONFLICT (company_id,attachment_id,account_id,lead_id) DO UPDATE
         SET observed_at=now()`,
      [input.companyId, input.attachmentId, input.accountId, input.leadId],
    );
  }

  async listAttachmentLeads(companyId: string, attachmentId: string): Promise<AttachmentLeadLink[]> {
    const { rows } = await this.db.query<{
      lead_id: string;
      link_state: 'active' | 'deleted' | 'merged';
      merged_into_lead_id: string | null;
    }>(
      `SELECT lead_id, link_state, merged_into_lead_id FROM ${this.q('attachment_lead_links')}
        WHERE company_id=$1 AND attachment_id=$2 ORDER BY lead_id`,
      [companyId, attachmentId],
    );
    return rows.map((row) => ({
      leadId: row.lead_id,
      linkState: row.link_state,
      mergedIntoLeadId: row.merged_into_lead_id,
    }));
  }

  /**
   * CRM deletion changes the link state only. The attachment row, the stored object
   * and the archive index entry are provider/archive originals and are never
   * cascade-deleted from a CRM observation.
   */
  async observeLeadDeleted(input: { companyId: string; accountId: string; leadId: string }): Promise<void> {
    await this.db.query(
      `UPDATE ${this.q('attachment_lead_links')} SET link_state='deleted'
        WHERE company_id=$1 AND account_id=$2 AND lead_id=$3 AND link_state='active'`,
      [input.companyId, input.accountId, input.leadId],
    );
  }

  /** A merge keeps the origin link and records where it went. */
  async observeLeadMerged(input: {
    companyId: string;
    accountId: string;
    leadId: string;
    mergedIntoLeadId: string;
  }): Promise<void> {
    await this.db.query(
      `UPDATE ${this.q('attachment_lead_links')}
          SET link_state='merged', merged_into_lead_id=$4
        WHERE company_id=$1 AND account_id=$2 AND lead_id=$3 AND link_state='active'`,
      [input.companyId, input.accountId, input.leadId, input.mergedIntoLeadId],
    );
  }
}

export type { Db, Tx };
