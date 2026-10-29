import { zodResolver } from '@hookform/resolvers/zod';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useGetCrmDiagnosticsQuery } from '@/api/baseApi';
import { describeError } from '@/api/errors';
import { Alert, Badge, Button, ErrorState, Field, LoadingState, uiStyles } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import styles from './crm.module.scss';

const diagnosticsSchema = z.object({
  accountId: z.string().trim().min(1, 'Укажите аккаунт amoCRM').max(128),
  conversationId: z.string().trim().min(1, 'Укажите диалог').max(128),
});

type DiagnosticsValues = z.infer<typeof diagnosticsSchema>;

/**
 * Диагностика связки диалога с CRM: состояние синхронизации, отсутствие сделки,
 * проекция и число открытых конфликтов. Читается по паре «аккаунт + диалог».
 */
export function CrmDiagnosticsPanel() {
  const [requested, setRequested] = useState<{ accountId: string; conversationId: string } | null>(
    null,
  );
  const query = useGetCrmDiagnosticsQuery(requested ?? { accountId: '', conversationId: '' }, {
    skip: !requested,
  });

  const form = useForm<DiagnosticsValues>({
    resolver: zodResolver(diagnosticsSchema),
    defaultValues: { accountId: '', conversationId: '' },
  });

  const handleSubmit = form.handleSubmit((values) => {
    setRequested({
      accountId: values.accountId.trim(),
      conversationId: values.conversationId.trim(),
    });
  });

  return (
    <section className={styles.section} aria-labelledby="crm-diagnostics-title">
      <h2 id="crm-diagnostics-title" className={styles.sectionTitle}>
        Диагностика связки
      </h2>

      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <div className={styles.formGrid}>
          <Field
            id="diagnostics-account"
            label="Аккаунт amoCRM для диагностики"
            error={form.formState.errors.accountId?.message}
          >
            <input
              id="diagnostics-account"
              className={uiStyles.input}
              autoComplete="off"
              aria-invalid={Boolean(form.formState.errors.accountId)}
              {...form.register('accountId')}
            />
          </Field>
          <Field
            id="diagnostics-conversation"
            label="Диалог для диагностики"
            error={form.formState.errors.conversationId?.message}
          >
            <input
              id="diagnostics-conversation"
              className={uiStyles.input}
              autoComplete="off"
              aria-invalid={Boolean(form.formState.errors.conversationId)}
              {...form.register('conversationId')}
            />
          </Field>
        </div>
        <div className={uiStyles.row}>
          <Button type="submit" variant="primary" disabled={query.isFetching}>
            <Search size={16} aria-hidden="true" />
            Показать диагностику
          </Button>
        </div>
      </form>

      {query.isLoading ? <LoadingState label="Запрашиваем диагностику…" /> : null}
      {query.isError ? (
        <ErrorState
          title="Диагностика недоступна"
          message={describeError(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : null}

      {query.data ? (
        <div className={styles.diagnostics}>
          <dl className={styles.meta}>
            <div>
              <dt>Синхронизация</dt>
              <dd>
                {query.data.sync ? (
                  <Badge tone={query.data.sync.status === 'ok' ? 'success' : 'warning'}>
                    {query.data.sync.status}
                  </Badge>
                ) : (
                  <span className={uiStyles.muted}>не запускалась</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Последняя попытка</dt>
              <dd>{formatDateTime(query.data.sync?.lastAttemptAt)}</dd>
            </div>
            <div>
              <dt>Последний успех</dt>
              <dd>{formatDateTime(query.data.sync?.lastSuccessAt)}</dd>
            </div>
            <div>
              <dt>Открытых конфликтов</dt>
              <dd>{query.data.openConflicts}</dd>
            </div>
            <div>
              <dt>Сделка</dt>
              <dd>
                {query.data.leadMissing ? (
                  <Badge tone="warning">не найдена в amoCRM</Badge>
                ) : (
                  <Badge tone="success">на месте</Badge>
                )}
              </dd>
            </div>
          </dl>

          {query.data.sync?.errorCode ? (
            <Alert tone="warning" title="Ошибка синхронизации">
              {query.data.sync.errorCode}
            </Alert>
          ) : null}

          <div>
            <h3 className={styles.subtitle}>Связанная карточка</h3>
            {query.data.binding ? (
              <>
                <p className={uiStyles.hint}>
                  Сделка: {query.data.binding.leadId ?? 'нет'} · контакт:{' '}
                  {query.data.binding.contactId ?? 'нет'} · чат:{' '}
                  {query.data.binding.chatId ?? 'нет'}
                </p>
                {query.data.cardUrl ? (
                  <a
                    className={styles.cardLink}
                    href={query.data.cardUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Открыть карточку в amoCRM
                  </a>
                ) : (
                  <p className={uiStyles.muted}>
                    Ссылка на карточку недоступна: домен аккаунта не настроен.
                  </p>
                )}
              </>
            ) : (
              <p className={uiStyles.muted}>Связки с CRM нет.</p>
            )}
          </div>

          <div>
            <h3 className={styles.subtitle}>Проекция в CRM</h3>
            {query.data.projection ? (
              <pre className={styles.pre}>{JSON.stringify(query.data.projection, null, 2)}</pre>
            ) : (
              <p className={uiStyles.muted}>Проекции нет: связь не создана или отключена.</p>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
