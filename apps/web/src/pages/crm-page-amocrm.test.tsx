import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '@/api/types';
import { CrmPage } from '@/pages/crm-page';
import { useSessionStore } from '@/store/session';
import { installFetch, jsonResponse, renderWithProviders, resetStores } from '@/test/utils';

const EMPTY = { items: [], page: { nextCursor: null } };

function routes() {
  return installFetch([
    {
      method: 'GET',
      match: /\/operator\/amocrm\/status$/,
      handler: () => jsonResponse({ authorizationEnabled: true, accounts: [] }),
    },
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
    { method: 'GET', match: /\/operator\/crm\/bindings/, handler: () => jsonResponse(EMPTY) },
  ]);
}

function setRole(role: Role | null) {
  useSessionStore.setState({ role, staffId: null, workshopId: null });
}

describe('страница CRM: подключение amoCRM', () => {
  beforeEach(() => {
    resetStores();
  });

  it('показывает блок подключения и кнопку администратору', async () => {
    setRole('admin');
    routes();
    renderWithProviders(<CrmPage />, { route: '/crm' });

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Подключение к amoCRM' }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Подключить amoCRM' })).toBeInTheDocument();
  });

  it('скрывает кнопку подключения для роли send', async () => {
    setRole('send');
    routes();
    renderWithProviders(<CrmPage />, { route: '/crm' });

    expect(await screen.findByText('Связка не настроена')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Подключить amoCRM' })).not.toBeInTheDocument();
    expect(screen.getByText('Подключение выполняет администратор.')).toBeInTheDocument();
  });
});
