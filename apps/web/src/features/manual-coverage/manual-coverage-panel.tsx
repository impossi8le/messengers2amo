import { zodResolver } from '@hookform/resolvers/zod';
import { ClipboardCheck, Search } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useGetSendOperationQuery, useManualCoverageMutation } from '@/api/baseApi';
import { describeError, isVersionConflict } from '@/api/errors';
import type { Obligation, WorkItem } from '@/api/types';
import { Alert, Badge, Button, Field, InlineError, LoadingState, uiStyles } from '@/components/ui';
import { newIdempotencyKey } from '@/lib/ids';
import { SEND_STATE_LABELS, SEND_STATE_TONE } from '@/lib/labels';
import styles from './manual-coverage-panel.module.scss';

const coverageSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, 'Опишите причину: минимум 10 символов')
    .max(1000, 'Не больше 1000 символов'),
  confirmed: z
    .boolean()
    .refine((value) => value, 'Подтвердите, что понимаете: это ручное действие с аудитом'),
});

type CoverageValues = z.infer<typeof coverageSchema>;

export interface ManualCoveragePanelProps {
  workItem: WorkItem;
  obligations: Obligation[];
  /** Идентификаторы операций отправки, известные из истории диалога. */
  knownOperationIds?: string[];
  onDone?: () => void;
}

/**
 * Ручное покрытие вопросов клиента.
 *
 * Это не «закрыть автоматически»: оператор подтверждает, что ответ уже дан
 * вне шлюза (например, в штатном чате amoCRM), указывает конкретную успешную
 * операцию отправки и причину. Сервер требует состояние `sent` и пишет аудит;
 * интерфейс не даёт отправить форму без причины и подтверждения.
 */
