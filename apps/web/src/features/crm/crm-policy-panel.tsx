import { useState } from 'react';
import { useGetCrmPolicyQuery, useUpdateCrmPolicyMutation } from '@/api/baseApi';
import { describeError, isForbidden, isVersionConflict } from '@/api/errors';
import type { CrmSourceOfTruth } from '@/api/types';
import { Alert, Badge, Button, ErrorState, LoadingState, uiStyles } from '@/components/ui';
import { CRM_POLICY_LABELS } from '@/lib/labels';
import styles from './crm.module.scss';

const SOURCES: CrmSourceOfTruth[] = ['platform', 'crm'];

export interface CrmPolicyPanelProps {
  /** Смена политики доступна только роли admin. */
  isAdmin: boolean;
}

/**
 * Политика назначения ответственного: платформа или amoCRM.
 *
 * Читать политику может любой оператор — от неё зависит, кто считается
 * владельцем диалога. Менять — только admin, с проверкой версии: политика
 * версионируется, чтобы не перезаписать чужое изменение.
 */
export function CrmPolicyPanel({ isAdmin }: CrmPolicyPanelProps) {
  const query = useGetCrmPolicyQuery();
  const [update, state] = useUpdateCrmPolicyMutation();
  const [draft, setDraft] = useState<CrmSourceOfTruth | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const current = query.data?.sourceOfTruth ?? 'platform';
  const selected = draft ?? current;

  const save = async () => {
    if (!query.data) return;
    setMessage(null);
    try {
      await update({ sourceOfTruth: selected, expectedVersion: query.data.version }).unwrap();
      setDraft(null);
      setMessage({ tone: 'success', text: 'Политика обновлена.' });
    } catch (error) {
      if (isForbidden(error)) {
        setMessage({
          tone: 'error',
          text: 'Менять политику назначений может только администратор.',
        });
        return;
      }
      setMessage({
        tone: 'error',
        text: isVersionConflict(error)
          ? `${describeError(error)} Политику уже изменили — обновите данные.`
          : describeError(error),
      });
      void query.refetch();
    }
  };

  return (
    <section className={styles.section} aria-labelledby="crm-policy-title">
      <div className={styles.sectionHeader}>
        <h2 id="crm-policy-title" className={styles.sectionTitle}>
          Политика назначений
        </h2>
        {query.data ? <Badge tone="neutral">версия {query.data.version}</Badge> : null}
      </div>
      <p className={uiStyles.hint}>
        Кто считается владельцем диалога при расхождении: платформа или amoCRM. Правило определяет,
        чьё назначение побеждает в конфликтах.
      </p>

      {query.isLoading ? <LoadingState label="Загружаем политику…" /> : null}
      {query.isError ? (
        <ErrorState
          title="Политика недоступна"
          message={describeError(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : null}

      {query.data ? (
        isAdmin ? (
          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>Источник истины</legend>
            {SOURCES.map((source) => (
              <label key={source} className={styles.option}>
                <input
                  type="radio"
                  name="crm-policy-source"
                  value={source}
                  checked={selected === source}
                  onChange={() => {
                    setDraft(source);
                    setMessage(null);
                  }}
                />
                <span>{CRM_POLICY_LABELS[source]}</span>
              </label>
            ))}
            <div className={uiStyles.row}>
              <Button
                variant="primary"
                size="small"
                onClick={() => void save()}
                disabled={state.isLoading || selected === current}
              >
                {state.isLoading ? 'Сохраняем…' : 'Сохранить политику'}
              </Button>
              <span className={uiStyles.hint}>Изменение попадёт в аудит.</span>
            </div>
          </fieldset>
        ) : (
          <div className={styles.policyReadOnly}>
            <Badge tone="accent">{CRM_POLICY_LABELS[current]}</Badge>
            <p className={uiStyles.hint}>Смена политики доступна только администратору.</p>
          </div>
        )
      ) : null}

      {message ? (
        <Alert tone={message.tone} title={message.tone === 'error' ? 'Не сохранено' : 'Готово'}>
          {message.text}
        </Alert>
      ) : null}
    </section>
  );
}
