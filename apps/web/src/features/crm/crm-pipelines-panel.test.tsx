import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
import {
  apiError,
  installFetch,
  jsonResponse,
  renderWithProviders,
  resetStores,
} from '@/test/utils';
import { CrmPipelinesPanel } from './crm-pipelines-panel';

beforeEach(resetStores);

it('обновляет серверный справочник и показывает новый результат', async () => {
  const user = userEvent.setup();
  const calls = installFetch([
    {
      method: 'GET',
      match: /\/amocrm\/pipelines\?refresh=true$/,
      handler: () => jsonResponse({ items: [{ id: '1', name: 'Продажи', stages: [] }] }),
    },
    { method: 'GET', match: /\/amocrm\/pipelines$/, handler: () => jsonResponse({ items: [] }) },
  ]);
  renderWithProviders(<CrmPipelinesPanel />);
  expect(await screen.findByText('Доступно воронок: 0.')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Обновить воронки' }));
  expect(await screen.findByText('Доступно воронок: 1.')).toBeInTheDocument();
  expect(calls.filter((call) => call.url.endsWith('?refresh=true'))).toHaveLength(1);
});

it('сохраняет последний результат и показывает ошибку обновления', async () => {
  const user = userEvent.setup();
  installFetch([
    {
      method: 'GET',
      match: /\/amocrm\/pipelines\?refresh=true$/,
      handler: () => apiError('UPSTREAM_UNAVAILABLE', 503),
    },
    { method: 'GET', match: /\/amocrm\/pipelines$/, handler: () => jsonResponse({ items: [] }) },
  ]);
  renderWithProviders(<CrmPipelinesPanel />);
  await screen.findByText('Доступно воронок: 0.');
  await user.click(screen.getByRole('button', { name: 'Обновить воронки' }));
  await waitFor(() => expect(screen.getByText('Не удалось обновить воронки')).toBeInTheDocument());
  expect(screen.getByText('Доступно воронок: 0.')).toBeInTheDocument();
});
