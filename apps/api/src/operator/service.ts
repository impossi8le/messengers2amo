// Operator read models and the manual-coverage command.
// Authorization is decided by the routes; this module only reads and writes within
// the already-authorized company/workshop scope.

import type { Db, Tx } from '../platform/db.ts';
import { withTransaction } from '../platform/db.ts';
import { fingerprint } from '../platform/auth.ts';
import { writeAudit } from '../platform/audit.ts';
import type { ObligationRef } from '../domain/attention.ts';
import { claimCommand } from '../connections/service.ts';
import type { ChannelAlertKind } from '../repo/alerts.ts';

export type OperatorRepoDeps = { schema: string };

export type OperatorScope = {
  companyId: string;
  /** null means company-wide; otherwise only connections routed to this workshop. */
  workshopId: string | null;
};

export type WorkItemProjection = {
  id: string;
  conversationId: string;
  assignmentVersion: number;
  state: string;
  owner: string | null;
};

export type ConversationProjection = {
  id: string;
  connectionId: string;
  externalChatId: string;
  bindingEpoch: number;
};

export type ObligationProjection = {
  id: string;
  contentVersion: number;
  attentionSeq: number;
  messageId: string;
};

export type MessageContent =
  | { kind: 'text'; text: string }
  | { kind: 'attachment'; mediaId: string; caption: string }
  | { kind: 'unsupported'; providerType: string };

export type MessageProjection = {
  id: string;
  conversationId: string;
  direction: 'in' | 'out';
  contentVersion: number;
  content: MessageContent;
  createdAt: string;
  sendOperationId: string | null;
};

export type EvidenceProjection = { timestamp: string; evidenceKey: string } | null;

export type SendOperationProjection = {
  id: string;
  state: string;
  providerMessageId: string | null;
  coverage: 'unconfirmed' | 'confirmed';
  selectedRefs: ObligationRef[];
  deliveryEvidence: EvidenceProjection;
  readEvidence: EvidenceProjection;
};

export class OperatorError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly current: WorkItemProjection | null;

  constructor(statusCode: number, code: string, current: WorkItemProjection | null = null) {
    super(code);
    this.name = 'OperatorError';
    this.statusCode = statusCode;
    this.code = code;
    this.current = current;
  }
}

function q(sql: string, schema: string): string {
  return sql.replaceAll('__S__', `"${schema}"`);
}

export function toWorkItem(row: {
  id: string;
  conversation_id: string;
  assignment_version: string | number;
  state: string;
  owner_id: string | null;
}): WorkItemProjection {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    assignmentVersion: Number(row.assignment_version),
    state: row.state,
    owner: row.owner_id,
  };
}

/** Contract-shaped content. Unknown provider payloads become an explicit `unsupported`. */
export function toMessageContent(raw: unknown): MessageContent {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (value.kind === 'text' && typeof value.text === 'string') {
    return { kind: 'text', text: value.text.slice(0, 65536) };
  }
  if (value.kind === 'attachment' && typeof value.mediaId === 'string' && value.mediaId.length > 0) {
    const caption = typeof value.caption === 'string' ? value.caption : '';
    return { kind: 'attachment', mediaId: value.mediaId.slice(0, 128), caption: caption.slice(0, 65536) };
  }
  const providerType = typeof value.kind === 'string' && value.kind.length > 0 ? value.kind : 'unknown';
  return { kind: 'unsupported', providerType: providerType.slice(0, 128) };
}

