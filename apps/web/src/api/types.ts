/**
 * Типы ручек и моделей, выведенные из `packages/contracts/schema/api.v2.json`
 * (v1.json + v2.json). Файл намеренно повторяет контракт один-в-один:
 * при расхождении прав контракт, а не этот файл.
 *
 * Секретов и клиентских доменов здесь нет: только структура данных.
 */

export type ChannelMode =
  | 'telegram_bot'
  | 'telegram_personal'
  | 'telegram_business'
  | 'whatsapp_cloud'
  | 'whatsapp_qr'
  | 'max_bot'
  | 'vk_community';

export type TriStateCapability = 'supported' | 'unsupported' | 'unknown';

export interface Capabilities {
  textReply: TriStateCapability;
  mediaReply: TriStateCapability;
  readReceipts: TriStateCapability;
  deliveryReceipts: TriStateCapability;
  messageEditing: TriStateCapability;
  messageDeletion: TriStateCapability;
}

export type WorkItemState =
  | 'queued'
  | 'assigned'
  | 'in_progress'
  | 'waiting_customer'
  | 'resolved'
  | 'cancelled';

export interface WorkItem {
  id: string;
  conversationId: string;
  assignmentVersion: number;
  state: WorkItemState;
  owner: string | null;
}

export interface Conversation {
  id: string;
  connectionId: string;
  externalChatId: string;
  bindingEpoch: number;
}

export interface Obligation {
  id: string;
  contentVersion: number;
  attentionSeq: number;
  messageId: string;
}

export interface WorkItemDetail {
  workItem: WorkItem;
  conversation: Conversation;
  outstandingObligations: Obligation[];
}

export interface ObligationRef {
  obligationId: string;
  contentVersion: number;
}

export interface ComposeSnapshot {
  id: string;
  workItemId: string;
  conversationId: string;
  bindingEpoch: number;
  assignmentVersion: number;
  obligationRefs: ObligationRef[];
}

export interface EvidenceData {
  timestamp: string;
  evidenceKey: string;
}

export type SendOperationState =
  | 'accepted'
  | 'queued'
  | 'dispatching'
  | 'sent'
  | 'failed'
  | 'unknown'
  | 'cancelled';

export interface SendOperation {
  id: string;
  state: SendOperationState;
  providerMessageId: string | null;
  coverage: 'unconfirmed' | 'confirmed';
  selectedRefs: ObligationRef[];
  deliveryEvidence: EvidenceData | null;
  readEvidence: EvidenceData | null;
}

export type MessageContent =
  | { kind: 'text'; text: string }
  | { kind: 'attachment'; mediaId: string; caption: string }
  | { kind: 'unsupported'; providerType: string };

export interface Message {
  id: string;
  conversationId: string;
  direction: 'in' | 'out';
  contentVersion: number;
  content: MessageContent;
  createdAt: string;
  sendOperationId: string | null;
}

export interface Page {
  nextCursor: string | null;
}

export interface MessageList {
  items: Message[];
  page: Page;
}

export interface WorkItemList {
  items: WorkItem[];
  page: Page;
}

export type ApiErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'CAPACITY_EXCEEDED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'STALE_EPOCH'
  | 'CAPABILITY_BLOCKED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export interface ApiError {
  code: ApiErrorCode;
  requestId: string;
  retryable: boolean;
}

export interface SendReplyRequest {
  idempotencyKey: string;
  snapshotId: string;
  expectedAssignmentVersion: number;
  selectedObligations: ObligationRef[];
  text: string;
  deadline: string;
}

export interface ClaimRequest {
  expectedAssignmentVersion: number;
  idempotencyKey: string;
}

export interface TransferRequest {
  expectedAssignmentVersion: number;
  idempotencyKey: string;
  departmentId: string;
  assigneeId: string | null;
}

export interface ResolveRequest {
  reason: string;
  expectedAssignmentVersion: number;
  idempotencyKey: string;
}

export interface ManualCoverageRequest {
  confirmedSendOperationId: string;
  obligationRefs: ObligationRef[];
  reason: string;
  expectedAssignmentVersion: number;
  idempotencyKey: string;
}

export interface EmptyRequest {
  [key: string]: never;
}

// ---------- v2: подключения ----------

export type ConnectionState =
  | 'setup'
  | 'active'
  | 'degraded'
  | 'auth_required'
  | 'paused'
  | 'disabled';

export type ConnectionHealthErrorCode =
  | 'AUTH_REQUIRED'
  | 'POLLING_CONFLICT'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_UNAVAILABLE'
  | 'CONFIGURATION_REQUIRED'
  | 'INTERNAL_ERROR';

export interface ConnectionHealth {
  checkedAt: string;
  lastInboundAt: string | null;
  lastSuccessAt: string | null;
  errorCode: ConnectionHealthErrorCode | null;
}

export interface ConnectionProjection {
  displayName?: string;
  id: string;
  state: ConnectionState;
  version: number;
  bindingEpoch: number;
  credentialsVersion: number;
  ingressEnabled: boolean;
  sendEnabled: boolean;
  health: ConnectionHealth;
  channelMode: ChannelMode;
  capabilities: Capabilities;
}

