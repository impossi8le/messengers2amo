import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposeSnapshot, Obligation, SendOperation } from '@/api/types';
import { Composer } from '@/features/composer/composer';
import {
  apiError,
  installFetch,
  jsonResponse,
  networkFailure,
  renderWithProviders,
  resetStores,
} from '@/test/utils';

const OBLIGATIONS: Obligation[] = [
  { id: 'obl-1', contentVersion: 2, attentionSeq: 4, messageId: 'msg-1' },
];

function snapshot(overrides: Partial<ComposeSnapshot> = {}): ComposeSnapshot {
  return {
    id: 'snap-A',
    workItemId: 'wi-1',
    conversationId: 'conv-1',
    bindingEpoch: 1,
    assignmentVersion: 5,
    obligationRefs: [{ obligationId: 'obl-1', contentVersion: 2 }],
    ...overrides,
  };
}

const SENT_OPERATION: SendOperation = {
  id: 'op-1',
  state: 'sent',
  providerMessageId: 'prov-1',
  coverage: 'confirmed',
  selectedRefs: [{ obligationId: 'obl-1', contentVersion: 2 }],
  deliveryEvidence: { timestamp: '2026-10-21T10:00:00.000Z', evidenceKey: 'ev-1' },
  readEvidence: null,
};

function renderComposer(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const onRefreshSnapshot = vi.fn(async () => snapshot());
  const utils = renderWithProviders(
    <Composer
      workItemId="wi-1"
      obligations={OBLIGATIONS}
      latestSnapshot={snapshot()}
      snapshotLoading={false}
      snapshotError={null}
      onRefreshSnapshot={onRefreshSnapshot}
      {...props}
    />,
  );
  return { ...utils, onRefreshSnapshot };
}

