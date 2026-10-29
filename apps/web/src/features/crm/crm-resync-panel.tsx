import { zodResolver } from '@hookform/resolvers/zod';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useResyncCrmMutation } from '@/api/baseApi';
import { describeError, isForbidden } from '@/api/errors';
import type { CrmResyncResult } from '@/api/types';
import { Alert, Badge, Button, Field, uiStyles } from '@/components/ui';
import { newIdempotencyKey } from '@/lib/ids';
import { CRM_RESYNC_STATUS_LABELS, CRM_RESYNC_STATUS_TONE } from '@/lib/labels';
import styles from './crm.module.scss';

const resyncSchema = z.object({
  accountId: z.string().trim().min(1, 'Укажите аккаунт amoCRM').max(128),
  conversationId: z.string().trim().min(1, 'Укажите диалог').max(128),
});

type ResyncValues = z.infer<typeof resyncSchema>;

/**
 * Ручная ресинхронизация владельца диалога с amoCRM.
 *
 * Операция идемпотентна по ключу: повтор с тем же ключом не читает CRM заново
 * и возвращает признак `replayed`. Пока запрос выполняется, кнопка заблокирована
 * и форма помечена `aria-busy` — двойной клик не создаёт вторую синхронизацию.
 */
export function CrmResyncPanel() {
  const [resync, state] = useResyncCrmMutation();
  const [result, setResult] = useState<CrmResyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<ResyncValues>({
    resolver: zodResolver(resyncSchema),
    defaultValues: { accountId: '', conversationId: '' },
  });

  const handleSubmit = form.handleSubmit(async (values) => {
    setResult(null);
    setError(null);
    try {
      const outcome = await resync({
        accountId: values.accountId.trim(),
        conversationId: values.conversationId.trim(),
        idempotencyKey: newIdempotencyKey('resync'),
      }).unwrap();
      setResult(outcome);
    } catch (caught) {
      setError(
        isForbidden(caught)
          ? 'Ручная ресинхронизация требует права отправки. Обратитесь к руководителю.'
          : describeError(caught),
      );
    }
  });

  return (
    <section className={styles.section} aria-labelledby="crm-resync-title">
      <div className={styles.sectionHeader}>
        <h2 id="crm-resync-title" className={styles.sectionTitle}>
          Ручная ресинхронизация
        </h2>
        <span className={uiStyles.hint}>идемпотентно по ключу</span>
      </div>
      <p className={uiStyles.hint}>
        Перечитывает ответственного из amoCRM и применяет политику назначений. Повторный запуск не
        создаёт дублей.
      </p>

      <form className={styles.form} onSubmit={handleSubmit} noValidate aria-busy={state.isLoading}>
        <div className={styles.formGrid}>
          <Field
            id="resync-account"
            label="Аккаунт amoCRM"
            error={form.formState.errors.accountId?.message}
          >
            <input
              id="resync-account"
              className={uiStyles.input}
              autoComplete="off"
              aria-invalid={Boolean(form.formState.errors.accountId)}
              {...form.register('accountId')}
            />
          </Field>
          <Field
            id="resync-conversation"
            label="Диалог"
            error={form.formState.errors.conversationId?.message}
          >
            <input
              id="resync-conversation"
              className={uiStyles.input}
              autoComplete="off"
              aria-invalid={Boolean(form.formState.errors.conversationId)}
              {...form.register('conversationId')}
            />
          </Field>
        </div>

        <div className={uiStyles.row}>
          <Button type="submit" variant="primary" disabled={state.isLoading}>
            <RefreshCw size={16} aria-hidden="true" />
            {state.isLoading ? 'Синхронизируем…' : 'Синхронизировать'}
          </Button>
          {state.isLoading ? (
            <span role="status" aria-live="polite" className={uiStyles.hint}>
              Запрос к amoCRM выполняется…
            </span>
          ) : (
            <span className={uiStyles.hint}>
              Результат появится здесь; диагностика обновится автоматически.
            </span>
          )}
        </div>
      </form>

      {error ? (
        <Alert tone="error" title="Синхронизация не выполнена">
          {error}
        </Alert>
      ) : null}

      {result ? (
        <Alert
          tone={
            result.status === 'ok'
              ? 'success'
              : result.status === 'lead_missing'
                ? 'warning'
                : 'error'
          }
          title="Результат синхронизации"
        >
          <div className={uiStyles.row}>
            <Badge tone={CRM_RESYNC_STATUS_TONE[result.status]}>
              {CRM_RESYNC_STATUS_LABELS[result.status]}
            </Badge>
            {result.replayed ? <Badge tone="neutral">повтор запроса</Badge> : null}
          </div>
          <p className={uiStyles.hint}>
            Сделка: {result.leadId ?? 'нет'} · ответственный в CRM: {result.crmOwnerRef ?? 'нет'}
            {result.errorCode ? ` · код ошибки: ${result.errorCode}` : ''}
          </p>
        </Alert>
      ) : null}
    </section>
  );
}
