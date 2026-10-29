import { describe, expect, it } from 'vitest';
import type { WorkItem } from '@/api/types';
import {
  filterWorkItems,
  matchesSearch,
  matchesWaitingFilter,
  summarizeAttention,
} from './filters';

function item(overrides: Partial<WorkItem> & Pick<WorkItem, 'id'>): WorkItem {
  return {
    conversationId: 'conv-1',
    assignmentVersion: 1,
    state: 'queued',
    owner: null,
    ...overrides,
  };
}

const items: WorkItem[] = [
  item({ id: 'wi-1', state: 'queued', owner: null }),
  item({ id: 'wi-2', state: 'in_progress', owner: 'staff-7' }),
  item({ id: 'wi-3', state: 'waiting_customer', owner: 'staff-7' }),
  item({ id: 'wi-4', state: 'resolved', owner: 'staff-9' }),
  item({ id: 'wi-5', state: 'cancelled', owner: null }),
];

describe('фильтр ожидания', () => {
  it('оставляет только обращения, где ход за оператором', () => {
    const result = filterWorkItems(items, 'needs_reply', '');
    expect(result.map((row) => row.id)).toEqual(['wi-1', 'wi-2']);
  });

  it('отделяет «ждём клиента» от закрытых', () => {
    expect(filterWorkItems(items, 'waiting_customer', '').map((row) => row.id)).toEqual(['wi-3']);
    expect(filterWorkItems(items, 'closed', '').map((row) => row.id)).toEqual(['wi-4', 'wi-5']);
  });

  it('фильтр all ничего не скрывает', () => {
    expect(filterWorkItems(items, 'all', '')).toHaveLength(items.length);
  });

  it('совмещает фильтр и поиск', () => {
    expect(filterWorkItems(items, 'needs_reply', 'staff-7').map((row) => row.id)).toEqual(['wi-2']);
  });

  it('matchesWaitingFilter учитывает каждое состояние', () => {
    expect(matchesWaitingFilter(item({ id: 'x', state: 'assigned' }), 'needs_reply')).toBe(true);
    expect(matchesWaitingFilter(item({ id: 'x', state: 'resolved' }), 'needs_reply')).toBe(false);
    expect(matchesWaitingFilter(item({ id: 'x', state: 'cancelled' }), 'closed')).toBe(true);
  });
});

describe('поиск', () => {
  it('ищет по идентификатору, диалогу и ответственному без учёта регистра', () => {
    expect(matchesSearch(item({ id: 'WI-1' }), 'wi-1')).toBe(true);
    expect(matchesSearch(item({ id: 'a', conversationId: 'conv-42' }), 'CONV-42')).toBe(true);
    expect(matchesSearch(item({ id: 'a', owner: 'Иванов' }), 'иван')).toBe(true);
    expect(matchesSearch(item({ id: 'a', owner: 'Иванов' }), 'петров')).toBe(false);
  });

  it('пустой запрос пропускает всё', () => {
    expect(matchesSearch(item({ id: 'a' }), '   ')).toBe(true);
  });
});

describe('счётчики внимания', () => {
  it('считает ожидание, закрытые и без владельца', () => {
    expect(summarizeAttention(items)).toEqual({
      total: 5,
      needsReply: 2,
      waitingCustomer: 1,
      closed: 2,
      unassigned: 2,
    });
  });
});
