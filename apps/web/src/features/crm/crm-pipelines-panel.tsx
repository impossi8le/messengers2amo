import { useState } from 'react';
import { useGetPipelinesQuery, useRefreshPipelinesMutation } from '@/api/baseApi';
import { describeError } from '@/api/errors';
import { Alert, Button, LoadingState, uiStyles } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import styles from './crm.module.scss';

export function CrmPipelinesPanel() {
  const catalogue = useGetPipelinesQuery(undefined);
  const [refresh, refreshing] = useRefreshPipelinesMutation();
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    setError(null);
    try {
      await refresh().unwrap();
    } catch (failure) {
      setError(describeError(failure));
    }
  };

  return (
    <section className={styles.section} aria-labelledby="crm-pipelines-title">
      <h2 id="crm-pipelines-title" className={styles.sectionTitle}>
        Воронки amoCRM
      </h2>
      <p className={uiStyles.hint}>
        Выберите воронку и этап в карточке канала. После изменения воронок в amoCRM обновите
        справочник.
      </p>
      {catalogue.isLoading ? <LoadingState label="Загружаем воронки…" /> : null}
      {catalogue.data ? (
        <>
          <p>Доступно воронок: {catalogue.data.items.length}.</p>
          <p className={uiStyles.muted}>
            Справочник получен:{' '}
            {formatDateTime(
              catalogue.fulfilledTimeStamp
                ? new Date(catalogue.fulfilledTimeStamp).toISOString()
                : null,
            )}
          </p>
        </>
      ) : null}
      {error || catalogue.isError ? (
        <Alert tone="error" title="Не удалось обновить воронки">
          {error ?? describeError(catalogue.error)}
        </Alert>
      ) : null}
      <Button onClick={() => void reload()} disabled={catalogue.isFetching || refreshing.isLoading}>
        {refreshing.isLoading ? 'Обновляем…' : 'Обновить воронки'}
      </Button>
    </section>
  );
}
