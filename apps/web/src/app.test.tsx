import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '@/app';
import { installFetch, jsonResponse, renderWithProviders, resetStores } from '@/test/utils';

const EMPTY_ROUTES = [
  {
    method: 'GET' as const,
    match: /\/auth\/session$/,
    handler: () =>
      jsonResponse({ staffId: 'staff-1', companyId: 'company-1', role: 'read', workshopId: null }),
  },
  {
    method: 'GET' as const,
    match: /\/operator\/work-items\?/,
    handler: () => jsonResponse({ items: [], page: { nextCursor: null } }),
  },
  {
    method: 'GET' as const,
    match: /\/operator\/connections\?/,
    handler: () => jsonResponse({ items: [], page: { nextCursor: null } }),
  },
  {
    method: 'GET' as const,
    match: /\/operator\/staff\/availability/,
    handler: () => jsonResponse({ items: [], page: { nextCursor: null } }),
  },
  {
    method: 'GET' as const,
    match: /\/operator\/crm\/bindings/,
    handler: () => jsonResponse({ items: [], page: { nextCursor: null } }),
  },
];

describe('оболочка приложения', () => {
  beforeEach(() => {
    resetStores();
  });

  it('содержит ориентир для клавиатуры и семантическую навигацию', async () => {
    installFetch(EMPTY_ROUTES);
    renderWithProviders(<App />, { route: '/' });

    expect(screen.getByRole('link', { name: 'Перейти к содержимому' })).toHaveAttribute(
      'href',
      '#main',
    );

    const nav = screen.getByRole('navigation', { name: 'Основная навигация' });
    expect(within(nav).getAllByRole('link')).toHaveLength(6);

    expect(await screen.findByRole('main')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 1, name: 'Обращения' })).toBeInTheDocument();
  });

  it('переходит между разделами по ссылкам навигации', async () => {
    const user = userEvent.setup();
    installFetch(EMPTY_ROUTES);
    renderWithProviders(<App />, { route: '/' });

    await screen.findByRole('heading', { level: 1, name: 'Обращения' });

    await user.click(screen.getByRole('link', { name: 'Подключения' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Подключения' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Диагностика' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Диагностика' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Мастерские' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Мастерские' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'CRM' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'CRM' })).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Смены и нагрузка' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Смены и нагрузка' }),
    ).toBeInTheDocument();
  });

  it('показывает индикатор доступности операторов в шапке', async () => {
    installFetch([
      ...EMPTY_ROUTES.filter((route) => !route.match.test('/operator/staff/availability')),
      {
        method: 'GET' as const,
        match: /\/operator\/staff\/availability/,
        handler: () =>
          jsonResponse({
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
          }),
      },
    ]);
    renderWithProviders(<App />, { route: '/' });

    expect(await screen.findByText('1 на линии')).toBeInTheDocument();
    expect(screen.getByText('1 отошли')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Подробнее' })).toHaveAttribute('href', '/staff');
  });

  it('показывает страницу 404 для неизвестного маршрута', async () => {
    installFetch(EMPTY_ROUTES);
    renderWithProviders(<App />, { route: '/nope' });

    expect(screen.getByRole('heading', { name: 'Страница не найдена' })).toBeInTheDocument();
  });
});
