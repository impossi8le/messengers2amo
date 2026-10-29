// Attention persistence: obligations, compose snapshots, reads and confirmed coverage.
// All decisions come from src/domain/attention.ts; this module only stores them.

import { randomUUID } from 'node:crypto';
import type { Db, Tx } from '../platform/db.ts';
import { withTransaction } from '../platform/db.ts';
import {
  inheritOpenedAt,
  isSubstantialEdit,
  planCoverage,
  type ObligationRef,
  type ObligationState,
} from '../domain/attention.ts';

export type AttentionRepoDeps = { schema: string };

export type Obligation = {
  id: string;
  workItemId: string;
  conversationId: string;
  messageId: string;
  contentVersion: number;
  attentionSeq: number;
  state: ObligationState;
  openedAt: string;
  createdAt: string;
  supersedesId: string | null;
};

export type OpenIncomingInput = { companyId: string; workItemId: string; messageId: string; contentVersion: number };

export type EditIncomingInput = {
  companyId: string;
  messageId: string;
  contentVersion: number;
  /** Optional override; when omitted the stored content versions are compared. */
  substantial?: boolean;
};

export type SnapshotResult = {
  snapshotId: string;
  workItemId: string;
  conversationId: string;
  /** Connection identity epoch the snapshot was sealed under. */
  bindingEpoch: number;
  actorId: string;
  assignmentVersion: number;
  items: ObligationRef[];
  sealedAt: string;
};

export type ConfirmCoverageResult = {
  operationId: string;
  covered: ObligationRef[];
  remaining: ObligationRef[];
};

export type RevokeCoverageResult = {
  revoked: ObligationRef[];
  reopened: string[];
  keptCovered: string[];
};

export class AttentionError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(statusCode: number, code: string) {
    super(code);
    this.name = 'AttentionError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

type ObligationRow = {
  id: string;
  work_item_id: string;
  conversation_id: string;
  message_id: string;
  content_version: string | number;
  attention_seq: string | number;
  state: ObligationState;
  opened_at: Date;
  created_at: Date;
  supersedes_id: string | null;
};

function toObligation(row: ObligationRow): Obligation {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    contentVersion: Number(row.content_version),
    attentionSeq: Number(row.attention_seq),
    state: row.state,
    openedAt: row.opened_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    supersedesId: row.supersedes_id,
  };
}

function q(sql: string, schema: string): string {
  return sql.replaceAll('__S__', `"${schema}"`);
}

const OBLIGATION_COLUMNS =
  'id, work_item_id, conversation_id, message_id, content_version, attention_seq, state, opened_at, created_at, supersedes_id';

async function selectObligation(
  tx: Tx,
  schema: string,
  where: string,
  params: unknown[],
  order = 'attention_seq DESC',
): Promise<Obligation | null> {
  const { rows } = await tx.query<ObligationRow>(
    q(`SELECT ${OBLIGATION_COLUMNS} FROM __S__.attention_obligations WHERE ${where} ORDER BY ${order} LIMIT 1`, schema),
    params,
  );
  const row = rows[0];
  return row ? toObligation(row) : null;
}

async function nextAttentionSeq(tx: Tx, schema: string, companyId: string, conversationId: string): Promise<number> {
  const { rows } = await tx.query<{ seq: string }>(
    q(
      `SELECT COALESCE(MAX(attention_seq), 0) + 1 AS seq FROM __S__.attention_obligations
        WHERE company_id = $1 AND conversation_id = $2`,
      schema,
    ),
    [companyId, conversationId],
  );
  return Number(rows[0]?.seq ?? 1);
}

/**
 * Opens the obligation for a new live inbound. Replaying the same message version
 * returns the existing obligation and creates nothing.
 */
