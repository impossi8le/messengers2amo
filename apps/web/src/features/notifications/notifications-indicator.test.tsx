import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationList } from '@/api/types';
import { useSessionStore } from '@/store/session';
import {
  apiError,
  installFetch,
  jsonResponse,
  type RecordedCall,
  renderWithProviders,
  resetStores,
} from '@/test/utils';
import { NOTIFICATIONS_POLL_INTERVAL_MS, NotificationsIndicator } from './notifications-indicator';

const NOTIFICATIONS: NotificationList = {
  items: [
    {
      id: 'n-1',
      kind: 'reply_required',
      workItemId: 'wi-1001',
      conversationId: 'conv-alpha',
      attentionSeq: 3,
      createdAt: '2026-10-22T10:00:00.000Z',
      hint: 'Клиент ждёт ответа',
    },
    {
      id: 'n-2',
      kind: 'overdue',
      workItemId: 'wi-1002',
      conversationId: 'conv-beta',
      attentionSeq: null,
      createdAt: '2026-10-22T09:30:00.000Z',
      hint: 'Ответ просрочен',
    },
  ],
  page: { nextCursor: null },
  hints: { replyRequiredCount: 2, overdueCount: 1, unknownSendCount: 1 },
};

it('считает алерты канала и ведёт к подключениям', async () => {
  resetStores();
  useSessionStore.getState().setSession({ role: 'admin', staffId: 'admin' });
  const user = userEvent.setup();
  installFetch([
    notificationsRoute({
      items: [
        {
          id: 'alert-1',
          kind: 'channel_alert',
          workItemId: 'conn1',
          conversationId: '',
          attentionSeq: null,
          createdAt: '2026-10-26T12:00:00Z',
          hint: 'Канал отключён',
          channelAlert: {
            connectionId: 'conn1',
            alertKind: 'channel_disabled',
            errorCode: 'ACCESS_REVOKED',
            connectionState: 'disabled',
          },
        },
      ],
      page: { nextCursor: null },
      hints: { replyRequiredCount: 0, overdueCount: 0, unknownSendCount: 0, channelAlertCount: 1 },
    }),
  ]);
  renderWithProviders(<NotificationsIndicator />);
  await user.click(await screen.findByRole('button', { name: 'Уведомления: 1 новых' }));
  expect(
    await screen.findByRole('link', { name: 'Проблема с каналом: канал conn1' }),
  ).toHaveAttribute('href', '/connections');
});

function notificationsRoute(body: unknown, status = 200) {
  return {
    method: 'GET',
    match: /\/operator\/notifications/,
    handler: () => jsonResponse(body, status),
  };
}

function notificationCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => /\/operator\/notifications/.test(call.url));
}

/** Событие visibilitychange и свойства документа, как их видит браузер. */
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

/** Дождаться ответа fetch и обновления состояния React. */
async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function renderIndicator() {
  return renderWithProviders(
    <>
      <NotificationsIndicator />
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </>,
    { route: '/' },
  );
}

