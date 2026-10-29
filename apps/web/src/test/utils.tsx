import { configureStore } from '@reduxjs/toolkit';
import { render } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { messengerApi } from '@/api/baseApi';
import { useDraftsStore } from '@/store/drafts';
import { useSessionStore } from '@/store/session';

export function makeTestStore() {
  return configureStore({
    reducer: { [messengerApi.reducerPath]: messengerApi.reducer },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(messengerApi.middleware),
  });
}

export function renderWithProviders(ui: ReactElement, { route = '/' }: { route?: string } = {}) {
  const store = makeTestStore();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>
      <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
    </Provider>
  );
  return { store, ...render(ui, { wrapper: Wrapper }) };
}

export function resetStores() {
  useDraftsStore.setState({ drafts: {} });
  useSessionStore.setState(useSessionStore.getInitialState());
}

export interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

export interface MockRoute {
  method: string;
  match: RegExp;
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function apiError(code: string, status: number, retryable = false): Response {
  return jsonResponse({ code, requestId: 'req-test-1', retryable }, status);
}

/**
 * Подменяет fetch маршрутами. Возвращает журнал вызовов, чтобы проверять,
 * что запрещённый запрос (например, отправка со старым снимком) не ушёл.
 */
export function installFetch(routes: MockRoute[]): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestLike = input as unknown as {
      url?: string;
      method?: string;
      body?: unknown;
    };
    const url = typeof input === 'string' ? input : (requestLike.url ?? String(input));
    const method = (init?.method ?? requestLike.method ?? 'GET').toUpperCase();
    const rawBody = init?.body ?? requestLike.body;
    calls.push({
      url,
      method,
      body: typeof rawBody === 'string' ? JSON.parse(rawBody) : undefined,
    });
    const route = routes.find(
      (candidate) => candidate.method === method && candidate.match.test(url),
    );
    if (!route) {
      return apiError('NOT_FOUND', 404);
    }
    return route.handler(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

export function networkFailure(): never {
  throw new TypeError('Failed to fetch');
}
