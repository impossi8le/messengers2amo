import { useEffect, useRef, useState } from 'react';

/**
 * Видима ли вкладка прямо сейчас. В SSR и в окружениях без `document`
 * считаем вкладку видимой, чтобы не гасить опрос без причины.
 */
export function isDocumentVisible(): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState !== 'hidden';
}

/**
 * Подписка на видимость вкладки.
 *
 * Браузер присылает `visibilitychange` и при скрытии, и при возврате, но само
 * событие не несёт состояния — его перечитываем из `document`.
 */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(isDocumentVisible);

  useEffect(() => {
    const onChange = () => setVisible(isDocumentVisible());
    document.addEventListener('visibilitychange', onChange);
    // Состояние могло измениться между рендером и подпиской.
    onChange();
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  return visible;
}

/**
 * Немедленное обновление данных при возврате на вкладку.
 *
 * `refetch` вызывается только на переходе «скрыта → видима»: пока вкладка была
 * скрыта, опрос стоял, и данные успели устареть. Переход «сессия не
 * подтверждена → подтверждена» намеренно не считается: подписка на запрос сама
 * делает первый запрос, и второй был бы дублем.
 */
export function useRefetchOnVisible(
  refetch: () => unknown,
  { enabled, visible }: { enabled: boolean; visible: boolean },
): void {
  const wasVisible = useRef(visible);

  useEffect(() => {
    const previous = wasVisible.current;
    wasVisible.current = visible;
    if (enabled && visible && !previous) void refetch();
  }, [enabled, visible, refetch]);
}
