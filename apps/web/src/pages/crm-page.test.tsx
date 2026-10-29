import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '@/api/types';
import { CrmPage } from '@/pages/crm-page';
import { useSessionStore } from '@/store/session';
import {
  apiError,
  installFetch,
  jsonResponse,
  type MockRoute,
  renderWithProviders,
  resetStores,
} from '@/test/utils';

const POLICY = { sourceOfTruth: 'platform', version: 4 };

const CONFLICTS = {
  items: [
    {
      id: 'confA',
      accountId: 'accA',
      conversationId: 'convA',
      crmOwnerRef: 'amo-user-9',
      platformOwnerId: 'owner1',
      desiredCrmOwnerRef: 'amo-user-1',
      policy: 'platform',
      winner: 'platform',
      state: 'open',
      detectedAt: '2026-10-21T09:00:00.000Z',
    },
  ],
};

function baseRoutes(overrides: MockRoute[] = []): MockRoute[] {
  return [
    {
      method: 'GET',
      match: /\/operator\/crm\/policy$/,
      handler: () => jsonResponse(POLICY),
    },
    {
      method: 'GET',
      match: /\/operator\/crm\/conflicts/,
      handler: () => jsonResponse(CONFLICTS),
    },
    ...overrides,
  ];
}

function setRole(role: Role | null) {
  useSessionStore.setState({ role, staffId: null, workshopId: null });
}

