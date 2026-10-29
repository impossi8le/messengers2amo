import type { Tx } from './db.ts';
import { randomId } from './auth.ts';

export type AuditRecord = {
  companyId: string;
  eventName: string;
  subjectId: string;
  actorId: string | null;
  traceId?: string | null;
  diagnosticCode?: string | null;
};

/**
 * Appends one audit row on the caller's transaction. Callers must perform this inside
 * the same transaction as the mutation: if the audit insert fails, the change rolls back.
 * Only identifiers and safe codes belong here — never credentials, tokens or message text.
 */
export async function writeAudit(tx: Tx, record: AuditRecord): Promise<void> {
  await tx.query(
    `INSERT INTO audit_events (company_id, id, event_name, subject_id, actor_id, trace_id, diagnostic_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      record.companyId,
      randomId('aud'),
      record.eventName,
      record.subjectId,
      record.actorId,
      record.traceId ?? null,
      record.diagnosticCode ?? null,
    ],
  );
}
