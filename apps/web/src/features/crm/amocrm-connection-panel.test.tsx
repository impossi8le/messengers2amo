import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AmocrmConnectionPanel } from '@/features/crm/amocrm-connection-panel';
import { formatDateTime } from '@/lib/format';
import {
  installFetch,
  jsonResponse,
  type RecordedCall,
  renderWithProviders,
  resetStores,
} from '@/test/utils';

// Сайт согласия в jsdom недоступен: проверяем, что кнопка открывает именно
// всплывающее окно OAuth, а адрес собирается отдельно.
const startAuthorization = vi.hoisted(() => vi.fn());
vi.mock('@/lib/amocrm', () => ({
  AMOCRM_AUTHORIZE_URL: '/api/v2/integrations/amocrm/oauth/authorize',
  startAmocrmAuthorization: startAuthorization,
  isAmocrmOAuthMessage: (
    data: unknown,
  ): data is { type: string; status: string; message?: string } => {
    if (!data || typeof data !== 'object') return false;
    const record = data as Record<string, unknown>;
    return record.type === 'amocrm-oauth' && (record.status === 'ok' || record.status === 'error');
  },
}));

function callsMatching(calls: RecordedCall[], pattern: RegExp): RecordedCall[] {
  return calls.filter((call) => pattern.test(call.url));
}

let currentPopup: Window;

function dispatchOAuthMessage(data: Record<string, unknown>, origin = window.location.origin) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, origin, source: currentPopup }));
  });
}

const PAGE = { nextCursor: null };

function routes(
  bindings: Record<string, unknown>,
  oauthActive = Boolean((bindings.items as unknown[])?.length),
) {
  return installFetch([
    {
      method: 'GET',
      match: /\/operator\/amocrm\/status/,
      handler: () =>
        jsonResponse({
          authorizationEnabled: true,
          accounts: oauthActive
            ? [
                {
                  id: 'accA',
                  state: 'active',
                  refreshFailureCount: 0,
                  lastAuthorizedAt: null,
                  lastRefreshedAt: null,
                },
              ]
            : [],
        }),
    },
    {
      method: 'GET',
      match: /\/operator\/crm\/bindings/,
      handler: () => jsonResponse(bindings),
    },
    {
      method: 'GET',
      match: /\/operator\/crm\/diagnostics/,
      handler: () =>
        jsonResponse({
          sync: {
            status: 'ok',
            result: null,
            errorCode: null,
            lastAttemptAt: '2026-10-21T09:00:00.000Z',
            lastSuccessAt: '2026-10-21T08:30:00.000Z',
          },
          leadMissing: false,
          projection: null,
          openConflicts: 0,
          binding: null,
          cardUrl: null,
        }),
    },
  ]);
}

const BOUND = {
  items: [
    {
      id: 'bind-1',
      conversationId: 'convA',
      crmAccountId: 'accA',
      contactId: 'contact-1',
      leadId: 'lead-1',
      chatId: 'chat-1',
      version: 2,
      state: 'bound',
    },
  ],
  page: PAGE,
};

function fakePopup(): Window {
  return { closed: false, focus: vi.fn() } as unknown as Window;
}

