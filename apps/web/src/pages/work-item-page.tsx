import { ArrowLeft, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  useCreateSnapshotMutation,
  useGetWorkItemMessagesQuery,
  useGetWorkItemQuery,
} from '@/api/baseApi';
import { describeError } from '@/api/errors';
import type { ComposeSnapshot } from '@/api/types';
import { Alert, Badge, Button, ErrorState, LoadingState, uiStyles } from '@/components/ui';
import { AssignmentPanel } from '@/features/assignment/assignment-panel';
import { Composer } from '@/features/composer/composer';
import { ManualCoveragePanel } from '@/features/manual-coverage/manual-coverage-panel';
import { MessageList } from '@/features/messages/message-list';
import { ResolvePanel } from '@/features/resolve/resolve-panel';
import { WORK_ITEM_STATE_LABELS, WORK_ITEM_STATE_TONE } from '@/lib/labels';
import styles from './work-item-page.module.scss';

export function WorkItemPage() {
  const { workItemId = '' } = useParams<{ workItemId: string }>();

  const detailQuery = useGetWorkItemQuery(workItemId, { skip: !workItemId });
  const messagesQuery = useGetWorkItemMessagesQuery(
    { id: workItemId, limit: 50 },
    { skip: !workItemId },
  );
  const [createSnapshot] = useCreateSnapshotMutation();

  const [latestSnapshot, setLatestSnapshot] = useState<ComposeSnapshot | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const currentIdRef = useRef(workItemId);

  const requestSnapshot = useCallback(async (): Promise<ComposeSnapshot | null> => {
    if (!workItemId) return null;
    setSnapshotLoading(true);
    setSnapshotError(null);
    try {
      const snapshot = await createSnapshot(workItemId).unwrap();
      setLatestSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      setSnapshotError(describeError(error));
      return null;
    } finally {
      setSnapshotLoading(false);
    }
  }, [createSnapshot, workItemId]);

  useEffect(() => {
    if (!workItemId) return;
    // При смене диалога старый снимок не должен «прилипнуть» к новому:
    // сбрасываем и запрашиваем заново.
    if (currentIdRef.current !== workItemId) {
      currentIdRef.current = workItemId;
      setLatestSnapshot(null);
      setSnapshotError(null);
    }
    void requestSnapshot();
  }, [requestSnapshot, workItemId]);

  const detail = detailQuery.data;
  const workItem = detail?.workItem;

  // Операции отправки, известные из истории: подсказка для формы ручного покрытия.
  const knownOperationIds = useMemo(() => {
    const ids = (messagesQuery.data?.items ?? [])
      .map((message) => message.sendOperationId)
      .filter((id): id is string => Boolean(id));
    return Array.from(new Set(ids));
  }, [messagesQuery.data]);

  const refreshAll = () => {
    void detailQuery.refetch();
    void messagesQuery.refetch();
    void requestSnapshot();
  };

  return (
    <div className={styles.page}>
      <div className={styles.breadcrumbRow}>
        <Link to="/work-items" className={styles.backLink}>
          <ArrowLeft size={16} aria-hidden="true" />К списку обращений
        </Link>
        <Button size="small" onClick={refreshAll} disabled={detailQuery.isFetching}>
          <RefreshCw size={14} aria-hidden="true" />
          Обновить карточку
        </Button>
      </div>

      {detailQuery.isLoading ? <LoadingState label="Загружаем карточку диалога…" /> : null}

      {detailQuery.isError ? (
        <ErrorState
          title="Карточка недоступна"
          message={describeError(detailQuery.error)}
          onRetry={() => void detailQuery.refetch()}
        />
      ) : null}

      {workItem && detail ? (
        <>
          <header className={styles.header}>
            <div>
              <h1 className={styles.title}>Диалог {detail.conversation.externalChatId}</h1>
              <p className={uiStyles.mono}>обращение {workItem.id}</p>
            </div>
            <div className={uiStyles.row}>
              <Badge tone={WORK_ITEM_STATE_TONE[workItem.state]}>
                {WORK_ITEM_STATE_LABELS[workItem.state]}
              </Badge>
              {detail.outstandingObligations.length > 0 ? (
                <Badge tone="warning">ждут ответа: {detail.outstandingObligations.length}</Badge>
              ) : (
                <Badge tone="success">нет открытых вопросов</Badge>
              )}
            </div>
          </header>

          <div className={styles.grid}>
            <div className={styles.mainColumn}>
              <section className={styles.section} aria-labelledby="history-title">
                <div className={styles.sectionHeader}>
                  <h2 id="history-title" className={styles.sectionTitle}>
                    История сообщений
                  </h2>
                  <span className={uiStyles.hint}>
                    {messagesQuery.isFetching
                      ? 'обновляем…'
                      : `${messagesQuery.data?.items.length ?? 0} сообщений`}
                  </span>
                </div>

                {messagesQuery.isLoading ? <LoadingState label="Загружаем сообщения…" /> : null}
                {messagesQuery.isError ? (
                  <ErrorState
                    title="Сообщения не загрузились"
                    message={describeError(messagesQuery.error)}
                    onRetry={() => void messagesQuery.refetch()}
                  />
                ) : null}
                {messagesQuery.data ? (
                  <MessageList
                    messages={messagesQuery.data.items}
                    obligations={detail.outstandingObligations}
                  />
                ) : null}
              </section>

              <Composer
                workItemId={workItem.id}
                obligations={detail.outstandingObligations}
                latestSnapshot={latestSnapshot}
                snapshotLoading={snapshotLoading}
                snapshotError={snapshotError}
                onRefreshSnapshot={requestSnapshot}
              />
            </div>

            <aside className={styles.sideColumn} aria-label="Сведения о диалоге">
              <section className={styles.section} aria-labelledby="waiting-title">
                <h2 id="waiting-title" className={styles.sectionTitle}>
                  Ожидание ответа
                </h2>
                {detail.outstandingObligations.length === 0 ? (
                  <p className={uiStyles.muted}>Все вопросы клиента закрыты.</p>
                ) : (
                  <ul className={styles.obligationList}>
                    {detail.outstandingObligations.map((item) => (
                      <li key={item.id} className={styles.obligationItem}>
                        <Badge tone="warning">#{item.attentionSeq}</Badge>
                        <span className={uiStyles.mono}>{item.messageId}</span>
                        <span className={uiStyles.hint}>версия {item.contentVersion}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className={styles.section} aria-labelledby="conversation-title">
                <h2 id="conversation-title" className={styles.sectionTitle}>
                  Подключение
                </h2>
                <dl className={styles.meta}>
                  <div>
                    <dt>Диалог</dt>
                    <dd className={uiStyles.mono}>{detail.conversation.id}</dd>
                  </div>
                  <div>
                    <dt>Подключение</dt>
                    <dd className={uiStyles.mono}>{detail.conversation.connectionId}</dd>
                  </div>
                  <div>
                    <dt>Внешний чат</dt>
                    <dd className={uiStyles.mono}>{detail.conversation.externalChatId}</dd>
                  </div>
                  <div>
                    <dt>Эпоха привязки</dt>
                    <dd className={uiStyles.mono}>{detail.conversation.bindingEpoch}</dd>
                  </div>
                </dl>
              </section>

              <AssignmentPanel workItem={workItem} onConflict={refreshAll} />

              <div className={styles.section}>
                <ResolvePanel
                  workItem={workItem}
                  openObligations={detail.outstandingObligations.length}
                  onDone={refreshAll}
                />
              </div>

              <div className={styles.section}>
                <ManualCoveragePanel
                  workItem={workItem}
                  obligations={detail.outstandingObligations}
                  knownOperationIds={knownOperationIds}
                  onDone={refreshAll}
                />
              </div>

              {snapshotError ? (
                <Alert tone="error" title="Снимок диалога недоступен">
                  {snapshotError} Отправка заблокирована до успешной проверки снимка.
                </Alert>
              ) : null}
              {latestSnapshot ? (
                <p className={uiStyles.hint}>
                  Снимок актуален: версия назначения {latestSnapshot.assignmentVersion}, открытых
                  вопросов {latestSnapshot.obligationRefs.length}.
                </p>
              ) : null}
            </aside>
          </div>
        </>
      ) : null}
    </div>
  );
}
