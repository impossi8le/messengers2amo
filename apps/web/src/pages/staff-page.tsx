import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useGetStaffAvailabilityQuery, useSetStaffAvailabilityMutation } from '@/api/baseApi';
import { describeError, isVersionConflict } from '@/api/errors';
import type { Availability, StaffAvailability } from '@/api/types';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  uiStyles,
} from '@/components/ui';
import { newIdempotencyKey } from '@/lib/ids';
import { AVAILABILITY_LABELS, AVAILABILITY_TONE } from '@/lib/labels';
import styles from './staff-page.module.scss';

const AVAILABILITY_ORDER: Availability[] = ['online', 'away', 'offline'];

export function StaffPage() {
  const query = useGetStaffAvailabilityQuery({ limit: 50 });

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Смены и нагрузка</h1>
          <p className={uiStyles.muted}>
            Кто на линии, сколько обращений в работе и в каком подразделении. Передача обращения
            выполняется из карточки диалога.
          </p>
        </div>
        <Button onClick={() => void query.refetch()} disabled={query.isFetching}>
          <RefreshCw size={16} aria-hidden="true" />
          {query.isFetching ? 'Обновляем…' : 'Обновить'}
        </Button>
      </header>

      {query.isLoading ? <LoadingState label="Загружаем сотрудников…" /> : null}

      {query.isError ? (
        <ErrorState
          title="Не удалось загрузить список сотрудников"
          message={describeError(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : null}

      {query.data && query.data.items.length === 0 ? (
        <EmptyState title="Сотрудников нет" description="Список смен пуст." />
      ) : null}

      {query.data && query.data.items.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="visually-hidden">
              Доступность сотрудников, подразделения и текущая нагрузка
            </caption>
            <thead>
              <tr>
                <th scope="col">Сотрудник</th>
                <th scope="col">Доступность</th>
                <th scope="col">Подразделения</th>
                <th scope="col">Нагрузка</th>
                <th scope="col">Изменить статус</th>
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((person) => (
                <StaffRow key={person.id} person={person} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function StaffRow({ person }: { person: StaffAvailability }) {
  const [setAvailability, state] = useSetStaffAvailabilityMutation();
  const [error, setError] = useState<string | null>(null);

  const change = async (availability: Availability) => {
    setError(null);
    try {
      await setAvailability({
        id: person.id,
        body: {
          idempotencyKey: newIdempotencyKey('availability'),
          expectedVersion: person.version,
          availability,
        },
      }).unwrap();
    } catch (e) {
      setError(
        isVersionConflict(e)
          ? `${describeError(e)} Статус уже изменили — обновите список.`
          : describeError(e),
      );
    }
  };

  const load = person.capacity > 0 ? Math.min(person.activeCount / person.capacity, 1) : 0;

  return (
    <tr>
      <td>
        <span className={uiStyles.mono}>{person.id}</span>
      </td>
      <td>
        <Badge tone={AVAILABILITY_TONE[person.availability]}>
          {AVAILABILITY_LABELS[person.availability]}
        </Badge>
      </td>
      <td>
        {person.departmentIds.length ? (
          <span className={uiStyles.mono}>{person.departmentIds.join(', ')}</span>
        ) : (
          <span className={uiStyles.muted}>—</span>
        )}
      </td>
      <td>
        <div className={styles.load}>
          <span aria-hidden="true" className={styles.loadBar}>
            <span className={styles.loadFill} style={{ width: `${load * 100}%` }} />
          </span>
          <span>
            {person.activeCount} / {person.capacity}
            <span className="visually-hidden">
              {' '}
              обращений в работе из {person.capacity} возможных
            </span>
          </span>
        </div>
      </td>
      <td>
        <div className={uiStyles.row}>
          {AVAILABILITY_ORDER.map((option) => (
            <Button
              key={option}
              size="small"
              onClick={() => void change(option)}
              disabled={state.isLoading || person.availability === option}
              aria-label={`Отметить «${AVAILABILITY_LABELS[option]}» для ${person.id}`}
            >
              {AVAILABILITY_LABELS[option]}
            </Button>
          ))}
        </div>
        {error ? (
          <Alert tone="error" title="Не удалось изменить статус">
            {error}
          </Alert>
        ) : null}
      </td>
    </tr>
  );
}
