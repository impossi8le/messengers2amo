import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkItem } from '@/api/types';
import { WorkItemsPage } from '@/pages/work-items-page';
import {
  apiError,
  installFetch,
  jsonResponse,
  networkFailure,
  renderWithProviders,
  resetStores,
} from '@/test/utils';

const WORK_ITEMS: WorkItem[] = [
  {
    id: 'wi-1001',
    conversationId: 'conv-alpha',
    assignmentVersion: 3,
    state: 'queued',
    owner: null,
  },
  {
    id: 'wi-1002',
    conversationId: 'conv-beta',
    assignmentVersion: 1,
    state: 'in_progress',
    owner: 'staff-ivanov',
  },
  {
    id: 'wi-1003',
    conversationId: 'conv-gamma',
    assignmentVersion: 2,
    state: 'waiting_customer',
    owner: 'staff-ivanov',
  },
  {
    id: 'wi-1004',
    conversationId: 'conv-delta',
    assignmentVersion: 5,
    state: 'resolved',
    owner: 'staff-petrova',
  },
];

function listRoute(items: WorkItem[]) {
  return {
    method: 'GET',
    match: /\/operator\/work-items\?/,
    handler: () => jsonResponse({ items, page: { nextCursor: null } }),
  };
}

describe('список обращений', () => {
  beforeEach(() => {
    resetStores();
  });

  it('рендерит строки из API с состоянием и ответственным', async () => {
    installFetch([listRoute(WORK_ITEMS)]);
    renderWithProviders(<WorkItemsPage />, { route: '/work-items' });

    expect(screen.getByRole('heading', { name: 'Обращения' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'wi-1001' })).toBeInTheDocument();

    const table = screen.getByRole('table');
    expect(within(table).getByText('conv-alpha')).toBeInTheDocument();
    expect(within(table).getByText('В очереди')).toBeInTheDocument();
    expect(within(table).getByText('Ждём клиента')).toBeInTheDocument();
    expect(within(table).getAllByText('staff-ivanov')).toHaveLength(2);
    expect(within(table).getByText('не назначен')).toBeInTheDocument();
  });

  it('фильтрует обращения, ожидающие ответа оператора', async () => {
    const user = userEvent.setup();
    installFetch([listRoute(WORK_ITEMS)]);
    renderWithProviders(<WorkItemsPage />, { route: '/work-items' });

    await screen.findByRole('link', { name: 'wi-1001' });

    await user.click(screen.getByRole('radio', { name: 'Ждут ответа' }));

    expect(screen.getByRole('link', { name: 'wi-1001' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'wi-1002' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'wi-1003' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'wi-1004' })).not.toBeInTheDocument();
  });

  it('ищет по идентификатору диалога и показывает пустое состояние', async () => {
    const user = userEvent.setup();
    installFetch([listRoute(WORK_ITEMS)]);
    renderWithProviders(<WorkItemsPage />, { route: '/work-items' });

    await screen.findByRole('link', { name: 'wi-1001' });
    await user.type(screen.getByLabelText('Поиск'), 'conv-gamma');

    expect(screen.getByRole('link', { name: 'wi-1003' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'wi-1001' })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Поиск'), 'нет-такого');
    expect(screen.getByText('Ничего не найдено')).toBeInTheDocument();
  });

  it('показывает явную ошибку сети и позволяет повторить', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    installFetch([
      {
        method: 'GET',
        match: /\/operator\/work-items\?/,
        handler: () => {
          attempt += 1;
          if (attempt === 1) return networkFailure();
          return jsonResponse({ items: WORK_ITEMS, page: { nextCursor: null } });
        },
      },
    ]);

    renderWithProviders(<WorkItemsPage />, { route: '/work-items' });

    expect(await screen.findByText('Не удалось загрузить обращения')).toBeInTheDocument();
    expect(screen.getByText(/Нет связи с сервером/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('link', { name: 'wi-1001' })).toBeInTheDocument();
  });

  it('показывает ошибку сервера с кодом, не выдавая её за пустой список', async () => {
    installFetch([
      {
        method: 'GET',
        match: /\/operator\/work-items\?/,
        handler: () => apiError('UPSTREAM_UNAVAILABLE', 503, true),
      },
    ]);

    renderWithProviders(<WorkItemsPage />, { route: '/work-items' });

    expect(await screen.findByText('Не удалось загрузить обращения')).toBeInTheDocument();
    expect(screen.getByText(/Внешний провайдер недоступен/)).toBeInTheDocument();
    expect(screen.queryByText('Обращений нет')).not.toBeInTheDocument();
  });

  it('доступен с клавиатуры: поиск и сортировка колонок', async () => {
    const user = userEvent.setup();
    installFetch([listRoute(WORK_ITEMS)]);
    renderWithProviders(<WorkItemsPage />, { route: '/work-items' });

    await screen.findByRole('link', { name: 'wi-1001' });

    const search = screen.getByLabelText('Поиск');
    search.focus();
    expect(search).toHaveFocus();

    const sortButton = screen.getByRole('button', { name: 'Состояние' });
    sortButton.focus();
    expect(sortButton).toHaveFocus();

    const header = sortButton.closest('th');
    expect(header).toHaveAttribute('aria-sort', 'ascending');

    await user.keyboard('{Enter}');
    await waitFor(() => expect(header).toHaveAttribute('aria-sort', 'descending'));
  });

  it('сообщает о пустой очереди отдельно от фильтра', async () => {
    installFetch([listRoute([])]);
    renderWithProviders(<WorkItemsPage />, { route: '/work-items' });

    expect(await screen.findByText('Обращений нет')).toBeInTheDocument();
  });
});
