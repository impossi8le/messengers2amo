import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  apiError,
  installFetch,
  jsonResponse,
  renderWithProviders,
  resetStores,
} from '@/test/utils';
import { ConnectionSetup } from './connection-setup';

beforeEach(resetStores);
const readRoutes = [
  {
    method: 'GET',
    match: /\/connections\/setup-options$/,
    handler: () =>
      jsonResponse({
        enabled: true,
        workshops: [{ id: 'w1', displayName: 'Мастерская' }],
        sources: [{ id: 'src1', externalId: 'source1', name: 'Чаты' }],
      }),
  },
  {
    method: 'GET',
    match: /\/amocrm\/pipelines$/,
    handler: () =>
      jsonResponse({
        items: [
          {
            id: '1',
            name: 'Продажи',
            stages: [
              { id: '10', name: 'Новый', isFinal: false },
              { id: '142', name: 'Закрыт', isFinal: true },
            ],
          },
        ],
      }),
  },
];

it('проходит три шага, сохраняет выключенный канал и не кладёт токен в Redux', async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  const calls = installFetch([
    ...readRoutes,
    {
      method: 'POST',
      match: /\/connections\/verify-telegram$/,
      handler: () => jsonResponse({ providerId: '123', displayName: 'Тестовый бот' }),
    },
    {
      method: 'POST',
      match: /\/connections\/setup-telegram$/,
      handler: () => jsonResponse({ id: 'new', state: 'setup' }),
    },
  ]);
  const { store } = renderWithProviders(<ConnectionSetup onClose={close} />);
  await screen.findByLabelText('Тип канала');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Продолжить' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Продолжить' }));
  await user.type(screen.getByLabelText('Токен Telegram-бота'), '123456:secret_token');
  await user.click(screen.getByRole('button', { name: 'Проверить подключение' }));
  await screen.findByLabelText('Название канала');
  await user.selectOptions(screen.getByLabelText('Мастерская'), 'w1');
  await user.selectOptions(screen.getByLabelText('Источник чатов amoCRM'), 'src1');
  await user.selectOptions(screen.getByLabelText('Воронка нового канала'), '1');
  expect(screen.getByLabelText('Новые обращения')).not.toHaveTextContent('Закрыт');
  await user.click(screen.getByRole('button', { name: 'Сохранить канал' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  const saved = calls.find((call) => call.url.endsWith('/setup-telegram'));
  expect(saved?.body).toMatchObject({
    statusId: null,
    workshopId: 'w1',
    sourceId: 'src1',
    funnelId: '1',
    displayName: 'Тестовый бот',
  });
  expect(JSON.stringify(store.getState())).not.toContain('123456:secret_token');
});

it('отказ проверки оставляет второй шаг и не создаёт подключение', async () => {
  const user = userEvent.setup();
  const calls = installFetch([
    ...readRoutes,
    {
      method: 'POST',
      match: /\/connections\/verify-telegram$/,
      handler: () => apiError('UPSTREAM_UNAVAILABLE', 503),
    },
  ]);
  renderWithProviders(<ConnectionSetup onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Продолжить' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Продолжить' }));
  await user.type(screen.getByLabelText('Токен Telegram-бота'), 'bad-token-value');
  await user.click(screen.getByRole('button', { name: 'Проверить подключение' }));
  expect(await screen.findByText('Подключение не создано')).toBeInTheDocument();
  expect(screen.getByLabelText('Токен Telegram-бота')).toBeInTheDocument();
  expect(calls.some((call) => call.url.endsWith('/setup-telegram'))).toBe(false);
});
