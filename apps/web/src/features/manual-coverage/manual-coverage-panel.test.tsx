import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Obligation, SendOperation, WorkItem } from '@/api/types';
import { ManualCoveragePanel } from '@/features/manual-coverage/manual-coverage-panel';
import {
  apiError,
  installFetch,
  jsonResponse,
  networkFailure,
  renderWithProviders,
  resetStores,
} from '@/test/utils';

const WORK_ITEM: WorkItem = {
  id: 'wi-1',
  conversationId: 'conv-1',
  assignmentVersion: 4,
  state: 'in_progress',
  owner: 'staff-1',
};

const OBLIGATIONS: Obligation[] = [
  { id: 'ob-1', contentVersion: 2, attentionSeq: 7, messageId: 'msg-1' },
  { id: 'ob-2', contentVersion: 1, attentionSeq: 8, messageId: 'msg-2' },
];

function operation(overrides: Partial<SendOperation> = {}): SendOperation {
  return {
    id: 'op-1',
    state: 'sent',
    providerMessageId: 'prov-1',
    coverage: 'unconfirmed',
    selectedRefs: [],
    deliveryEvidence: null,
    readEvidence: null,
    ...overrides,
  };
}

function operationRoute(item: SendOperation) {
  return {
    method: 'GET' as const,
    match: /\/operator\/send-operations\/op-1$/,
    handler: () => jsonResponse(item),
  };
}

async function checkOperation(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Операция отправки'), 'op-1');
  await user.click(screen.getByRole('button', { name: 'Проверить' }));
  await screen.findByText('Отправлено');
}

describe('ручное покрытие', () => {
  beforeEach(() => {
    resetStores();
  });

  it('объясняет, что это ручное действие с аудитом', () => {
    installFetch([]);
    renderWithProviders(<ManualCoveragePanel workItem={WORK_ITEM} obligations={OBLIGATIONS} />);

    expect(screen.getByText('Это не автоматическое закрытие')).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', {
        name: /Понимаю, что это ручное действие с аудитом/,
      }),
    ).not.toBeChecked();
  });

  it('требует причину и подтверждение перед отправкой', async () => {
    const user = userEvent.setup();
    const calls = installFetch([operationRoute(operation())]);
    renderWithProviders(<ManualCoveragePanel workItem={WORK_ITEM} obligations={OBLIGATIONS} />);

    await checkOperation(user);
    await user.click(screen.getByRole('checkbox', { name: /об-1|msg-1|#7/ }));

    await user.click(screen.getByRole('button', { name: 'Зафиксировать покрытие' }));

    expect(await screen.findByText('Опишите причину: минимум 10 символов')).toBeInTheDocument();
    expect(
      await screen.findByText('Подтвердите, что понимаете: это ручное действие с аудитом'),
    ).toBeInTheDocument();
    expect(calls.some((call) => call.url.includes('/manual-coverage'))).toBe(false);
  });

  it('отправляет покрытие с причиной, версией и выбранными вопросами', async () => {
    const user = userEvent.setup();
    const calls = installFetch([
      operationRoute(operation()),
      {
        method: 'POST',
        match: /\/operator\/work-items\/wi-1\/manual-coverage$/,
        handler: () => jsonResponse({ ...WORK_ITEM, assignmentVersion: 5 }),
      },
    ]);
    renderWithProviders(<ManualCoveragePanel workItem={WORK_ITEM} obligations={OBLIGATIONS} />);

    await checkOperation(user);
    await user.click(screen.getByRole('checkbox', { name: /#7/ }));
    await user.click(screen.getByRole('checkbox', { name: /#8/ }));
    // Повторное нажатие снимает выбор: покрываем только первый вопрос.
    await user.click(screen.getByRole('checkbox', { name: /#8/ }));

    await user.type(screen.getByLabelText('Причина'), 'Ответ дан в штатном чате amoCRM 22.10');
    await user.click(
      screen.getByRole('checkbox', { name: /Понимаю, что это ручное действие с аудитом/ }),
    );
    await user.click(screen.getByRole('button', { name: 'Зафиксировать покрытие' }));

    expect(await screen.findByText(/Покрытие зафиксировано/)).toBeInTheDocument();

    const call = calls.find((item) => item.url.includes('/manual-coverage'));
    expect(call?.body).toMatchObject({
      confirmedSendOperationId: 'op-1',
      expectedAssignmentVersion: 4,
      reason: 'Ответ дан в штатном чате amoCRM 22.10',
      obligationRefs: [{ obligationId: 'ob-1', contentVersion: 2 }],
    });
    const body = call?.body as { idempotencyKey?: string } | undefined;
    expect(body?.idempotencyKey).toEqual(expect.any(String));
  });

  it('не даёт оформить покрытие по неотправленной операции', async () => {
    const user = userEvent.setup();
    installFetch([operationRoute(operation({ state: 'unknown' }))]);
    renderWithProviders(<ManualCoveragePanel workItem={WORK_ITEM} obligations={OBLIGATIONS} />);

    await user.type(screen.getByLabelText('Операция отправки'), 'op-1');
    await user.click(screen.getByRole('button', { name: 'Проверить' }));

    expect(await screen.findByText('Результат неизвестен')).toBeInTheDocument();
    expect(screen.getByText('Операция не подходит')).toBeInTheDocument();
  });

  it('показывает отказ сервера и не выдаёт его за успех', async () => {
    const user = userEvent.setup();
    installFetch([
      operationRoute(operation()),
      {
        method: 'POST',
        match: /\/manual-coverage$/,
        handler: () => apiError('FORBIDDEN', 403),
      },
    ]);
    renderWithProviders(<ManualCoveragePanel workItem={WORK_ITEM} obligations={OBLIGATIONS} />);

    await checkOperation(user);
    await user.click(screen.getByRole('checkbox', { name: /#7/ }));
    await user.type(screen.getByLabelText('Причина'), 'Ответ дан в звонке клиенту');
    await user.click(
      screen.getByRole('checkbox', { name: /Понимаю, что это ручное действие с аудитом/ }),
    );
    await user.click(screen.getByRole('button', { name: 'Зафиксировать покрытие' }));

    expect(await screen.findByText('Покрытие не оформлено')).toBeInTheDocument();
    expect(screen.getByText(/Недостаточно прав для этого действия/)).toBeInTheDocument();
    expect(screen.queryByText(/Покрытие зафиксировано/)).not.toBeInTheDocument();
  });

  it('сообщает об ошибке сети при проверке операции', async () => {
    const user = userEvent.setup();
    installFetch([
      {
        method: 'GET',
        match: /\/operator\/send-operations\/op-1$/,
        handler: () => networkFailure(),
      },
    ]);
    renderWithProviders(<ManualCoveragePanel workItem={WORK_ITEM} obligations={OBLIGATIONS} />);

    await user.type(screen.getByLabelText('Операция отправки'), 'op-1');
    await user.click(screen.getByRole('button', { name: 'Проверить' }));

    await waitFor(() => expect(screen.getByText(/Нет связи с сервером/)).toBeInTheDocument());
  });
});
