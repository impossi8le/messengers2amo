import { Bell } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useGetNotificationsQuery } from '@/api/baseApi';
import { uiStyles } from '@/components/ui';
import { useDocumentVisible, useRefetchOnVisible } from '@/lib/document-visibility';
import { formatRelative } from '@/lib/format';
import { notificationKindLabel } from '@/lib/labels';
import { useSessionStore } from '@/store/session';
import styles from './notifications-indicator.module.scss';

/**
 * Период опроса ленты уведомлений.
 *
 * Раз в минуту, и только пока вкладка видима и сессия подтверждена: уведомления
 * не настолько срочные, чтобы платить запросом каждые 30 секунд, а фоновые
 * вкладки и истёкшие cookie иначе дают 401 в логах круглые сутки.
 */
export const NOTIFICATIONS_POLL_INTERVAL_MS = 60_000;

const PAGE_SIZE = 20;

/**
 * Индикатор уведомлений в шапке: счётчик из `hints` (сводка по области
 * сессии) и выпадающая панель со списком. Ошибка запроса не выносится в
 * громкий баннер: шапка остаётся рабочей, а панель показывает нейтральный
 * текст.
 */
export function NotificationsIndicator() {
  const authenticated = useSessionStore((state) => state.status === 'authenticated');
  const visible = useDocumentVisible();
  const query = useGetNotificationsQuery(
    { limit: PAGE_SIZE },
    {
      // Без подтверждённой сессии запрос не подписывается вовсе: иначе выход
      // или истёкшая cookie дают 401 на каждом тике опроса.
      skip: !authenticated,
      // Ноль выключает таймер RTK Query; при возврате на вкладку данные
      // обновляются немедленно (см. useRefetchOnVisible).
      pollingInterval: authenticated && visible ? NOTIFICATIONS_POLL_INTERVAL_MS : 0,
    },
  );
  useRefetchOnVisible(query.refetch, { enabled: authenticated, visible });
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const items = query.data?.items ?? [];
  const hints = query.data?.hints;
  // hints — сводка по всей области сессии, а не по текущей странице списка.
  // Без hints (старый ответ) считаем элементы, которые реально пришли.
  const count = hints
    ? hints.replyRequiredCount +
      hints.overdueCount +
      hints.unknownSendCount +
      (hints.channelAlertCount ?? 0)
    : items.length;
  const badge = count > 99 ? '99+' : String(count);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-haspopup="true"
        aria-controls={open ? panelId : undefined}
        aria-label={count > 0 ? `Уведомления: ${count} новых` : 'Уведомления'}
        onClick={() => {
          // Панель показывает свежий срез, а не ждёт следующего тика опроса.
          if (!open && authenticated) void query.refetch();
          setOpen(!open);
        }}
      >
        <Bell size={18} aria-hidden="true" />
        {count > 0 ? (
          <span className={styles.counter} aria-hidden="true">
            {badge}
          </span>
        ) : null}
      </button>
      <span className="visually-hidden" aria-live="polite">
        {count > 0 ? `Новых уведомлений: ${count}` : 'Новых уведомлений нет'}
      </span>

      {open ? (
        <section id={panelId} className={styles.panel} aria-label="Уведомления">
          {/* Ошибка держится и во время повторного запроса: иначе панель на
              мгновение пустеет после refetch при открытии. */}
          {query.isError ? (
            <p className={uiStyles.hint}>Не удалось загрузить уведомления</p>
          ) : query.isLoading || (query.isFetching && !query.data) ? (
            <p className={uiStyles.hint}>Загружаем уведомления…</p>
          ) : null}

          {query.data && items.length === 0 ? (
            <p className={uiStyles.hint}>Нет уведомлений</p>
          ) : null}

          {items.length > 0 ? (
            <ul className={styles.list}>
              {items.map((item) => (
                <li key={item.id}>
                  <Link
                    to={
                      item.kind === 'channel_alert'
                        ? '/connections'
                        : `/work-items/${encodeURIComponent(item.workItemId)}`
                    }
                    className={styles.item}
                    aria-label={
                      item.kind === 'channel_alert'
                        ? `${notificationKindLabel(item.kind)}: канал ${item.channelAlert?.connectionId ?? item.workItemId}`
                        : `${notificationKindLabel(item.kind)}: обращение ${item.workItemId}`
                    }
                    onClick={() => setOpen(false)}
                  >
                    <span className={styles.kind}>{notificationKindLabel(item.kind)}</span>
                    {item.hint ? <span className={styles.hint}>{item.hint}</span> : null}
                    <time className={styles.time} dateTime={item.createdAt}>
                      {formatRelative(item.createdAt)}
                    </time>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
