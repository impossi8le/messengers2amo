import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  apiError,
  installFetch,
  jsonResponse,
  renderWithProviders,
  resetStores,
} from '@/test/utils';
import { CrmPeoplePanel } from './crm-people-panel';

function fixtures(failRefresh = false) {
  return installFetch([
    {
      method: 'GET',
      match: /\/amocrm\/status$/,
      handler: () =>
        jsonResponse({ authorizationEnabled: true, accounts: [{ id: 'acc1', state: 'active' }] }),
    },
    {
      method: 'GET',
      match: /\/amocrm\/directory\?/,
      handler: () =>
        jsonResponse({
          accountId: 'acc1',
          version: 1,
          lastSuccessAt: '2026-10-26T10:00:00Z',
          errorCode: null,
          refreshEnabled: true,
          roles: [{ id: '1', name: 'Sales' }],
          channels: [{ id: 'conn1', name: 'Synthetic channel' }],
          users: [
            {
              id: '11',
              staffId: 'staff11',
              name: 'Synthetic manager',
              isActive: true,
              isCrmAdmin: false,
              roleId: '1',
              roleName: 'Sales',
              groupName: 'Team',
              chatIdentityAvailable: true,
            },
            {
              id: '22',
              staffId: 'staff22',
              name: 'Synthetic admin',
              isActive: true,
              isCrmAdmin: true,
              roleId: null,
              roleName: null,
              groupName: null,
              chatIdentityAvailable: true,
            },
          ],
        }),
    },
    {
      method: 'GET',
      match: /\/connections\/conn1\/crm-access$/,
      handler: () =>
        jsonResponse({
          accountId: 'acc1',
          connectionId: 'conn1',
          version: 2,
          enforced: false,
          grants: [{ crmUserId: '11', role: 'quality' }],
        }),
    },
    {
      method: 'PATCH',
      match: /\/connections\/conn1\/crm-access$/,
      handler: () =>
        jsonResponse({
          accountId: 'acc1',
          connectionId: 'conn1',
          version: 3,
          enforced: true,
          grants: [{ crmUserId: '11', role: 'supervisor' }],
        }),
    },
    {
      method: 'POST',
      match: /\/amocrm\/directory\/refresh$/,
      handler: () =>
        failRefresh ? apiError('UPSTREAM_UNAVAILABLE', 503) : jsonResponse({ accountId: 'acc1' }),
    },
  ]);
}

describe('сотрудники из CRM и права канала', () => {
  beforeEach(resetStores);
  it('показывает исходную CRM-роль отдельно от роли канала и не даёт импортированному админу доступ автоматически', async () => {
    fixtures();
    renderWithProviders(<CrmPeoplePanel />);
    expect(await screen.findByText('Synthetic manager')).toBeInTheDocument();
    expect(screen.getByText('Sales')).toBeInTheDocument();
    expect(screen.getByText('Администратор CRM')).toBeInTheDocument();
    expect(
      await screen.findByRole('combobox', { name: 'Доступ к каналу: Synthetic manager (11)' }),
    ).toHaveValue('quality');
    expect(
      screen.getByRole('combobox', { name: 'Доступ к каналу: Synthetic admin (22)' }),
    ).toHaveValue('none');
  });
  it('сохраняет выбранные роли с версией канала, без смены ответственных или CRM-ролей', async () => {
    const user = userEvent.setup();
    const calls = fixtures();
    renderWithProviders(<CrmPeoplePanel />);
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Доступ к каналу: Synthetic manager (11)' }),
      'supervisor',
    );
    await user.click(screen.getByRole('button', { name: 'Применить права канала' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      accountId: 'acc1',
      expectedVersion: 2,
      grants: [{ crmUserId: '11', role: 'supervisor' }],
    });
    expect(await screen.findByText('Права канала применены.')).toBeInTheDocument();
  });
  it('при ошибке обновления из CRM сохраняет прежний список и несохранённый выбор ролей', async () => {
    const user = userEvent.setup();
    const calls = fixtures(true);
    renderWithProviders(<CrmPeoplePanel />);
    const select = await screen.findByRole('combobox', {
      name: 'Доступ к каналу: Synthetic manager (11)',
    });
    await user.selectOptions(select, 'manager');
    await user.click(screen.getByRole('button', { name: 'Обновить данные из CRM' }));
    expect(await screen.findByText('Не выполнено')).toBeInTheDocument();
    expect(screen.getByText('Synthetic manager')).toBeInTheDocument();
    expect(select).toHaveValue('manager');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ accountId: 'acc1' });
  });
});