/** Only contract-shaped refs survive; anything else is dropped rather than echoed. */
export function toObligationRefs(raw: unknown): ObligationRef[] {
  if (!Array.isArray(raw)) return [];
  const out: ObligationRef[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const value = item as Record<string, unknown>;
    if (typeof value.obligationId !== 'string' || value.obligationId.length === 0) continue;
    if (typeof value.contentVersion !== 'number' || !Number.isInteger(value.contentVersion)) continue;
    if (value.contentVersion < 0) continue;
    const key = `${value.obligationId}:${value.contentVersion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ obligationId: value.obligationId, contentVersion: value.contentVersion });
  }
  return out;
}

/** SQL fragment: the session scope filter, applied to an aliased conversation `c`. */
function scopeClause(scope: OperatorScope, schema: string, params: unknown[]): string {
  if (scope.workshopId === null) return '';
  params.push(scope.workshopId);
  return ` AND EXISTS (SELECT 1 FROM ${q('__S__.connection_routes', schema)} r
             WHERE r.company_id = c.company_id AND r.connection_id = c.connection_id
               AND r.workshop_id = $${params.length})`;
}

/**
 * SQL fragment: the session scope filter for a stored channel alert.
 *
 * A channel alert belongs to a connection, not to a conversation, so it cannot use
 * the conversation-aliased `scopeClause`. The route of the connection decides
 * whether a workshop-scoped actor may see it — the same rule as everywhere else.
 * The workshop id gets its own parameter, so it never depends on the position the
 * other filters happened to occupy.
 */
function alertScopeClause(scope: OperatorScope, schema: string, params: unknown[]): string {
  if (scope.workshopId === null) return '';
  params.push(scope.workshopId);
  return ` AND EXISTS (SELECT 1 FROM ${q('__S__.connection_routes', schema)} r
             WHERE r.company_id = a.company_id AND r.connection_id = a.connection_id
               AND r.workshop_id = $${params.length})`;
}

type WorkItemRow = {
  id: string;
  conversation_id: string;
  state: string;
  owner_id: string | null;
  department_id: string | null;
  assignment_version: string | number;
};

export type WorkItemScopeRow = WorkItemRow & {
  connection_id: string;
  binding_epoch: string | number;
  external_chat_id: string;
};

const WORK_ITEM_SELECT = `w.id, w.conversation_id, w.state, w.owner_id, w.department_id, w.assignment_version,
       c.connection_id, c.binding_epoch, c.external_chat_id`;

async function readWorkItemRow(
  db: Db | Tx,
  deps: OperatorRepoDeps,
  scope: OperatorScope,
  workItemId: string,
  options: { forUpdate?: boolean } = {},
): Promise<WorkItemScopeRow | null> {
  const params: unknown[] = [scope.companyId, workItemId];
  const scoped = scopeClause(scope, deps.schema, params);
  const { rows } = await db.query<WorkItemScopeRow>(
    q(
      `SELECT ${WORK_ITEM_SELECT}
         FROM __S__.work_items w
         JOIN __S__.conversations c
           ON c.company_id = w.company_id AND c.id = w.conversation_id
        WHERE w.company_id = $1 AND w.id = $2${scoped}
        ${options.forUpdate ? 'FOR UPDATE OF w' : ''}`,
      deps.schema,
    ),
    params,
  );
  return rows[0] ?? null;
}

/**
 * Reads one work item inside the caller's scope. A work item outside the session
 * workshop is reported exactly like a missing one, so its existence never leaks.
 */
export async function readWorkItemInScope(
  db: Db | Tx,
  deps: OperatorRepoDeps,
  scope: OperatorScope,
  workItemId: string,
  options: { forUpdate?: boolean } = {},
): Promise<WorkItemScopeRow> {
  const row = await readWorkItemRow(db, deps, scope, workItemId, options);
  if (!row) throw new OperatorError(404, 'NOT_FOUND');
  return row;
}

export async function listWorkItemsInScope(
  db: Db,
  deps: OperatorRepoDeps,
  scope: OperatorScope,
  options: { after: string | null; limit: number },
): Promise<{ items: WorkItemProjection[]; nextCursor: string | null }> {
  const params: unknown[] = [scope.companyId];
  let where = `w.company_id = $1`;
  where += scopeClause(scope, deps.schema, params);
  if (options.after) {
    params.push(options.after);
    where += ` AND w.id > $${params.length}`;
  }
  params.push(options.limit);
  const { rows } = await db.query<WorkItemRow>(
    q(
      `SELECT w.id, w.conversation_id, w.state, w.owner_id, w.department_id, w.assignment_version
         FROM __S__.work_items w
         JOIN __S__.conversations c
           ON c.company_id = w.company_id AND c.id = w.conversation_id
        WHERE ${where}
        ORDER BY w.id
        LIMIT $${params.length}`,
      deps.schema,
    ),
    params,
  );
  const items = rows.map(toWorkItem);
  const nextCursor = rows.length === options.limit ? rows[rows.length - 1]!.id : null;
  return { items, nextCursor };
}

export type CrmBindingProjection = {
  id: string;
  conversationId: string;
  crmAccountId: string;
  contactId: string | null;
  leadId: string | null;
  chatId: string | null;
  version: number;
  state: string;
};

type CrmBindingRow = {
  id: string;
  conversation_id: string;
  account_id: string;
  contact_id: string | null;
  lead_id: string | null;
  chat_id: string | null;
  version: string | number;
  state: string;
};

/**
 * Cursor-paginated CRM bindings. The operator route passes the company from the
 * verified session; the internal adapter route passes its deployment company, or
 * null when the service is not tenant-scoped. There is no client tenant input.
 */
export async function listCrmBindings(
  db: Db,
  deps: OperatorRepoDeps,
  companyId: string | null,
  options: {
    after: string | null;
    limit: number;
    conversationId: string | null;
    state: string | null;
  },
): Promise<{ items: CrmBindingProjection[]; nextCursor: string | null }> {
  const params: unknown[] = [];
  let where = 'TRUE';
  if (companyId !== null) {
    params.push(companyId);
    where = `b.company_id = $${params.length}`;
  }
  if (options.conversationId !== null) {
    params.push(options.conversationId);
    where += ` AND b.conversation_id = $${params.length}`;
  }
  if (options.state !== null) {
    params.push(options.state);
    where += ` AND b.state = $${params.length}`;
  }
  if (options.after !== null) {
    params.push(options.after);
    where += ` AND b.id > $${params.length}`;
  }
  params.push(options.limit);
  const { rows } = await db.query<CrmBindingRow>(
    q(
      `SELECT b.id, b.conversation_id, b.account_id, b.contact_id, b.lead_id, b.chat_id,
              b.version, b.state
         FROM __S__.crm_bindings b
        WHERE ${where}
        ORDER BY b.id
        LIMIT $${params.length}`,
      deps.schema,
    ),
    params,
  );
  const items = rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    crmAccountId: row.account_id,
    contactId: row.contact_id,
    leadId: row.lead_id,
    chatId: row.chat_id,
    version: Number(row.version),
    state: row.state,
  }));
  const nextCursor = rows.length === options.limit ? rows[rows.length - 1]!.id : null;
  return { items, nextCursor };
}

export async function listOpenObligations(
  db: Db | Tx,
  deps: OperatorRepoDeps,
  companyId: string,
  workItemId: string,
): Promise<ObligationProjection[]> {
  const { rows } = await db.query<{
    id: string;
    content_version: string;
    attention_seq: string;
    message_id: string;
  }>(
    q(
      `SELECT id, content_version, attention_seq, message_id
         FROM __S__.attention_obligations
        WHERE company_id = $1 AND work_item_id = $2 AND state = 'open'
        ORDER BY attention_seq`,
      deps.schema,
    ),
    [companyId, workItemId],
  );
  return rows.map((row) => ({
    id: row.id,
    contentVersion: Number(row.content_version),
    attentionSeq: Number(row.attention_seq),
    messageId: row.message_id,
  }));
}

export async function listMessagesInScope(
  db: Db,
  deps: OperatorRepoDeps,
  scope: OperatorScope,
  workItem: WorkItemScopeRow,
  options: { after: string | null; limit: number },
): Promise<{ items: MessageProjection[]; nextCursor: string | null }> {
  const params: unknown[] = [scope.companyId, workItem.conversation_id];
  let where = `m.company_id = $1 AND m.conversation_id = $2`;

  if (options.after) {
    // The cursor must resolve inside this conversation; otherwise a page would
    // silently start from the beginning or return nothing.
    // `created_at` travels as text: a JS Date would truncate microseconds and the
    // cursor row itself would satisfy `>` on the same millisecond.
    const cursor = await db.query<{ created_at: string; id: string }>(
      q(
        `SELECT created_at::text AS created_at, id FROM __S__.messages
          WHERE company_id = $1 AND conversation_id = $2 AND id = $3`,
        deps.schema,
      ),
      [scope.companyId, workItem.conversation_id, options.after],
    );
    const anchor = cursor.rows[0];
    if (!anchor) throw new OperatorError(400, 'VALIDATION_FAILED');
    params.push(anchor.created_at, anchor.id);
    where += ` AND (m.created_at, m.id) > ($${params.length - 1}::timestamptz, $${params.length}::text)`;
  }

  params.push(options.limit);
  const { rows } = await db.query<{
    id: string;
    conversation_id: string;
    direction: 'in' | 'out';
    content_version: string;
    content: unknown;
    created_at: Date;
    send_operation_id: string | null;
  }>(
    q(
      `SELECT m.id, m.conversation_id, m.direction, m.current_content_version AS content_version,
              v.content, m.created_at,
              (SELECT o.id FROM __S__.send_operations o
                WHERE o.company_id = m.company_id AND o.conversation_id = m.conversation_id
                  AND o.provider_message_id = m.provider_message_id AND o.state = 'sent'
                ORDER BY o.created_at DESC LIMIT 1) AS send_operation_id
         FROM __S__.messages m
         JOIN __S__.message_versions v
           ON v.company_id = m.company_id AND v.message_id = m.id
          AND v.content_version = m.current_content_version
        WHERE ${where}
        ORDER BY m.created_at, m.id
        LIMIT $${params.length}`,
      deps.schema,
    ),
    params,
  );

  const items = rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    direction: row.direction,
    contentVersion: Number(row.content_version),
    content: toMessageContent(row.content),
    createdAt: row.created_at.toISOString(),
    sendOperationId: row.send_operation_id,
  }));
  const nextCursor = rows.length === options.limit ? rows[rows.length - 1]!.id : null;
  return { items, nextCursor };
}

type SendOperationRow = {
  id: string;
  state: string;
  provider_message_id: string | null;
  coverage: 'unconfirmed' | 'confirmed';
  content: unknown;
  delivery_key: string | null;
  delivery_at: Date | null;
  read_key: string | null;
  read_at: Date | null;
};

function evidence(key: string | null, at: Date | null): EvidenceProjection {
  if (!key || !at) return null;
  return { timestamp: at.toISOString(), evidenceKey: key };
}

function toSendOperation(row: SendOperationRow): SendOperationProjection {
  const content = row.content && typeof row.content === 'object' ? (row.content as Record<string, unknown>) : {};
  return {
    id: row.id,
    state: row.state,
    providerMessageId: row.provider_message_id,
    coverage: row.coverage,
    selectedRefs: toObligationRefs(content.selectedObligations),
    deliveryEvidence: evidence(row.delivery_key, row.delivery_at),
    readEvidence: evidence(row.read_key, row.read_at),
  };
}

export async function readSendOperationInScope(
  db: Db | Tx,
  deps: OperatorRepoDeps,
  scope: OperatorScope,
  operationId: string,
): Promise<SendOperationProjection> {
  const params: unknown[] = [scope.companyId, operationId];
  const scoped = scopeClause(scope, deps.schema, params);
  const { rows } = await db.query<SendOperationRow>(
    q(
      `SELECT o.id, o.state, o.provider_message_id, o.coverage, o.content,
              d.evidence_key AS delivery_key, d.observed_at AS delivery_at,
              r.evidence_key AS read_key, r.observed_at AS read_at
         FROM __S__.send_operations o
         JOIN __S__.conversations c
           ON c.company_id = o.company_id AND c.id = o.conversation_id
         LEFT JOIN LATERAL (
           SELECT e.evidence_key, e.observed_at
             FROM __S__.provider_receipt_links l
             JOIN __S__.provider_receipt_evidence e
               ON e.company_id = l.company_id AND e.id = l.evidence_id
            WHERE l.company_id = o.company_id AND l.operation_id = o.id
              AND e.kind = 'message.delivery_observed' AND e.status = 'delivered'
            ORDER BY e.observed_at DESC LIMIT 1
         ) d ON TRUE
         LEFT JOIN LATERAL (
           SELECT e.evidence_key, e.observed_at
             FROM __S__.provider_receipt_links l
             JOIN __S__.provider_receipt_evidence e
               ON e.company_id = l.company_id AND e.id = l.evidence_id
            WHERE l.company_id = o.company_id AND l.operation_id = o.id
              AND e.kind = 'message.read_observed'
            ORDER BY e.observed_at DESC LIMIT 1
         ) r ON TRUE
        WHERE o.company_id = $1 AND o.id = $2${scoped}`,
      deps.schema,
    ),
    params,
  );
  const row = rows[0];
  if (!row) throw new OperatorError(404, 'NOT_FOUND');
  return toSendOperation(row);
}

export type SnapshotRow = {
  id: string;
  work_item_id: string;
  conversation_id: string;
  binding_epoch: string | number;
  assignment_version: string | number;
  sealed_at: Date | null;
};

export async function loadSnapshot(
  tx: Tx,
  deps: OperatorRepoDeps,
  input: { companyId: string; workItemId: string; snapshotId: string },
): Promise<SnapshotRow> {
  const { rows } = await tx.query<SnapshotRow>(
    q(
      `SELECT id, work_item_id, conversation_id, binding_epoch, assignment_version, sealed_at
         FROM __S__.reply_snapshots
        WHERE company_id = $1 AND id = $2 AND work_item_id = $3`,
      deps.schema,
    ),
    [input.companyId, input.snapshotId, input.workItemId],
  );
  const row = rows[0];
  if (!row) throw new OperatorError(404, 'NOT_FOUND');
  return row;
}

export async function loadSnapshotRefs(
  tx: Tx,
  deps: OperatorRepoDeps,
  input: { companyId: string; snapshotId: string },
): Promise<Map<string, number>> {
  const { rows } = await tx.query<{ obligation_id: string; content_version: string }>(
    q(
      `SELECT obligation_id, content_version FROM __S__.reply_snapshot_items
        WHERE company_id = $1 AND snapshot_id = $2`,
      deps.schema,
    ),
    [input.companyId, input.snapshotId],
  );
  return new Map(rows.map((row) => [row.obligation_id, Number(row.content_version)]));
}

export type ObligationStateRow = { contentVersion: number; state: string; superseded: boolean };

/**
 * Current version and supersession of the selected obligations. A late answer may
 * still cover an obligation that is already covered, but never a version that a
 * substantial edit replaced.
 */
export async function loadObligationStates(
  tx: Tx,
  deps: OperatorRepoDeps,
  input: { companyId: string; workItemId: string; obligationIds: string[] },
): Promise<Map<string, ObligationStateRow>> {
  if (input.obligationIds.length === 0) return new Map();
  const { rows } = await tx.query<{
    id: string;
    content_version: string;
    state: string;
    superseded: boolean;
  }>(
    q(
      `SELECT o.id, o.content_version, o.state,
              EXISTS (SELECT 1 FROM __S__.attention_obligations n
                       WHERE n.company_id = o.company_id AND n.supersedes_id = o.id) AS superseded
         FROM __S__.attention_obligations o
        WHERE o.company_id = $1 AND o.work_item_id = $2 AND o.id = ANY($3::text[])`,
      deps.schema,
    ),
    [input.companyId, input.workItemId, input.obligationIds],
  );
  return new Map(
    rows.map((row) => [
      row.id,
      { contentVersion: Number(row.content_version), state: row.state, superseded: row.superseded },
    ]),
  );
}

// --- staff availability ----------------------------------------------------------
//
// The database is the source of truth for the state set (`online|offline|away`);
// the API never renames `online` to `available`, so a value written here is the value
// a list read returns. Department ids are memberships, not a denormalized column.

export const STAFF_AVAILABILITY_STATES = ['online', 'away', 'offline'] as const;
export type StaffAvailabilityState = (typeof STAFF_AVAILABILITY_STATES)[number];

export type StaffAvailabilityProjection = {
  id: string;
  availability: StaffAvailabilityState;
  departmentIds: string[];
  capacity: number;
  activeCount: number;
  version: number;
};

/** A CAS failure carries the live version so the client can retry without a re-read. */
export class StaffAvailabilityConflictError extends Error {
  readonly currentVersion: number;

  constructor(currentVersion: number) {
    super('VERSION_CONFLICT');
    this.name = 'StaffAvailabilityConflictError';
    this.currentVersion = currentVersion;
  }
}

type StaffRow = {
  id: string;
  availability: StaffAvailabilityState;
  capacity: number;
  active_count: string | number;
  version: string | number;
};

const STAFF_SELECT = `id, availability, capacity, active_count, version`;

function toStaffAvailability(row: StaffRow, departmentIds: string[]): StaffAvailabilityProjection {
  return {
    id: row.id,
    availability: row.availability,
    departmentIds,
    capacity: row.capacity,
    activeCount: Number(row.active_count),
    version: Number(row.version),
  };
}

async function loadDepartmentIds(
  db: Db | Tx,
  deps: OperatorRepoDeps,
  companyId: string,
  staffIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (staffIds.length === 0) return out;
  const { rows } = await db.query<{ staff_id: string; department_id: string }>(
    q(
      `SELECT staff_id, department_id FROM __S__.staff_memberships
        WHERE company_id = $1 AND staff_id = ANY($2::text[])
        ORDER BY department_id`,
      deps.schema,
    ),
    [companyId, staffIds],
  );
  for (const row of rows) {
    const list = out.get(row.staff_id) ?? [];
    list.push(row.department_id);
    out.set(row.staff_id, list);
  }
  return out;
}

/** Company-scoped roster. Cursor pagination follows the operator list convention. */
export async function listStaffAvailability(
  db: Db,
  deps: OperatorRepoDeps,
  companyId: string,
  options: { after: string | null; limit: number },
): Promise<{ items: StaffAvailabilityProjection[]; nextCursor: string | null }> {
  const params: unknown[] = [companyId];
  let where = `company_id = $1`;
  if (options.after) {
    params.push(options.after);
    where += ` AND id > $${params.length}`;
  }
  params.push(options.limit);
  const { rows } = await db.query<StaffRow>(
    q(
      `SELECT ${STAFF_SELECT} FROM __S__.staff
        WHERE ${where}
        ORDER BY id
        LIMIT $${params.length}`,
      deps.schema,
    ),
    params,
  );
  const departments = await loadDepartmentIds(
    db,
    deps,
    companyId,
    rows.map((row) => row.id),
  );
  const items = rows.map((row) => toStaffAvailability(row, departments.get(row.id) ?? []));
  const nextCursor = rows.length === options.limit ? rows[rows.length - 1]!.id : null;
  return { items, nextCursor };
}

// --- notifications ---------------------------------------------------------------
//
// Notifications are a read-only projection of state that already exists: open
// attention obligations, `unknown` send operations and ownership transfers. Nothing
// is stored per notification, so a lost cursor only costs a re-read, never an event.
// A notification is personal: only work items owned by the session staff member are
// projected, and the company/workshop scope is applied exactly like the other
// operator lists. Message text, phone numbers and provider payloads never appear.
//
// Channel alerts are the one exception: they are stored events, not a projection.
// A channel that was disabled and later re-enabled still happened, so the alert row
// is the record. They are addressed to one staff member (`connection_routes.
// alert_staff_id`) and carry no work item, only the channel they belong to.

export const NOTIFICATION_KINDS = [
  'reply_required',
  'overdue',
  'assignment_changed',
  'send_unknown',
  'channel_alert',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** An unanswered obligation older than this is reported as `overdue`. */
export const REPLY_OVERDUE_SECONDS = 60 * 60;

export type NotificationProjection = {
  id: string;
  kind: NotificationKind;
  /**
   * The work item the notification is about. A channel alert has none: it is about
   * a connection, so it carries the connection id here and says so in `channelAlert`.
   */
  workItemId: string;
  conversationId: string;
  /** Present for obligation-derived notifications, `null` for the other kinds. */
  attentionSeq: number | null;
  createdAt: string;
  hint: string;
  /** Present only for `channel_alert` notifications, `null` for the other kinds. */
  channelAlert: ChannelAlertSummary | null;
};

/**
 * The channel a stored alert belongs to. Identifiers and our own error code only:
 * no provider text, no message text, no phone number.
 */
export type ChannelAlertSummary = {
  connectionId: string;
  alertKind: ChannelAlertKind;
  errorCode: string | null;
  connectionState: string | null;
};

export type NotificationHints = {
  /** Open obligations in scope, overdue ones included. */
  replyRequiredCount: number;
  overdueCount: number;
  unknownSendCount: number;
  /** Stored channel alerts addressed to the session staff member. */
  channelAlertCount: number;
};

export type NotificationListResult = {
  items: NotificationProjection[];
  nextCursor: string | null;
  hints: NotificationHints;
};

const NOTIFICATION_HINTS: Record<NotificationKind, string> = {
  reply_required: 'Ответьте клиенту',
  overdue: 'Просроченный ответ',
  assignment_changed: 'Вам передали обращение',
  send_unknown: 'Проверьте статус отправки',
  channel_alert: 'Проверьте состояние канала',
};

/** One hint per stored alert kind, so the operator sees what happened. */
const CHANNEL_ALERT_HINTS: Record<ChannelAlertKind, string> = {
  channel_disabled: 'Канал отключён: доступ отозван',
  refresh_exhausted: 'Не удалось обновить токен канала',
  send_rejected: 'Отправка отклонена провайдером',
  manual_review: 'Отправка требует ручной проверки',
};

type NotificationRow = {
  kind: NotificationKind;
  id: string;
  work_item_id: string;
  conversation_id: string;
  attention_seq: string | null;
  sort_at: Date;
  sort_at_text: string;
  /** Channel alert columns; null for every other kind. */
  alert_connection_id: string | null;
  alert_kind: ChannelAlertKind | null;
  alert_error_code: string | null;
  alert_connection_state: string | null;
};

/** Cursor scope marker: a cursor issued for one company/workshop pair is useless in another. */
function notificationCursorScope(scope: OperatorScope): string {
  return `${scope.companyId}|${scope.workshopId ?? '*'}`;
}

/**
 * Opaque keyset cursor on `(created_at, id)`. Timestamps travel as PostgreSQL text so
 * microseconds survive the round trip; a JS Date would truncate them and the cursor
 * row itself could satisfy the comparison again.
 */
function encodeNotificationCursor(scope: OperatorScope, sortAt: string, id: string): string {
  const payload = JSON.stringify({ v: 1, s: notificationCursorScope(scope), t: sortAt, i: id });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

function decodeNotificationCursor(scope: OperatorScope, raw: string): { at: string; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new OperatorError(400, 'VALIDATION_FAILED');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OperatorError(400, 'VALIDATION_FAILED');
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.v !== 1 ||
    typeof value.s !== 'string' ||
    typeof value.t !== 'string' ||
    value.t.length === 0 ||
    typeof value.i !== 'string' ||
    value.i.length === 0 ||
    value.s !== notificationCursorScope(scope)
  ) {
    throw new OperatorError(400, 'VALIDATION_FAILED');
  }
  return { at: value.t, id: value.i };
}

async function countNotificationHints(
  db: Db,
  deps: OperatorRepoDeps,
  scope: OperatorScope,
  staffId: string,
): Promise<NotificationHints> {
  const params: unknown[] = [scope.companyId, staffId];
  const scoped = scopeClause(scope, deps.schema, params);
  params.push(REPLY_OVERDUE_SECONDS);
  const overdueParam = params.length;
  const alertScoped = alertScopeClause(scope, deps.schema, params);

  const { rows } = await db.query<{
    reply_required: string;
    overdue: string;
    unknown_send: string;
    channel_alert: string;
  }>(
    q(
      `SELECT
         (SELECT count(*)
            FROM __S__.attention_obligations o
            JOIN __S__.work_items w ON w.company_id = o.company_id AND w.id = o.work_item_id
            JOIN __S__.conversations c ON c.company_id = w.company_id AND c.id = w.conversation_id
           WHERE o.company_id = $1 AND o.state = 'open' AND w.owner_id = $2
             AND w.state NOT IN ('resolved','cancelled')${scoped}) AS reply_required,
         (SELECT count(*)
            FROM __S__.attention_obligations o
            JOIN __S__.work_items w ON w.company_id = o.company_id AND w.id = o.work_item_id
            JOIN __S__.conversations c ON c.company_id = w.company_id AND c.id = w.conversation_id
           WHERE o.company_id = $1 AND o.state = 'open' AND w.owner_id = $2
             AND w.state NOT IN ('resolved','cancelled')
             AND o.opened_at < now() - ($${overdueParam}::bigint * interval '1 second')${scoped}) AS overdue,
         (SELECT count(*)
            FROM __S__.send_operations s
            JOIN __S__.work_items w ON w.company_id = s.company_id AND w.id = s.work_item_id
            JOIN __S__.conversations c ON c.company_id = w.company_id AND c.id = w.conversation_id
           WHERE s.company_id = $1 AND s.state = 'unknown' AND w.owner_id = $2
             AND w.state NOT IN ('resolved','cancelled')${scoped}) AS unknown_send,
         (SELECT count(*)
            FROM __S__.channel_alerts a
           WHERE a.company_id = $1 AND a.recipient_staff_id = $2${alertScoped}) AS channel_alert`,
      deps.schema,
    ),
    params,
  );
  const row = rows[0];
  return {
    replyRequiredCount: Number(row?.reply_required ?? 0),
    overdueCount: Number(row?.overdue ?? 0),
    unknownSendCount: Number(row?.unknown_send ?? 0),
    channelAlertCount: Number(row?.channel_alert ?? 0),
  };
}

/**
 * Personal notification feed, newest first. The sources are unioned in one
 * statement, so a page is one round trip and the hints are a second aggregate query;
 * no per-row lookups are performed.
 *
 * The fourth source is the stored channel alerts. They are addressed to one staff
 * member rather than projected from a work item, so they carry the connection id
 * instead of a work item id, and they are filtered by the recipient — a channel
 * alert never leaks to another staff member of the same company.
 */
export async function listNotifications(
  db: Db,
  deps: OperatorRepoDeps,
  scope: OperatorScope,
  staffId: string,
  options: { after: string | null; limit: number },
): Promise<NotificationListResult> {
  const params: unknown[] = [scope.companyId, staffId];
  const scoped = scopeClause(scope, deps.schema, params);
  params.push(REPLY_OVERDUE_SECONDS);
  const overdueParam = params.length;
  const alertScoped = alertScopeClause(scope, deps.schema, params);

  let cursorClause = '';
  if (options.after !== null) {
    const cursor = decodeNotificationCursor(scope, options.after);
    params.push(cursor.at);
    const atParam = params.length;
    params.push(cursor.id);
    const idParam = params.length;
    cursorClause = `WHERE (n.sort_at, n.id) < ($${atParam}::timestamptz, $${idParam}::text)`;
  }
  params.push(options.limit);
  const limitParam = params.length;

  const { rows } = await db.query<NotificationRow>(
    q(
      `WITH n AS (
         SELECT CASE WHEN o.opened_at < now() - ($${overdueParam}::bigint * interval '1 second')
                     THEN 'overdue' ELSE 'reply_required' END AS kind,
                'obligation:' || o.id AS id,
                o.work_item_id, o.conversation_id, o.attention_seq, o.created_at AS sort_at,
                NULL::text AS alert_connection_id, NULL::text AS alert_kind,
                NULL::text AS alert_error_code, NULL::text AS alert_connection_state
           FROM __S__.attention_obligations o
           JOIN __S__.work_items w ON w.company_id = o.company_id AND w.id = o.work_item_id
           JOIN __S__.conversations c ON c.company_id = w.company_id AND c.id = w.conversation_id
          WHERE o.company_id = $1 AND o.state = 'open' AND w.owner_id = $2
            AND w.state NOT IN ('resolved','cancelled')${scoped}
         UNION ALL
         SELECT 'send_unknown', 'send:' || s.id, s.work_item_id, s.conversation_id,
                NULL::bigint, s.created_at,
                NULL::text, NULL::text, NULL::text, NULL::text
           FROM __S__.send_operations s
           JOIN __S__.work_items w ON w.company_id = s.company_id AND w.id = s.work_item_id
           JOIN __S__.conversations c ON c.company_id = w.company_id AND c.id = w.conversation_id
          WHERE s.company_id = $1 AND s.state = 'unknown' AND w.owner_id = $2
            AND w.state NOT IN ('resolved','cancelled')${scoped}
         UNION ALL
         SELECT 'assignment_changed', 'assignment:' || h.id, h.work_item_id, w.conversation_id,
                NULL::bigint, h.created_at,
                NULL::text, NULL::text, NULL::text, NULL::text
           FROM __S__.assignment_history h
           JOIN __S__.work_items w ON w.company_id = h.company_id AND w.id = h.work_item_id
           JOIN __S__.conversations c ON c.company_id = w.company_id AND c.id = w.conversation_id
          WHERE h.company_id = $1 AND h.owner_id = $2
            AND h.previous_owner_id IS DISTINCT FROM h.owner_id
            AND w.state NOT IN ('resolved','cancelled')${scoped}
         UNION ALL
         SELECT 'channel_alert', 'alert:' || a.id, a.connection_id, '',
                NULL::bigint, a.created_at,
                a.connection_id, a.kind, a.error_code, a.connection_state
           FROM __S__.channel_alerts a
          WHERE a.company_id = $1 AND a.recipient_staff_id = $2${alertScoped}
       )
       SELECT kind, id, work_item_id, conversation_id, attention_seq, sort_at, sort_at::text AS sort_at_text,
              alert_connection_id, alert_kind, alert_error_code, alert_connection_state
         FROM n
         ${cursorClause}
        ORDER BY sort_at DESC, id DESC
        LIMIT $${limitParam}`,
      deps.schema,
    ),
    params,
  );

  const items = rows.map((row) => {
    const isChannelAlert = row.kind === 'channel_alert' && row.alert_kind !== null;
    return {
      id: row.id,
      kind: row.kind,
      workItemId: row.work_item_id,
      conversationId: row.conversation_id,
      attentionSeq: row.attention_seq === null ? null : Number(row.attention_seq),
      createdAt: row.sort_at.toISOString(),
      hint: isChannelAlert
        ? CHANNEL_ALERT_HINTS[row.alert_kind as ChannelAlertKind]
        : NOTIFICATION_HINTS[row.kind],
      channelAlert: isChannelAlert
        ? {
            connectionId: row.alert_connection_id ?? '',
            alertKind: row.alert_kind as ChannelAlertKind,
            errorCode: row.alert_error_code,
            connectionState: row.alert_connection_state,
          }
        : null,
    };
  });
  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === options.limit && last ? encodeNotificationCursor(scope, last.sort_at_text, last.id) : null;

  return { items, nextCursor, hints: await countNotificationHints(db, deps, scope, staffId) };
}

export type SetStaffAvailabilityInput = {
  companyId: string;
  staffId: string;
  actorId: string;
  traceId: string;
  expectedVersion: number;
  availability: StaffAvailabilityState;
  idempotencyKey: string;
};

/**
 * Version-checked availability change. The idempotency ledger row, the update and the
 * audit row share one transaction: a rejected CAS rolls the ledger back too, so the
 * client may retry the same key with the corrected version. A replay returns the
 * current row and never writes twice.
 */
export async function setStaffAvailability(
  db: Db,
  deps: OperatorRepoDeps,
  input: SetStaffAvailabilityInput,
): Promise<StaffAvailabilityProjection> {
  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query<StaffRow>(
      q(
        `SELECT ${STAFF_SELECT} FROM __S__.staff
          WHERE company_id = $1 AND id = $2
          FOR UPDATE`,
        deps.schema,
      ),
      [input.companyId, input.staffId],
    );
    const row = rows[0];
    // Another company's staff member is indistinguishable from a missing one.
    if (!row) throw new OperatorError(404, 'NOT_FOUND');

    const claim = await claimCommand(tx, {
      companyId: input.companyId,
      idempotencyKey: input.idempotencyKey,
      command: 'staff.availability',
      connectionId: null,
      fingerprint: fingerprint({
        command: 'staff.availability',
        staffId: input.staffId,
        expectedVersion: input.expectedVersion,
        availability: input.availability,
      }),
    });
    if (claim.kind === 'conflict') throw new OperatorError(409, 'IDEMPOTENCY_CONFLICT');

    const departmentIds =
      (await loadDepartmentIds(tx, deps, input.companyId, [input.staffId])).get(input.staffId) ?? [];
    if (claim.kind === 'replay') return toStaffAvailability(row, departmentIds);

    const currentVersion = Number(row.version);
    if (input.expectedVersion !== currentVersion) {
      throw new StaffAvailabilityConflictError(currentVersion);
    }

    const updated = await tx.query<StaffRow>(
      q(
        `UPDATE __S__.staff
            SET availability = $3, version = version + 1
          WHERE company_id = $1 AND id = $2 AND version = $4
          RETURNING ${STAFF_SELECT}`,
        deps.schema,
      ),
      [input.companyId, input.staffId, input.availability, input.expectedVersion],
    );
    const next = updated.rows[0];
    if (!next) throw new StaffAvailabilityConflictError(currentVersion);

    await writeAudit(tx, {
      companyId: input.companyId,
      eventName: 'staff.availability_changed',
      subjectId: input.staffId,
      actorId: input.actorId,
      traceId: input.traceId,
      diagnosticCode: input.availability,
    });
    return toStaffAvailability(next, departmentIds);
  });
}

export type ManualCoverageInput = {
  companyId: string;
  workItemId: string;
  actorId: string;
  confirmedSendOperationId: string;
  obligationRefs: ObligationRef[];
  reason: string;
  expectedAssignmentVersion: number;
  idempotencyKey: string;
  traceId: string;
};

export type ManualCoverageResult = { workItem: WorkItemProjection; replayed: boolean };

/**
 * Confirms that a specific, already `sent` human reply covered the listed
 * obligations. Versions are re-checked against the live rows; the coverage rows,
 * the obligation state change and the audit row are written in one transaction.
 * The command ledger makes a retry a replay and a changed payload a conflict.
 */
export async function applyManualCoverage(
  db: Db,
  deps: OperatorRepoDeps,
  scope: OperatorScope,
  input: ManualCoverageInput,
): Promise<ManualCoverageResult> {
  return withTransaction(db, async (tx) => {
    const workItem = await readWorkItemInScope(tx, deps, scope, input.workItemId, { forUpdate: true });

    const commandFingerprint = fingerprint({
      command: 'manual_coverage',
      workItemId: input.workItemId,
      confirmedSendOperationId: input.confirmedSendOperationId,
      obligationRefs: input.obligationRefs,
      reason: input.reason,
      expectedAssignmentVersion: input.expectedAssignmentVersion,
    });

    const inserted = await tx.query(
      q(
        `INSERT INTO __S__.work_item_commands
           (company_id, command_type, request_key, work_item_id, payload_fingerprint, result)
         VALUES ($1,'manual_coverage',$2,$3,$4,'{}'::jsonb)
         ON CONFLICT (company_id, command_type, request_key) DO NOTHING
         RETURNING request_key`,
        deps.schema,
      ),
      [input.companyId, input.idempotencyKey, input.workItemId, commandFingerprint],
    );

    if ((inserted.rowCount ?? 0) === 0) {
      const { rows } = await tx.query<{ payload_fingerprint: string; result: { workItem?: WorkItemProjection } }>(
        q(
          `SELECT payload_fingerprint, result FROM __S__.work_item_commands
            WHERE company_id = $1 AND command_type = 'manual_coverage' AND request_key = $2`,
          deps.schema,
        ),
        [input.companyId, input.idempotencyKey],
      );
      const stored = rows[0];
      if (!stored || stored.payload_fingerprint !== commandFingerprint) {
        throw new OperatorError(409, 'IDEMPOTENCY_CONFLICT');
      }
      const replay = stored.result?.workItem;
      if (!replay) throw new OperatorError(409, 'IDEMPOTENCY_CONFLICT');
      return { workItem: replay, replayed: true };
    }

    const current = toWorkItem(workItem);
    if (input.expectedAssignmentVersion !== current.assignmentVersion) {
      throw new OperatorError(409, 'VERSION_CONFLICT', current);
    }

    const operation = await tx.query<{ id: string; work_item_id: string; state: string }>(
      q(
        `SELECT id, work_item_id, state FROM __S__.send_operations
          WHERE company_id = $1 AND id = $2`,
        deps.schema,
      ),
      [input.companyId, input.confirmedSendOperationId],
    );
    const sendOperation = operation.rows[0];
    // A send operation of another work item is reported as missing, not as forbidden.
    if (!sendOperation || sendOperation.work_item_id !== input.workItemId) {
      throw new OperatorError(404, 'NOT_FOUND');
    }
    if (sendOperation.state !== 'sent') throw new OperatorError(409, 'VERSION_CONFLICT', current);

    const states = await loadObligationStates(tx, deps, {
      companyId: input.companyId,
      workItemId: input.workItemId,
      obligationIds: input.obligationRefs.map((ref) => ref.obligationId),
    });
    for (const ref of input.obligationRefs) {
      const live = states.get(ref.obligationId);
      if (!live || live.contentVersion !== ref.contentVersion || live.superseded) {
        throw new OperatorError(409, 'STALE_EPOCH', current);
      }
    }

    for (const ref of input.obligationRefs) {
      await tx.query(
        q(
          `INSERT INTO __S__.send_coverage
             (company_id, operation_id, work_item_id, conversation_id, operation_state,
              obligation_id, content_version, reason)
           VALUES ($1,$2,$3,$4,'sent',$5,$6,$7)
           ON CONFLICT DO NOTHING`,
          deps.schema,
        ),
        [
          input.companyId,
          input.confirmedSendOperationId,
          input.workItemId,
          workItem.conversation_id,
          ref.obligationId,
          ref.contentVersion,
          input.reason,
        ],
      );
      await tx.query(
        q(
          `UPDATE __S__.attention_obligations SET state = 'covered'
            WHERE company_id = $1 AND id = $2 AND content_version = $3 AND state = 'open'`,
          deps.schema,
        ),
        [input.companyId, ref.obligationId, ref.contentVersion],
      );
    }

    await writeAudit(tx, {
      companyId: input.companyId,
      eventName: 'work_item.manual_coverage',
      subjectId: input.workItemId,
      actorId: input.actorId,
      traceId: input.traceId,
      diagnosticCode: input.reason,
    });

    await tx.query(
      q(
        `UPDATE __S__.work_item_commands SET result = $3::jsonb
          WHERE company_id = $1 AND command_type = 'manual_coverage' AND request_key = $2`,
        deps.schema,
      ),
      [input.companyId, input.idempotencyKey, JSON.stringify({ workItem: current })],
    );

    return { workItem: current, replayed: false };
  });
}