export interface ConnectionProjectionList {
  items: ConnectionProjection[];
  page: Page;
}

export interface ConnectionLifecycleRequest {
  idempotencyKey: string;
  expectedVersion: number;
  desiredState: 'active' | 'paused' | 'disabled';
}

export interface ConnectionSetupRequest {
  idempotencyKey: string;
  channelMode: ChannelMode;
  credentialRef: string;
}

export interface ConnectionSetupOptions {
  enabled: boolean;
  workshops: Array<{ id: string; displayName: string | null }>;
  sources: Array<{ id: string; externalId: string; name: string }>;
}

export interface ConnectionCredentialRotationRequest {
  idempotencyKey: string;
  expectedVersion: number;
  credentialRef: string;
}

// ---------- v2: персонал ----------

export type Availability = 'online' | 'away' | 'offline';

export interface StaffAvailability {
  id: string;
  availability: Availability;
  departmentIds: string[];
  capacity: number;
  activeCount: number;
  version: number;
}

export interface StaffAvailabilityList {
  items: StaffAvailability[];
  page: Page;
}

export interface StaffAvailabilityRequest {
  idempotencyKey: string;
  expectedVersion: number;
  availability: Availability;
}

// ---------- v2: уведомления ----------

export type NotificationKind =
  | 'reply_required'
  | 'overdue'
  | 'assignment_changed'
  | 'send_unknown'
  | 'channel_alert';

/** Персональное уведомление: только идентификаторы и тип, без текста переписки. */
export interface Notification {
  channelAlert?: {
    connectionId: string;
    alertKind: 'channel_disabled' | 'refresh_exhausted' | 'send_rejected' | 'manual_review';
    errorCode: string | null;
    connectionState: string | null;
  } | null;
  id: string;
  kind: NotificationKind;
  workItemId: string;
  conversationId: string;
  /** Есть у уведомлений из обязательств ответа; null у остальных видов. */
  attentionSeq: number | null;
  createdAt: string;
  /** Короткая подсказка, что делать; не содержит данных клиента. */
  hint: string;
}

/** Сводка по всей области сессии, не только по текущей странице. */
export interface NotificationHints {
  channelAlertCount?: number;
  replyRequiredCount: number;
  overdueCount: number;
  unknownSendCount: number;
}

export interface NotificationList {
  items: Notification[];
  page: Page;
  hints: NotificationHints;
}

// ---------- v2: CRM ----------

export type CrmBindingState = 'pending' | 'bound' | 'creation_unknown' | 'disabled';

export interface CrmBinding {
  id: string;
  conversationId: string;
  crmAccountId: string;
  contactId: string | null;
  leadId: string | null;
  chatId: string | null;
  version: number;
  state: CrmBindingState;
}

export interface CrmBindingList {
  items: CrmBinding[];
  page: Page;
}

export interface CrmBindingRequest {
  idempotencyKey: string;
  conversationId: string;
  crmAccountId: string;
  contactId: string;
  leadId: string | null;
  chatId: string;
  expectedVersion: number;
}

// ---------- роли ----------

/** Роли сессии. Порядок строгий: read < send < manage < admin. */
export type Role = 'read' | 'send' | 'manage' | 'admin';

// ---------- v2: вход ----------

/**
 * Тело `POST /auth/login`. Пароль живёт только в состоянии формы и в этом
 * запросе: ни хранилище сессии, ни кэш RTK Query его не удерживают.
 */
export interface LoginRequest {
  companyId: string;
  staffId: string;
  password: string;
}

/** Ответ логина: сервер уже поставил HttpOnly-cookie сессии. */
export interface LoginResponse {
  staffId: string;
  companyId: string;
  role: Role;
  workshopId: string | null;
  expiresAt: string;
}

export const ROLE_RANK: Record<Role, number> = { read: 0, send: 1, manage: 2, admin: 3 };

// ---------- v2: мастерские ----------

export interface Workshop {
  id: string;
  displayName: string | null;
}

export interface WorkshopList {
  items: Workshop[];
}

export interface ConnectionRoute {
  connectionId: string;
  workshopId: string;
  crmAccountId: string;
  funnelId: string;
  defaultOwnerId: string;
  technicalSourceId: string;
  statusId?: string | null;
  alertStaffId?: string | null;
  normalizePhone?: boolean;
  version: number;
}

export interface PipelineStage {
  id: string;
  name: string;
  isFinal: boolean;
}

export interface Pipeline {
  id: string;
  name: string;
  stages: PipelineStage[];
}

export interface PipelineList {
  items: Pipeline[];
}

/** The routing settings an admin edits per channel; the rest of the route is fixed. */
export interface ConnectionRouting {
  connectionId: string;
  funnelId: string;
  statusId: string | null;
  alertStaffId: string | null;
  normalizePhone: boolean;
  version: number;
}

export interface ConnectionRoutingRequest {
  funnelId: string;
  statusId?: string | null;
  alertStaffId?: string | null;
  normalizePhone?: boolean;
  expectedVersion?: number;
}

