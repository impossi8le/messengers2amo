import { zodResolver } from '@hookform/resolvers/zod';
import { Route } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  useGetConnectionsQuery,
  useGetWorkshopRoutesQuery,
  useSetWorkshopRouteMutation,
} from '@/api/baseApi';
import { describeError, isVersionConflict } from '@/api/errors';
import type { ConnectionRoute } from '@/api/types';
import {
  Alert,
  Button,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  uiStyles,
} from '@/components/ui';
import { channelLabel } from '@/lib/labels';
import styles from './workshops.module.scss';

const routeSchema = z.object({
  connectionId: z.string().trim().min(1, 'Выберите подключение'),
  crmAccountId: z.string().trim().min(1, 'Укажите аккаунт amoCRM').max(128),
  funnelId: z.string().trim().min(1, 'Укажите воронку').max(128),
  defaultOwnerId: z.string().trim().min(1, 'Укажите ответственного по умолчанию').max(128),
  technicalSourceId: z.string().trim().min(1, 'Укажите технический источник').max(128),
});

type RouteValues = z.infer<typeof routeSchema>;

export interface WorkshopRoutesProps {
  workshopId: string;
  /** Создание и правка маршрутов доступны только роли admin. */
  isAdmin: boolean;
}

export function WorkshopRoutes({ workshopId, isAdmin }: WorkshopRoutesProps) {
  const query = useGetWorkshopRoutesQuery(workshopId);

  return (
    <section className={styles.section} aria-labelledby="workshop-routes-title">
      <div className={styles.sectionHeader}>
        <h3 id="workshop-routes-title" className={styles.sectionTitle}>
          Маршруты подключений
        </h3>
        <span className={uiStyles.hint}>{query.data?.items.length ?? 0} маршрутов</span>
      </div>
      <p className={uiStyles.hint}>
        Маршрут связывает подключение с мастерской, аккаунтом amoCRM, воронкой и техническим
        источником. У подключения ровно один маршрут.
      </p>

      {query.isLoading ? <LoadingState label="Загружаем маршруты…" /> : null}
      {query.isError ? (
        <ErrorState
          title="Маршруты недоступны"
          message={describeError(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {query.data && query.data.items.length === 0 ? (
        <EmptyState
          title="Маршрутов нет"
          description="Подключения этой мастерской ещё не распределены."
        />
      ) : null}
      {query.data && query.data.items.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="visually-hidden">
              Маршруты подключений мастерской: подключение, аккаунт, воронка, ответственный,
              источник и версия
            </caption>
            <thead>
              <tr>
                <th scope="col">Подключение</th>
                <th scope="col">Аккаунт CRM</th>
                <th scope="col">Воронка</th>
                <th scope="col">Ответственный</th>
                <th scope="col">Источник</th>
                <th scope="col">Версия</th>
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((route) => (
                <tr key={route.connectionId}>
                  <td className={uiStyles.mono}>{route.connectionId}</td>
                  <td className={uiStyles.mono}>{route.crmAccountId}</td>
                  <td className={uiStyles.mono}>{route.funnelId}</td>
                  <td className={uiStyles.mono}>{route.defaultOwnerId}</td>
                  <td className={uiStyles.mono}>{route.technicalSourceId}</td>
                  <td className={uiStyles.mono}>{route.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {isAdmin ? <RouteForm workshopId={workshopId} routes={query.data?.items ?? []} /> : null}
    </section>
  );
}

function RouteForm({ workshopId, routes }: { workshopId: string; routes: ConnectionRoute[] }) {
  const [save, state] = useSetWorkshopRouteMutation();
  const connections = useGetConnectionsQuery({ limit: 50 });
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const form = useForm<RouteValues>({
    resolver: zodResolver(routeSchema),
    defaultValues: {
      connectionId: '',
      crmAccountId: '',
      funnelId: '',
      defaultOwnerId: '',
      technicalSourceId: '',
    },
  });

  const handleSubmit = form.handleSubmit(async (values) => {
    setMessage(null);
    const existing = routes.find((item) => item.connectionId === values.connectionId);
    try {
      await save({
        workshopId,
        body: {
          connectionId: values.connectionId.trim(),
          crmAccountId: values.crmAccountId.trim(),
          funnelId: values.funnelId.trim(),
          defaultOwnerId: values.defaultOwnerId.trim(),
          technicalSourceId: values.technicalSourceId.trim(),
          // Новый маршрут начинается с версии 0; существующий правится по текущей версии.
          expectedVersion: existing?.version ?? 0,
        },
      }).unwrap();
      setMessage({ tone: 'success', text: 'Маршрут сохранён.' });
      form.reset();
    } catch (error) {
      setMessage({
        tone: 'error',
        text: isVersionConflict(error)
          ? `${describeError(error)} Маршрут изменили — обновите список.`
          : describeError(error),
      });
    }
  });

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      <h4 className={styles.subtitle}>Создать или изменить маршрут</h4>
      <p className={uiStyles.hint}>
        Доступно только роли admin. Изменение маршрута повышает его версию и попадает в аудит.
      </p>

      <Field
        id="route-connection"
        label="Подключение"
        hint="Выберите канал из списка или введите его идентификатор."
        error={form.formState.errors.connectionId?.message}
      >
        <input
          id="route-connection"
          className={uiStyles.input}
          list="route-connection-options"
          autoComplete="off"
          aria-invalid={Boolean(form.formState.errors.connectionId)}
          {...form.register('connectionId')}
        />
        <datalist id="route-connection-options">
          {(connections.data?.items ?? []).map((connection) => (
            <option key={connection.id} value={connection.id}>
              {channelLabel(connection.channelMode)}
            </option>
          ))}
        </datalist>
      </Field>

      <div className={styles.formGrid}>
        <Field
          id="route-account"
          label="Аккаунт amoCRM"
          error={form.formState.errors.crmAccountId?.message}
        >
          <input
            id="route-account"
            className={uiStyles.input}
            autoComplete="off"
            aria-invalid={Boolean(form.formState.errors.crmAccountId)}
            {...form.register('crmAccountId')}
          />
        </Field>
        <Field id="route-funnel" label="Воронка" error={form.formState.errors.funnelId?.message}>
          <input
            id="route-funnel"
            className={uiStyles.input}
            autoComplete="off"
            aria-invalid={Boolean(form.formState.errors.funnelId)}
            {...form.register('funnelId')}
          />
        </Field>
        <Field
          id="route-owner"
          label="Ответственный по умолчанию"
          error={form.formState.errors.defaultOwnerId?.message}
        >
          <input
            id="route-owner"
            className={uiStyles.input}
            autoComplete="off"
            aria-invalid={Boolean(form.formState.errors.defaultOwnerId)}
            {...form.register('defaultOwnerId')}
          />
        </Field>
        <Field
          id="route-source"
          label="Технический источник"
          error={form.formState.errors.technicalSourceId?.message}
        >
          <input
            id="route-source"
            className={uiStyles.input}
            autoComplete="off"
            aria-invalid={Boolean(form.formState.errors.technicalSourceId)}
            {...form.register('technicalSourceId')}
          />
        </Field>
      </div>

      <div className={uiStyles.row}>
        <Button type="submit" variant="primary" disabled={state.isLoading}>
          <Route size={16} aria-hidden="true" />
          {state.isLoading ? 'Сохраняем…' : 'Сохранить маршрут'}
        </Button>
      </div>

      {message ? (
        <Alert tone={message.tone} title={message.tone === 'error' ? 'Не сохранено' : 'Готово'}>
          {message.text}
        </Alert>
      ) : null}
    </form>
  );
}
