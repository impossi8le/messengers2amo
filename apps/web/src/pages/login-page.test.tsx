import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from '@/pages/login-page';
import { useSessionStore } from '@/store/session';
import {
  apiError,
  installFetch,
  jsonResponse,
  renderWithProviders,
  resetStores,
} from '@/test/utils';

const LOGIN_OK = {
  staffId: 'staff-1',
  companyId: 'company-1',
  role: 'admin',
  workshopId: null,
  expiresAt: '2026-10-22T12:00:00.000Z',
};

function renderLogin(route = '/login') {
  return renderWithProviders(
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/work-items" element={<h1>Обращения</h1>} />
      <Route path="/crm" element={<h1>CRM</h1>} />
    </Routes>,
    { route },
  );
}

async function fillForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Компания'), 'company-1');
  await user.type(screen.getByLabelText('Сотрудник'), 'staff-1');
  await user.type(screen.getByLabelText('Пароль'), 'secret');
}

describe('страница входа', () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('показывает подписи полей, прячет пароль и ставит фокус на первое поле', () => {
    installFetch([]);
    renderLogin();

    expect(screen.getByRole('heading', { level: 1, name: 'Вход' })).toBeInTheDocument();
    expect(screen.getByLabelText('Компания')).toBeInTheDocument();
    expect(screen.getByLabelText('Сотрудник')).toBeInTheDocument();
    expect(screen.getByLabelText('Пароль')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Компания')).toHaveFocus();
  });

  it('подставляет компанию из переменной окружения', () => {
    vi.stubEnv('VITE_OPERATOR_COMPANY_ID', 'company-env');
    installFetch([]);
    renderLogin();

    expect(screen.getByLabelText('Компания')).toHaveValue('company-env');
    expect(screen.getByLabelText('Сотрудник')).toHaveValue('');
  });

  it('не отправляет пустую форму и показывает подсказки под полями', async () => {
    const user = userEvent.setup();
    const calls = installFetch([]);
    renderLogin();

    await user.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByText('Укажите компанию')).toBeInTheDocument();
    expect(screen.getByText('Укажите сотрудника')).toBeInTheDocument();
    expect(screen.getByText('Введите пароль')).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    expect(useSessionStore.getState().status).not.toBe('authenticated');
  });

  it('показывает «Неверные данные» при 401', async () => {
    const user = userEvent.setup();
    installFetch([
      {
        method: 'POST',
        match: /\/auth\/login$/,
        handler: () => apiError('UNAUTHENTICATED', 401),
      },
    ]);
    renderLogin();

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByText('Неверные данные')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Неверные данные');
    expect(useSessionStore.getState().role).toBeNull();
  });

  it('показывает предупреждение о слишком частых попытках при 429', async () => {
    const user = userEvent.setup();
    installFetch([
      {
        method: 'POST',
        match: /\/auth\/login$/,
        handler: () => apiError('RATE_LIMITED', 429),
      },
    ]);
    renderLogin();

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByText('Слишком много попыток, подождите')).toBeInTheDocument();
  });

  it('после успешного входа открывает рабочие места и сохраняет роль', async () => {
    const user = userEvent.setup();
    const calls = installFetch([
      {
        method: 'POST',
        match: /\/auth\/login$/,
        handler: () => jsonResponse(LOGIN_OK),
      },
    ]);
    renderLogin();

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByRole('heading', { name: 'Обращения' })).toBeInTheDocument();
    const call = calls.find((item) => item.url.endsWith('/auth/login'));
    expect(call?.body).toEqual({
      companyId: 'company-1',
      staffId: 'staff-1',
      password: 'secret',
    });
    expect(useSessionStore.getState().role).toBe('admin');
    expect(useSessionStore.getState().status).toBe('authenticated');
  });

  it('возвращает на сохранённый адрес после входа', async () => {
    const user = userEvent.setup();
    installFetch([
      {
        method: 'POST',
        match: /\/auth\/login$/,
        handler: () => jsonResponse(LOGIN_OK),
      },
    ]);
    renderLogin('/login?next=%2Fcrm');

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByRole('heading', { name: 'CRM' })).toBeInTheDocument();
  });

  it('не оставляет пароль в состоянии приложения после неудачной попытки', async () => {
    const user = userEvent.setup();
    installFetch([
      {
        method: 'POST',
        match: /\/auth\/login$/,
        handler: () => apiError('UNAUTHENTICATED', 401),
      },
    ]);
    const { store } = renderLogin();

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Войти' }));
    await screen.findByText('Неверные данные');

    // RTK Query хранит аргументы мутации; после попытки кэш сброшен, поэтому
    // пароля нет ни в кэше запросов, ни в хранилище сессии.
    expect(JSON.stringify(store.getState())).not.toContain('secret');
    expect(JSON.stringify(useSessionStore.getState())).not.toContain('secret');
  });

  it('блокирует кнопку, пока запрос выполняется', async () => {
    const user = userEvent.setup();
    let release: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    installFetch([
      {
        method: 'POST',
        match: /\/auth\/login$/,
        handler: () => pending,
      },
    ]);
    renderLogin();

    await fillForm(user);
    const button = screen.getByRole('button', { name: 'Войти' });
    await user.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    expect(screen.getByText('Входим…')).toBeInTheDocument();

    release?.(apiError('UNAUTHENTICATED', 401));
    expect(await screen.findByText('Неверные данные')).toBeInTheDocument();
  });
});