export async function openIncomingInTransaction(
  tx: Tx,
  deps: AttentionRepoDeps,
  input: OpenIncomingInput,
): Promise<{ obligation: Obligation; created: boolean }> {
  const { rows: work } = await tx.query<{ conversation_id: string }>(
    q(`SELECT conversation_id FROM __S__.work_items WHERE company_id = $1 AND id = $2 FOR UPDATE`, deps.schema),
    [input.companyId, input.workItemId],
  );
  const workItem = work[0];
  if (!workItem) throw new AttentionError(404, 'WORK_ITEM_NOT_FOUND');

  const existing = await selectObligation(
    tx,
    deps.schema,
    `company_id = $1 AND work_item_id = $2 AND message_id = $3 AND content_version = $4`,
    [input.companyId, input.workItemId, input.messageId, input.contentVersion],
  );
  if (existing) return { obligation: existing, created: false };

  const seq = await nextAttentionSeq(tx, deps.schema, input.companyId, workItem.conversation_id);
  const { rows } = await tx.query<ObligationRow>(
    q(
      `INSERT INTO __S__.attention_obligations
         (company_id, id, work_item_id, conversation_id, message_id, content_version, attention_seq,
          state, opened_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'open', clock_timestamp(), clock_timestamp())
       RETURNING ${OBLIGATION_COLUMNS}`,
      deps.schema,
    ),
    [input.companyId, randomUUID(), input.workItemId, workItem.conversation_id, input.messageId, input.contentVersion, seq],
  );
  const created = rows[0];
  if (!created) throw new AttentionError(500, 'OBLIGATION_NOT_CREATED');
  return { obligation: toObligation(created), created: true };
}

export async function openIncoming(
  db: Db,
  deps: AttentionRepoDeps,
  input: OpenIncomingInput,
): Promise<{ obligation: Obligation; created: boolean }> {
  return withTransaction(db, (tx) => openIncomingInTransaction(tx, deps, input));
}

/**
 * Applies a content version change. A substantial edit of an open obligation inherits
 * opened_at and supersedes the old row; an edit of an answered obligation starts a new
 * waiting cycle. A technical (non-substantial) edit changes nothing.
 */
export async function editIncoming(
  db: Db,
  deps: AttentionRepoDeps,
  input: EditIncomingInput,
): Promise<{ obligation: Obligation; superseded: Obligation | null }> {
  return withTransaction(db, async (tx) => {
    const { rows: messageRows } = await tx.query<{ conversation_id: string }>(
      q(`SELECT conversation_id FROM __S__.messages WHERE company_id = $1 AND id = $2`, deps.schema),
      [input.companyId, input.messageId],
    );
    const message = messageRows[0];
    if (!message) throw new AttentionError(404, 'MESSAGE_NOT_FOUND');

    const { rows: workRows } = await tx.query<{ id: string }>(
      q(
        `SELECT id FROM __S__.work_items
          WHERE company_id = $1 AND conversation_id = $2 AND state NOT IN ('resolved','cancelled')
          FOR UPDATE`,
        deps.schema,
      ),
      [input.companyId, message.conversation_id],
    );
    const workItem = workRows[0];
    if (!workItem) throw new AttentionError(404, 'WORK_ITEM_NOT_FOUND');

    const replay = await selectObligation(
      tx,
      deps.schema,
      `company_id = $1 AND work_item_id = $2 AND message_id = $3 AND content_version = $4`,
      [input.companyId, workItem.id, input.messageId, input.contentVersion],
    );
    if (replay) return { obligation: replay, superseded: null };

    const previous = await selectObligation(
      tx,
      deps.schema,
      `company_id = $1 AND work_item_id = $2 AND message_id = $3`,
      [input.companyId, workItem.id, input.messageId],
    );
    if (!previous) throw new AttentionError(404, 'OBLIGATION_NOT_FOUND');

    let substantial = input.substantial;
    if (substantial === undefined) {
      const { rows: versions } = await tx.query<{ content_version: string; content: unknown }>(
        q(
          `SELECT content_version, content FROM __S__.message_versions
            WHERE company_id = $1 AND message_id = $2 ORDER BY content_version DESC LIMIT 2`,
          deps.schema,
        ),
        [input.companyId, input.messageId],
      );
      const next = versions.find((row) => Number(row.content_version) === input.contentVersion);
      const prior = versions.find((row) => Number(row.content_version) < input.contentVersion);
      substantial = next && prior ? isSubstantialEdit(prior.content, next.content) : true;
    }

    if (!substantial) return { obligation: previous, superseded: null };

    const seq = await nextAttentionSeq(tx, deps.schema, input.companyId, message.conversation_id);
    const openedAt = inheritOpenedAt(previous, new Date());
    const { rows } = await tx.query<ObligationRow>(
      q(
        `INSERT INTO __S__.attention_obligations
           (company_id, id, work_item_id, conversation_id, message_id, content_version, attention_seq,
            state, opened_at, created_at, supersedes_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8, clock_timestamp(), $9)
         RETURNING ${OBLIGATION_COLUMNS}`,
        deps.schema,
      ),
      [
        input.companyId,
        randomUUID(),
        workItem.id,
        message.conversation_id,
        input.messageId,
        input.contentVersion,
        seq,
        openedAt,
        previous.id,
      ],
    );
    const created = rows[0];
    if (!created) throw new AttentionError(500, 'OBLIGATION_NOT_CREATED');

    // The superseded version is no longer outstanding; the new version carries the wait.
    if (previous.state === 'open') {
      await tx.query(
        q(`UPDATE __S__.attention_obligations SET state = 'covered' WHERE company_id = $1 AND id = $2`, deps.schema),
        [input.companyId, previous.id],
      );
    }
    return { obligation: toObligation(created), superseded: { ...previous, state: 'covered' } };
  });
}

