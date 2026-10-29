import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { MESSAGE_FEATURE_LABELS, type ChannelCatalogItem } from '@/api/channel-catalog';
import { installFetch, jsonResponse, renderWithProviders, resetStores } from '@/test/utils';
import { ChannelCatalog } from './channel-catalog';

beforeEach(resetStores);

const unknownCapabilities = (): ChannelCatalogItem['capabilities'] =>
  Object.fromEntries(
    Object.keys(MESSAGE_FEATURE_LABELS).map((key) => [key, { send: 'unknown', receive: 'unknown' }]),
  ) as ChannelCatalogItem['capabilities'];

const telegram: ChannelCatalogItem = {
  id: 'telegram',
  name: 'Telegram',
  family: 'telegram',
  connectionType: 'telegram',
  implementation: 'adapter',
  requiresSeparateCrmChannel: true,
  setupAvailable: true,
  verification: 'unverified',
  capabilities: unknownCapabilities(),
};

const viber: ChannelCatalogItem = {
  id: 'viber',
  name: 'Viber',
  family: 'viber',
  connectionType: 'viber',
  implementation: 'planned',
  requiresSeparateCrmChannel: true,
  setupAvailable: false,
  verification: 'unverified',
  capabilities: unknownCapabilities(),
};

const catalogRoute = {
  method: 'GET',
  match: /\/operator\/channels\/catalog$/,
  handler: () => jsonResponse({ schemaVersion: 1, items: [telegram, viber] }),
};

const openCatalog = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByText('Мессенджеры и возможности'));
};

it('не отправляет запросов, пока раздел свёрнут', () => {
  const calls = installFetch([catalogRoute]);
  renderWithProviders(<ChannelCatalog onAddTelegram={vi.fn()} />);
  expect(screen.getByText('Мессенджеры и возможности')).toBeInTheDocument();
  expect(calls).toHaveLength(0);
});

it('по раскрытию запрашивает каталог и различает adapter и planned', async () => {
  const user = userEvent.setup();
  const calls = installFetch([catalogRoute]);
  renderWithProviders(<ChannelCatalog onAddTelegram={vi.fn()} />);
  await openCatalog(user);
  expect(await screen.findByText('Telegram — Требуется подключение')).toBeInTheDocument();
  expect(screen.getByText('Viber — Подключение готовится')).toBeInTheDocument();
  const call = calls.find((entry) => entry.url.endsWith('/operator/channels/catalog'));
  expect(call?.method).toBe('GET');
  expect(calls).toHaveLength(1);
});

it('поиск скрывает другой мессенджер', async () => {
  const user = userEvent.setup();
  installFetch([catalogRoute]);
  renderWithProviders(<ChannelCatalog onAddTelegram={vi.fn()} />);
  await openCatalog(user);
  await screen.findByText('Telegram — Требуется подключение');
  await user.type(screen.getByLabelText('Найти мессенджер'), 'viber');
  expect(screen.queryByText('Telegram — Требуется подключение')).not.toBeInTheDocument();
  expect(screen.getByText('Viber — Подключение готовится')).toBeInTheDocument();
});

it('в раскрытой строке отправка и приём показаны как «Не проверено» без ложного «Доступно»', async () => {
  const user = userEvent.setup();
  installFetch([catalogRoute]);
  renderWithProviders(<ChannelCatalog onAddTelegram={vi.fn()} />);
  await openCatalog(user);
  const row = await screen.findByText('Telegram — Требуется подключение');
  await user.click(row);
  const rowScope = within(row.closest('li') as HTMLElement);
  expect(rowScope.getByText('Возможность')).toBeInTheDocument();
  expect(rowScope.getByText('Отправка')).toBeInTheDocument();
  expect(rowScope.getByText('Приём')).toBeInTheDocument();
  const unknownCells = rowScope.getAllByText('Не проверено');
  expect(unknownCells).toHaveLength(Object.keys(MESSAGE_FEATURE_LABELS).length * 2);
  expect(unknownCells[0]?.tagName).toBe('TD');
  expect(screen.queryByText('Доступно')).not.toBeInTheDocument();
  expect(screen.queryByText('Недоступно')).not.toBeInTheDocument();
});

it('кнопка настройки есть только у Telegram, клик вызывает onAddTelegram', async () => {
  const user = userEvent.setup();
  const onAddTelegram = vi.fn();
  installFetch([catalogRoute]);
  renderWithProviders(<ChannelCatalog onAddTelegram={onAddTelegram} />);
  await openCatalog(user);
  const telegramSummary = await screen.findByText('Telegram — Требуется подключение');
  await user.click(telegramSummary);
  await user.click(screen.getByRole('button', { name: 'Настроить Telegram-бота' }));
  expect(onAddTelegram).toHaveBeenCalledOnce();
  await user.click(screen.getByText('Viber — Подключение готовится'));
  expect(screen.getAllByRole('button', { name: 'Настроить Telegram-бота' })).toHaveLength(1);
});
