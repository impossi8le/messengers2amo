import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '@/api/types';
import { WorkshopsPage } from '@/pages/workshops-page';
import { useSessionStore } from '@/store/session';
import {
  apiError,
  installFetch,
  jsonResponse,
  type MockRoute,
  renderWithProviders,
  resetStores,
} from '@/test/utils';

const WORKSHOPS = {
  items: [
    { id: 'wA', displayName: 'Мастерская A' },
    { id: 'wB', displayName: null },
  ],
};

const ROUTES = {
  items: [
    {
      connectionId: 'connA',
      workshopId: 'wA',
      crmAccountId: 'accA',
      funnelId: 'funnel-1',
      defaultOwnerId: 'owner1',
      technicalSourceId: 'srcA',
      version: 2,
    },
  ],
};

const PERMISSIONS = {
  items: [{ connectionId: 'connA', staffId: 'agent1', canRead: true, canSend: false }],
};

const GROUPS = {
  items: [
    {
      connectionId: 'connA',
      bindingEpoch: 1,
      externalChatId: 'group-1',
      decision: 'exclude',
      displayName: 'Sales',
      version: 3,
    },
  ],
};

function baseRoutes(overrides: MockRoute[] = []): MockRoute[] {
  return [
    {
      method: 'GET',
      match: /\/operator\/workshops$/,
      handler: () => jsonResponse(WORKSHOPS),
    },
    {
      method: 'GET',
      match: /\/operator\/workshops\/wA\/routes$/,
      handler: () => jsonResponse(ROUTES),
    },
    {
      method: 'GET',
      match: /\/operator\/workshops\/wA\/permissions$/,
      handler: () => jsonResponse(PERMISSIONS),
    },
    {
      method: 'GET',
      match: /\/operator\/workshops\/wA\/groups/,
      handler: () => jsonResponse(GROUPS),
    },
    {
      method: 'GET',
      match: /\/operator\/connections\?/,
      handler: () => jsonResponse({ items: [], page: { nextCursor: null } }),
    },
    ...overrides,
  ];
}

function setRole(role: Role | null) {
  useSessionStore.setState({ role, staffId: null, workshopId: null });
}

describe('страница мастерских', () => {
  beforeEach(() => {
    resetStores();
    setRole(null);
  });

  it('показывает список, маршруты, права и правила групп', async () => {
    installFetch(baseRoutes());
    renderWithProviders(<WorkshopsPage />, { route: '/workshops' });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Мастерские' }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Мастерская A/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Без названия/ })).toBeInTheDocument();

    expect(await screen.findByText('funnel-1')).toBeInTheDocument();
    expect(await screen.findByText('agent1')).toBeInTheDocument();
    expect(await screen.findByText('Исключить')).toBeInTheDocument();
  });

  it('разделяет права чтения и отправки', async () => {
    installFetch(baseRoutes());
    renderWithProviders(<WorkshopsPage />, { route: '/workshops' });

    const row = (await screen.findByText('agent1')).closest('tr');
    expect(row).not.toBeNull();
    const cells = within(row as HTMLElement).getAllByRole('cell');
    expect(cells[2]).toHaveTextContent('разрешено');
    expect(cells[3]).toHaveTextContent('нет');
  });

  it('скрывает создание и правку для роли ниже admin', async () => {
    setRole('manage');
    installFetch(baseRoutes());
    renderWithProviders(<WorkshopsPage />, { route: '/workshops' });

    await screen.findByText('funnel-1');

    expect(screen.queryByRole('heading', { name: 'Новая мастерская' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Сохранить маршрут' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Сохранить правило' })).not.toBeInTheDocument();
  });

  it('показывает формы создания и правки администратору', async () => {
    setRole('admin');
    installFetch(baseRoutes());
    renderWithProviders(<WorkshopsPage />, { route: '/workshops' });

    expect(await screen.findByRole('heading', { name: 'Новая мастерская' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Сохранить маршрут' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Сохранить правило' })).toBeInTheDocument();
  });

  it('создаёт мастерскую и валидирует идентификатор', async () => {
    const user = userEvent.setup();
    setRole('admin');
    const calls = installFetch(
      baseRoutes([
        {
          method: 'POST',
          match: /\/operator\/workshops$/,
          handler: () => jsonResponse({ id: 'wC', displayName: 'Мастерская C' }, 201),
        },
      ]),
    );
    renderWithProviders(<WorkshopsPage />, { route: '/workshops' });

    await user.click(await screen.findByRole('button', { name: 'Создать мастерскую' }));
    expect(await screen.findByText('Укажите идентификатор мастерской')).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);

    await user.type(screen.getByLabelText('Идентификатор'), 'wC');
    await user.type(screen.getByLabelText('Название'), 'Мастерская C');
    await user.click(screen.getByRole('button', { name: 'Создать мастерскую' }));

    expect(await screen.findByText('Мастерская создана.')).toBeInTheDocument();
    const call = calls.find((item) => item.method === 'POST');
    expect(call?.body).toEqual({ id: 'wC', displayName: 'Мастерская C' });
  });

  it('сохраняет маршрут с текущей версией и сообщает о конфликте', async () => {
    const user = userEvent.setup();
    setRole('admin');
    const calls = installFetch(
      baseRoutes([
        {
          method: 'POST',
          match: /\/operator\/workshops\/wA\/routes$/,
          handler: () => apiError('VERSION_CONFLICT', 409),
        },
      ]),
    );
    renderWithProviders(<WorkshopsPage />, { route: '/workshops' });

    await user.type(await screen.findByLabelText('Подключение'), 'connA');
    await user.type(screen.getByLabelText('Аккаунт amoCRM'), 'accA');
    await user.type(screen.getByLabelText('Воронка'), 'funnel-2');
    await user.type(screen.getByLabelText('Ответственный по умолчанию'), 'owner1');
    await user.type(screen.getByLabelText('Технический источник'), 'srcA');
    await user.click(screen.getByRole('button', { name: 'Сохранить маршрут' }));

    expect(await screen.findByText('Не сохранено')).toBeInTheDocument();
    const call = calls.find((item) => item.url.endsWith('/routes') && item.method === 'POST');
    expect(call?.body).toMatchObject({ connectionId: 'connA', expectedVersion: 2 });
  });

  it('показывает ошибку сети вместо пустого списка', async () => {
    installFetch([
      {
        method: 'GET',
        match: /\/operator\/workshops$/,
        handler: () => {
          throw new TypeError('Failed to fetch');
        },
      },
    ]);
    renderWithProviders(<WorkshopsPage />, { route: '/workshops' });

    await waitFor(() =>
      expect(screen.getByText('Не удалось загрузить мастерские')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Мастерских нет')).not.toBeInTheDocument();
  });

  it('объясняет пустой список', async () => {
    installFetch([
      {
        method: 'GET',
        match: /\/operator\/workshops$/,
        handler: () => jsonResponse({ items: [] }),
      },
    ]);
    renderWithProviders(<WorkshopsPage />, { route: '/workshops' });

    expect(await screen.findByText('Мастерских нет')).toBeInTheDocument();
  });
});