describe('форма ответа', () => {
  beforeEach(() => {
    resetStores();
  });

  it('не предупреждает о некэшированном snapshot при отсутствии черновика', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      installFetch([]);
      renderComposer();
      await screen.findByLabelText('Текст ответа');

      expect(
        errorSpy.mock.calls.some(
          ([message]) =>
            typeof message === 'string' && message.includes('getSnapshot should be cached'),
        ),
      ).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('блокирует отправку со старым снимком и объясняет причину', async () => {
    const user = userEvent.setup();
    const calls = installFetch([]);
    const { rerender } = renderComposer();

    await user.type(screen.getByLabelText('Текст ответа'), 'Добрый день!');
    expect(screen.getByRole('button', { name: /Отправить/ })).toBeEnabled();

    // Пока оператор печатал, сервер вернул новый снимок диалога.
    rerender(
      <Composer
        workItemId="wi-1"
        obligations={OBLIGATIONS}
        latestSnapshot={snapshot({ id: 'snap-B' })}
        snapshotLoading={false}
        snapshotError={null}
        onRefreshSnapshot={async () => snapshot({ id: 'snap-B' })}
      />,
    );

    expect(screen.getByRole('button', { name: /Отправить/ })).toBeDisabled();
    expect(screen.getAllByText(/снимок устарел/i).length).toBeGreaterThan(0);
    expect(screen.getByText('Отправка заблокирована')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Применить свежий снимок' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Отправить/ }));
    expect(calls.some((call) => call.url.endsWith('/reply'))).toBe(false);
    // Текст не потерян.
    expect(screen.getByLabelText('Текст ответа')).toHaveValue('Добрый день!');
  });

  it('блокирует отправку, пока снимок не загружен', () => {
    installFetch([]);
    renderComposer({ latestSnapshot: null, snapshotLoading: true });

    expect(screen.getByRole('button', { name: /Отправить/ })).toBeDisabled();
    expect(screen.getAllByText(/Проверяем актуальность диалога/).length).toBeGreaterThan(0);
  });

  it('блокирует отправку при ошибке загрузки снимка', () => {
    installFetch([]);
    renderComposer({ latestSnapshot: null, snapshotError: 'Нет связи с сервером.' });

    expect(screen.getByRole('button', { name: /Отправить/ })).toBeDisabled();
    expect(screen.getAllByText(/Не удалось проверить актуальность диалога/).length).toBeGreaterThan(
      0,
    );
  });

  it('отправляет ответ с идентификатором снимка и версией назначения', async () => {
    const user = userEvent.setup();
    const calls = installFetch([
      {
        method: 'POST',
        match: /\/operator\/work-items\/wi-1\/reply$/,
        handler: () => jsonResponse(SENT_OPERATION, 202),
      },
      {
        method: 'GET',
        match: /\/operator\/send-operations\/op-1$/,
        handler: () => jsonResponse(SENT_OPERATION),
      },
    ]);

    renderComposer();
    await user.type(screen.getByLabelText('Текст ответа'), 'Отвечаем по существу');
    await user.click(screen.getByRole('button', { name: /Отправить/ }));

    await waitFor(() =>
      expect(screen.getByText('Доставка подтверждена провайдером')).toBeInTheDocument(),
    );

    const replyCall = calls.find((call) => call.url.endsWith('/reply'));
    const replyBody = (replyCall?.body ?? {}) as {
      idempotencyKey?: string;
      deadline?: string;
      snapshotId?: string;
      expectedAssignmentVersion?: number;
      selectedObligations?: unknown;
      text?: string;
    };
    expect(replyBody).toMatchObject({
      snapshotId: 'snap-A',
      expectedAssignmentVersion: 5,
      selectedObligations: [{ obligationId: 'obl-1', contentVersion: 2 }],
      text: 'Отвечаем по существу',
    });
    expect(replyBody.idempotencyKey).toMatch(/^reply_/);
    expect(replyBody.deadline).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('не выдаёт 202 за доставку: показывает ожидание подтверждения', async () => {
    const user = userEvent.setup();
    const pending: SendOperation = { ...SENT_OPERATION, state: 'queued', coverage: 'unconfirmed' };
    installFetch([
      {
        method: 'POST',
        match: /\/operator\/work-items\/wi-1\/reply$/,
        handler: () => jsonResponse(pending, 202),
      },
      {
        method: 'GET',
        match: /\/operator\/send-operations\/op-1$/,
        handler: () => jsonResponse(pending),
      },
    ]);

    renderComposer();
    await user.type(screen.getByLabelText('Текст ответа'), 'Проверка статуса');
    await user.click(screen.getByRole('button', { name: /Отправить/ }));

    expect(await screen.findByText(/провайдер ещё не подтвердил доставку/i)).toBeInTheDocument();
    expect(screen.queryByText('Доставка подтверждена провайдером')).not.toBeInTheDocument();
  });

  it('показывает сетевую ошибку и сохраняет текст', async () => {
    const user = userEvent.setup();
    installFetch([
      {
        method: 'POST',
        match: /\/operator\/work-items\/wi-1\/reply$/,
        handler: () => networkFailure(),
      },
    ]);

    renderComposer();
    await user.type(screen.getByLabelText('Текст ответа'), 'Важный текст');
    await user.click(screen.getByRole('button', { name: /Отправить/ }));

    expect(await screen.findByText('Отправка не выполнена')).toBeInTheDocument();
    expect(screen.getByText(/Нет связи с сервером/)).toBeInTheDocument();
    expect(screen.getByLabelText('Текст ответа')).toHaveValue('Важный текст');
    expect(screen.getByRole('button', { name: /Отправить/ })).toBeEnabled();
  });

  it('показывает конфликт версии как причину отказа', async () => {
    const user = userEvent.setup();
    installFetch([
      {
        method: 'POST',
        match: /\/operator\/work-items\/wi-1\/reply$/,
        handler: () => apiError('VERSION_CONFLICT', 409),
      },
    ]);

    renderComposer();
    await user.type(screen.getByLabelText('Текст ответа'), 'Ответ');
    await user.click(screen.getByRole('button', { name: /Отправить/ }));

    expect(await screen.findByText(/уже изменил другой оператор/)).toBeInTheDocument();
  });

  it('не отправляет пустой текст', async () => {
    const user = userEvent.setup();
    const calls = installFetch([]);
    renderComposer();

    await user.click(screen.getByRole('button', { name: /Отправить/ }));
    expect(calls.some((call) => call.url.endsWith('/reply'))).toBe(false);
  });

  it('позволяет выбрать, какие вопросы закрывает ответ', async () => {
    const user = userEvent.setup();
    renderComposer();

    const checkbox = screen.getByRole('checkbox', { name: /Вопрос #4/ });
    expect(checkbox).toBeChecked();
    await user.click(checkbox);
    expect(checkbox).not.toBeChecked();
  });
});
