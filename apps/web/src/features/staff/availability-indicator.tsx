import { Link } from 'react-router-dom';
import { useGetStaffAvailabilityQuery } from '@/api/baseApi';
import type { Availability } from '@/api/types';
import { uiStyles } from '@/components/ui';
import { useDocumentVisible, useRefetchOnVisible } from '@/lib/document-visibility';
import { useSessionStore } from '@/store/session';
import styles from './availability-indicator.module.scss';

const ORDER: Availability[] = ['online', 'away', 'offline'];

const SHORT_LABELS: Record<Availability, string> = {
  online: 'на линии',
  away: 'отошли',
  offline: 'не в сети',
};

/**
 * Период опроса смены. Смена меняется не мгновенно, минуты достаточно; главное —
 * не опрашивать скрытую вкладку и консоль без подтверждённой сессии.
 */
export const STAFF_AVAILABILITY_POLL_INTERVAL_MS = 60_000;

const PAGE_SIZE = 50;

/**
 * Компактный индикатор смены: сколько операторов на линии, отошло и офлайн.
 *
 * Он всегда виден в шапке, поэтому ошибка сети не превращается в громкий
 * баннер: показываем нейтральное «нет данных» и ссылку на раздел смен.
 */
export function AvailabilityIndicator() {
  const authenticated = useSessionStore((state) => state.status === 'authenticated');
  const visible = useDocumentVisible();
  const query = useGetStaffAvailabilityQuery(
    { limit: PAGE_SIZE },
    {
      skip: !authenticated,
      pollingInterval: authenticated && visible ? STAFF_AVAILABILITY_POLL_INTERVAL_MS : 0,
    },
  );
  useRefetchOnVisible(query.refetch, { enabled: authenticated, visible });
  const items = query.data?.items ?? [];

  const counts = ORDER.map((availability) => ({
    availability,
    count: items.filter((person) => person.availability === availability).length,
  }));

  return (
    <div className={styles.indicator} role="status" aria-live="polite">
      <span className={styles.caption}>Смена</span>
      {query.isLoading ? (
        <span className={uiStyles.hint}>загружаем…</span>
      ) : query.isError ? (
        <span className={uiStyles.hint}>нет данных</span>
      ) : items.length === 0 ? (
        <span className={uiStyles.hint}>сотрудников нет</span>
      ) : (
        <ul className={styles.list}>
          {counts.map(({ availability, count }) => (
            <li key={availability} className={styles.item}>
              <span className={styles[availability]} aria-hidden="true" />
              <span>
                {count} {SHORT_LABELS[availability]}
              </span>
            </li>
          ))}
        </ul>
      )}
      <Link to="/staff" className={styles.link}>
        Подробнее
      </Link>
    </div>
  );
}