export function ManualCoveragePanel({
  workItem,
  obligations,
  knownOperationIds = [],
  onDone,
}: ManualCoveragePanelProps) {
  const [coverage, coverageState] = useManualCoverageMutation();
  const [operationInput, setOperationInput] = useState('');
  const [requestedId, setRequestedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const operationQuery = useGetSendOperationQuery(requestedId ?? '', { skip: !requestedId });

  const form = useForm<CoverageValues>({
    resolver: zodResolver(coverageSchema),
    defaultValues: { reason: '', confirmed: false },
  });

  const operation = operationQuery.data;
  const operationEligible = operation?.state === 'sent';
  const closed = workItem.state === 'resolved' || workItem.state === 'cancelled';

  const toggle = (obligationId: string) => {
    setFormError(null);
    setSelected((prev) =>
      prev.includes(obligationId)
        ? prev.filter((id) => id !== obligationId)
        : [...prev, obligationId],
    );
  };

  const handleSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    setSuccess(null);

    if (!operation) {
      setFormError('Сначала проверьте операцию отправки: покрытие привязывается к ней.');
      return;
    }
    if (!operationEligible) {
      setFormError(
        'Покрытие возможно только для операции в состоянии «Отправлено». Сначала проверьте чат у клиента.',
      );
      return;
    }
    if (selected.length === 0) {
      setFormError('Выберите хотя бы один открытый вопрос, который считается закрытым.');
      return;
    }

    const refs = selected
      .map((id) => obligations.find((item) => item.id === id))
      .filter((item): item is Obligation => Boolean(item))
      .map((item) => ({ obligationId: item.id, contentVersion: item.contentVersion }));

    try {
      await coverage({
        id: workItem.id,
        body: {
          confirmedSendOperationId: operation.id,
          obligationRefs: refs,
          reason: values.reason.trim(),
          expectedAssignmentVersion: workItem.assignmentVersion,
          idempotencyKey: newIdempotencyKey('coverage'),
        },
      }).unwrap();
      setSuccess('Покрытие зафиксировано. Действие записано в аудит.');
      setSelected([]);
      form.reset();
      onDone?.();
    } catch (error) {
      setFormError(
        isVersionConflict(error)
          ? `${describeError(error)} Перечитайте карточку и повторите.`
          : describeError(error),
      );
    }
  });

  return (
    <section className={styles.panel} aria-labelledby="coverage-title">
      <div className={styles.header}>
        <h2 id="coverage-title" className={styles.title}>
          Ручное покрытие
        </h2>
        <Badge tone="warning">ручное действие</Badge>
      </div>

      <Alert tone="warning" title="Это не автоматическое закрытие">
        Ручное покрытие подтверждает, что ответ клиенту уже дан — например, в штатном чате amoCRM.
        Сообщение через шлюз не отправляется, а действие с причиной и автором попадает в аудит.
        Повтор вслепую после неопределённой отправки недопустим.
      </Alert>

      <div className={styles.lookup}>
        <Field
          id="coverage-operation"
          label="Операция отправки"
          hint="Введите идентификатор операции и нажмите «Проверить». Покрытие привязывается только к операции «Отправлено»."
        >
          <div className={uiStyles.row}>
            <input
              id="coverage-operation"
              className={uiStyles.input}
              value={operationInput}
              list="coverage-operation-options"
              autoComplete="off"
              placeholder="op_…"
              onChange={(event) => setOperationInput(event.currentTarget.value)}
            />
            <datalist id="coverage-operation-options">
              {knownOperationIds.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
            <Button
              size="small"
              onClick={() => setRequestedId(operationInput.trim() || null)}
              disabled={!operationInput.trim() || operationQuery.isFetching}
            >
              <Search size={14} aria-hidden="true" />
              Проверить
            </Button>
          </div>
        </Field>

        {operationQuery.isLoading ? <LoadingState label="Запрашиваем операцию…" /> : null}
        {operationQuery.isError ? (
          <InlineError>{describeError(operationQuery.error)}</InlineError>
        ) : null}
        {operation ? (
          <div className={styles.operationRow}>
            <Badge tone={SEND_STATE_TONE[operation.state]}>
              {SEND_STATE_LABELS[operation.state]}
            </Badge>
            <span className={uiStyles.mono}>{operation.id}</span>
            <span className={uiStyles.hint}>
              покрытие: {operation.coverage === 'confirmed' ? 'подтверждено' : 'не подтверждено'}
            </span>
          </div>
        ) : null}
        {operation && !operationEligible ? (
          <Alert tone="warning" title="Операция не подходит">
            Покрытие оформляется только для успешно отправленной операции. Для состояния «Результат
            неизвестен» сначала проверьте чат у клиента в разделе диагностики.
          </Alert>
        ) : null}
      </div>

      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <fieldset className={styles.fieldset} aria-describedby="coverage-obligations-hint">
          <legend className={styles.legend}>Какие вопросы считать закрытыми</legend>
          <p id="coverage-obligations-hint" className={uiStyles.hint}>
            Отметьте только те вопросы, на которые клиент действительно получил ответ.
          </p>
          {obligations.length === 0 ? (
            <p className={uiStyles.muted}>Открытых вопросов нет — покрывать нечего.</p>
          ) : (
            <ul className={styles.obligationList}>
              {obligations.map((item) => {
                const checkboxId = `coverage-obligation-${item.id}`;
                return (
                  <li key={item.id} className={styles.obligationItem}>
                    <input
                      id={checkboxId}
                      type="checkbox"
                      className={styles.checkbox}
                      checked={selected.includes(item.id)}
                      onChange={() => toggle(item.id)}
                    />
                    <label htmlFor={checkboxId} className={styles.checkboxLabel}>
                      <Badge tone="warning">#{item.attentionSeq}</Badge>
                      <span className={uiStyles.mono}>{item.messageId}</span>
                      <span className={uiStyles.hint}>версия {item.contentVersion}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>

        <Field
          id="coverage-reason"
          label="Причина"
          hint="Где и когда дан ответ. Причина сохраняется в аудите."
          error={form.formState.errors.reason?.message}
        >
          <textarea
            id="coverage-reason"
            className={uiStyles.textarea}
            aria-invalid={Boolean(form.formState.errors.reason)}
            aria-describedby={
              form.formState.errors.reason ? 'coverage-reason-error' : 'coverage-reason-hint'
            }
            {...form.register('reason')}
          />
        </Field>

        <div className={styles.confirmRow}>
          <input
            id="coverage-confirm"
            type="checkbox"
            className={styles.checkbox}
            aria-invalid={Boolean(form.formState.errors.confirmed)}
            {...form.register('confirmed')}
          />
          <label htmlFor="coverage-confirm" className={styles.checkboxLabel}>
            Понимаю, что это ручное действие с аудитом, а не автоматическое закрытие.
          </label>
        </div>
        {form.formState.errors.confirmed?.message ? (
          <InlineError>{form.formState.errors.confirmed.message}</InlineError>
        ) : null}

        {formError ? (
          <Alert tone="error" title="Покрытие не оформлено">
            {formError}
          </Alert>
        ) : null}
        {success ? (
          <Alert tone="success" title="Готово">
            {success}
          </Alert>
        ) : null}

        <div className={uiStyles.row}>
          <Button type="submit" variant="primary" disabled={coverageState.isLoading || closed}>
            <ClipboardCheck size={16} aria-hidden="true" />
            {coverageState.isLoading ? 'Фиксируем…' : 'Зафиксировать покрытие'}
          </Button>
          <span className={uiStyles.hint}>
            Команда уйдёт с версией назначения {workItem.assignmentVersion}.
          </span>
        </div>
        {closed ? (
          <p className={uiStyles.hint}>Обращение уже закрыто: покрытие не требуется.</p>
        ) : null}
      </form>
    </section>
  );
}