describe('блок подключения amoCRM', () => {
  beforeEach(() => {
    resetStores();
    startAuthorization.mockReset();
    currentPopup = fakePopup();
    startAuthorization.mockReturnValue({ opened: true, popup: currentPopup });
  });

  it('показывает кнопку подключения администратору, если связки нет', async () => {
    routes({ items: [], page: PAGE });
    renderWithProviders(<AmocrmConnectionPanel isAdmin={true} />, { route: '/crm' });

    expect(await screen.findByText('Связка не настроена')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Подключить amoCRM' })).toBeInTheDocument();
  });

  it('не показывает кнопку подключения роли ниже admin', async () => {
    routes({ items: [], page: PAGE });
    renderWithProviders(<AmocrmConnectionPanel isAdmin={false} />, { route: '/crm' });

    expect(await screen.findByText('Связка не настроена')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Подключить amoCRM' })).not.toBeInTheDocument();
    expect(screen.getByText('Подключение выполняет администратор.')).toBeInTheDocument();
  });

  it('показывает состояние связки и дату последней успешной синхронизации', async () => {
    routes(BOUND);
    renderWithProviders(<AmocrmConnectionPanel isAdmin={true} />, { route: '/crm' });

    expect(await screen.findByText('Связка настроена')).toBeInTheDocument();
    expect(screen.getByText('Привязано')).toBeInTheDocument();
    expect(screen.getByText('Последняя успешная синхронизация')).toBeInTheDocument();
    expect(
      (await screen.findAllByText(formatDateTime('2026-10-21T08:30:00.000Z'))).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Подключить amoCRM' })).not.toBeInTheDocument();
  });

  it('открывает OAuth amoCRM переходом на серверный адрес', async () => {
    const user = userEvent.setup();
    routes({ items: [], page: PAGE });
    renderWithProviders(<AmocrmConnectionPanel isAdmin={true} />, { route: '/crm' });

    await user.click(await screen.findByRole('button', { name: 'Подключить amoCRM' }));

    expect(startAuthorization).toHaveBeenCalledOnce();
  });

  it('не путает пустой список связок с ошибкой загрузки', async () => {
    routes({ items: [], page: PAGE });
    renderWithProviders(<AmocrmConnectionPanel isAdmin={false} />, { route: '/crm' });

    await screen.findByText('Связка не настроена');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('при заблокированном всплывающем окне показывает ошибку и ручную ссылку', async () => {
    const user = userEvent.setup();
    startAuthorization.mockReturnValue({
      opened: false,
      url: '/api/v2/integrations/amocrm/oauth/authorize',
    });
    routes({ items: [], page: PAGE });
    renderWithProviders(<AmocrmConnectionPanel isAdmin={true} />, { route: '/crm' });

    await user.click(await screen.findByRole('button', { name: 'Подключить amoCRM' }));

    expect(await screen.findByText('Браузер заблокировал всплывающее окно')).toBeInTheDocument();
    const manual = screen.getByRole('link', { name: 'Открыть страницу согласия вручную' });
    expect(manual).toHaveAttribute('href', '/api/v2/integrations/amocrm/oauth/authorize');
    expect(manual).toHaveAttribute('target', '_blank');
  });

  it('после сообщения ok перезапрашивает связки и диагностику и показывает подключение', async () => {
    const user = userEvent.setup();
    const calls = routes(BOUND);
    renderWithProviders(<AmocrmConnectionPanel isAdmin={true} />, { route: '/crm' });

    await screen.findByText('Связка настроена');
    await user.click(await screen.findByRole('button', { name: 'Переподключить amoCRM' }));
    const bindingsBefore = callsMatching(calls, /\/operator\/crm\/bindings/).length;
    const diagnosticsBefore = callsMatching(calls, /\/operator\/crm\/diagnostics/).length;

    dispatchOAuthMessage({ type: 'amocrm-oauth', status: 'ok' });

    expect(await screen.findByText('amoCRM подключена')).toBeInTheDocument();
    await waitFor(() => {
      expect(callsMatching(calls, /\/operator\/crm\/bindings/).length).toBe(bindingsBefore + 1);
      expect(callsMatching(calls, /\/operator\/crm\/diagnostics/).length).toBe(
        diagnosticsBefore + 1,
      );
    });
  });

  it('показывает текст ошибки из сообщения callback-страницы', async () => {
    const user = userEvent.setup();
    routes({ items: [], page: PAGE });
    renderWithProviders(<AmocrmConnectionPanel isAdmin={true} />, { route: '/crm' });

    await screen.findByText('Связка не настроена');
    await user.click(await screen.findByRole('button', { name: 'Подключить amoCRM' }));
    dispatchOAuthMessage({
      type: 'amocrm-oauth',
      status: 'error',
      message: 'Код авторизации отклонён или истёк.',
    });

    expect(await screen.findByText('Код авторизации отклонён или истёк.')).toBeInTheDocument();
    expect(screen.getByText('Не удалось подключить amoCRM')).toBeInTheDocument();
  });

  it('после ручного закрытия окна делает один перезапрос по focus', async () => {
    const user = userEvent.setup();
    const calls = routes({ items: [], page: PAGE });
    renderWithProviders(<AmocrmConnectionPanel isAdmin={true} />, { route: '/crm' });

    await user.click(await screen.findByRole('button', { name: 'Подключить amoCRM' }));
    const before = callsMatching(calls, /\/operator\/crm\/bindings/).length;
    (currentPopup as unknown as { closed: boolean }).closed = true;

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => {
      expect(callsMatching(calls, /\/operator\/crm\/bindings/).length).toBe(before + 1);
    });
    expect(screen.getByRole('button', { name: 'Подключить amoCRM' })).toBeEnabled();
  });

  it('игнорирует сообщения других типов', async () => {
    const calls = routes({ items: [], page: PAGE });
    renderWithProviders(<AmocrmConnectionPanel isAdmin={true} />, { route: '/crm' });

    await screen.findByText('Связка не настроена');
    const before = callsMatching(calls, /\/operator\/crm\/bindings/).length;
    dispatchOAuthMessage({ type: 'something-else', status: 'ok' });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(callsMatching(calls, /\/operator\/crm\/bindings/).length).toBe(before);
    expect(screen.queryByText('amoCRM подключена')).not.toBeInTheDocument();
  });

  it('показывает выданный OAuth даже без единой привязки диалога', async () => {
    routes({ items: [], page: PAGE }, true);
    renderWithProviders(<AmocrmConnectionPanel isAdmin={true} />);
    expect((await screen.findAllByText('Доступ выдан')).length).toBeGreaterThan(0);
    expect(screen.getByText('Связка не настроена')).toBeInTheDocument();
    expect(screen.queryByText(/подключение не начиналось/)).not.toBeInTheDocument();
  });

  it('игнорирует OAuth callback с чужого origin даже при открытом окне', async () => {
    const user = userEvent.setup();
    const calls = routes({ items: [], page: PAGE });
    renderWithProviders(<AmocrmConnectionPanel isAdmin={true} />);
    await user.click(await screen.findByRole('button', { name: 'Подключить amoCRM' }));
    const before = callsMatching(calls, /\/operator\/amocrm\/status/).length;
    dispatchOAuthMessage({ type: 'amocrm-oauth', status: 'ok' }, 'https://foreign.example');
    expect(callsMatching(calls, /\/operator\/amocrm\/status/).length).toBe(before);
    expect(screen.queryByText('amoCRM подключена')).not.toBeInTheDocument();
  });

  it('привязанный диалог не означает, что OAuth-доступ выдан', async () => {
    routes(BOUND, false);
    renderWithProviders(<AmocrmConnectionPanel isAdmin={true} />);
    expect(await screen.findByText('Доступ не выдан')).toBeInTheDocument();
    expect(screen.getByText('Связка настроена')).toBeInTheDocument();
  });
});
