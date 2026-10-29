import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ConnectionProjection } from '@/api/types';
import { ConnectionsPage } from '@/pages/connections-page';
import { useSessionStore } from '@/store/session';
import {
  apiError,
  installFetch,
  jsonResponse,
  renderWithProviders,
  resetStores,
} from '@/test/utils';

const CONNECTION: ConnectionProjection = {
  id: 'conn-1',
  state: 'degraded',
  version: 7,
  bindingEpoch: 2,
  credentialsVersion: 3,
  ingressEnabled: true,
  sendEnabled: true,
  channelMode: 'telegram_bot',
  capabilities: {
    textReply: 'supported',
    mediaReply: 'supported',
    readReceipts: 'unknown',
    deliveryReceipts: 'supported',
    messageEditing: 'unsupported',
    messageDeletion: 'unsupported',
  },
  health: {
    checkedAt: '2026-10-21T09:00:00.000Z',
    lastInboundAt: '2026-10-21T08:55:00.000Z',
    lastSuccessAt: null,
    errorCode: 'AUTH_REQUIRED',
  },
};

function connectionsRoute(item: ConnectionProjection) {
  return {
    method: 'GET' as const,
    match: /\/operator\/connections\?/,
    handler: () => jsonResponse({ items: [item], page: { nextCursor: null } }),
  };
}

