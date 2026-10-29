import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '@/api/types';
import { AssignmentPanel } from '@/features/assignment/assignment-panel';
import {
  apiError,
  installFetch,
  jsonResponse,
  renderWithProviders,
  resetStores,
} from '@/test/utils';

const WORK_ITEM: WorkItem = {
  id: 'wi-77',
  conversationId: 'conv-77',
  assignmentVersion: 5,
  state: 'queued',
  owner: null,
};

describe('назначение и передача ответственного', () => {
  beforeEach(() => {
    resetStores();
  });

  it('показывает текущего ответственного и версию назначения', () => {
    renderWithProviders(<AssignmentPanel workItem={WORK_ITEM} onConflict={() => {}} />);

    expect(screen.getByText('не назначен')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Взять в работу/ })).toBeEnabled();
  });

  it('отправляет claim с ожидаемой версией назначения', async () => {
    const user = userEvent.setup();
    const calls = installFetch([
      {
        method: 'POST',
        match: /\/operator\/work-items\/wi-77\/claim$/,
        handler: () =>
          jsonResponse({
            ...WORK_ITEM,
            state: 'assigned',
            owner: 'staff-me',
            assignmentVersion: 6,
          }),
      },
    ]);

    renderWithProviders(<AssignmentPanel workItem={WORK_ITEM} onConflict={() => {}} />);
    await user.click(screen.getByRole('button', { name: /Взять в работу/ }));

    expect(await screen.findByText('Обращение назначено на вас.')).toBeInTheDocument();
    const claimCall = calls.find((call) => call.url.endsWith('/claim'));
    const claimBody = (claimCall?.body ?? {}) as {
      expectedAssignmentVersion?: number;
      idempotencyKey?: string;
    };
    expect(claimBody.expectedAssignmentVersion).toBe(5);
    expect(claimBody.idempotencyKey).toMatch(/^claim_/);
  });

  it('явно сообщает, что оператор проиграл гонку (CAS-конфликт)', async () => {
    const user = userEvent.setup();
    const onConflict = vi.fn();
    installFetch([
      {
        method: 'POST',
        match: /\/operator\/work-items\/wi-77\/claim$/,
        handler: () => apiError('VERSION_CONFLICT', 409),
      },
    ]);

    renderWithProviders(<AssignmentPanel workItem={WORK_ITEM} onConflict={onConflict} />);
    await user.click(screen.getByRole('button', { name: /Взять в работу/ }));

    expect(await screen.findByText('Назначение не выполнено')).toBeInTheDocument();
    expect(screen.getByText(/уже изменил другой оператор/)).toBeInTheDocument();

    const reread = screen.getByRole('button', { name: /Перечитать карточку/ });
    await user.click(reread);
    expect(onConflict).toHaveBeenCalledTimes(1);
  });

  it('не выдаёт конфликт версии за успех', async () => {
    const user = userEvent.setup();
    installFetch([
      {
        method: 'POST',
        match: /\/operator\/work-items\/wi-77\/transfer$/,
        handler: () => apiError('VERSION_CONFLICT', 409),
      },
    ]);

    renderWithProviders(<AssignmentPanel workItem={WORK_ITEM} onConflict={() => {}} />);
    await user.type(screen.getByLabelText('Подразделение'), 'dept-1');
    await user.type(screen.getByLabelText('Сотрудник (ID)'), 'staff-2');
    await user.click(screen.getByRole('button', { name: 'Передать' }));

    expect(await screen.findByText('Назначение не выполнено')).toBeInTheDocument();
    expect(screen.queryByText('Ответственный изменён.')).not.toBeInTheDocument();
  });

  it('валидирует пустое подразделение без обращения к серверу', async () => {
    const user = userEvent.setup();
    const calls = installFetch([]);

    renderWithProviders(<AssignmentPanel workItem={WORK_ITEM} onConflict={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Передать' }));

    expect(await screen.findByText('Укажите подразделение')).toBeInTheDocument();
    expect(calls.some((call) => call.url.endsWith('/transfer'))).toBe(false);
  });

  it('передаёт null при снятии ответственного', async () => {
    const user = userEvent.setup();
    const calls = installFetch([
      {
        method: 'POST',
        match: /\/operator\/work-items\/wi-77\/transfer$/,
        handler: () => jsonResponse({ ...WORK_ITEM, owner: null, assignmentVersion: 6 }),
      },
    ]);

    renderWithProviders(<AssignmentPanel workItem={WORK_ITEM} onConflict={() => {}} />);
    await user.type(screen.getByLabelText('Подразделение'), 'dept-1');
    await user.click(screen.getByRole('button', { name: 'Передать' }));

    await waitFor(() => expect(screen.getByText('Ответственный изменён.')).toBeInTheDocument());
    const transferCall = calls.find((call) => call.url.endsWith('/transfer'));
    expect(transferCall?.body).toMatchObject({
      departmentId: 'dept-1',
      assigneeId: null,
      expectedAssignmentVersion: 5,
    });
  });
});
