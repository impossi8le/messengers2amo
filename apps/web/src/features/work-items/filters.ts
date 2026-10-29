import type { WorkItem, WorkItemState } from '@/api/types';

/**
 * Фильтр ожидания. Контракт списка отдаёт состояние обращения, поэтому
 * «ждёт ответа» определяется по состояниям, в которых ход за оператором.
 * Счётчики внимания считаются по загруженной странице — это подсказка,
 * а не замена серверной аналитике.
 */
export type WaitingFilter = 'all' | 'needs_reply' | 'waiting_customer' | 'closed';

export const WAITING_FILTER_LABELS: Record<WaitingFilter, string> = {
  all: 'Все',
  needs_reply: 'Ждут ответа',
  waiting_customer: 'Ждём клиента',
  closed: 'Закрытые',
};

export const NEEDS_REPLY_STATES: ReadonlySet<WorkItemState> = new Set<WorkItemState>([
  'queued',
  'assigned',
  'in_progress',
]);

export function isNeedsReply(state: WorkItemState): boolean {
  return NEEDS_REPLY_STATES.has(state);
}

export function matchesWaitingFilter(item: WorkItem, filter: WaitingFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'needs_reply':
      return isNeedsReply(item.state);
    case 'waiting_customer':
      return item.state === 'waiting_customer';
    case 'closed':
      return item.state === 'resolved' || item.state === 'cancelled';
    default:
      return true;
  }
}

export function matchesSearch(item: WorkItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [item.id, item.conversationId, item.owner ?? ''].join(' ').toLowerCase();
  return haystack.includes(needle);
}

export function filterWorkItems(
  items: readonly WorkItem[],
  filter: WaitingFilter,
  query: string,
): WorkItem[] {
  return items.filter((item) => matchesWaitingFilter(item, filter) && matchesSearch(item, query));
}

export interface AttentionSummary {
  total: number;
  needsReply: number;
  waitingCustomer: number;
  closed: number;
  unassigned: number;
}

export function summarizeAttention(items: readonly WorkItem[]): AttentionSummary {
  return items.reduce<AttentionSummary>(
    (acc, item) => {
      acc.total += 1;
      if (isNeedsReply(item.state)) acc.needsReply += 1;
      if (item.state === 'waiting_customer') acc.waitingCustomer += 1;
      if (item.state === 'resolved' || item.state === 'cancelled') acc.closed += 1;
      if (item.owner === null) acc.unassigned += 1;
      return acc;
    },
    { total: 0, needsReply: 0, waitingCustomer: 0, closed: 0, unassigned: 0 },
  );
}

export interface AttentionDatum {
  key: keyof AttentionSummary;
  /** Короткая подпись для оси графика: на 375px длинные подписи перекрываются. */
  shortLabel: string;
  /** Полная подпись для таблицы чисел и скринридера. */
  label: string;
  value: number;
}

export function attentionChartData(summary: AttentionSummary): AttentionDatum[] {
  return [
    { key: 'needsReply', shortLabel: 'Ждут', label: 'Ждут ответа', value: summary.needsReply },
    {
      key: 'waitingCustomer',
      shortLabel: 'Клиент',
      label: 'Ждём клиента',
      value: summary.waitingCustomer,
    },
    { key: 'closed', shortLabel: 'Закрыто', label: 'Закрытые', value: summary.closed },
    {
      key: 'unassigned',
      shortLabel: 'Без влад.',
      label: 'Без владельца',
      value: summary.unassigned,
    },
  ];
}
