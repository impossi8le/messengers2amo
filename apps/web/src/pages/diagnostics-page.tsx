import { Search } from 'lucide-react';
import { useState } from 'react';
import {
  useGetConnectionsQuery,
  useGetCrmBindingsQuery,
  useGetSendOperationQuery,
} from '@/api/baseApi';
import { describeError } from '@/api/errors';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  uiStyles,
} from '@/components/ui';
import { SendOperationStatus } from '@/features/composer/send-operation-status';
import { SystemStatusPanel } from '@/features/system-status/system-status-panel';
import { formatDateTime } from '@/lib/format';
import {
  CONNECTION_STATE_LABELS,
  CRM_BINDING_STATE_LABELS,
  CRM_BINDING_STATE_TONE,
  channelLabel,
  HEALTH_ERROR_LABELS,
  SEND_STATE_LABELS,
  SEND_STATE_TONE,
} from '@/lib/labels';
import styles from './diagnostics-page.module.scss';

export function DiagnosticsPage() {
  return (
    <div className={styles.page}>
      <header>
        <h1 className={styles.title}>Диагностика</h1>
        <p className={uiStyles.muted}>
          Ошибки отправки, неопределённые операции и спорные связи с CRM. Всё, что требует решения
          человека, а не автоматического повтора.
        </p>
      </header>

      <SystemStatusPanel />

      <div className={styles.grid}>
        <SendOperationLookup />
        <UnknownOperationsHelp />
        <ConnectionsHealth />
        <DisputedBindings />
      </div>
    </div>
  );
}

function SendOperationLookup() {
  const [input, setInput] = useState('');
  const [requested, setRequested] = useState<string | null>(null);
  const query = useGetSendOperationQuery(requested ?? '', { skip: !requested });

  return (
    <section className={styles.section} aria-labelledby="lookup-title">
      <h2 id="lookup-title" className={styles.sectionTitle}>
        Проверить операцию отправки
      </h2>
      <form
        className={styles.lookupForm}
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = input.trim();
          setRequested(trimmed || null);
        }}
      >
        <label htmlFor="operation-id" className={styles.label}>
          Идентификатор операции
        </label>
        <div className={uiStyles.row}>
          <input
            id="operation-id"
            className={uiStyles.input}
            value={input}
            onChange={(event) => setInput(event.currentTarget.value)}
            placeholder="op_…"
            autoComplete="off"
          />
          <Button type="submit" variant="primary" disabled={!input.trim()}>
            <Search size={16} aria-hidden="true" />
            Проверить
          </Button>
        </div>
      </form>

      {query.isLoading ? <LoadingState label="Запрашиваем операцию…" /> : null}
      {query.isError ? (
        <ErrorState
          title="Операция недоступна"
          message={describeError(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {query.data ? (
        <>
          <div className={uiStyles.row}>
            <Badge tone={SEND_STATE_TONE[query.data.state]}>
              {SEND_STATE_LABELS[query.data.state]}
            </Badge>
            <span className={uiStyles.mono}>{query.data.id}</span>
          </div>
          <p className={uiStyles.hint}>
            Провайдерское сообщение: {query.data.providerMessageId ?? 'нет'} · покрытие вопросов:{' '}
            {query.data.coverage === 'confirmed' ? 'подтверждено' : 'не подтверждено'}
          </p>
          {query.data.state === 'unknown' ? (
            <SendOperationStatus operationId={query.data.id} />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function UnknownOperationsHelp() {
  return (
    <section className={styles.section} aria-labelledby="unknown-title">
      <h2 id="unknown-title" className={styles.sectionTitle}>
        Неопределённые операции
      </h2>
      <Alert tone="warning" title="Повтор вслепую запрещён">
        Операция в состоянии «результат неизвестен» могла быть доставлена. Проверьте чат у клиента,
        затем оформите ручное покрытие: оно фиксирует, что ответ дан, не создавая второе сообщение.
      </Alert>
      <ul className={styles.rules}>
        <li>Сетевой таймаут не означает, что сообщение не ушло.</li>
        <li>Истёкшая аренда воркера не доказывает отсутствие отправки.</li>
        <li>Ручное покрытие требует подтверждённой операции и причины.</li>
      </ul>
    </section>
  );
}

function ConnectionsHealth() {
  const query = useGetConnectionsQuery({ limit: 50 });
  const broken = (query.data?.items ?? []).filter(
    (item) => item.health.errorCode !== null || item.state !== 'active',
  );

  return (
    <section className={styles.section} aria-labelledby="connections-health-title">
      <h2 id="connections-health-title" className={styles.sectionTitle}>
        Подключения с ошибками
      </h2>
      {query.isLoading ? <LoadingState label="Загружаем подключения…" /> : null}
      {query.isError ? (
        <ErrorState
          title="Подключения недоступны"
          message={describeError(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {query.data && broken.length === 0 ? (
        <EmptyState title="Ошибок нет" description="Все подключения активны и отвечают." />
      ) : null}
      {broken.length > 0 ? (
        <ul className={styles.list}>
          {broken.map((connection) => (
            <li key={connection.id} className={styles.listItem}>
              <div className={styles.itemHeader}>
                <strong>{channelLabel(connection.channelMode)}</strong>
                <Badge tone={connection.state === 'active' ? 'success' : 'warning'}>
                  {CONNECTION_STATE_LABELS[connection.state]}
                </Badge>
              </div>
              <p className={uiStyles.mono}>{connection.id}</p>
              <p className={uiStyles.hint}>
                {connection.health.errorCode
                  ? HEALTH_ERROR_LABELS[connection.health.errorCode]
                  : 'Состояние требует внимания'}
                {' · проверка '}
                {formatDateTime(connection.health.checkedAt)}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function DisputedBindings() {
  const query = useGetCrmBindingsQuery({ limit: 50 });
  const disputed = (query.data?.items ?? []).filter((item) => item.state !== 'bound');

  return (
    <section className={styles.section} aria-labelledby="bindings-title">
      <h2 id="bindings-title" className={styles.sectionTitle}>
        Спорные связи с CRM
      </h2>
      <p className={uiStyles.hint}>
        Связи, где создание контакта или чата не подтверждено. Повторное создание запрещено до
        сверки в amoCRM.
      </p>
      {query.isLoading ? <LoadingState label="Загружаем связи…" /> : null}
      {query.isError ? (
        <ErrorState
          title="Связи с CRM недоступны"
          message={describeError(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {query.data && disputed.length === 0 ? (
        <EmptyState title="Спорных связей нет" description="Все связи подтверждены." />
      ) : null}
      {disputed.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="visually-hidden">Спорные связи диалогов с CRM</caption>
            <thead>
              <tr>
                <th scope="col">Диалог</th>
                <th scope="col">Состояние</th>
                <th scope="col">Контакт</th>
                <th scope="col">Чат</th>
                <th scope="col">Версия</th>
              </tr>
            </thead>
            <tbody>
              {disputed.map((binding) => (
                <tr key={binding.id}>
                  <td className={uiStyles.mono}>{binding.conversationId}</td>
                  <td>
                    <Badge tone={CRM_BINDING_STATE_TONE[binding.state]}>
                      {CRM_BINDING_STATE_LABELS[binding.state]}
                    </Badge>
                  </td>
                  <td className={uiStyles.mono}>{binding.contactId ?? '—'}</td>
                  <td className={uiStyles.mono}>{binding.chatId ?? '—'}</td>
                  <td className={uiStyles.mono}>{binding.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
