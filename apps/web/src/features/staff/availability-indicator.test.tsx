import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffAvailabilityList } from '@/api/types';
import { useSessionStore } from '@/store/session';
import {
  installFetch,
  jsonResponse,
  type RecordedCall,
  renderWithProviders,
  resetStores,
} from '@/test/utils';
import {
  AvailabilityIndicator,
  STAFF_AVAILABILITY_POLL_INTERVAL_MS,
} from './availability-indicator';

const AVAILABILITY: StaffAvailabilityList = {
  items: [
    {
      id: 'agent-1',
      availability: 'online',
      departmentIds: [],
      capacity: 5,
      activeCount: 1,
      version: 1,
    },
    {
      id: 'agent-2',
      availability: 'away',
      departmentIds: [],
      capacity: 5,
      activeCount: 0,
      version: 1,
    },
  ],
  page: { nextCursor: null },
};

function availabilityRoute() {
  return {
    method: 'GET',
    match: /\/operator\/staff\/availability/,
    handler: () => jsonResponse(AVAILABILITY),
  };
}

function availabilityCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => /\/operator\/staff\/availability/.test(call.url));
}

function setDocumentVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => state === 'hidden',
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('индикатор доступности сотрудников', () => {
  beforeEach(() => {
    resetStores();
    useSessionStore.setState({ status: 'authenticated', role: 'send' });
  });

  afterEach(() => {
    setDocumentVisibility('visible');
    vi.useRealTimers();
  });

  it('показывает распределение по смене', async () => {
    installFetch([availabilityRoute()]);
    renderWithProviders(<AvailabilityIndicator />, { route: '/' });

    expect(await screen.findByText('1 на линии')).toBeInTheDocument();
    expect(screen.getByText('1 отошли')).toBeInTheDocument();
    expect(screen.getByText('0 не в сети')).toBeInTheDocument();
  });

  it('опрашивает смену не чаще раза в 60 секунд', () => {
    expect(STAFF_AVAILABILITY_POLL_INTERVAL_MS).toBe(60_000);
  });

  it('не опрашивает смену, пока сессия не подтверждена', async () => {
    useSessionStore.setState({ role: null, staffId: null, status: 'anonymous' });
    const calls = installFetch([availabilityRoute()]);
    renderWithProviders(<AvailabilityIndicator />, { route: '/' });

    await flushPromises();
    expect(availabilityCalls(calls)).toHaveLength(0);
  });

  it('останавливает опрос при скрытой вкладке и обновляет данные при возврате', async () => {
    vi.useFakeTimers();
    const calls = installFetch([availabilityRoute()]);
    renderWithProviders(<AvailabilityIndicator />, { route: '/' });
    await flushPromises();
    expect(availabilityCalls(calls)).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STAFF_AVAILABILITY_POLL_INTERVAL_MS);
    });
    expect(availabilityCalls(calls)).toHaveLength(2);

    act(() => setDocumentVisibility('hidden'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STAFF_AVAILABILITY_POLL_INTERVAL_MS * 3);
    });
    expect(availabilityCalls(calls)).toHaveLength(2);

    act(() => setDocumentVisibility('visible'));
    await flushPromises();
    expect(availabilityCalls(calls)).toHaveLength(3);
  });
});