export interface ConnectionRouteList {
  items: ConnectionRoute[];
}

export interface ConnectionRouteRequest {
  connectionId: string;
  crmAccountId: string;
  funnelId: string;
  defaultOwnerId: string;
  technicalSourceId: string;
  expectedVersion: number;
}

export type GroupRuleDecision = 'allow_crm' | 'exclude' | 'archive_only';

export interface GroupRule {
  connectionId: string;
  bindingEpoch: number;
  externalChatId: string;
  decision: GroupRuleDecision;
  displayName: string | null;
  version: number;
}

export interface GroupRuleList {
  items: GroupRule[];
}

export interface GroupRuleRequest {
  connectionId: string;
  bindingEpoch: number;
  externalChatId: string;
  decision: GroupRuleDecision;
  displayName?: string | null;
}

export interface ChannelPermission {
  connectionId: string;
  staffId: string;
  canRead: boolean;
  canSend: boolean;
}

export interface ChannelPermissionList {
  items: ChannelPermission[];
}

// ---------- v2: CRM ----------

export type CrmSourceOfTruth = 'platform' | 'crm';

export interface CrmPolicy {
  sourceOfTruth: CrmSourceOfTruth;
  version: number;
}

export interface CrmPolicyRequest {
  sourceOfTruth: CrmSourceOfTruth;
  expectedVersion: number;
}

export interface CrmConflict {
  id: string;
  accountId: string;
  conversationId: string;
  crmOwnerRef: string | null;
  platformOwnerId: string | null;
  desiredCrmOwnerRef: string | null;
  policy: CrmSourceOfTruth;
  winner: CrmSourceOfTruth;
  state: string;
  detectedAt: string;
}

export interface CrmConflictList {
  items: CrmConflict[];
}

export interface CrmResyncRequest {
  accountId: string;
  conversationId: string;
  idempotencyKey: string;
}

export type CrmResyncStatus = 'ok' | 'lead_missing' | 'error';

export interface CrmResyncResult {
  status: CrmResyncStatus;
  replayed: boolean;
  leadId: string | null;
  crmOwnerRef: string | null;
  errorCode: string | null;
}

export interface CrmSyncState {
  status: string;
  result: string | null;
  errorCode: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
}

/** Связка диалога с CRM: то, из чего строится переход в карточку. */
export interface CrmDiagnosticsBinding {
  accountId: string;
  contactId: string | null;
  leadId: string | null;
  chatId: string | null;
  state: string;
}

export interface CrmDiagnostics {
  sync: CrmSyncState | null;
  leadMissing: boolean;
  projection: Record<string, unknown> | null;
  openConflicts: number;
  binding: CrmDiagnosticsBinding | null;
  /** Готовая ссылка на карточку в amoCRM; null, если связки или домена нет. */
  cardUrl: string | null;
}

// ---------- v2: состояние системы ----------

export type SystemHealth = 'ok' | 'degraded' | 'critical';

export type SystemIssueSeverity = 'warning' | 'critical';

/**
 * Проблема, найденная сводной оценкой. Только код, важность и текст:
 * идентификаторов компании, подключений и людей здесь нет.
 */
export interface SystemStatusIssue {
  code: string;
  severity: SystemIssueSeverity;
  title: string;
  detail: string;
}

/** Агрегированное состояние системы для страницы диагностики. */
export interface SystemStatus {
  checkedAt: string;
  database: { reachable: boolean; latencyMs: number | null };
  queues: {
    inboxPending: number;
    outboxPending: number;
    outboxLeased: number;
    outboxFailed: number;
    sendUnknown: number;
  };
  activity: {
    lastInboundAt: string | null;
    lastSendAt: string | null;
  };
  connections: {
    total: number;
    active: number;
    degraded: number;
    authRequired: number;
  };
  health: SystemHealth;
  issues: SystemStatusIssue[];
}

// ---------- запросы списков ----------

export interface PageQuery {
  after?: string;
  limit?: number;
}
export interface CrmIntegrationStatus {
  authorizationEnabled: boolean;
  accounts: Array<{
    id: string;
    state: 'setup' | 'active' | 'revoked' | 'disabled';
    refreshFailureCount: number;
    lastAuthorizedAt: string | null;
    lastRefreshedAt: string | null;
  }>;
}

export type ChannelCrmRole = 'manager' | 'supervisor' | 'quality';
export interface CrmDirectoryView {
  accountId: string;
  users: Array<{
    id: string;
    staffId: string;
    name: string;
    isActive: boolean;
    isCrmAdmin: boolean;
    roleId: string | null;
    roleName: string | null;
    groupName: string | null;
    chatIdentityAvailable: boolean;
  }>;
  roles: Array<{ id: string; name: string }>;
  channels: Array<{ id: string; name: string }>;
  refreshEnabled: boolean;
  version: number;
  lastSuccessAt: string | null;
  errorCode: string | null;
}
export interface ChannelCrmAccess {
  connectionId: string;
  accountId: string;
  version: number;
  enforced: boolean;
  grants: Array<{ crmUserId: string; role: ChannelCrmRole }>;
}