/**
 * Freezes the exact set of open obligations at the start of composing a reply. The
 * header is sealed in the same transaction, so no late membership can be added.
 */
export async function captureSnapshot(
  db: Db,
  deps: AttentionRepoDeps,
  input: { companyId: string; workItemId: string; actorId: string },
): Promise<SnapshotResult> {
  return withTransaction(db, async (tx) => {
    const { rows: workRows } = await tx.query<{ conversation_id: string; assignment_version: string }>(
      q(
        `SELECT conversation_id, assignment_version FROM __S__.work_items
          WHERE company_id = $1 AND id = $2 FOR UPDATE`,
        deps.schema,
      ),
      [input.companyId, input.workItemId],
    );
    const workItem = workRows[0];
    if (!workItem) throw new AttentionError(404, 'WORK_ITEM_NOT_FOUND');

    const { rows: conversationRows } = await tx.query<{ binding_epoch: string }>(
      q(`SELECT binding_epoch FROM __S__.conversations WHERE company_id = $1 AND id = $2`, deps.schema),
      [input.companyId, workItem.conversation_id],
    );
    const conversation = conversationRows[0];
    if (!conversation) throw new AttentionError(404, 'CONVERSATION_NOT_FOUND');

    const { rows: openRows } = await tx.query<ObligationRow>(
      q(
        `SELECT ${OBLIGATION_COLUMNS} FROM __S__.attention_obligations
          WHERE company_id = $1 AND work_item_id = $2 AND state = 'open' ORDER BY attention_seq`,
        deps.schema,
      ),
      [input.companyId, input.workItemId],
    );

    const snapshotId = randomUUID();
    await tx.query(
      q(
        `INSERT INTO __S__.reply_snapshots
           (company_id, id, work_item_id, conversation_id, binding_epoch, assignment_version, actor_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        deps.schema,
      ),
      [
        input.companyId,
        snapshotId,
        input.workItemId,
        workItem.conversation_id,
        conversation.binding_epoch,
        workItem.assignment_version,
        input.actorId,
      ],
    );

    const items: ObligationRef[] = [];
    for (const row of openRows) {
      await tx.query(
        q(
          `INSERT INTO __S__.reply_snapshot_items
             (company_id, snapshot_id, work_item_id, conversation_id, obligation_id, content_version)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          deps.schema,
        ),
        [input.companyId, snapshotId, input.workItemId, workItem.conversation_id, row.id, row.content_version],
      );
      items.push({ obligationId: row.id, contentVersion: Number(row.content_version) });
    }

    const { rows: sealedRows } = await tx.query<{ sealed_at: Date }>(
      q(
        `UPDATE __S__.reply_snapshots SET sealed_at = clock_timestamp()
          WHERE company_id = $1 AND id = $2 RETURNING sealed_at`,
        deps.schema,
      ),
      [input.companyId, snapshotId],
    );
    const sealedAt = sealedRows[0]?.sealed_at ?? new Date();

    return {
      snapshotId,
      workItemId: input.workItemId,
      conversationId: workItem.conversation_id,
      bindingEpoch: Number(conversation.binding_epoch),
      actorId: input.actorId,
      assignmentVersion: Number(workItem.assignment_version),
      items,
      sealedAt: sealedAt.toISOString(),
    };
  });
}

