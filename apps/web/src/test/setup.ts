import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Recharts и часть компонентов измеряют контейнер; в jsdom ResizeObserver нет.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (!('ResizeObserver' in globalThis)) {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    writable: true,
    configurable: true,
    value: ResizeObserverStub,
  });
}

/**
 * jsdom приносит свой AbortController/AbortSignal, а Request/Response берутся
 * из Node (undici). Из-за смешения реализаций `new Request(url, { signal })`
 * падает с «Expected signal to be an instance of AbortSignal».
 *
 * fetchBaseQuery использует Request только как контейнер аргументов для fetch,
 * поэтому в тестах достаточно простого совместимого класса. Проверяется
 * поведение приложения, а не реализация Request из undici.
 */
interface RequestLikeInit extends RequestInit {
  headers?: Headers | Record<string, string>;
}

class RequestStub {
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null;
  signal: AbortSignal | null;
  credentials: RequestCredentials;
  mode: RequestMode;

  constructor(input: string | RequestStub, init: RequestLikeInit = {}) {
    const source = typeof input === 'string' ? null : input;
    this.url = typeof input === 'string' ? input : input.url;
    this.method = (init.method ?? source?.method ?? 'GET').toUpperCase();
    this.headers = new Headers(init.headers ?? source?.headers);
    this.body = (init.body ?? source?.body ?? null) as BodyInit | null;
    this.signal = init.signal ?? source?.signal ?? null;
    this.credentials = init.credentials ?? source?.credentials ?? 'same-origin';
    this.mode = init.mode ?? source?.mode ?? 'cors';
  }

  clone(): RequestStub {
    return new RequestStub(this);
  }
}

Object.defineProperty(globalThis, 'Request', {
  writable: true,
  configurable: true,
  value: RequestStub,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
