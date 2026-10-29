import { useGetCrmConflictsQuery } from '@/api/baseApi';
import { describeError } from '@/api/errors';
import { Badge, EmptyState, ErrorState, LoadingState, uiStyles } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { CRM_POLICY_LABELS } from '@/lib/labels';
import styles from './crm.module.scss';

/**
 * Конфликты владельцев: в платформе и в amoCRM назначены разные ответственные.
 * Конфликт не разрешается автоматически — он показывает, чья сторона победила
 * по действующей политике, и ждёт решения человека.
 */
export function CrmConflictsPanel() {
  const query = useGetCrmConflictsQuery({ limit: 50 });
  const items = query.data?.items ?? [];

  return (
    <section className={styles.section} aria-labelledby="crm-conflicts-title">
      <div className={styles.sectionHeader}>
        <h2 id="crm-conflicts-title" className={styles.sectionTitle}>
          Конфликты владельцев
        </h2>
        <span className={uiStyles.hint}>{items.length} записей</span>
      </div>

      {query.isLoading ? <LoadingState label="Загружаем конфликты…" /> : null}
      {query.isError ? (
        <ErrorState
          title="Конфликты недоступны"
          message={describeError(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {query.data && items.length === 0 ? (
        <EmptyState
          title="Конфликтов нет"
          description="Ответственные в платформе и amoCRM совпадают."
        />
      ) : null}
      {items.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="visually-hidden">
              Конфликты владельцев: диалог, ответственные, политика, победитель и состояние
            </caption>
            <thead>
              <tr>
                <th scope="col">Диалог</th>
                <th scope="col">В amoCRM</th>
                <th scope="col">На платформе</th>
                <th scope="col">Нужно в CRM</th>
                <th scope="col">Политика</th>
                <th scope="col">Победитель</th>
                <th scope="col">Обнаружен</th>
              </tr>
            </thead>
            <tbody>
              {items.map((conflict) => (
                <tr key={conflict.id}>
                  <td className={uiStyles.mono}>{conflict.conversationId}</td>
                  <td className={uiStyles.mono}>{conflict.crmOwnerRef ?? '—'}</td>
                  <td className={uiStyles.mono}>{conflict.platformOwnerId ?? '—'}</td>
                  <td className={uiStyles.mono}>{conflict.desiredCrmOwnerRef ?? '—'}</td>
                  <td>{CRM_POLICY_LABELS[conflict.policy]}</td>
                  <td>
                    <Badge tone={conflict.winner === 'platform' ? 'accent' : 'neutral'}>
                      {conflict.winner === 'platform' ? 'платформа' : 'amoCRM'}
                    </Badge>
                  </td>
                  <td>{formatDateTime(conflict.detectedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
