import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkItem } from '@/api/types';
import { ResolvePanel } from '@/features/resolve/resolve-panel';
import {
  apiError,
  installFetch,
  jsonResponse,
  renderWithProviders,
  resetStores,
} from '@/test/utils';

const WORK_ITEM: WorkItem = {
  id: 'wi-1',
  conversationId: 'conv-1',
  assignmentVersion: 3,
  state: 'in_progress',
  owner: 'staff-1',
};

describe('закрытие обращения', () => {
  beforeEach(() => {
    resetStores();
  });

  it('предупреждает о праве manage при открытых обязательствах', () => {
    installFetch([]);
    renderWithProviders(<ResolvePanel workItem={WORK_ITEM} openObligations={2} />);

    expect(screen.getByText('Есть открытые вопросы')).toBeInTheDocument();
    expect(screen.getByText(/требует права/)).toBeInTheDocument();
  });

  it('не показывает предупреждение, когда вопросов нет', () => {
    installFetch([]);
    renderWithProviders(<ResolvePanel workItem={WORK_ITEM} openObligations={0} />);

    expect(screen.queryByText('Есть открытые вопросы')).not.toBeInTheDocument();
    expect(screen.getByText(/Все вопросы клиента закрыты/)).toBeInTheDocument();
  });

  it('требует причину', async () => {
    const user = userEvent.setup();
    const calls = installFetch([]);
    renderWithProviders(<ResolvePanel workItem={WORK_ITEM} openObligations={0} />);

    await user.click(screen.getByRole('button', { name: 'Закрыть обращение' }));

    expect(
      await screen.findByText('Опишите причину закрытия: минимум 5 символов'),
    ).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('закрывает обращение с причиной и версией назначения', async () => {
    const user = userEvent.setup();
    const calls = installFetch([
      {
        method: 'POST',
        match: /\/operator\/work-items\/wi-1\/resolve$/,
        handler: () => jsonResponse({ ...WORK_ITEM, state: 'resolved', assignmentVersion: 4 }),
      },
    ]);
    renderWithProviders(<ResolvePanel workItem={WORK_ITEM} openObligations={0} />);

    await user.type(screen.getByLabelText('Причина закрытия'), 'Вопрос решён в звонке');
    await user.click(screen.getByRole('button', { name: 'Закрыть обращение' }));

    expect(await screen.findByText(/Обращение закрыто/)).toBeInTheDocument();
    const call = calls.find((item) => item.url.endsWith('/resolve'));
    expect(call?.body).toMatchObject({
      reason: 'Вопрос решён в звонке',
      expectedAssignmentVersion: 3,
    });
  });

  it('объясняет отказ 403 как нехватку права manage', async () => {
    const user = userEvent.setup();
    installFetch([
      {
        method: 'POST',
        match: /\/resolve$/,
        handler: () => apiError('FORBIDDEN', 403),
      },
    ]);
    renderWithProviders(<ResolvePanel workItem={WORK_ITEM} openObligations={1} />);

    await user.type(screen.getByLabelText('Причина закрытия'), 'Клиент передумал');
    await user.click(screen.getByRole('button', { name: 'Закрыть обращение' }));

    expect(await screen.findByText('Обращение не закрыто')).toBeInTheDocument();
    expect(screen.getByText(/только сотрудник с правом manage/)).toBeInTheDocument();
  });

  it('показывает ошибку сети', async () => {
    const user = userEvent.setup();
    installFetch([
      {
        method: 'POST',
        match: /\/resolve$/,
        handler: () => {
          throw new TypeError('Failed to fetch');
        },
      },
    ]);
    renderWithProviders(<ResolvePanel workItem={WORK_ITEM} openObligations={0} />);

    await user.type(screen.getByLabelText('Причина закрытия'), 'Дубль обращения');
    await user.click(screen.getByRole('button', { name: 'Закрыть обращение' }));

    expect(await screen.findByText(/Нет связи с сервером/)).toBeInTheDocument();
  });

  it('блокирует форму для уже закрытого обращения', () => {
    installFetch([]);
    renderWithProviders(
      <ResolvePanel workItem={{ ...WORK_ITEM, state: 'resolved' }} openObligations={0} />,
    );

    expect(screen.getByRole('button', { name: 'Закрыть обращение' })).toBeDisabled();
    expect(screen.getByText('Обращение уже закрыто.')).toBeInTheDocument();
  });
});
