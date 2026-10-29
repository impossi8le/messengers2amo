/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Базовый путь внутреннего API. Секретов здесь нет: авторизация — серверная сессия. */
  readonly VITE_API_BASE_URL?: string;
  /**
   * Подсказка для интерфейса: какую роль показывать. Права всё равно проверяет
   * сервер; без значения админские действия скрыты.
   */
  readonly VITE_OPERATOR_ROLE?: string;
  /**
   * Компания по умолчанию для формы входа: подставляется в поле, чтобы
   * оператору не вводить её каждый раз. Это не секрет.
   */
  readonly VITE_OPERATOR_COMPANY_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