describe('индикатор уведомлений', () => {
  beforeEach(() => {
    resetStores();
    // Индикатор живёт только в шапке авторизованной консоли.
    useSessionStore.setState({ status: 'authenticated', role: 'send' });
  });

  afterEach(() => {
    setDocumentVisibility('visible');
    vi.useRealTimers();
  });

  it('показывает в счётчике сумму из hints, а не длину текущей страницы', async () => {
    installFetch([notificationsRoute(NOTIFICATIONS)]);
    renderIndicator();

    const trigger = await screen.findByRole('button', { name: 'Уведомления: 4 новых' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('aria-label', 'Уведомления: 4 новых');
  });

  it('падает обратно на items.length, если hints нет в ответе', async () => {
    const { hints: _hints, ...withoutHints } = NOTIFICATIONS;
    installFetch([notificationsRoute(withoutHints)]);
    renderIndicator();

    expect(await screen.findByRole('button', { name: 'Уведомления: 2 новых' })).toBeInTheDocument();
  });

  it('открывает панель со списком уведомлений по клику', async () => {
    const user = userEvent.setup();
    installFetch([notificationsRoute(NOTIFICATIONS)]);
    renderIndicator();

    const trigger = await screen.findByRole('button', { name: /Уведомления: 4/ });
    await user.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const panel = screen.getByRole('region', { name: 'Уведомления' });
    expect(panel).toBeInTheDocument();
    expect(screen.getByText('Нужен ответ оператора')).toBeInTheDocument();
    expect(screen.getByText('Просрочен ответ')).toBeInTheDocument();
  });

  it('показывает понятное сообщение при пустом ответе', async () => {
    const user = userEvent.setup();
    installFetch([
      notificationsRoute({
        items: [],
        page: { nextCursor: null },
        hints: { replyRequiredCount: 0, overdueCount: 0, unknownSendCount: 0 },
      }),
    ]);
    renderIndicator();

    await user.click(await screen.findByRole('button', { name: 'Уведомления' }));

    expect(screen.getByText('Нет уведомлений')).toBeInTheDocument();
  });

  it('ведёт на карточку обращения по клику на уведомление', async () => {
    const user = userEvent.setup();
    installFetch([notificationsRoute(NOTIFICATIONS)]);
    renderIndicator();

    await user.click(await screen.findByRole('button', { name: /Уведомления: 4/ }));
    await user.click(screen.getByRole('link', { name: /обращение wi-1001/ }));

    expect(screen.getByTestId('location')).toHaveTextContent('/work-items/wi-1001');
  });

  it('закрывается по Escape и возвращает фокус на кнопку', async () => {
    const user = userEvent.setup();
    installFetch([notificationsRoute(NOTIFICATIONS)]);
    renderIndicator();

    const trigger = await screen.findByRole('button', { name: /Уведомления: 4/ });
    await user.click(trigger);
    expect(screen.getByRole('region', { name: 'Уведомления' })).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('region', { name: 'Уведомления' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('закрывается по клику вне панели', async () => {
    const user = userEvent.setup();
    installFetch([notificationsRoute(NOTIFICATIONS)]);
    renderIndicator();

    await user.click(await screen.findByRole('button', { name: /Уведомления: 4/ }));
    expect(screen.getByRole('region', { name: 'Уведомления' })).toBeInTheDocument();

    await user.click(document.body);

    expect(screen.queryByRole('region', { name: 'Уведомления' })).not.toBeInTheDocument();
  });

  it('при ошибке запроса не ломает шапку и показывает нейтральное состояние', async () => {
    const user = userEvent.setup();
    installFetch([
      {
        method: 'GET',
        match: /\/operator\/notifications/,
        handler: () => apiError('INTERNAL_ERROR', 500),
      },
    ]);
    renderIndicator();

    const trigger = await screen.findByRole('button', { name: 'Уведомления' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);

    // Открытие панели делает повторный запрос, поэтому ошибка приходит асинхронно.
    expect(await screen.findByText('Не удалось загрузить уведомления')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('опрашивает ленту не чаще раза в 60 секунд', () => {
    expect(NOTIFICATIONS_POLL_INTERVAL_MS).toBe(60_000);
  });

  it('не опрашивает ленту, пока сессия не подтверждена', async () => {
    useSessionStore.setState({ role: null, staffId: null, status: 'anonymous' });
    const calls = installFetch([notificationsRoute(NOTIFICATIONS)]);
    renderIndicator();

    await flushPromises();
    expect(notificationCalls(calls)).toHaveLength(0);

    act(() => {
      useSessionStore.setState({ status: 'authenticated', role: 'send' });
    });

    await screen.findByRole('button', { name: 'Уведомления: 4 новых' });
    expect(notificationCalls(calls)).toHaveLength(1);
  });

  it('останавливает опрос при скрытой вкладке и сразу обновляет данные при возврате', async () => {
    vi.useFakeTimers();
    const calls = installFetch([notificationsRoute(NOTIFICATIONS)]);
    renderIndicator();
    await flushPromises();
    expect(notificationCalls(calls)).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(NOTIFICATIONS_POLL_INTERVAL_MS);
    });
    expect(notificationCalls(calls)).toHaveLength(2);

    act(() => setDocumentVisibility('hidden'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NOTIFICATIONS_POLL_INTERVAL_MS * 3);
    });
    expect(notificationCalls(calls)).toHaveLength(2);

    act(() => setDocumentVisibility('visible'));
    await flushPromises();
    expect(notificationCalls(calls)).toHaveLength(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(NOTIFICATIONS_POLL_INTERVAL_MS);
    });
    expect(notificationCalls(calls)).toHaveLength(4);
  });

  it('при открытии панели сразу запрашивает свежие уведомления', async () => {
    const user = userEvent.setup();
    const calls = installFetch([notificationsRoute(NOTIFICATIONS)]);
    renderIndicator();

    const trigger = await screen.findByRole('button', { name: /Уведомления: 4/ });
    expect(notificationCalls(calls)).toHaveLength(1);

    await user.click(trigger);

    await waitFor(() => expect(notificationCalls(calls)).toHaveLength(2));
  });
});