describe('страница CRM', () => {
  beforeEach(() => {
    resetStores();
    setRole(null);
  });

  it('показывает политику и конфликты владельцев всем', async () => {
    installFetch(baseRoutes());
    renderWithProviders(<CrmPage />, { route: '/crm' });

    expect(await screen.findByRole('heading', { level: 1, name: 'CRM' })).toBeInTheDocument();
    expect(await screen.findByText('версия 4')).toBeInTheDocument();
    expect(await screen.findByText('amo-user-9')).toBeInTheDocument();
    expect(screen.getAllByText('Платформа назначает ответственного').length).toBeGreaterThan(0);
  });

  it('скрывает смену политики для роли ниже admin', async () => {
    setRole('send');
    installFetch(baseRoutes());
    renderWithProviders(<CrmPage />, { route: '/crm' });

    await screen.findByText('версия 4');

    expect(screen.queryByRole('button', { name: 'Сохранить политику' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.getByText('Смена политики доступна только администратору.')).toBeInTheDocument();
  });

  it('меняет политику с ожидаемой версией для admin', async () => {
    const user = userEvent.setup();
    setRole('admin');
    const calls = installFetch(
      baseRoutes([
        {
          method: 'POST',
          match: /\/operator\/crm\/policy$/,
          handler: () => jsonResponse({ sourceOfTruth: 'crm', version: 5 }),
        },
      ]),
    );
    renderWithProviders(<CrmPage />, { route: '/crm' });

    await screen.findByRole('radio', { name: 'amoCRM назначает ответственного' });
    await user.click(screen.getByRole('radio', { name: 'amoCRM назначает ответственного' }));
    await user.click(screen.getByRole('button', { name: 'Сохранить политику' }));

    expect(await screen.findByText('Политика обновлена.')).toBeInTheDocument();
    const call = calls.find((item) => item.url.endsWith('/crm/policy') && item.method === 'POST');
    expect(call?.body).toEqual({ sourceOfTruth: 'crm', expectedVersion: 4 });
  });

  it('показывает отказ по роли при смене политики', async () => {
    const user = userEvent.setup();
    setRole('admin');
    installFetch(
      baseRoutes([
        {
          method: 'POST',
          match: /\/operator\/crm\/policy$/,
          handler: () => apiError('FORBIDDEN', 403),
        },
      ]),
    );
    renderWithProviders(<CrmPage />, { route: '/crm' });

    await screen.findByRole('radio', { name: 'amoCRM назначает ответственного' });
    await user.click(screen.getByRole('radio', { name: 'amoCRM назначает ответственного' }));
    await user.click(screen.getByRole('button', { name: 'Сохранить политику' }));

    expect(
      await screen.findByText('Менять политику назначений может только администратор.'),
    ).toBeInTheDocument();
  });

  it('запускает ресинхронизацию и показывает результат', async () => {
    const user = userEvent.setup();
    const calls = installFetch(
      baseRoutes([
        {
          method: 'POST',
          match: /\/operator\/crm\/resync$/,
          handler: () =>
            jsonResponse({
              status: 'ok',
              replayed: false,
              leadId: 'lead-1',
              crmOwnerRef: 'amo-user-1',
              errorCode: null,
            }),
        },
      ]),
    );
    renderWithProviders(<CrmPage />, { route: '/crm' });

    await user.type(await screen.findByLabelText('Аккаунт amoCRM'), 'accA');
    await user.type(screen.getByLabelText('Диалог'), 'convA');
    await user.click(screen.getByRole('button', { name: 'Синхронизировать' }));

    expect(await screen.findByText('Результат синхронизации')).toBeInTheDocument();
    expect(screen.getByText('Синхронизировано')).toBeInTheDocument();
    const call = calls.find((item) => item.url.endsWith('/crm/resync'));
    expect(call).toBeDefined();
    expect(call?.body).toMatchObject({ accountId: 'accA', conversationId: 'convA' });
    const body = call?.body as { idempotencyKey?: string } | undefined;
    expect(body?.idempotencyKey).toEqual(expect.any(String));
  });

  it('сообщает о пропавшей сделке как о предупреждении', async () => {
    const user = userEvent.setup();
    installFetch(
      baseRoutes([
        {
          method: 'POST',
          match: /\/operator\/crm\/resync$/,
          handler: () =>
            jsonResponse({
              status: 'lead_missing',
              replayed: true,
              leadId: null,
              crmOwnerRef: 'amo-user-5',
              errorCode: 'crm_lead_missing',
            }),
        },
      ]),
    );
    renderWithProviders(<CrmPage />, { route: '/crm' });

    await user.type(await screen.findByLabelText('Аккаунт amoCRM'), 'accA');
    await user.type(screen.getByLabelText('Диалог'), 'convA');
    await user.click(screen.getByRole('button', { name: 'Синхронизировать' }));

    expect(await screen.findByText('Сделка не найдена в amoCRM')).toBeInTheDocument();
    expect(screen.getByText('повтор запроса')).toBeInTheDocument();
  });

  it('показывает ошибку сети при ресинхронизации', async () => {
    const user = userEvent.setup();
    installFetch(
      baseRoutes([
        {
          method: 'POST',
          match: /\/operator\/crm\/resync$/,
          handler: () => {
            throw new TypeError('Failed to fetch');
          },
        },
      ]),
    );
    renderWithProviders(<CrmPage />, { route: '/crm' });

    await user.type(await screen.findByLabelText('Аккаунт amoCRM'), 'accA');
    await user.type(screen.getByLabelText('Диалог'), 'convA');
    await user.click(screen.getByRole('button', { name: 'Синхронизировать' }));

    expect(await screen.findByText('Синхронизация не выполнена')).toBeInTheDocument();
    expect(screen.getByText(/Нет связи с сервером/)).toBeInTheDocument();
  });

  it('показывает диагностику связки по запросу', async () => {
    const user = userEvent.setup();
    installFetch(
      baseRoutes([
        {
          method: 'GET',
          match: /\/operator\/crm\/diagnostics/,
          handler: () =>
            jsonResponse({
              sync: {
                status: 'lead_missing',
                result: null,
                errorCode: 'crm_lead_missing',
                lastAttemptAt: '2026-10-21T09:00:00.000Z',
                lastSuccessAt: null,
              },
              leadMissing: true,
              projection: null,
              openConflicts: 1,
              binding: null,
              cardUrl: null,
            }),
        },
      ]),
    );
    renderWithProviders(<CrmPage />, { route: '/crm' });

    await user.type(await screen.findByLabelText('Аккаунт amoCRM для диагностики'), 'accA');
    await user.type(screen.getByLabelText('Диалог для диагностики'), 'convA');
    await user.click(screen.getByRole('button', { name: 'Показать диагностику' }));

    expect(await screen.findByText('не найдена в amoCRM')).toBeInTheDocument();
    expect(screen.getByText('Ошибка синхронизации')).toBeInTheDocument();
    expect(screen.getByText(/Проекции нет/)).toBeInTheDocument();
  });

  it('даёт перейти в связанную карточку amoCRM из диагностики', async () => {
    const user = userEvent.setup();
    installFetch(
      baseRoutes([
        {
          method: 'GET',
          match: /\/operator\/crm\/diagnostics/,
          handler: () =>
            jsonResponse({
              sync: null,
              leadMissing: false,
              projection: null,
              openConflicts: 0,
              binding: {
                accountId: 'accA',
                contactId: 'contact-1',
                leadId: 'lead-1',
                chatId: 'chat-1',
                state: 'bound',
              },
              cardUrl: 'https://p14lenrem.amocrm.ru/leads/detail/lead-1',
            }),
        },
      ]),
    );
    renderWithProviders(<CrmPage />, { route: '/crm' });

    await user.type(await screen.findByLabelText('Аккаунт amoCRM для диагностики'), 'accA');
    await user.type(screen.getByLabelText('Диалог для диагностики'), 'convA');
    await user.click(screen.getByRole('button', { name: 'Показать диагностику' }));

    const link = await screen.findByRole('link', { name: 'Открыть карточку в amoCRM' });
    expect(link).toHaveAttribute('href', 'https://p14lenrem.amocrm.ru/leads/detail/lead-1');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    expect(screen.getByText(/Сделка: lead-1/)).toBeInTheDocument();
  });

  it('не показывает ссылку на карточку, если связки или домена нет', async () => {
    const user = userEvent.setup();
    installFetch(
      baseRoutes([
        {
          method: 'GET',
          match: /\/operator\/crm\/diagnostics/,
          handler: () =>
            jsonResponse({
              sync: null,
              leadMissing: false,
              projection: null,
              openConflicts: 0,
              binding: null,
              cardUrl: null,
            }),
        },
      ]),
    );
    renderWithProviders(<CrmPage />, { route: '/crm' });

    await user.type(await screen.findByLabelText('Аккаунт amoCRM для диагностики'), 'accA');
    await user.type(screen.getByLabelText('Диалог для диагностики'), 'convA');
    await user.click(screen.getByRole('button', { name: 'Показать диагностику' }));

    await screen.findByText('Проекции нет: связь не создана или отключена.');
    expect(
      screen.queryByRole('link', { name: 'Открыть карточку в amoCRM' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Связки с CRM нет.')).toBeInTheDocument();
  });

  it('не путает пустой список конфликтов с ошибкой загрузки', async () => {
    installFetch([
      {
        method: 'GET',
        match: /\/operator\/crm\/policy$/,
        handler: () => jsonResponse(POLICY),
      },
      {
        method: 'GET',
        match: /\/operator\/crm\/conflicts/,
        handler: () => {
          throw new TypeError('Failed to fetch');
        },
      },
    ]);
    renderWithProviders(<CrmPage />, { route: '/crm' });

    await waitFor(() => expect(screen.getByText('Конфликты недоступны')).toBeInTheDocument());
    expect(screen.queryByText('Конфликтов нет')).not.toBeInTheDocument();
  });
});