/** Records a read marker. It never touches obligations or waiting_since. */
export async function markConversationRead(
  db: Db,
  deps: AttentionRepoDeps,
  input: { companyId: string; conversationId: string; staffId: string; attentionSeq: number },
): Promise<{ lastReadSeq: number }> {
  const { rows } = await db.query<{ last_read_seq: string }>(
    q(
      `INSERT INTO __S__.staff_read_marks
         (company_id, conversation_id, staff_id, last_read_seq, read_at)
       VALUES ($1,$2,$3,$4, clock_timestamp())
       ON CONFLICT (company_id, conversation_id, staff_id) DO UPDATE
         SET last_read_seq = GREATEST(__S__.staff_read_marks.last_read_seq, EXCLUDED.last_read_seq),
             read_at = clock_timestamp()
       RETURNING last_read_seq`,
      deps.schema,
    ),
    [input.companyId, input.conversationId, input.staffId, input.attentionSeq],
  );
  return { lastReadSeq: Number(rows[0]?.last_read_seq ?? 0) };
}

async function openObligations(
  tx: Tx,
  schema: string,
  companyId: string,
  workItemId: string,
): Promise<ObligationRef[]> {
  const { rows } = await tx.query<{ id: string; content_version: string }>(
    q(
      `SELECT id, content_version FROM __S__.attention_obligations
        WHERE company_id = $1 AND work_item_id = $2 AND state = 'open' ORDER BY attention_seq`,
      schema,
    ),
    [companyId, workItemId],
  );
  return rows.map((row) => ({ obligationId: row.id, contentVersion: Number(row.content_version) }));
}

/**
 * Closes the snapshot items that are still open at the snapshotted version. Only a
 * confirmed `sent` operation may call this. Repeating the call is idempotent.
 */
export async function confirmSendCoverage(
  db: Db,
  deps: AttentionRepoDeps,
  input: { companyId: string; operationId: string },
): Promise<ConfirmCoverageResult> {
  return withTransaction(db, async (tx) => {
    const { rows: operationRows } = await tx.query<{
      id: string;
      work_item_id: string;
      conversation_id: string;
      snapshot_id: string | null;
      state: string;
      coverage: string;
    }>(
      q(
        `SELECT id, work_item_id, conversation_id, snapshot_id, state, coverage
           FROM __S__.send_operations WHERE company_id = $1 AND id = $2 FOR UPDATE`,
        deps.schema,
      ),
      [input.companyId, input.operationId],
    );
    const operation = operationRows[0];
    if (!operation) throw new AttentionError(404, 'OPERATION_NOT_FOUND');
    if (operation.state !== 'sent') throw new AttentionError(409, 'OPERATION_NOT_CONFIRMED');
    if (!operation.snapshot_id) throw new AttentionError(409, 'SNAPSHOT_REQUIRED');

    if (operation.coverage !== 'confirmed') {
      const { rows: snapshotItems } = await tx.query<{ obligation_id: string; content_version: string }>(
        q(
          `SELECT obligation_id, content_version FROM __S__.reply_snapshot_items
            WHERE company_id = $1 AND snapshot_id = $2 ORDER BY obligation_id`,
          deps.schema,
        ),
        [input.companyId, operation.snapshot_id],
      );
      // All versions, with a supersession flag: a late answer may still confirm the
      // version it snapshotted, but never a version replaced by a substantial edit.
      const { rows: obligationRows } = await tx.query<ObligationRow & { superseded: boolean }>(
        q(
          `SELECT o.id, o.work_item_id, o.conversation_id, o.message_id, o.content_version, o.attention_seq,
                  o.state, o.opened_at, o.created_at, o.supersedes_id,
                  EXISTS (SELECT 1 FROM __S__.attention_obligations n
                           WHERE n.company_id = o.company_id AND n.supersedes_id = o.id) AS superseded
             FROM __S__.attention_obligations o
            WHERE o.company_id = $1 AND o.work_item_id = $2
            ORDER BY o.attention_seq`,
          deps.schema,
        ),
        [input.companyId, operation.work_item_id],
      );
      const planned = planCoverage(
        snapshotItems.map((row) => ({
          obligationId: row.obligation_id,
          contentVersion: Number(row.content_version),
        })),
        obligationRows.map((row) => {
          const obligation = toObligation(row);
          return { ...obligation, obligationId: obligation.id, superseded: row.superseded };
        }),
      );

      for (const item of planned) {
        await tx.query(
          q(
            `INSERT INTO __S__.send_coverage
               (company_id, operation_id, work_item_id, conversation_id, operation_state,
                obligation_id, content_version)
             VALUES ($1,$2,$3,$4,'sent',$5,$6)
             ON CONFLICT DO NOTHING`,
            deps.schema,
          ),
          [
            input.companyId,
            input.operationId,
            operation.work_item_id,
            operation.conversation_id,
            item.obligationId,
            item.contentVersion,
          ],
        );
        await tx.query(
          q(
            `UPDATE __S__.attention_obligations SET state = 'covered'
              WHERE company_id = $1 AND id = $2 AND state = 'open' AND content_version = $3`,
            deps.schema,
          ),
          [input.companyId, item.obligationId, item.contentVersion],
        );
      }

      await tx.query(
        q(
          `UPDATE __S__.send_operations
              SET coverage = 'confirmed', version = version + 1
            WHERE company_id = $1 AND id = $2`,
          deps.schema,
        ),
        [input.companyId, input.operationId],
      );
    }

    const { rows: coverageRows } = await tx.query<{ obligation_id: string; content_version: string }>(
      q(
        `SELECT obligation_id, content_version FROM __S__.send_coverage
          WHERE company_id = $1 AND operation_id = $2 ORDER BY obligation_id, content_version`,
        deps.schema,
      ),
      [input.companyId, input.operationId],
    );

    return {
      operationId: input.operationId,
      covered: coverageRows.map((row) => ({
        obligationId: row.obligation_id,
        contentVersion: Number(row.content_version),
      })),
      remaining: await openObligations(tx, deps.schema, input.companyId, operation.work_item_id),
    };
  });
}

