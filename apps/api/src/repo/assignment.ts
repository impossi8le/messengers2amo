// Assignment CAS, capacity fence and CRM owner isolation.
// Every mutation runs in one transaction: row locks + version compare + counter update.

import { createHash, randomUUID } from 'node:crypto';
import type { Db, Tx } from '../platform/db.ts';
import { withTransaction } from '../platform/db.ts';

export type AssignmentRepoDeps = { schema: string };

export type WorkItemAssignment = {
  workItemId: string;
  conversationId: string;
  state: string;
  ownerId: string | null;
  departmentId: string | null;
  assignmentVersion: number;
};

export type ClaimInput = {
  companyId: string;
  workItemId: string;
  staffId: string;
  expectedVersion: number;
  requestKey: string;
};

export type ClaimResult = {
  workItem: WorkItemAssignment;
  replayed: boolean;
  activeCount: number;
};

export class AssignmentError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly current: WorkItemAssignment | null;

  constructor(statusCode: number, code: string, current: WorkItemAssignment | null = null) {
    super(code);
    this.name = 'AssignmentError';
    this.statusCode = statusCode;
    this.code = code;
    this.current = current;
  }
}

type WorkItemRow = {
  id: string;
  conversation_id: string;
  state: string;
  owner_id: string | null;
  department_id: string | null;
  assignment_version: string | number;
};

function q(sql: string, schema: string): string {
  return sql.replaceAll('__S__', `"${schema}"`);
}

function toWorkItem(row: WorkItemRow): WorkItemAssignment {
  return {
    workItemId: row.id,
    conversationId: row.conversation_id,
    state: row.state,
    ownerId: row.owner_id,
    departmentId: row.department_id,
    assignmentVersion: Number(row.assignment_version),
  };
}

