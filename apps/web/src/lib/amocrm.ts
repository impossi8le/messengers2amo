import { API_BASE_URL } from '@/api/baseApi';

/**
 * Начало OAuth-согласия amoCRM.
 *
 * Адрес серверный: он проверяет сессию администратора и отвечает 302 на сайт
 * amoCRM. Согласие открывается во всплывающем окне, а не переходом всей
 * страницы: callback-страница на сервере сообщает результат через
 * `postMessage` и закрывает окно, поэтому консоль остаётся на месте.
 */
export const AMOCRM_AUTHORIZE_URL = `${API_BASE_URL.replace(/\/$/, '')}/v2/integrations/amocrm/oauth/authorize`;

export const AMOCRM_OAUTH_WINDOW_NAME = 'amocrm-oauth';
export const AMOCRM_OAUTH_WINDOW_FEATURES = 'width=560,height=760';

/** Тип сообщения, которое присылает callback-страница сервера. */
export const AMOCRM_OAUTH_MESSAGE_TYPE = 'amocrm-oauth';

export type AmocrmOAuthMessage =
  | { type: typeof AMOCRM_OAUTH_MESSAGE_TYPE; status: 'ok' }
  | { type: typeof AMOCRM_OAUTH_MESSAGE_TYPE; status: 'error'; message?: string };

/** Проверяет форму `MessageEvent.data` без доверия к содержимому. */
export function isAmocrmOAuthMessage(data: unknown): data is AmocrmOAuthMessage {
  if (!data || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  if (record.type !== AMOCRM_OAUTH_MESSAGE_TYPE) return false;
  return record.status === 'ok' || record.status === 'error';
}

export type AmocrmAuthorizationStart =
  | { opened: true; popup: Window }
  | { opened: false; url: string };

/**
 * Открывает страницу согласия во всплывающем окне.
 *
 * Если браузер заблокировал окно (`window.open` вернул null), возвращается
 * адрес, чтобы компонент показал ошибку и ссылку для ручного открытия.
 */
export function startAmocrmAuthorization(): AmocrmAuthorizationStart {
  const popup = window.open(
    AMOCRM_AUTHORIZE_URL,
    AMOCRM_OAUTH_WINDOW_NAME,
    AMOCRM_OAUTH_WINDOW_FEATURES,
  );
  if (!popup) return { opened: false, url: AMOCRM_AUTHORIZE_URL };
  return { opened: true, popup };
}