/** Stores a failed/unknown dispatch outcome. Obligations stay open. */
export async function recordSendOutcome(
  db: Db,
  deps: AttentionRepoDeps,
  input: { companyId: string; operationId: string; outcome: 'failed' | 'unknown' },
): Promise<{ operationId: string; state: string }> {
  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query<{ state: string }>(
      q(
        `UPDATE __S__.send_operations
            SET state = $3, version = version + 1
          WHERE company_id = $1 AND id = $2 AND state NOT IN ('sent','failed','unknown','cancelled')
          RETURNING state`,
        deps.schema,
      ),
      [input.companyId, input.operationId, input.outcome],
    );
    const updated = rows[0];
    if (updated) return { operationId: input.operationId, state: updated.state };

    const { rows: current } = await tx.query<{ state: string }>(
      q(`SELECT state FROM __S__.send_operations WHERE company_id = $1 AND id = $2`, deps.schema),
      [input.companyId, input.operationId],
    );
    const existing = current[0];
    if (!existing) throw new AttentionError(404, 'OPERATION_NOT_FOUND');
    // A recorded failure/unknown is stable; a confirmed send is never silently downgraded.
    if (existing.state === input.outcome) return { operationId: input.operationId, state: existing.state };
    throw new AttentionError(409, 'OUTCOME_CONFLICT');
  });
}

/**
 * Withdraws a provisional `sent`: deletes its coverage and reopens obligations that no
 * other answer still covers. A delivered/read receipt is proof and blocks withdrawal.
 */
