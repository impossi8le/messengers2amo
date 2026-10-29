import { zodResolver } from '@hookform/resolvers/zod';
import { AlertTriangle, UserCheck } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useClaimWorkItemMutation, useTransferWorkItemMutation } from '@/api/baseApi';
import { describeError, isVersionConflict } from '@/api/errors';
import type { WorkItem } from '@/api/types';
import { Alert, Badge, Button, Field, uiStyles } from '@/components/ui';
import { newIdempotencyKey } from '@/lib/ids';
import { WORK_ITEM_STATE_LABELS, WORK_ITEM_STATE_TONE } from '@/lib/labels';
import styles from './assignment-panel.module.scss';

const transferSchema = z.object({
  departmentId: z.string().trim().min(1, 'Укажите подразделение').max(128),
  assigneeId: z.string().trim().max(128).optional(),
});

type TransferValues = z.infer<typeof transferSchema>;

export interface AssignmentPanelProps {
  workItem: WorkItem;
  onConflict: () => void;
}

/**
 * Назначение и передача ответственного.
 *
 * Все команды условны по версии: сервер сравнивает expectedAssignmentVersion
 * с текущей. Если оператор проиграл гонку (кто-то успел раньше), показываем
 * это явно и предлагаем перечитать карточку — молча повторять команду нельзя,
 * иначе можно перезаписать чужое назначение.
 */
export function AssignmentPanel({ workItem, onConflict }: AssignmentPanelProps) {
  const [claim, claimState] = useClaimWorkItemMutation();
  const [transfer, transferState] = useTransferWorkItemMutation();
  const [conflict, setConflict] = useState<{ message: string; operation: string } | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const form = useForm<TransferValues>({
    resolver: zodResolver(transferSchema),
    defaultValues: { departmentId: '', assigneeId: '' },
  });

  const handleClaim = async () => {
    setConflict(null);
    setSuccess(null);
    try {
      await claim({
        id: workItem.id,
        body: {
          expectedAssignmentVersion: workItem.assignmentVersion,
          idempotencyKey: newIdempotencyKey('claim'),
        },
      }).unwrap();
      setSuccess('Обращение назначено на вас.');
    } catch (error) {
      if (isVersionConflict(error)) {
        setConflict({ message: describeError(error), operation: 'назначение' });
        return;
      }
      setConflict({ message: describeError(error), operation: 'назначение' });
    }
  };

  const handleTransfer = form.handleSubmit(async (values) => {
    setConflict(null);
    setSuccess(null);
    try {
      await transfer({
        id: workItem.id,
        body: {
          expectedAssignmentVersion: workItem.assignmentVersion,
          idempotencyKey: newIdempotencyKey('transfer'),
          departmentId: values.departmentId,
          assigneeId: values.assigneeId?.trim() ? values.assigneeId.trim() : null,
        },
      }).unwrap();
      setSuccess('Ответственный изменён.');
      form.reset();
    } catch (error) {
      setConflict({ message: describeError(error), operation: 'передача' });
    }
  });

  return (
    <section className={styles.panel} aria-labelledby="assignment-title">
      <div className={styles.header}>
        <h2 id="assignment-title" className={styles.title}>
          Назначение
        </h2>
        <Badge tone={WORK_ITEM_STATE_TONE[workItem.state]}>
          {WORK_ITEM_STATE_LABELS[workItem.state]}
        </Badge>
      </div>

      <dl className={styles.meta}>
        <div>
          <dt>Ответственный</dt>
          <dd>{workItem.owner ?? 'не назначен'}</dd>
        </div>
        <div>
          <dt>Версия назначения</dt>
          <dd className={uiStyles.mono}>{workItem.assignmentVersion}</dd>
        </div>
      </dl>

      {conflict ? (
        <Alert tone="error" title="Назначение не выполнено">
          {conflict.message}
          <div className={uiStyles.row} style={{ marginTop: 8 }}>
            <Button size="small" variant="primary" onClick={onConflict}>
              <AlertTriangle size={14} aria-hidden="true" />
              Перечитать карточку
            </Button>
          </div>
        </Alert>
      ) : null}

      {success ? (
        <Alert tone="success" title="Готово">
          {success}
        </Alert>
      ) : null}

      <div className={uiStyles.row}>
        <Button
          onClick={() => void handleClaim()}
          disabled={claimState.isLoading || workItem.state === 'resolved'}
        >
          <UserCheck size={16} aria-hidden="true" />
          {claimState.isLoading ? 'Назначаем…' : 'Взять в работу'}
        </Button>
        <span className={uiStyles.hint}>
          Команда отправится с версией {workItem.assignmentVersion}. Если её уже изменили, сервер
          отклонит запрос.
        </span>
      </div>

      <form className={styles.form} onSubmit={handleTransfer} noValidate>
        <h3 className={styles.subtitle}>Передать другому сотруднику</h3>
        <Field
          id="transfer-department"
          label="Подразделение"
          error={form.formState.errors.departmentId?.message}
        >
          <input
            id="transfer-department"
            className={uiStyles.input}
            autoComplete="off"
            aria-invalid={Boolean(form.formState.errors.departmentId)}
            {...form.register('departmentId')}
          />
        </Field>
        <Field
          id="transfer-assignee"
          label="Сотрудник (ID)"
          hint="Оставьте пустым, чтобы снять ответственного и вернуть обращение в очередь."
          error={form.formState.errors.assigneeId?.message}
        >
          <input
            id="transfer-assignee"
            className={uiStyles.input}
            autoComplete="off"
            aria-invalid={Boolean(form.formState.errors.assigneeId)}
            {...form.register('assigneeId')}
          />
        </Field>
        <div className={uiStyles.row}>
          <Button type="submit" variant="primary" disabled={transferState.isLoading}>
            {transferState.isLoading ? 'Передаём…' : 'Передать'}
          </Button>
          <Button type="button" onClick={() => form.reset()} disabled={transferState.isLoading}>
            Очистить
          </Button>
        </div>
      </form>
    </section>
  );
}
