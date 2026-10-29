import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useResolveWorkItemMutation } from '@/api/baseApi';
import { describeError, isForbidden, isVersionConflict } from '@/api/errors';
import type { WorkItem } from '@/api/types';
import { Alert, Button, Field, uiStyles } from '@/components/ui';
import { newIdempotencyKey } from '@/lib/ids';
import styles from './resolve-panel.module.scss';

const resolveSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, 'Опишите причину закрытия: минимум 5 символов')
    .max(1000, 'Не больше 1000 символов'),
});

type ResolveValues = z.infer<typeof resolveSchema>;

export interface ResolvePanelProps {
  workItem: WorkItem;
  /** Сколько вопросов клиента ещё открыто. */
  openObligations: number;
  onDone?: () => void;
}

/**
 * Закрытие обращения.
 *
 * Причина обязательна и сохраняется в аудите. Если остались открытые вопросы,
 * сервер требует роль `manage`: закрытие «через голову» клиента — осознанное
 * управленческое решение, а не следствие нажатия кнопки.
 */
export function ResolvePanel({ workItem, openObligations, onDone }: ResolvePanelProps) {
  const [resolve, state] = useResolveWorkItemMutation();
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const form = useForm<ResolveValues>({
    resolver: zodResolver(resolveSchema),
    defaultValues: { reason: '' },
  });

  const closed = workItem.state === 'resolved' || workItem.state === 'cancelled';
  const needsManage = openObligations > 0;

  const handleSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    setSuccess(null);
    try {
      await resolve({
        id: workItem.id,
        body: {
          reason: values.reason.trim(),
          expectedAssignmentVersion: workItem.assignmentVersion,
          idempotencyKey: newIdempotencyKey('resolve'),
        },
      }).unwrap();
      setSuccess('Обращение закрыто. Причина записана в аудит.');
      form.reset();
      onDone?.();
    } catch (error) {
      if (isForbidden(error)) {
        setFormError(
          'Закрыть обращение с открытыми вопросами может только сотрудник с правом manage. ' +
            'Ответьте клиенту или попросите руководителя закрыть обращение.',
        );
        return;
      }
      setFormError(
        isVersionConflict(error)
          ? `${describeError(error)} Перечитайте карточку и повторите.`
          : describeError(error),
      );
    }
  });

  return (
    <section className={styles.panel} aria-labelledby="resolve-title">
      <h2 id="resolve-title" className={styles.title}>
        Закрытие обращения
      </h2>

      {needsManage ? (
        <Alert tone="warning" title="Есть открытые вопросы">
          Клиент ждёт ответа на {openObligations}. Закрытие в таком состоянии требует права
          <strong> manage</strong>; с ролью ниже сервер отклонит запрос. Обычно сначала отвечают или
          оформляют ручное покрытие.
        </Alert>
      ) : (
        <p className={uiStyles.hint}>
          Все вопросы клиента закрыты. Закрытие обратимо только новой командой назначения.
        </p>
      )}

      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <Field
          id="resolve-reason"
          label="Причина закрытия"
          hint="Например: «вопрос решён в звонке», «клиент отказался от заказа»."
          error={form.formState.errors.reason?.message}
        >
          <textarea
            id="resolve-reason"
            className={uiStyles.textarea}
            aria-invalid={Boolean(form.formState.errors.reason)}
            {...form.register('reason')}
          />
        </Field>

        {formError ? (
          <Alert tone="error" title="Обращение не закрыто">
            {formError}
          </Alert>
        ) : null}
        {success ? (
          <Alert tone="success" title="Готово">
            {success}
          </Alert>
        ) : null}

        <div className={uiStyles.row}>
          <Button type="submit" variant="primary" disabled={state.isLoading || closed}>
            <CheckCircle2 size={16} aria-hidden="true" />
            {state.isLoading ? 'Закрываем…' : 'Закрыть обращение'}
          </Button>
          <span className={uiStyles.hint}>
            Команда уйдёт с версией назначения {workItem.assignmentVersion}.
          </span>
        </div>
        {closed ? <p className={uiStyles.hint}>Обращение уже закрыто.</p> : null}
      </form>
    </section>
  );
}