function fingerprint(payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function isSerializationFailure(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === '40001' || code === '40P01';
}

async function readWorkItemTx(tx: Tx, schema: string, companyId: string, workItemId: string): Promise<WorkItemAssignment | null> {
  const { rows } = await tx.query<WorkItemRow>(
    q(
      `SELECT id, conversation_id, state, owner_id, department_id, assignment_version
         FROM __S__.work_items WHERE company_id = $1 AND id = $2`,
      schema,
    ),
    [companyId, workItemId],
  );
  const row = rows[0];
  return row ? toWorkItem(row) : null;
}

/**
 * Command ledger. The insert holds the idempotency key for the whole transaction; a
 * concurrent duplicate waits for this transaction to commit or roll back. A replay
 * with a different payload is a conflict, not a silent second effect.
 */
async function beginCommand(
  tx: Tx,
  schema: string,
  input: {
    companyId: string;
    commandType: string;
    requestKey: string;
    workItemId: string;
    fingerprint: string;
  },
): Promise<{ replayed: false } | { replayed: true; result: ClaimResult }> {
  const { rows: inserted } = await tx.query<{ request_key: string }>(
    q(
      `INSERT INTO __S__.work_item_commands
         (company_id, command_type, request_key, work_item_id, payload_fingerprint, result)
       VALUES ($1,$2,$3,$4,$5,'{}'::jsonb)
       ON CONFLICT (company_id, command_type, request_key) DO NOTHING
       RETURNING request_key`,
      schema,
    ),
    [input.companyId, input.commandType, input.requestKey, input.workItemId, input.fingerprint],
  );
  if (inserted[0]) return { replayed: false };

  const { rows: existing } = await tx.query<{ payload_fingerprint: string; result: ClaimResult }>(
    q(
      `SELECT payload_fingerprint, result FROM __S__.work_item_commands
        WHERE company_id = $1 AND command_type = $2 AND request_key = $3`,
      schema,
    ),
    [input.companyId, input.commandType, input.requestKey],
  );
  const stored = existing[0];
  if (!stored) throw new AssignmentError(409, 'IDEMPOTENCY_CONFLICT');
  if (stored.payload_fingerprint !== input.fingerprint) throw new AssignmentError(409, 'IDEMPOTENCY_CONFLICT');
  return { replayed: true, result: { ...stored.result, replayed: true } };
}

async function finishCommand(
  tx: Tx,
  schema: string,
  input: { companyId: string; commandType: string; requestKey: string; result: ClaimResult },
): Promise<void> {
  await tx.query(
    q(
      `UPDATE __S__.work_item_commands SET result = $4::jsonb
        WHERE company_id = $1 AND command_type = $2 AND request_key = $3`,
      schema,
    ),
    [input.companyId, input.commandType, input.requestKey, JSON.stringify({ ...input.result, replayed: false })],
  );
}

async function lockStaff(
  tx: Tx,
  schema: string,
  companyId: string,
  staffId: string,
): Promise<{ activeCount: number; capacity: number }> {
  const { rows } = await tx.query<{ active_count: number; capacity: number }>(
    q(
      `SELECT active_count, capacity FROM __S__.staff
        WHERE company_id = $1 AND id = $2 FOR UPDATE`,
      schema,
    ),
    [companyId, staffId],
  );
  const row = rows[0];
  if (!row) throw new AssignmentError(404, 'STAFF_NOT_FOUND');
  return { activeCount: row.active_count, capacity: row.capacity };
}

async function adjustActiveCount(tx: Tx, schema: string, companyId: string, staffId: string, delta: number): Promise<number> {
  const { rows } = await tx.query<{ active_count: number }>(
    q(
      `UPDATE __S__.staff
          SET active_count = active_count + $3, version = version + 1
        WHERE company_id = $1 AND id = $2
        RETURNING active_count`,
      schema,
    ),
    [companyId, staffId, delta],
  );
  const row = rows[0];
  if (!row) throw new AssignmentError(404, 'STAFF_NOT_FOUND');
  return row.active_count;
}

async function recordHistory(
  tx: Tx,
  schema: string,
  input: {
    companyId: string;
    workItemId: string;
    previousOwnerId: string | null;
    ownerId: string | null;
    assignmentVersion: number;
    reason: string;
    actorId: string;
  },
): Promise<void> {
  await tx.query(
    q(
      `INSERT INTO __S__.assignment_history
         (company_id, id, work_item_id, previous_owner_id, owner_id, assignment_version, reason, actor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      schema,
    ),
    [
      input.companyId,
      randomUUID(),
      input.workItemId,
      input.previousOwnerId,
      input.ownerId,
      input.assignmentVersion,
      input.reason,
      input.actorId,
    ],
  );
}

/** Locks staff rows in a stable order so concurrent transfers cannot deadlock. */
async function lockStaffPair(
  tx: Tx,
  schema: string,
  companyId: string,
  first: string | null,
  second: string | null,
): Promise<Map<string, { activeCount: number; capacity: number }>> {
  const ids = [...new Set([first, second].filter((id): id is string => id !== null))].sort();
  const locked = new Map<string, { activeCount: number; capacity: number }>();
  for (const id of ids) locked.set(id, await lockStaff(tx, schema, companyId, id));
  return locked;
}

/**
 * Compare-and-swap claim. Locks the staff row first (capacity fence), then updates the
 * work item only when the expected version still matches and no owner exists.
 */
async function claimInTx(
  tx: Tx,
  deps: AssignmentRepoDeps,
  input: ClaimInput,
): Promise<ClaimResult> {
  const schema = deps.schema;
  const fp = fingerprint({
    command: 'claim',
    workItemId: input.workItemId,
    staffId: input.staffId,
    expectedVersion: input.expectedVersion,
  });
  const replay = await beginCommand(tx, schema, {
    companyId: input.companyId,
    commandType: 'claim',
    requestKey: input.requestKey,
    workItemId: input.workItemId,
    fingerprint: fp,
  });
  if (replay.replayed) return replay.result;

  const staff = await lockStaff(tx, schema, input.companyId, input.staffId);
  if (staff.activeCount >= staff.capacity) throw new AssignmentError(409, 'CAPACITY_EXCEEDED');

  const { rows } = await tx.query<WorkItemRow>(
    q(
      `UPDATE __S__.work_items
          SET owner_id = $3, state = 'assigned', assignment_version = assignment_version + 1
        WHERE company_id = $1 AND id = $2
          AND assignment_version = $4 AND owner_id IS NULL
          AND state NOT IN ('resolved','cancelled')
        RETURNING id, conversation_id, state, owner_id, department_id, assignment_version`,
      schema,
    ),
    [input.companyId, input.workItemId, input.staffId, input.expectedVersion],
  );
  const updated = rows[0];
  if (!updated) {
    const current = await readWorkItemTx(tx, schema, input.companyId, input.workItemId);
    if (!current) throw new AssignmentError(404, 'WORK_ITEM_NOT_FOUND');
    throw new AssignmentError(409, 'VERSION_CONFLICT', current);
  }

  const activeCount = await adjustActiveCount(tx, schema, input.companyId, input.staffId, 1);
  const workItem = toWorkItem(updated);
  await recordHistory(tx, schema, {
    companyId: input.companyId,
    workItemId: input.workItemId,
    previousOwnerId: null,
    ownerId: input.staffId,
    assignmentVersion: workItem.assignmentVersion,
    reason: 'claim',
    actorId: input.staffId,
  });

  const result: ClaimResult = { workItem, replayed: false, activeCount };
  await finishCommand(tx, schema, {
    companyId: input.companyId,
    commandType: 'claim',
    requestKey: input.requestKey,
    result,
  });
  return result;
}

export async function claimWorkItem(db: Db, deps: AssignmentRepoDeps, input: ClaimInput): Promise<ClaimResult> {
  try {
    return await withTransaction(db, (tx) => claimInTx(tx, deps, input));
  } catch (error) {
    if (isSerializationFailure(error)) throw new AssignmentError(409, 'SERIALIZATION_FAILURE');
    throw error;
  }
}

/** Same command inside a caller-owned transaction (used for explicit isolation tests). */
export async function claimWorkItemInTransaction(
  tx: Tx,
  deps: AssignmentRepoDeps,
  input: ClaimInput,
): Promise<ClaimResult> {
  try {
    return await claimInTx(tx, deps, input);
  } catch (error) {
    if (isSerializationFailure(error)) throw new AssignmentError(409, 'SERIALIZATION_FAILURE');
    throw error;
  }
}

export type TransferInput = {
  companyId: string;
  workItemId: string;
  actorId: string;
  toStaffId: string | null;
  toDepartmentId: string | null;
  expectedVersion: number;
  requestKey: string;
};

export type ResolveInput = {
  companyId: string;
  workItemId: string;
  actorId: string;
  expectedVersion: number;
  requestKey: string;
};

async function transferInTx(tx: Tx, deps: AssignmentRepoDeps, input: TransferInput): Promise<ClaimResult> {
  const schema = deps.schema;
  const fp = fingerprint({
    command: 'transfer',
    workItemId: input.workItemId,
    actorId: input.actorId,
    toStaffId: input.toStaffId,
    toDepartmentId: input.toDepartmentId,
    expectedVersion: input.expectedVersion,
  });
  const replay = await beginCommand(tx, schema, {
    companyId: input.companyId,
    commandType: 'transfer',
    requestKey: input.requestKey,
    workItemId: input.workItemId,
    fingerprint: fp,
  });
  if (replay.replayed) return replay.result;

  const current = await readWorkItemTx(tx, schema, input.companyId, input.workItemId);
  if (!current) throw new AssignmentError(404, 'WORK_ITEM_NOT_FOUND');
  if (current.state === 'resolved' || current.state === 'cancelled') {
    throw new AssignmentError(409, 'WORK_ITEM_CLOSED', current);
  }

  const locked = await lockStaffPair(tx, schema, input.companyId, current.ownerId, input.toStaffId);
  if (input.toStaffId && input.toStaffId !== current.ownerId) {
    const target = locked.get(input.toStaffId);
    if (!target) throw new AssignmentError(404, 'STAFF_NOT_FOUND');
    if (target.activeCount >= target.capacity) throw new AssignmentError(409, 'CAPACITY_EXCEEDED', current);
  }

  const { rows } = await tx.query<WorkItemRow>(
    q(
      `UPDATE __S__.work_items
          SET owner_id = $3, department_id = COALESCE($4, department_id),
              state = CASE WHEN $3::text IS NULL THEN 'queued' ELSE 'assigned' END,
              assignment_version = assignment_version + 1
        WHERE company_id = $1 AND id = $2 AND assignment_version = $5
          AND state NOT IN ('resolved','cancelled')
        RETURNING id, conversation_id, state, owner_id, department_id, assignment_version`,
      schema,
    ),
    [input.companyId, input.workItemId, input.toStaffId, input.toDepartmentId, input.expectedVersion],
  );
  const updated = rows[0];
  if (!updated) {
    const latest = await readWorkItemTx(tx, schema, input.companyId, input.workItemId);
    throw new AssignmentError(409, 'VERSION_CONFLICT', latest);
  }

  if (current.ownerId && current.ownerId !== input.toStaffId) {
    await adjustActiveCount(tx, schema, input.companyId, current.ownerId, -1);
  }
  let activeCount = 0;
  if (input.toStaffId && input.toStaffId !== current.ownerId) {
    activeCount = await adjustActiveCount(tx, schema, input.companyId, input.toStaffId, 1);
  } else if (input.toStaffId) {
    activeCount = locked.get(input.toStaffId)?.activeCount ?? 0;
  }

  const workItem = toWorkItem(updated);
  await recordHistory(tx, schema, {
    companyId: input.companyId,
    workItemId: input.workItemId,
    previousOwnerId: current.ownerId,
    ownerId: input.toStaffId,
    assignmentVersion: workItem.assignmentVersion,
    reason: 'transfer',
    actorId: input.actorId,
  });

  const result: ClaimResult = { workItem, replayed: false, activeCount };
  await finishCommand(tx, schema, {
    companyId: input.companyId,
    commandType: 'transfer',
    requestKey: input.requestKey,
    result,
  });
  return result;
}

async function resolveInTx(tx: Tx, deps: AssignmentRepoDeps, input: ResolveInput): Promise<ClaimResult> {
  const schema = deps.schema;
  const fp = fingerprint({
    command: 'resolve',
    workItemId: input.workItemId,
    actorId: input.actorId,
    expectedVersion: input.expectedVersion,
  });
  const replay = await beginCommand(tx, schema, {
    companyId: input.companyId,
    commandType: 'resolve',
    requestKey: input.requestKey,
    workItemId: input.workItemId,
    fingerprint: fp,
  });
  if (replay.replayed) return replay.result;

  const current = await readWorkItemTx(tx, schema, input.companyId, input.workItemId);
  if (!current) throw new AssignmentError(404, 'WORK_ITEM_NOT_FOUND');
  if (current.ownerId) await lockStaff(tx, schema, input.companyId, current.ownerId);

  const { rows } = await tx.query<WorkItemRow>(
    q(
      `UPDATE __S__.work_items
          SET state = 'resolved', owner_id = NULL, assignment_version = assignment_version + 1
        WHERE company_id = $1 AND id = $2 AND assignment_version = $3
          AND state NOT IN ('resolved','cancelled')
        RETURNING id, conversation_id, state, owner_id, department_id, assignment_version`,
      schema,
    ),
    [input.companyId, input.workItemId, input.expectedVersion],
  );
  const updated = rows[0];
  if (!updated) {
    const latest = await readWorkItemTx(tx, schema, input.companyId, input.workItemId);
    throw new AssignmentError(409, 'VERSION_CONFLICT', latest);
  }

  if (current.ownerId) await adjustActiveCount(tx, schema, input.companyId, current.ownerId, -1);

  const workItem = toWorkItem(updated);
  await recordHistory(tx, schema, {
    companyId: input.companyId,
    workItemId: input.workItemId,
    previousOwnerId: current.ownerId,
    ownerId: null,
    assignmentVersion: workItem.assignmentVersion,
    reason: 'resolve',
    actorId: input.actorId,
  });

  const result: ClaimResult = { workItem, replayed: false, activeCount: 0 };
  await finishCommand(tx, schema, {
    companyId: input.companyId,
    commandType: 'resolve',
    requestKey: input.requestKey,
    result,
  });
  return result;
}

export async function transferWorkItem(
  db: Db,
  deps: AssignmentRepoDeps,
  input: TransferInput,
): Promise<ClaimResult> {
  try {
    return await withTransaction(db, (tx) => transferInTx(tx, deps, input));
  } catch (error) {
    if (isSerializationFailure(error)) throw new AssignmentError(409, 'SERIALIZATION_FAILURE');
    throw error;
  }
}

/** Transfer inside a caller-owned transaction, so an audit row can join it. */
export async function transferWorkItemInTransaction(
  tx: Tx,
  deps: AssignmentRepoDeps,
  input: TransferInput,
): Promise<ClaimResult> {
  try {
    return await transferInTx(tx, deps, input);
  } catch (error) {
    if (isSerializationFailure(error)) throw new AssignmentError(409, 'SERIALIZATION_FAILURE');
    throw error;
  }
}

/** Resolves the work item and releases the owner slot exactly once. */
export async function resolveWorkItem(
  db: Db,
  deps: AssignmentRepoDeps,
  input: ResolveInput,
): Promise<ClaimResult> {
  try {
    return await withTransaction(db, (tx) => resolveInTx(tx, deps, input));
  } catch (error) {
    if (isSerializationFailure(error)) throw new AssignmentError(409, 'SERIALIZATION_FAILURE');
    throw error;
  }
}

/** Resolve inside a caller-owned transaction, so an audit row can join it. */
export async function resolveWorkItemInTransaction(
  tx: Tx,
  deps: AssignmentRepoDeps,
  input: ResolveInput,
): Promise<ClaimResult> {
  try {
    return await resolveInTx(tx, deps, input);
  } catch (error) {
    if (isSerializationFailure(error)) throw new AssignmentError(409, 'SERIALIZATION_FAILURE');
    throw error;
  }
}

export async function readWorkItem(
  db: Db,
  deps: AssignmentRepoDeps,
  input: { companyId: string; workItemId: string },
): Promise<WorkItemAssignment | null> {
  const { rows } = await db.query<WorkItemRow>(
    q(
      `SELECT id, conversation_id, state, owner_id, department_id, assignment_version
         FROM __S__.work_items WHERE company_id = $1 AND id = $2`,
      deps.schema,
    ),
    [input.companyId, input.workItemId],
  );
  const row = rows[0];
  return row ? toWorkItem(row) : null;
}

/**
 * Stores the amoCRM contact owner. It is a separate external fact: nothing here writes
 * work_items.owner_id, so a CRM owner change never replaces the local assignee.
 */
export async function recordCrmContactOwner(
  db: Db,
  deps: AssignmentRepoDeps,
  input: { companyId: string; conversationId: string; crmOwnerRef: string; expectedVersion?: number },
): Promise<{ crmOwnerRef: string; version: number }> {
  if (input.expectedVersion === undefined) {
    const { rows } = await db.query<{ crm_owner_ref: string; version: string }>(
      q(
        `INSERT INTO __S__.crm_contact_owners (company_id, conversation_id, crm_owner_ref, version, observed_at)
         VALUES ($1,$2,$3,0, clock_timestamp())
         ON CONFLICT (company_id, conversation_id) DO UPDATE
           SET crm_owner_ref = EXCLUDED.crm_owner_ref,
               version = __S__.crm_contact_owners.version + 1,
               observed_at = clock_timestamp()
         RETURNING crm_owner_ref, version`,
        deps.schema,
      ),
      [input.companyId, input.conversationId, input.crmOwnerRef],
    );
    const row = rows[0];
    if (!row) throw new AssignmentError(500, 'CRM_OWNER_NOT_STORED');
    return { crmOwnerRef: row.crm_owner_ref, version: Number(row.version) };
  }

  const { rows } = await db.query<{ crm_owner_ref: string; version: string }>(
    q(
      `INSERT INTO __S__.crm_contact_owners (company_id, conversation_id, crm_owner_ref, version, observed_at)
       VALUES ($1,$2,$3,0, clock_timestamp())
       ON CONFLICT (company_id, conversation_id) DO UPDATE
         SET crm_owner_ref = EXCLUDED.crm_owner_ref,
             version = __S__.crm_contact_owners.version + 1,
             observed_at = clock_timestamp()
         WHERE __S__.crm_contact_owners.version = $4
       RETURNING crm_owner_ref, version`,
      deps.schema,
    ),
    [input.companyId, input.conversationId, input.crmOwnerRef, input.expectedVersion],
  );
  const row = rows[0];
  if (!row) throw new AssignmentError(409, 'VERSION_CONFLICT');
  return { crmOwnerRef: row.crm_owner_ref, version: Number(row.version) };
}

export async function readCrmContactOwner(
  db: Db,
  deps: AssignmentRepoDeps,
  input: { companyId: string; conversationId: string },
): Promise<{ crmOwnerRef: string; version: number } | null> {
  const { rows } = await db.query<{ crm_owner_ref: string; version: string }>(
    q(
      `SELECT crm_owner_ref, version FROM __S__.crm_contact_owners
        WHERE company_id = $1 AND conversation_id = $2`,
      deps.schema,
    ),
    [input.companyId, input.conversationId],
  );
  const row = rows[0];
  return row ? { crmOwnerRef: row.crm_owner_ref, version: Number(row.version) } : null;
}
