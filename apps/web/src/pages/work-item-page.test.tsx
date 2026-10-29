import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { WorkItemPage } from '@/pages/work-item-page';
import { installFetch, jsonResponse, renderWithProviders, resetStores } from '@/test/utils';

const DETAIL = {
  workItem: {
    id: 'wi-1',
    conversationId: 'conv-1',
    assignmentVersion: 2,
    state: 'in_progress',
    owner: 'staff-1',
  },
  conversation: {
    id: 'conv-1',
    connectionId: 'conn-1',
    externalChatId: 'chat-42',
    bindingEpoch: 1,
  },
  outstandingObligations: [{ id: 'ob-1', contentVersion: 1, attentionSeq: 3, messageId: 'msg-1' }],
};

const ROUTES = [
  {
    method: 'GET' as const,
    match: /\/operator\/work-items\/wi-1$/,
    handler: () => jsonResponse(DETAIL),
  },
  {
    method: 'GET' as const,
    match: /\/operator\/work-items\/wi-1\/messages/,
    handler: () =>
      jsonResponse({
        items: [
          {
            id: 'msg-1',
            conversationId: 'conv-1',
            direction: 'in',
            contentVersion: 1,
            content: { kind: 'text', text: 'Когда доставите?' },
            createdAt: '2026-10-21T09:00:00.000Z',
            sendOperationId: null,
          },
        ],
        page: { nextCursor: null },
      }),
  },
  {
    method: 'POST' as const,
    match: /\/operator\/work-items\/wi-1\/snapshot$/,
    handler: () =>
      jsonResponse({
        id: 'snap-1',
        workItemId: 'wi-1',
        conversationId: 'conv-1',
        bindingEpoch: 1,
        assignmentVersion: 2,
        obligationRefs: [{ obligationId: 'ob-1', contentVersion: 1 }],
      }),
  },
];

describe('карточка диалога', () => {
  beforeEach(() => {
    resetStores();
  });

  it('показывает формы закрытия и ручного покрытия', async () => {
    installFetch(ROUTES);
    renderWithProviders(
      <Routes>
        <Route path="/work-items/:workItemId" element={<WorkItemPage />} />
      </Routes>,
      { route: '/work-items/wi-1' },
    );

    expect(await screen.findByRole('heading', { name: /Диалог chat-42/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Закрытие обращения' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ручное покрытие' })).toBeInTheDocument();
    expect(screen.getByText('Есть открытые вопросы')).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: /Понимаю, что это ручное действие с аудитом/ }),
    ).toBeInTheDocument();
  });

  it('объясняет, почему карточка недоступна', async () => {
    installFetch([
      {
        method: 'GET',
        match: /\/operator\/work-items\/wi-1$/,
        handler: () => jsonResponse({ code: 'NOT_FOUND', requestId: 'r1', retryable: false }, 404),
      },
      {
        method: 'GET',
        match: /\/messages/,
        handler: () => jsonResponse({ items: [], page: { nextCursor: null } }),
      },
    ]);
    renderWithProviders(
      <Routes>
        <Route path="/work-items/:workItemId" element={<WorkItemPage />} />
      </Routes>,
      { route: '/work-items/wi-1' },
    );

    expect(await screen.findByText('Карточка недоступна')).toBeInTheDocument();
    expect(screen.getByText(/Объект не найден/)).toBeInTheDocument();
  });
});
