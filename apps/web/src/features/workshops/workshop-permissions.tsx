import { useGetWorkshopPermissionsQuery } from '@/api/baseApi';
import { describeError } from '@/api/errors';
import { Badge, EmptyState, ErrorState, LoadingState, uiStyles } from '@/components/ui';
import styles from './workshops.module.scss';

/**
 * Права на канал внутри мастерской. Чтение и отправка выдаются раздельно:
 * доступ на чтение не даёт права отвечать клиенту.
 */
export function WorkshopPermissions({ workshopId }: { workshopId: string }) {
  const query = useGetWorkshopPermissionsQuery(workshopId);

  return (
    <section className={styles.section} aria-labelledby="workshop-permissions-title">
      <div className={styles.sectionHeader}>
        <h3 id="workshop-permissions-title" className={styles.sectionTitle}>
          Права на каналы
        </h3>
        <span className={uiStyles.hint}>чтение и отправка — раздельно</span>
      </div>

      {query.isLoading ? <LoadingState label="Загружаем права…" /> : null}
      {query.isError ? (
        <ErrorState
          title="Права недоступны"
          message={describeError(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {query.data && query.data.items.length === 0 ? (
        <EmptyState
          title="Прав нет"
          description="Ни один сотрудник не имеет доступа к каналам мастерской."
        />
      ) : null}
      {query.data && query.data.items.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="visually-hidden">
              Права сотрудников на каналы мастерской: чтение и отправка
            </caption>
            <thead>
              <tr>
                <th scope="col">Подключение</th>
                <th scope="col">Сотрудник</th>
                <th scope="col">Чтение</th>
                <th scope="col">Отправка</th>
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((permission) => (
                <tr key={`${permission.connectionId}:${permission.staffId}`}>
                  <td className={uiStyles.mono}>{permission.connectionId}</td>
                  <td className={uiStyles.mono}>{permission.staffId}</td>
                  <td>
                    <Badge tone={permission.canRead ? 'success' : 'neutral'}>
                      {permission.canRead ? 'разрешено' : 'нет'}
                    </Badge>
                  </td>
                  <td>
                    <Badge tone={permission.canSend ? 'success' : 'neutral'}>
                      {permission.canSend ? 'разрешено' : 'нет'}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