describe('подключения', () => {
  beforeEach(() => {
    resetStores();
  });

  it('показывает канал, состояние и ошибку здоровья', async () => {
    installFetch([connectionsRoute(CONNECTION)]);
    renderWithProviders(<ConnectionsPage />, { route: '/connections' });

    expect(await screen.findByRole('heading', { name: 'Telegram (бот)' })).toBeInTheDocument();
    expect(screen.getByText('Сбои')).toBeInTheDocument();
    expect(screen.getByText('Требуется повторная авторизация')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Приём сообщений' })).toBeChecked();
  });

  it('отправляет lifecycle с ожидаемой версией и не выдаёт конфликт за успех', async () => {
    const user = userEvent.setup();
    const calls = installFetch([
      connectionsRoute(CONNECTION),
      {
        method: 'POST',
        match: /\/operator\/connections\/conn-1\/lifecycle$/,
        handler: () => apiError('VERSION_CONFLICT', 409),
      },
    ]);

    renderWithProviders(<ConnectionsPage />, { route: '/connections' });
    await screen.findByRole('heading', { name: 'Telegram (бот)' });

    await user.click(screen.getByRole('button', { name: 'Приостановить' }));

    expect(await screen.findByText('Не выполнено')).toBeInTheDocument();
    expect(screen.getByText(/Карточка устарела/)).toBeInTheDocument();
    const call = calls.find((item) => item.url.endsWith('/lifecycle'));
    expect(call?.body).toMatchObject({ expectedVersion: 7, desiredState: 'paused' });
  });

  it('показывает воронку и этап из CRM и сохраняет выбор', async () => {
    useSessionStore.getState().setSession({ role: 'admin' });
    const user = userEvent.setup();
    const calls = installFetch([
      connectionsRoute(CONNECTION),
      {
        method: 'GET',
        match: /\/operator\/connections\/conn-1\/routing$/,
        handler: () =>
          jsonResponse({
            connectionId: 'conn-1',
            funnelId: 'funnel-1',
            statusId: null,
            alertStaffId: 'staff-alert',
            normalizePhone: false,
            version: 3,
          }),
      },
      {
        method: 'GET',
        match: /\/operator\/amocrm\/pipelines/,
        handler: () =>
          jsonResponse({
            items: [
              {
                id: 'funnel-1',
                name: 'Продажи',
                stages: [
                  { id: 'stage-1', name: 'Новый', isFinal: false },
                  { id: 'stage-2', name: 'Закрыт', isFinal: true },
                ],
              },
            ],
          }),
      },
      {
        method: 'PATCH',
        match: /\/operator\/connections\/conn-1\/routing$/,
        handler: () =>
          jsonResponse({
            connectionId: 'conn-1',
            funnelId: 'funnel-1',
            statusId: 'stage-1',
            alertStaffId: null,
            normalizePhone: true,
            version: 4,
          }),
      },
    ]);

    renderWithProviders(<ConnectionsPage />, { route: '/connections' });
    await screen.findByRole('heading', { name: 'Маршрутизация' });

    const stageSelect = await screen.findByLabelText('Этап, на который падает новый клиент');
    // A stage that closes the deal is never offered as a starting stage.
    expect(stageSelect).not.toHaveTextContent('Закрыт');

    await user.selectOptions(stageSelect, 'stage-1');
    await user.click(screen.getByRole('tab', { name: 'Дополнительно' }));
    await user.click(screen.getByRole('switch', { name: 'Приводить 8XXXXXXXXXX к +7XXXXXXXXXX' }));
    await user.click(screen.getByRole('button', { name: 'Сохранить маршрут' }));

    expect(await screen.findByText('Маршрутизация сохранена.')).toBeInTheDocument();
    const call = calls.find((item) => item.method === 'PATCH' && item.url.endsWith('/routing'));
    expect(call?.body).toMatchObject({
      funnelId: 'funnel-1',
      statusId: 'stage-1',
      normalizePhone: true,
      expectedVersion: 3,
      alertStaffId: 'staff-alert',
    });

    const advanced = screen.getByRole('tab', { name: 'Дополнительно' });
    advanced.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Диагностика' })).toHaveFocus();
    expect(screen.getByText('Эпоха привязки')).toBeVisible();
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Привязка' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Обновить воронки' }));
    await waitFor(() =>
      expect(calls.some((item) => item.url.endsWith('/amocrm/pipelines?refresh=true'))).toBe(true),
    );
  });

  it('не запрашивает админскую маршрутизацию для роли чтения', async () => {
    useSessionStore.getState().setSession({ role: 'read' });
    const calls = installFetch([connectionsRoute(CONNECTION)]);
    renderWithProviders(<ConnectionsPage />, { route: '/connections' });
    await screen.findByRole('heading', { name: 'Telegram (бот)' });
    expect(calls.some((item) => /\/(routing|pipelines)/.test(item.url))).toBe(false);
  });

  it('показывает ошибку чтения маршрута, а не отсутствие привязки', async () => {
    useSessionStore.getState().setSession({ role: 'admin' });
    installFetch([
      connectionsRoute(CONNECTION),
      {
        method: 'GET',
        match: /\/connections\/conn-1\/routing$/,
        handler: () => apiError('INTERNAL_ERROR', 500),
      },
    ]);
    renderWithProviders(<ConnectionsPage />, { route: '/connections' });
    expect(await screen.findByText('Не удалось загрузить маршрутизацию')).toBeInTheDocument();
    expect(screen.queryByText('Канал не привязан к CRM')).not.toBeInTheDocument();
  });

  it('объясняет пустой список подключений', async () => {
    installFetch([
      {
        method: 'GET',
        match: /\/operator\/connections\?/,
        handler: () => jsonResponse({ items: [], page: { nextCursor: null } }),
      },
    ]);

    renderWithProviders(<ConnectionsPage />, { route: '/connections' });
    expect(await screen.findByText('Подключений нет')).toBeInTheDocument();
  });

  it('показывает ошибку сети вместо пустого списка', async () => {
    installFetch([
      {
        method: 'GET',
        match: /\/operator\/connections\?/,
        handler: () => {
          throw new TypeError('Failed to fetch');
        },
      },
    ]);

    renderWithProviders(<ConnectionsPage />, { route: '/connections' });

    await waitFor(() =>
      expect(screen.getByText('Не удалось загрузить подключения')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Подключений нет')).not.toBeInTheDocument();
  });
});
