import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '@/app';
import { useSessionStore } from '@/store/session';
import { installFetch, jsonResponse, renderWithProviders, resetStores } from '@/test/utils';

const page = { nextCursor: null };
const detail = {
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

function fixtures() {
  return installFetch([
    {
      method: 'GET',
      match: /\/operator\/amocrm\/status$/,
      handler: () => jsonResponse({ authorizationEnabled: true, accounts: [] }),
    },
    { method: 'GET', match: /\/operator\/work-items\/wi-1$/, handler: () => jsonResponse(detail) },
    {
      method: 'POST',
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
    {
      method: 'GET',
      match: /\/operator\/crm\/policy$/,
      handler: () => jsonResponse({ sourceOfTruth: 'platform', version: 4 }),
    },
    {
      method: 'GET',
      match: /\/operator\/system-status$/,
      handler: () =>
        jsonResponse({
          checkedAt: '2026-10-22T10:00:00.000Z',
          database: { reachable: true, latencyMs: 3 },
          queues: {
            inboxPending: 0,
            outboxPending: 0,
            outboxLeased: 0,
            outboxFailed: 0,
            sendUnknown: 0,
          },
          activity: { lastInboundAt: null, lastSendAt: null },
          connections: { total: 1, active: 1, degraded: 0, authRequired: 0 },
          health: 'ok',
          issues: [],
        }),
    },
    {
      method: 'GET',
      match: /\/operator\/staff\/availability/,
      handler: () =>
        jsonResponse({
          items: ['staff-1', 'staff-2'].map((id) => ({
            id,
            availability: 'online',
            departmentIds: [],
            capacity: 5,
            activeCount: 1,
            version: 1,
          })),
          page,
        }),
    },
    {
      method: 'GET',
      match: /\/operator\/workshops$/,
      handler: () => jsonResponse({ items: [{ id: 'ws-1', displayName: 'Мастерская 1' }], page }),
    },
    // Explicitly enumerated fixture endpoints; unmatched requests get a fake 404.
    {
      method: 'GET',
      match: /\/operator\/amocrm\/pipelines$/,
      handler: () => jsonResponse({ items: [] }),
    },
    // No request ever reaches the network (including provider transports).
    {
      method: 'GET',
      match:
        /\/operator\/(?:work-items(?:\/wi-1\/messages)?|connections|notifications|crm\/(?:conflicts|bindings)|workshops\/ws-1\/(?:routes|groups|permissions))(?:\?|$)/,
      handler: () => jsonResponse({ items: [], page }),
    },
  ]);
}

const screens = [
  ['/work-items', 'Обращения', 'Обращений нет'],
  ['/work-items/wi-1', 'Диалог chat-42', 'Снимок актуален:'],
  ['/connections', 'Подключения', 'Подключений нет'],
  ['/workshops', 'Мастерские', 'Правил нет'],
  ['/crm', 'CRM', 'версия 4'],
  ['/staff', 'Смены и нагрузка', 'staff-2'],
  ['/diagnostics', 'Диагностика', 'Спорных связей нет'],
] as const;

describe('доступность семи экранов (DOM и клавиатура)', () => {
  beforeEach(() => {
    resetStores();
    useSessionStore.getState().setSession({ role: 'admin', staffId: 'staff-1' });
  });
  afterEach(() => useSessionStore.getState().clear());

  it.each(screens)('%s: landmarks, заголовки, имена и порядок Tab', async (route, title, ready) => {
    const calls = fixtures();
    const user = userEvent.setup();
    const { container } = renderWithProviders(<App />, { route });
    await screen.findByRole('heading', { level: 1, name: title });
    await screen.findByText(ready, { exact: false });
    await waitFor(() => expect(screen.queryAllByText(/Загружаем|Загрузка…/)).toHaveLength(0));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(screen.getAllByRole('main')).toHaveLength(1);
    // A page-level <header> inside <main> is not a banner landmark (HTML-AAM), but
    // dom-accessibility-api maps every <header> to banner. Assert on the real rule:
    // exactly one banner, and it must be the application header outside <main>.
    const banners = screen.getAllByRole('banner').filter((element) => !main.contains(element));
    expect(banners).toHaveLength(1);
    expect(screen.getAllByRole('contentinfo')).toHaveLength(1);
    expect(screen.getByRole('navigation', { name: 'Основная навигация' })).toBeInTheDocument();
    expect(within(main).getAllByRole('heading', { level: 1 })).toHaveLength(1);

    let previousLevel = 0;
    for (const heading of screen.getAllByRole('heading')) {
      const level = Number(heading.getAttribute('aria-level') ?? heading.tagName.slice(1));
      expect(level).toBeLessThanOrEqual(previousLevel + 1);
      expect(heading).toHaveAccessibleName(/\S/);
      previousLevel = level;
    }
    for (const role of [
      'button',
      'link',
      'textbox',
      'combobox',
      'spinbutton',
      'checkbox',
      'radio',
      'switch',
    ] as const) {
      for (const control of screen.queryAllByRole(role)) {
        expect(control).toHaveAccessibleName(/\S/);
      }
    }
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href')?.trim()).toBeTruthy();
      expect(link.getAttribute('href')).not.toBe('#');
    }
    for (const image of screen.queryAllByRole('img')) expect(image).toHaveAccessibleName(/\S/);
    for (const node of container.querySelectorAll<HTMLElement>('[tabindex]')) {
      expect(node.tabIndex).toBeLessThanOrEqual(0);
    }

    const tabbable = Array.from(
      container.querySelectorAll<HTMLElement>(
        'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex="0"]',
      ),
    ).filter(
      (node) =>
        node.tabIndex >= 0 &&
        !node.matches(':disabled') &&
        !node.closest('[hidden], [inert], [aria-hidden="true"]') &&
        // Native radio groups expose only the checked radio in the Tab sequence.
        (!node.matches('input[type="radio"]') || (node as HTMLInputElement).checked),
    );
    await user.tab();
    expect(screen.getByRole('link', { name: 'Перейти к содержимому' })).toHaveFocus();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
    for (const node of tabbable.slice(1)) {
      await user.tab();
      expect(node).toHaveFocus();
    }
    await user.tab({ shift: true });
    expect(tabbable[tabbable.length - 2]).toHaveFocus();
    expect(calls.every((call) => /\/operator\//.test(call.url))).toBe(true);
  });

  it('называет сотрудника в каждой кнопке изменения статуса', async () => {
    fixtures();
    renderWithProviders(<App />, { route: '/staff' });
    await screen.findByText('staff-2');
    for (const id of ['staff-1', 'staff-2']) {
      expect(screen.getAllByRole('button', { name: new RegExp(`для ${id}$`) })).toHaveLength(3);
    }
  });
});
