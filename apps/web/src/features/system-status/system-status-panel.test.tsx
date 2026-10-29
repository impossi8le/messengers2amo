import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemStatus } from '@/api/types';
import { useSessionStore } from '@/store/session';
import {
  apiError,
  installFetch,
  jsonResponse,
  type RecordedCall,
  renderWithProviders,
  resetStores,
} from '@/test/utils';
import { SYSTEM_STATUS_POLL_INTERVAL_MS, SystemStatusPanel } from './system-status-panel';

function status(overrides: Partial<SystemStatus> = {}): SystemStatus {
  return {
    checkedAt: '2026-10-22T10:00:00.000Z',
    database: { reachable: true, latencyMs: 4 },
    queues: {
      inboxPending: 3,
      outboxPending: 2,
      outboxLeased: 1,
      outboxFailed: 0,
      sendUnknown: 0,
    },
    activity: {
      lastInboundAt: '2026-10-22T09:55:00.000Z',
      lastSendAt: '2026-10-22T09:50:00.000Z',
    },
    connections: { total: 2, active: 2, degraded: 0, authRequired: 0 },
    health: 'ok',
    issues: [],
    ...overrides,
  };
}

function statusRoute(body: SystemStatus) {
  return {
    method: 'GET',
    match: /\/operator\/system-status/,
    handler: () => jsonResponse(body),
  };
}

function statusCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => /\/operator\/system-status/.test(call.url));
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

function renderPanel() {
  return renderWithProviders(<SystemStatusPanel />, { route: '/diagnostics' });
}

describe('состояние системы', () => {
  beforeEach(() => {
    resetStores();
    useSessionStore.setState({ status: 'authenticated', role: 'admin' });
  });

  afterEach(() => {
    setDocumentVisibility('visible');
    vi.useRealTimers();
  });

  it('показывает спокойное состояние без проблем', async () => {
    installFetch([statusRoute(status())]);
    renderPanel();

    expect(await screen.findByText('Система работает нормально')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /проблемы/i })).not.toBeInTheDocument();
  });

  it('показывает деградацию и человеческие подсказки по проблемам', async () => {
    installFetch([
      statusRoute(
        status({
          health: 'degraded',
          connections: { total: 2, active: 1, degraded: 1, authRequired: 0 },
          issues: [
            {
              code: 'CONNECTIONS_DEGRADED',
              severity: 'warning',
              title: 'Подключения деградировали',
              detail: '1 подключений в состоянии degraded. Проверьте здоровье каналов.',
            },
          ],
        }),
      ),
    ]);
    renderPanel();

    expect(await screen.findByText('Есть проблемы')).toBeInTheDocument();
    expect(screen.getByText('Подключения деградировали')).toBeInTheDocument();
    expect(screen.getByText(/Проверьте здоровье каналов/)).toBeInTheDocument();
  });

  it('показывает критическое состояние', async () => {
    installFetch([
      statusRoute(
        status({
          health: 'critical',
          queues: {
            inboxPending: 0,
            outboxPending: 0,
            outboxLeased: 0,
            outboxFailed: 2,
            sendUnknown: 0,
          },
          issues: [
            {
              code: 'OUTBOX_FAILED',
              severity: 'critical',
              title: 'Есть проваленные задания отправки',
              detail: '2 заданий в очереди отправки перешли в failed.',
            },
          ],
        }),
      ),
    ]);
    renderPanel();

    expect(await screen.findByText('Критическое состояние')).toBeInTheDocument();
    expect(screen.getByText('Есть проваленные задания отправки')).toBeInTheDocument();
  });

  it('показывает числа очередей и время активности', async () => {
    installFetch([statusRoute(status())]);
    renderPanel();

    await screen.findByText('Система работает нормально');

    expect(screen.getByRole('rowheader', { name: 'Входящие без обработки' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '3' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'Проваленные отправки' })).toBeInTheDocument();
    expect(document.querySelector('time[datetime="2026-10-22T09:55:00.000Z"]')).toBeInTheDocument();
    expect(document.querySelector('time[datetime="2026-10-22T09:50:00.000Z"]')).toBeInTheDocument();
  });

  it('обновляет данные по кнопке «Обновить»', async () => {
    const user = userEvent.setup();
    const calls = installFetch([statusRoute(status())]);
    renderPanel();

    await screen.findByText('Система работает нормально');
    expect(statusCalls(calls)).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Обновить' }));

    expect(statusCalls(calls)).toHaveLength(2);
  });

  it('не опрашивает систему, пока сессия не подтверждена', async () => {
    useSessionStore.setState({ status: 'anonymous', role: null, staffId: null });
    const calls = installFetch([statusRoute(status())]);
    renderPanel();

    await flushPromises();
    expect(statusCalls(calls)).toHaveLength(0);
  });

  it('останавливает опрос при скрытой вкладке и обновляет данные при возврате', async () => {
    vi.useFakeTimers();
    const calls = installFetch([statusRoute(status())]);
    renderPanel();
    await flushPromises();
    expect(statusCalls(calls)).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SYSTEM_STATUS_POLL_INTERVAL_MS);
    });
    expect(statusCalls(calls)).toHaveLength(2);

    act(() => setDocumentVisibility('hidden'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SYSTEM_STATUS_POLL_INTERVAL_MS * 3);
    });
    expect(statusCalls(calls)).toHaveLength(2);

    act(() => setDocumentVisibility('visible'));
    await flushPromises();
    expect(statusCalls(calls)).toHaveLength(3);
  });

  it('показывает нейтральную ошибку без громкого баннера', async () => {
    installFetch([
      {
        method: 'GET',
        match: /\/operator\/system-status/,
        handler: () => apiError('INTERNAL_ERROR', 500),
      },
    ]);
    renderPanel();

    expect(await screen.findByText(/Не удалось загрузить состояние системы/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('объясняет, что раздел доступен администратору', async () => {
    installFetch([
      {
        method: 'GET',
        match: /\/operator\/system-status/,
        handler: () => apiError('FORBIDDEN', 403),
      },
    ]);
    renderPanel();

    expect(await screen.findByText(/доступно администратору/i)).toBeInTheDocument();
  });

  it('опрашивает состояние раз в 60 секунд', () => {
    expect(SYSTEM_STATUS_POLL_INTERVAL_MS).toBe(60_000);
  });
});
