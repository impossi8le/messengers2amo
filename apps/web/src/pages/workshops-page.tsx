import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useCreateWorkshopMutation, useGetWorkshopsQuery } from '@/api/baseApi';
import { describeError } from '@/api/errors';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  uiStyles,
} from '@/components/ui';
import { WorkshopGroups } from '@/features/workshops/workshop-groups';
import { WorkshopPermissions } from '@/features/workshops/workshop-permissions';
import { WorkshopRoutes } from '@/features/workshops/workshop-routes';
import { useHasRole } from '@/store/session';
import styles from './workshops-page.module.scss';

const workshopSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1, 'Укажите идентификатор мастерской')
    .max(128, 'Не больше 128 символов'),
  displayName: z.string().trim().max(256, 'Не больше 256 символов').optional(),
});

type WorkshopValues = z.infer<typeof workshopSchema>;

/**
 * Мастерские: точки обслуживания с собственными маршрутами подключений,
 * правами на каналы и правилами групп. Создание и правка доступны только
 * роли admin; остальным интерфейс показывает данные только для чтения.
 */
export function WorkshopsPage() {
  const isAdmin = useHasRole('admin');
  const query = useGetWorkshopsQuery();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const items = query.data?.items ?? [];
  const activeId = selectedId ?? items[0]?.id ?? null;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Мастерские</h1>
          <p className={uiStyles.muted}>
            Точки обслуживания: какие подключения к ним привязаны, кому разрешено читать и отвечать,
            и какие группы попадают в CRM.
          </p>
        </div>
        <Button onClick={() => void query.refetch()} disabled={query.isFetching}>
          <RefreshCw size={16} aria-hidden="true" />
          {query.isFetching ? 'Обновляем…' : 'Обновить'}
        </Button>
      </header>

      {query.isLoading ? <LoadingState label="Загружаем мастерские…" /> : null}

      {query.isError ? (
        <ErrorState
          title="Не удалось загрузить мастерские"
          message={describeError(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : null}

      {query.data && items.length === 0 ? (
        <EmptyState
          title="Мастерских нет"
          description={
            isAdmin
              ? 'Создайте первую мастерскую: к ней привязываются подключения и права сотрудников.'
              : 'Список пуст. Создание доступно администратору.'
          }
        />
      ) : null}

      {items.length > 0 ? (
        <section className={styles.section} aria-labelledby="workshop-list-title">
          <div className={styles.sectionHeader}>
            <h2 id="workshop-list-title" className={styles.sectionTitle}>
              Список мастерских
            </h2>
            <span className={uiStyles.hint}>{items.length} всего</span>
          </div>
          <ul className={styles.workshopList}>
            {items.map((workshop) => {
              const active = workshop.id === activeId;
              return (
                <li key={workshop.id}>
                  <button
                    type="button"
                    className={
                      active ? `${styles.workshop} ${styles.workshopActive}` : styles.workshop
                    }
                    aria-pressed={active}
                    onClick={() => setSelectedId(workshop.id)}
                  >
                    <span className={styles.workshopName}>
                      {workshop.displayName ?? 'Без названия'}
                    </span>
                    <span className={uiStyles.mono}>{workshop.id}</span>
                    {active ? <Badge tone="accent">открыта</Badge> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {isAdmin ? <CreateWorkshopForm onCreated={(id) => setSelectedId(id)} /> : null}

      {activeId ? (
        <div className={styles.details} aria-live="polite">
          <h2 className={styles.detailsTitle}>
            Мастерская <span className={uiStyles.mono}>{activeId}</span>
          </h2>
          <WorkshopRoutes workshopId={activeId} isAdmin={isAdmin} />
          <WorkshopPermissions workshopId={activeId} />
          <WorkshopGroups workshopId={activeId} isAdmin={isAdmin} />
        </div>
      ) : null}
    </div>
  );
}

function CreateWorkshopForm({ onCreated }: { onCreated: (id: string) => void }) {
  const [create, state] = useCreateWorkshopMutation();
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const form = useForm<WorkshopValues>({
    resolver: zodResolver(workshopSchema),
    defaultValues: { id: '', displayName: '' },
  });

  const handleSubmit = form.handleSubmit(async (values) => {
    setMessage(null);
    try {
      const created = await create({
        id: values.id.trim(),
        displayName: values.displayName?.trim() ? values.displayName.trim() : null,
      }).unwrap();
      setMessage({ tone: 'success', text: 'Мастерская создана.' });
      form.reset();
      onCreated(created.id);
    } catch (error) {
      setMessage({ tone: 'error', text: describeError(error) });
    }
  });

  return (
    <section className={styles.section} aria-labelledby="create-workshop-title">
      <h2 id="create-workshop-title" className={styles.sectionTitle}>
        Новая мастерская
      </h2>
      <p className={uiStyles.hint}>
        Раздел виден только роли admin. Идентификатор — неизменяемый ключ; название можно менять.
      </p>

      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <div className={styles.formGrid}>
          <Field id="workshop-id" label="Идентификатор" error={form.formState.errors.id?.message}>
            <input
              id="workshop-id"
              className={uiStyles.input}
              autoComplete="off"
              aria-invalid={Boolean(form.formState.errors.id)}
              {...form.register('id')}
            />
          </Field>
          <Field
            id="workshop-name"
            label="Название"
            error={form.formState.errors.displayName?.message}
          >
            <input
              id="workshop-name"
              className={uiStyles.input}
              autoComplete="off"
              {...form.register('displayName')}
            />
          </Field>
        </div>
        <div className={uiStyles.row}>
          <Button type="submit" variant="primary" disabled={state.isLoading}>
            <Plus size={16} aria-hidden="true" />
            {state.isLoading ? 'Создаём…' : 'Создать мастерскую'}
          </Button>
        </div>
        {message ? (
          <Alert tone={message.tone} title={message.tone === 'error' ? 'Не создано' : 'Готово'}>
            {message.text}
          </Alert>
        ) : null}
      </form>
    </section>
  );
}
