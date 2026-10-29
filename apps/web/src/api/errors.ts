import type { ApiError, ApiErrorCode } from './types';

/**
 * Единая форма ошибки для всего UI. Сетевой сбой, невалидный ответ и
 * прикладная ошибка контракта выглядят одинаково: у каждого состояния
 * загрузки есть явный текст и признак повторяемости.
 */
export interface NormalizedApiError {
  kind: 'http' | 'network' | 'invalid-response';
  httpStatus?: number;
  code?: ApiErrorCode;
  requestId?: string;
  retryable: boolean;
  message: string;
}

const CODE_MESSAGES: Record<ApiErrorCode, string> = {
  VALIDATION_FAILED: 'Сервер отклонил данные запроса. Проверьте заполнение полей.',
  UNAUTHENTICATED: 'Сессия истекла. Войдите заново.',
  FORBIDDEN: 'Недостаточно прав для этого действия.',
  NOT_FOUND: 'Объект не найден: возможно, его уже удалили или перенесли.',
  VERSION_CONFLICT: 'Данные уже изменил другой оператор. Обновите карточку и повторите.',
  CAPACITY_EXCEEDED:
    'У сотрудника нет свободных мест для новых обращений. Повтор запроса не поможет — нужен администратор.',
  IDEMPOTENCY_CONFLICT: 'Этот запрос уже выполнялся с другими параметрами.',
  STALE_EPOCH: 'Подключение перепривязано. Обновите снимок перед отправкой.',
  CAPABILITY_BLOCKED: 'Канал не поддерживает это действие.',
  UPSTREAM_UNAVAILABLE: 'Внешний провайдер недоступен. Повторите позже.',
  RATE_LIMITED: 'Слишком много запросов. Подождите и повторите.',
  INTERNAL_ERROR: 'Внутренняя ошибка сервиса. Сообщите номер запроса администратору.',
};

export const NETWORK_ERROR_MESSAGE = 'Нет связи с сервером. Проверьте сеть и повторите запрос.';

export const INVALID_RESPONSE_MESSAGE =
  'Сервер вернул неожиданный ответ. Повторите запрос; если ошибка повторится — сообщите администратору.';

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && value in CODE_MESSAGES;
}

export function messageForCode(code: ApiErrorCode): string {
  return CODE_MESSAGES[code];
}

export function networkError(): NormalizedApiError {
  return {
    kind: 'network',
    retryable: true,
    message: NETWORK_ERROR_MESSAGE,
  };
}

export function invalidResponseError(httpStatus?: number): NormalizedApiError {
  return {
    kind: 'invalid-response',
    httpStatus,
    retryable: true,
    message: INVALID_RESPONSE_MESSAGE,
  };
}

export function httpError(httpStatus: number, body: unknown): NormalizedApiError {
  if (body && typeof body === 'object') {
    const candidate = body as Partial<ApiError>;
    if (isApiErrorCode(candidate.code)) {
      return {
        kind: 'http',
        httpStatus,
        code: candidate.code,
        requestId: typeof candidate.requestId === 'string' ? candidate.requestId : undefined,
        retryable: candidate.retryable === true,
        message: CODE_MESSAGES[candidate.code],
      };
    }
  }
  return {
    kind: 'http',
    httpStatus,
    retryable: httpStatus >= 500 || httpStatus === 429,
    message: `Запрос отклонён (HTTP ${httpStatus}). Повторите позже.`,
  };
}

export function isVersionConflict(error: unknown): boolean {
  const e = error as NormalizedApiError | undefined;
  return e?.code === 'VERSION_CONFLICT' || e?.code === 'STALE_EPOCH';
}

export function isForbidden(error: unknown): boolean {
  return (error as NormalizedApiError | undefined)?.code === 'FORBIDDEN';
}

export function describeError(error: unknown): string {
  const e = error as NormalizedApiError | undefined;
  if (e?.message) {
    return e.requestId ? `${e.message} (запрос ${e.requestId})` : e.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Неизвестная ошибка. Повторите запрос.';
}
