import { RefreshCw, Send } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useReplyToWorkItemMutation } from '@/api/baseApi';
import { describeError } from '@/api/errors';
import type { ComposeSnapshot, Obligation, SendOperation } from '@/api/types';
import { Alert, Button, uiStyles } from '@/components/ui';
import { newDeadline, newIdempotencyKey } from '@/lib/ids';
import { createEmptyDraft, getDraft, useDraftsStore } from '@/store/drafts';
import styles from './composer.module.scss';
import { SendOperationStatus } from './send-operation-status';
import { checkSnapshot, validateReplyText } from './snapshotGuard';

export interface ComposerProps {
  workItemId: string;
  obligations: Obligation[];
  latestSnapshot: ComposeSnapshot | null;
  snapshotLoading: boolean;
  snapshotError: string | null;
  onRefreshSnapshot: () => Promise<ComposeSnapshot | null>;
}

export function Composer({
  workItemId,
  obligations,
  latestSnapshot,
  snapshotLoading,
  snapshotError,
  onRefreshSnapshot,
}: ComposerProps) {
  const storedDraft = useDraftsStore((state) => state.drafts[workItemId]);
  const draft = useMemo(() => storedDraft ?? createEmptyDraft(workItemId), [storedDraft, workItemId]);
  const ensureDraft = useDraftsStore((state) => state.ensureDraft);
  const setText = useDraftsStore((state) => state.setText);
  const bindSnapshot = useDraftsStore((state) => state.bindSnapshot);
  const toggleObligation = useDraftsStore((state) => state.toggleObligation);
  const beginSend = useDraftsStore((state) => state.beginSend);
  const completeSend = useDraftsStore((state) => state.completeSend);
  const failSend = useDraftsStore((state) => state.failSend);
  const block = useDraftsStore((state) => state.block);

  const [reply, replyState] = useReplyToWorkItemMutation();
  const [localError, setLocalError] = useState<string | null>(null);
  const [lastOperationId, setLastOperationId] = useState<string | null>(null);
  const [showOperation, setShowOperation] = useState(false);

  useEffect(() => {
    ensureDraft(workItemId);
  }, [ensureDraft, workItemId]);

  // Первая привязка к снимку. Повторная привязка к изменившемуся снимку
  // не делается молча: иначе оператор не узнает, что диалог поменялся.
  useEffect(() => {
    if (!latestSnapshot) return;
    if (latestSnapshot.workItemId !== workItemId) return;
    if (draft.snapshotId === null) {
      bindSnapshot(workItemId, latestSnapshot);
    }
  }, [latestSnapshot, workItemId, draft.snapshotId, bindSnapshot]);

  const guard = useMemo(
    () =>
      checkSnapshot({
        draft,
        currentWorkItemId: workItemId,
        snapshot: latestSnapshot,
        snapshotLoading,
        snapshotError,
      }),
    [draft, workItemId, latestSnapshot, snapshotLoading, snapshotError],
  );

  const textError = validateReplyText(draft.text).message;
  const canSend = guard.ok && !textError && draft.phase !== 'sending';

  const staleSnapshot =
    draft.snapshotId !== null && latestSnapshot !== null && latestSnapshot.id !== draft.snapshotId;

  const applyFreshSnapshot = useCallback(async () => {
    const fresh = await onRefreshSnapshot();
    if (fresh) {
      bindSnapshot(workItemId, fresh);
      setLocalError(null);
    }
  }, [bindSnapshot, onRefreshSnapshot, workItemId]);

  const handleSend = useCallback(async () => {
    setLocalError(null);

    const check = checkSnapshot({
      draft: getDraft(useDraftsStore.getState().drafts, workItemId),
      currentWorkItemId: workItemId,
      snapshot: latestSnapshot,
      snapshotLoading,
      snapshotError,
    });

    if (!check.ok) {
      block(workItemId, check.message ?? 'Отправка заблокирована: снимок диалога устарел.');
      return;
    }

    const textCheck = validateReplyText(draft.text);
    if (!textCheck.ok) {
      setLocalError(textCheck.message);
      return;
    }

    const current = getDraft(useDraftsStore.getState().drafts, workItemId);
    if (!current.snapshotId || current.expectedAssignmentVersion === null) {
      block(workItemId, 'Черновик не привязан к снимку. Обновите карточку перед отправкой.');
      return;
    }

    beginSend(workItemId);
    try {
      const operation: SendOperation = await reply({
        id: workItemId,
        body: {
          idempotencyKey: newIdempotencyKey('reply'),
          snapshotId: current.snapshotId,
          expectedAssignmentVersion: current.expectedAssignmentVersion,
          selectedObligations: current.selectedObligations,
          text: current.text,
          deadline: newDeadline(),
        },
      }).unwrap();
      completeSend(workItemId, operation);
      setLastOperationId(operation.id);
      setShowOperation(true);
      // После успешной отправки текст пуст — безопасно перепривязать черновик
      // к новому снимку, чтобы следующий ответ не упирался в устаревший.
      const fresh = await onRefreshSnapshot();
      if (fresh) bindSnapshot(workItemId, fresh);
    } catch (error) {
      failSend(workItemId, describeError(error));
    }
  }, [
    block,
    beginSend,
    bindSnapshot,
    completeSend,
    draft.text,
    failSend,
    latestSnapshot,
    onRefreshSnapshot,
    reply,
    snapshotError,
    snapshotLoading,
    workItemId,
  ]);

  const blockedMessage =
    draft.phase === 'blocked' ? draft.blockReason : !guard.ok ? guard.message : null;

  return (
    <section className={styles.composer} aria-labelledby="composer-title">
      <div className={styles.header}>
        <h2 id="composer-title" className={styles.title}>
          Ответ клиенту
        </h2>
        <span className={uiStyles.hint}>
          {draft.snapshotId ? `снимок ${draft.snapshotId.slice(0, 12)}…` : 'снимок не получен'}
        </span>
        <Button
          size="small"
          onClick={() => void onRefreshSnapshot()}
          disabled={snapshotLoading}
          aria-label="Обновить снимок диалога"
        >
          <RefreshCw size={14} aria-hidden="true" />
          {snapshotLoading ? 'Проверяем…' : 'Обновить снимок'}
        </Button>
      </div>

      {staleSnapshot && !blockedMessage ? (
        <Alert tone="warning" title="Диалог изменился">
          Сервер вернул новый снимок. Нажмите «Применить свежий снимок», чтобы ответ ушёл с
          актуальными вопросами и версией назначения.
        </Alert>
      ) : null}

      {blockedMessage ? (
        <Alert tone="warning" title="Отправка заблокирована">
          {blockedMessage}
          <div className={uiStyles.row} style={{ marginTop: 8 }}>
            <Button size="small" variant="primary" onClick={() => void applyFreshSnapshot()}>
              Применить свежий снимок
            </Button>
            <Button size="small" onClick={() => void onRefreshSnapshot()}>
              Проверить ещё раз
            </Button>
          </div>
        </Alert>
      ) : null}

      {obligations.length > 0 ? (
        <fieldset className={styles.obligations}>
          <legend className={styles.legend}>Какие вопросы закрывает ответ</legend>
          <div className={styles.obligationList}>
            {obligations.map((item) => {
              const checked = draft.selectedObligations.some(
                (ref) => ref.obligationId === item.id && ref.contentVersion === item.contentVersion,
              );
              return (
                <label key={item.id} className={styles.obligation}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      toggleObligation(workItemId, {
                        obligationId: item.id,
                        contentVersion: item.contentVersion,
                      })
                    }
                  />
                  <span>Вопрос #{item.attentionSeq}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      <div className={uiStyles.field}>
        <label className={styles.legend} htmlFor="composer-text">
          Текст ответа
        </label>
        <textarea
          id="composer-text"
          className={uiStyles.textarea}
          value={draft.text}
          onChange={(event) => setText(workItemId, event.currentTarget.value)}
          aria-describedby="composer-text-hint"
          aria-invalid={Boolean(textError && draft.text.length > 0)}
          maxLength={4096}
          rows={4}
          placeholder="Ответ уйдёт в канал клиента после проверки снимка"
        />
        <p id="composer-text-hint" className={uiStyles.hint}>
          {draft.text.length}/4096. Ответ отправляется от имени оператора, назначенного на диалог.
        </p>
      </div>

      {draft.errorMessage ? (
        <Alert tone="error" title="Отправка не выполнена">
          {draft.errorMessage}
        </Alert>
      ) : null}
      {localError ? (
        <Alert tone="error" title="Проверьте текст">
          {localError}
        </Alert>
      ) : null}

      <div className={uiStyles.row}>
        <Button
          variant="primary"
          onClick={() => void handleSend()}
          disabled={!canSend || replyState.isLoading}
          aria-describedby={canSend ? undefined : 'composer-blocked-hint'}
        >
          <Send size={16} aria-hidden="true" />
          {draft.phase === 'sending' ? 'Отправляем…' : 'Отправить'}
        </Button>
        {!canSend ? (
          <span id="composer-blocked-hint" className={uiStyles.hint}>
            {guard.message ?? textError ?? ''}
          </span>
        ) : null}
      </div>

      {showOperation && lastOperationId ? (
        <SendOperationStatus operationId={lastOperationId} />
      ) : null}
    </section>
  );
}
