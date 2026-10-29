import { zodResolver } from '@hookform/resolvers/zod';
import { Users } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useGetWorkshopGroupsQuery, useSetWorkshopGroupRuleMutation } from '@/api/baseApi';
import { describeError } from '@/api/errors';
import type { GroupRuleDecision } from '@/api/types';
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
import { GROUP_RULE_LABELS, GROUP_RULE_TONE } from '@/lib/labels';
import styles from './workshops.module.scss';

const DECISIONS: GroupRuleDecision[] = ['allow_crm', 'archive_only', 'exclude'];

const groupSchema = z.object({
  connectionId: z.string().trim().min(1, 'Укажите подключение').max(128),
  bindingEpoch: z
    .string()
    .trim()
    .min(1, 'Укажите эпоху привязки')
    .regex(/^\d+$/, 'Эпоха привязки — целое неотрицательное число'),
  externalChatId: z.string().trim().min(1, 'Укажите идентификатор чата').max(256),
  decision: z.enum(['allow_crm', 'archive_only', 'exclude']),
  displayName: z.string().trim().max(256).optional(),
});

type GroupValues = z.infer<typeof groupSchema>;

/**
 * Правила групп. По умолчанию группа в CRM не проецируется: правило может
 * только явно разрешить проекцию (`allow_crm`), исключить чат или оставить его
 * только в архиве. Имя группы — подпись, а не ключ: решение принимается по
 * неизменяемому идентификатору чата внутри подключения и эпохи привязки.
 */
export function WorkshopGroups({ workshopId, isAdmin }: { workshopId: string; isAdmin: boolean }) {
  const query = useGetWorkshopGroupsQuery({ workshopId });

  return (
    <section className={styles.section} aria-labelledby="workshop-groups-title">
      <div className={styles.sectionHeader}>
        <h3 id="workshop-groups-title" className={styles.sectionTitle}>
          Правила групп
        </h3>
        <span className={uiStyles.hint}>по умолчанию — запрет</span>
      </div>
      <p className={uiStyles.hint}>
        Групповые чаты не попадают в CRM без явного правила. Название группы не используется как
        ключ: правило привязано к подключению, эпохе привязки и внешнему идентификатору чата.
      </p>

      {query.isLoading ? <LoadingState label="Загружаем правила…" /> : null}
      {query.isError ? (
        <ErrorState
          title="Правила недоступны"
          message={describeError(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {query.data && query.data.items.length === 0 ? (
        <EmptyState title="Правил нет" description="Все группы этой мастерской остаются вне CRM." />
      ) : null}
      {query.data && query.data.items.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="visually-hidden">
              Правила групп: подключение, эпоха привязки, чат, решение и версия
            </caption>
            <thead>
              <tr>
                <th scope="col">Подключение</th>
                <th scope="col">Эпоха</th>
                <th scope="col">Чат</th>
                <th scope="col">Решение</th>
                <th scope="col">Название</th>
                <th scope="col">Версия</th>
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((rule) => (
                <tr key={`${rule.connectionId}:${rule.bindingEpoch}:${rule.externalChatId}`}>
                  <td className={uiStyles.mono}>{rule.connectionId}</td>
                  <td className={uiStyles.mono}>{rule.bindingEpoch}</td>
                  <td className={uiStyles.mono}>{rule.externalChatId}</td>
                  <td>
                    <Badge tone={GROUP_RULE_TONE[rule.decision]}>
                      {GROUP_RULE_LABELS[rule.decision]}
                    </Badge>
                  </td>
                  <td>{rule.displayName ?? '—'}</td>
                  <td className={uiStyles.mono}>{rule.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {isAdmin ? <GroupRuleForm workshopId={workshopId} /> : null}
    </section>
  );
}

function GroupRuleForm({ workshopId }: { workshopId: string }) {
  const [save, state] = useSetWorkshopGroupRuleMutation();
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const form = useForm<GroupValues>({
    resolver: zodResolver(groupSchema),
    defaultValues: {
      connectionId: '',
      bindingEpoch: '0',
      externalChatId: '',
      decision: 'exclude',
      displayName: '',
    },
  });

  const handleSubmit = form.handleSubmit(async (values) => {
    setMessage(null);
    try {
      await save({
        workshopId,
        body: {
          connectionId: values.connectionId.trim(),
          bindingEpoch: Number(values.bindingEpoch),
          externalChatId: values.externalChatId.trim(),
          decision: values.decision,
          displayName: values.displayName?.trim() ? values.displayName.trim() : null,
        },
      }).unwrap();
      setMessage({ tone: 'success', text: 'Правило сохранено.' });
      form.reset();
    } catch (error) {
      setMessage({ tone: 'error', text: describeError(error) });
    }
  });

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      <h4 className={styles.subtitle}>Задать правило группы</h4>
      <p className={uiStyles.hint}>Доступно только роли admin.</p>

      <div className={styles.formGrid}>
        <Field
          id="group-connection"
          label="Подключение группы"
          error={form.formState.errors.connectionId?.message}
        >
          <input
            id="group-connection"
            className={uiStyles.input}
            autoComplete="off"
            aria-invalid={Boolean(form.formState.errors.connectionId)}
            {...form.register('connectionId')}
          />
        </Field>
        <Field
          id="group-epoch"
          label="Эпоха привязки"
          hint="Число из карточки подключения."
          error={form.formState.errors.bindingEpoch?.message}
        >
          <input
            id="group-epoch"
            type="number"
            min={0}
            className={uiStyles.input}
            aria-invalid={Boolean(form.formState.errors.bindingEpoch)}
            {...form.register('bindingEpoch')}
          />
        </Field>
        <Field
          id="group-chat"
          label="Внешний идентификатор чата"
          error={form.formState.errors.externalChatId?.message}
        >
          <input
            id="group-chat"
            className={uiStyles.input}
            autoComplete="off"
            aria-invalid={Boolean(form.formState.errors.externalChatId)}
            {...form.register('externalChatId')}
          />
        </Field>
        <Field
          id="group-name"
          label="Название (подпись)"
          hint="Не используется как ключ."
          error={form.formState.errors.displayName?.message}
        >
          <input
            id="group-name"
            className={uiStyles.input}
            autoComplete="off"
            {...form.register('displayName')}
          />
        </Field>
        <Field id="group-decision" label="Решение" error={form.formState.errors.decision?.message}>
          <select id="group-decision" className={uiStyles.select} {...form.register('decision')}>
            {DECISIONS.map((decision) => (
              <option key={decision} value={decision}>
                {GROUP_RULE_LABELS[decision]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className={uiStyles.row}>
        <Button type="submit" variant="primary" disabled={state.isLoading}>
          <Users size={16} aria-hidden="true" />
          {state.isLoading ? 'Сохраняем…' : 'Сохранить правило'}
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
