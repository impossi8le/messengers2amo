import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '@/app';
import { useSessionStore } from '@/store/session';
import {
  apiError,
  installFetch,
  jsonResponse,
  type MockRoute,
  renderWithProviders,
  resetStores,
} from '@/test/utils';

const EMPTY_PAGE = { items: [], page: { nextCursor: null } };

function shellRoutes(overrides: MockRoute[] = []): MockRoute[] {
  return [
    {
      method: 'GET',
      match: /\/auth\/session$/,
      handler: () =>
        jsonResponse({
          staffId: 'staff-1',
          companyId: 'company-1',
          role: 'admin',
          workshopId: null,
        }),
    },
    { method: 'GET', match: /\/operator\/work-items\?/, handler: () => jsonResponse(EMPTY_PAGE) },
    {
      method: 'GET',
      match: /\/operator\/staff\/availability/,
      handler: () => jsonResponse(EMPTY_PAGE),
    },
    {
      method: 'GET',
      match: /\/operator\/notifications/,
      handler: () =>
        jsonResponse({
          ...EMPTY_PAGE,
          hints: {
            replyRequiredCount: 0,
            overdueCount: 0,
            unknownSendCount: 0,
          },
        }),
    },
    ...overrides,
  ];
}

const CRM_ROUTES: MockRoute[] = [
  {
    method: 'GET',
    match: /\/operator\/crm\/policy$/,
    handler: () => jsonResponse({ sourceOfTruth: 'platform', version: 4 }),
  },
  {
    method: 'GET',
    match: /\/operator\/crm\/conflicts/,
    handler: () => jsonResponse({ items: [] }),
  },
  { method: 'GET', match: /\/operator\/crm\/bindings/, handler: () => jsonResponse(EMPTY_PAGE) },
];

describe('сессия и защита маршрутов', () => {
  beforeEach(() => {
    resetStores();
  });

  it('без сессии отправляет на вход и возвращает на исходный адрес после входа', async () => {
    const user = userEvent.setup();
    const calls = installFetch([
      {
        method: 'GET',
        match: /\/auth\/session$/,
        handler: () => apiError('UNAUTHENTICATED', 401),
      },
      {
        method: 'POST',
        match: /\/auth\/login$/,
        handler: () =>
          jsonResponse({
            staffId: 'staff-1',
            companyId: 'company-1',
            role: 'admin',
            workshopId: null,
            expiresAt: '2026-10-22T12:00:00.000Z',
          }),
      },
      ...shellRoutes(),
      ...CRM_ROUTES,
    ]);

    renderWithProviders(<App />, { route: '/crm' });

    expect(await screen.findByRole('heading', { level: 1, name: 'Вход' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'CRM' })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Компания'), 'company-1');
    await user.type(screen.getByLabelText('Сотрудник'), 'staff-1');
    await user.type(screen.getByLabelText('Пароль'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'CRM' })).toBeInTheDocument();
    expect(calls.some((call) => call.url.endsWith('/operator/crm/policy'))).toBe(true);
  });

  it('проверяет cookie запросом и пускает в консоль после перезагрузки', async () => {
    const calls = installFetch(shellRoutes());
    renderWithProviders(<App />, { route: '/work-items' });

    expect(await screen.findByRole('heading', { level: 1, name: 'Обращения' })).toBeInTheDocument();
    await waitFor(() => expect(useSessionStore.getState().status).toBe('authenticated'));
    expect(calls.some((call) => /\/auth\/session$/.test(call.url))).toBe(true);
    expect(useSessionStore.getState().role).toBe('admin');
    expect(useSessionStore.getState().companyId).toBe('company-1');
  });

  it('кнопка «Выйти» завершает сессию и ведёт на вход', async () => {
    const user = userEvent.setup();
    useSessionStore.getState().setSession({ role: 'admin', staffId: 'staff-1' });
    const calls = installFetch([
      ...shellRoutes(),
      {
        method: 'POST',
        match: /\/auth\/logout$/,
        handler: () => new Response(null, { status: 204 }),
      },
    ]);

    renderWithProviders(<App />, { route: '/work-items' });
    await screen.findByRole('heading', { level: 1, name: 'Обращения' });

    await user.click(screen.getByRole('button', { name: 'Выйти' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Вход' })).toBeInTheDocument();
    expect(useSessionStore.getState().role).toBeNull();
    expect(useSessionStore.getState().status).toBe('anonymous');
    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/auth/logout'))).toBe(
      true,
    );
  });
});
