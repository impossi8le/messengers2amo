import type {
  Availability,
  ChannelMode,
  ConnectionHealthErrorCode,
  ConnectionState,
  CrmBindingState,
  CrmResyncStatus,
  CrmSourceOfTruth,
  GroupRuleDecision,
  NotificationKind,
  SendOperationState,
  WorkItemState,
} from '@/api/types';
import type { BadgeTone } from '@/components/ui';

export const CHANNEL_LABELS: Record<ChannelMode, string> = {
  telegram_bot: 'Telegram (бот)',
  telegram_personal: 'Telegram (личный)',
  telegram_business: 'Telegram (business)',
  whatsapp_cloud: 'WhatsApp Cloud API',
  whatsapp_qr: 'WhatsApp QR',
  max_bot: 'MAX (бот)',
  vk_community: 'VK (сообщество)',
};

export const WORK_ITEM_STATE_LABELS: Record<WorkItemState, string> = {
  queued: 'В очереди',
  assigned: 'Назначен',
  in_progress: 'В работе',
  waiting_customer: 'Ждём клиента',
  resolved: 'Закрыт',
  cancelled: 'Отменён',
};

export const WORK_ITEM_STATE_TONE: Record<WorkItemState, BadgeTone> = {
  queued: 'warning',
  assigned: 'accent',
  in_progress: 'accent',
  waiting_customer: 'neutral',
  resolved: 'success',
  cancelled: 'neutral',
};

export const CONNECTION_STATE_LABELS: Record<ConnectionState, string> = {
  setup: 'Настройка',
  active: 'Активно',
  degraded: 'Сбои',
  auth_required: 'Требуется авторизация',
  paused: 'Приостановлено',
  disabled: 'Отключено',
};

export const CONNECTION_STATE_TONE: Record<ConnectionState, BadgeTone> = {
  setup: 'neutral',
  active: 'success',
  degraded: 'warning',
  auth_required: 'danger',
  paused: 'warning',
  disabled: 'neutral',
};

export const HEALTH_ERROR_LABELS: Record<ConnectionHealthErrorCode, string> = {
  AUTH_REQUIRED: 'Требуется повторная авторизация',
  POLLING_CONFLICT: 'Конфликт опроса: токен использует другой потребитель',
  UPSTREAM_TIMEOUT: 'Провайдер не ответил вовремя',
  UPSTREAM_UNAVAILABLE: 'Провайдер недоступен',
  CONFIGURATION_REQUIRED: 'Не хватает настроек подключения',
  INTERNAL_ERROR: 'Внутренняя ошибка шлюза',
};

export const SEND_STATE_LABELS: Record<SendOperationState, string> = {
  accepted: 'Принято сервером',
  queued: 'В очереди',
  dispatching: 'Отправляется',
  sent: 'Отправлено',
  failed: 'Ошибка отправки',
  unknown: 'Результат неизвестен',
  cancelled: 'Отменено',
};

export const SEND_STATE_TONE: Record<SendOperationState, BadgeTone> = {
  accepted: 'accent',
  queued: 'neutral',
  dispatching: 'accent',
  sent: 'success',
  failed: 'danger',
  unknown: 'warning',
  cancelled: 'neutral',
};

export const AVAILABILITY_LABELS: Record<Availability, string> = {
  online: 'На линии',
  away: 'Отошёл',
  offline: 'Не в сети',
};

export const AVAILABILITY_TONE: Record<Availability, BadgeTone> = {
  online: 'success',
  away: 'warning',
  offline: 'neutral',
};

export const CRM_BINDING_STATE_LABELS: Record<CrmBindingState, string> = {
  pending: 'Ожидает привязки',
  bound: 'Привязано',
  creation_unknown: 'Создание не подтверждено',
  disabled: 'Отключено',
};

export const CRM_BINDING_STATE_TONE: Record<CrmBindingState, BadgeTone> = {
  pending: 'warning',
  bound: 'success',
  creation_unknown: 'danger',
  disabled: 'neutral',
};

export const GROUP_RULE_LABELS: Record<GroupRuleDecision, string> = {
  allow_crm: 'Разрешить проекцию в CRM',
  exclude: 'Исключить',
  archive_only: 'Только архив',
};

export const GROUP_RULE_TONE: Record<GroupRuleDecision, BadgeTone> = {
  allow_crm: 'success',
  exclude: 'danger',
  archive_only: 'neutral',
};

export const CRM_POLICY_LABELS: Record<CrmSourceOfTruth, string> = {
  platform: 'Платформа назначает ответственного',
  crm: 'amoCRM назначает ответственного',
};

export const CRM_RESYNC_STATUS_LABELS: Record<CrmResyncStatus, string> = {
  ok: 'Синхронизировано',
  lead_missing: 'Сделка не найдена в amoCRM',
  error: 'Синхронизация не удалась',
};

export const CRM_RESYNC_STATUS_TONE: Record<CrmResyncStatus, BadgeTone> = {
  ok: 'success',
  lead_missing: 'warning',
  error: 'danger',
};

export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  reply_required: 'Нужен ответ оператора',
  overdue: 'Просрочен ответ',
  assignment_changed: 'Обращение переназначено',
  send_unknown: 'Результат отправки неизвестен',
  channel_alert: 'Проблема с каналом',
};

export function channelLabel(mode: ChannelMode): string {
  return CHANNEL_LABELS[mode] ?? mode;
}

export function notificationKindLabel(kind: NotificationKind): string {
  return NOTIFICATION_KIND_LABELS[kind] ?? kind;
}