export async function revokeProvisionalSent(
  db: Db,
  deps: AttentionRepoDeps,
  input: { companyId: string; operationId: string },
): Promise<RevokeCoverageResult> {
  return withTransaction(db, async (tx) => {
    const { rows: operationRows } = await tx.query<{
      state: string;
      work_item_id: string;
      conversation_id: string;
    }>(
      q(
        `SELECT state, work_item_id, conversation_id FROM __S__.send_operations
          WHERE company_id = $1 AND id = $2 FOR UPDATE`,
        deps.schema,
      ),
      [input.companyId, input.operationId],
    );
    const operation = operationRows[0];
    if (!operation) throw new AttentionError(404, 'OPERATION_NOT_FOUND');
    if (operation.state !== 'sent') throw new AttentionError(409, 'OPERATION_NOT_CONFIRMED');

    const { rows: proof } = await tx.query<{ kind: string }>(
      q(
        `SELECT e.kind FROM __S__.provider_receipt_links l
           JOIN __S__.provider_receipt_evidence e
             ON e.company_id = l.company_id AND e.id = l.evidence_id
          WHERE l.company_id = $1 AND l.operation_id = $2
            AND (e.kind = 'message.read_observed'
                 OR (e.kind = 'message.delivery_observed' AND e.status = 'delivered'))
          LIMIT 1`,
        deps.schema,
      ),
      [input.companyId, input.operationId],
    );
    if (proof[0]) throw new AttentionError(409, 'COVERAGE_CONFIRMED_BY_RECEIPT');

    const { rows: claimed } = await tx.query<{ obligation_id: string }>(
      q(
        `SELECT obligation_id FROM __S__.send_coverage
          WHERE company_id = $1 AND operation_id = $2 ORDER BY obligation_id`,
        deps.schema,
      ),
      [input.companyId, input.operationId],
    );

    // The "is anything else still covering it?" decision is taken under a lock on the
    // obligation itself, so two concurrent withdrawals cannot each see the other's
    // coverage and both leave the obligation closed. The lock is taken before this
    // operation's own coverage is deleted; ordering by id keeps the lock order
    // identical in every transaction.
    if (claimed.length > 0) {
      const obligationIds = [...new Set(claimed.map((row) => row.obligation_id))].sort();
      await tx.query(
        q(
          `SELECT id FROM __S__.attention_obligations
            WHERE company_id = $1 AND id = ANY($2::text[])
            ORDER BY id FOR UPDATE`,
          deps.schema,
        ),
        [input.companyId, obligationIds],
      );
    }

    const { rows: coverageRows } = await tx.query<{ obligation_id: string; content_version: string }>(
      q(
        `DELETE FROM __S__.send_coverage
          WHERE company_id = $1 AND operation_id = $2
          RETURNING obligation_id, content_version`,
        deps.schema,
      ),
      [input.companyId, input.operationId],
    );

    await tx.query(
      q(
        `UPDATE __S__.send_operations
            SET state = 'failed', coverage = 'unconfirmed', version = version + 1
          WHERE company_id = $1 AND id = $2`,
        deps.schema,
      ),
      [input.companyId, input.operationId],
    );

    const reopened: string[] = [];
    const keptCovered: string[] = [];
    for (const row of coverageRows) {
      // A locking read, so a REPEATABLE READ transaction cannot decide from a snapshot
      // taken before a concurrent withdrawal committed.
      const { rows: other } = await tx.query<{ c: number }>(
        q(
          `SELECT 1 AS c FROM __S__.send_coverage
            WHERE company_id = $1 AND obligation_id = $2 AND content_version = $3
            LIMIT 1 FOR SHARE`,
          deps.schema,
        ),
        [input.companyId, row.obligation_id, row.content_version],
      );
      if ((other[0]?.c ?? 0) > 0) {
        keptCovered.push(row.obligation_id);
        continue;
      }
      // A version replaced by a substantial edit is no longer outstanding: reopening
      // it would resurrect a question the customer has already rewritten.
      const { rows: reopenedRows } = await tx.query<{ id: string }>(
        q(
          `UPDATE __S__.attention_obligations o SET state = 'open'
            WHERE o.company_id = $1 AND o.id = $2 AND o.state = 'covered'
              AND NOT EXISTS (
                SELECT 1 FROM __S__.attention_obligations n
                 WHERE n.company_id = o.company_id AND n.supersedes_id = o.id
              )
            RETURNING o.id`,
          deps.schema,
        ),
        [input.companyId, row.obligation_id],
      );
      if (reopenedRows[0]) reopened.push(reopenedRows[0].id);
      else keptCovered.push(row.obligation_id);
    }

    return {
      revoked: coverageRows.map((row) => ({
        obligationId: row.obligation_id,
        contentVersion: Number(row.content_version),
      })),
      reopened,
      keptCovered,
    };
  });
}

export async function listObligations(
  db: Db,
  deps: AttentionRepoDeps,
  input: { companyId: string; workItemId: string },
): Promise<Obligation[]> {
  const { rows } = await db.query<ObligationRow>(
    q(
      `SELECT ${OBLIGATION_COLUMNS} FROM __S__.attention_obligations
        WHERE company_id = $1 AND work_item_id = $2 ORDER BY attention_seq`,
      deps.schema,
    ),
    [input.companyId, input.workItemId],
  );
  return rows.map(toObligation);
}
