import { RefreshCw } from 'lucide-react';
import { type KeyboardEvent, useEffect, useState } from 'react';
import {
  useGetConnectionRoutingQuery,
  useGetConnectionsQuery,
  useGetPipelinesQuery,
  useGetStaffAvailabilityQuery,
  useRefreshPipelinesMutation,
  useUpdateConnectionLifecycleMutation,
  useUpdateConnectionRoutingMutation,
} from '@/api/baseApi';
import { describeError, isVersionConflict, type NormalizedApiError } from '@/api/errors';
import type { ConnectionProjection } from '@/api/types';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Switch,
  uiStyles,
} from '@/components/ui';
import { ConnectionSetup } from '@/features/connections/connection-setup';
import {ChannelCatalog} from '@/features/connections/channel-catalog';
import { formatDateTime, formatRelative } from '@/lib/format';
import { newIdempotencyKey } from '@/lib/ids';
import {
  CONNECTION_STATE_LABELS,
  CONNECTION_STATE_TONE,
  channelLabel,
  HEALTH_ERROR_LABELS,
} from '@/lib/labels';
import { useHasRole } from '@/store/session';
import styles from './connections-page.module.scss';

export function ConnectionsPage() {
  const query = useGetConnectionsQuery({ limit: 50 });
  const isAdmin = useHasRole('admin');
  const [adding, setAdding] = useState(false);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Подключения</h1>
          <p className={uiStyles.muted}>
            Состояние каналов, здоровье провайдера и управление приёмом и отправкой. Выключение
            отправки не отключает приём.
          </p>
        </div>
        {isAdmin ? (
          <Button onClick={() => setAdding(true)} disabled={adding}>
            Добавить канал
          </Button>
        ) : null}
        <Button onClick={() => void query.refetch()} disabled={query.isFetching}>
          <RefreshCw size={16} aria-hidden="true" />
          {query.isFetching ? 'Обновляем…' : 'Обновить'}
        </Button>
      </header>
      {adding ? <ConnectionSetup onClose={() => setAdding(false)} /> : null}
      {isAdmin?<ChannelCatalog onAddTelegram={()=>setAdding(true)}/>:null}

      {query.isLoading ? <LoadingState label="Загружаем подключения…" /> : null}

      {query.isError ? (
        <ErrorState
          title="Не удалось загрузить подключения"
          message={describeError(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : null}

      {query.data && query.data.items.length === 0 ? (
        <EmptyState
          title="Подключений нет"
          description="Добавьте канал, чтобы настроить его привязку к amoCRM."
        />
      ) : null}

      {query.data && query.data.items.length > 0 ? (
        <ul className={styles.list}>
          {query.data.items.map((connection) => (
            <ConnectionCard key={connection.id} connection={connection} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ConnectionCard({ connection }: { connection: ConnectionProjection }) {
  const isAdmin = useHasRole('admin');
  const [tab, setTab] = useState<'binding' | 'advanced' | 'diagnostics'>(
    isAdmin ? 'binding' : 'diagnostics',
  );
  const tabs = isAdmin
    ? (['binding', 'advanced', 'diagnostics'] as const)
    : (['diagnostics'] as const);
  const panelId = (value: string) => `connection-${connection.id}-${value}`;
  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (index + tabs.length - 1) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    const target = tabs[next];
    if (!target) return;
    setTab(target);
    document.getElementById(`${panelId(target)}-tab`)?.focus();
  };
  const [updateLifecycle, state] = useUpdateConnectionLifecycleMutation();
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const changeState = async (desiredState: 'active' | 'paused' | 'disabled') => {
    setMessage(null);
    try {
      await updateLifecycle({
        id: connection.id,
        body: {
          idempotencyKey: newIdempotencyKey('lifecycle'),
          expectedVersion: connection.version,
          desiredState,
        },
      }).unwrap();
      setMessage({ tone: 'success', text: 'Состояние обновлено.' });
    } catch (error) {
      setMessage({
        tone: 'error',
        text: isVersionConflict(error)
          ? `${describeError(error)} Карточка устарела — обновите список.`
          : describeError(error),
      });
    }
  };

  const health = connection.health;
  const sendBlockedByState =
    connection.state === 'auth_required' || connection.state === 'disabled';

  return (
    <li>
      <section className={styles.card} aria-labelledby={`connection-${connection.id}`}>
        <div className={styles.cardHeader}>
          <div>
            <h2 id={`connection-${connection.id}`} className={styles.cardTitle}>
              {connection.displayName ?? channelLabel(connection.channelMode)}
            </h2>
            <p className={uiStyles.mono}>{connection.id}</p>
          </div>
          <Badge tone={CONNECTION_STATE_TONE[connection.state]}>
            {CONNECTION_STATE_LABELS[connection.state]}
          </Badge>
        </div>

        <div
          role="tablist"
          aria-label={`Настройки ${connection.displayName ?? channelLabel(connection.channelMode)}`}
          className={styles.tabs}
        >
          {tabs.map((value, index) => (
            <button
              key={value}
              type="button"
              role="tab"
              id={`${panelId(value)}-tab`}
              aria-controls={panelId(value)}
              aria-selected={tab === value}
              tabIndex={tab === value ? 0 : -1}
              onClick={() => setTab(value)}
              onKeyDown={(event) => moveTab(event, index)}
            >
              {
                { binding: 'Привязка', advanced: 'Дополнительно', diagnostics: 'Диагностика' }[
                  value
                ]
              }
            </button>
          ))}
        </div>

        <div
          role="tabpanel"
          id={panelId('diagnostics')}
          aria-labelledby={`${panelId('diagnostics')}-tab`}
          hidden={tab !== 'diagnostics'}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Tab must enter this tabpanel because its diagnostic content has no controls.
          tabIndex={0}
        >
          <dl className={styles.meta}>
            <div>
              <dt>Проверка</dt>
              <dd>{formatDateTime(health.checkedAt)}</dd>
            </div>
            <div>
              <dt>Последний приём</dt>
              <dd>{health.lastInboundAt ? formatRelative(health.lastInboundAt) : 'не было'}</dd>
            </div>
            <div>
              <dt>Последний успех</dt>
              <dd>{health.lastSuccessAt ? formatRelative(health.lastSuccessAt) : 'не было'}</dd>
            </div>
            <div>
              <dt>Версия</dt>
              <dd className={uiStyles.mono}>{connection.version}</dd>
            </div>
            <div>
              <dt>Эпоха привязки</dt>
              <dd className={uiStyles.mono}>{connection.bindingEpoch}</dd>
            </div>
            <div>
              <dt>Версия секретов</dt>
              <dd className={uiStyles.mono}>{connection.credentialsVersion}</dd>
            </div>
          </dl>

          {health.errorCode ? (
            <Alert tone="error" title="Ошибка провайдера">
              {HEALTH_ERROR_LABELS[health.errorCode]}
            </Alert>
          ) : (
            <Alert tone="neutral" title="Нет зафиксированных ошибок">
              В сохранённом состоянии нет кода ошибки. Даты проверки и успешного обмена показаны
              выше.
            </Alert>
          )}
        </div>

        {isAdmin ? <RoutingSection connectionId={connection.id} activeTab={tab} /> : null}

        <div className={styles.toggles}>
          <Switch
            id={`ingress-${connection.id}`}
            label="Приём сообщений"
            description="Входящие события принимаются и сохраняются."
            checked={connection.ingressEnabled}
            disabled={state.isLoading}
            onChange={(next) => void changeState(next ? 'active' : 'paused')}
          />
          <Switch
            id={`send-${connection.id}`}
            label="Отправка сообщений"
            description={
              sendBlockedByState
                ? 'Отправка недоступна, пока подключение не активно и не авторизовано.'
                : 'Разрешает исходящие ответы через этот канал.'
            }
            checked={connection.sendEnabled && !sendBlockedByState}
            disabled={state.isLoading || sendBlockedByState}
            onChange={(next) => void changeState(next ? 'active' : 'paused')}
          />
        </div>

        <div className={uiStyles.row}>
          <Button
            size="small"
            onClick={() => void changeState('active')}
            disabled={state.isLoading || connection.state === 'active'}
          >
            Включить
          </Button>
          <Button
            size="small"
            onClick={() => void changeState('paused')}
            disabled={state.isLoading || connection.state === 'paused'}
          >
            Приостановить
          </Button>
          <Button
            size="small"
            variant="danger"
            onClick={() => void changeState('disabled')}
            disabled={state.isLoading || connection.state === 'disabled'}
          >
            Отключить
          </Button>
        </div>

        {message ? (
          <Alert tone={message.tone} title={message.tone === 'error' ? 'Не выполнено' : 'Готово'}>
            {message.text}
          </Alert>
        ) : null}
      </section>
    </li>
  );
}

/**
 * Routing settings of one channel. The funnel and stage come from the CRM account,
 * so an admin picks a real stage instead of typing an id. Closing stages are left
 * out of the list: a new deal must not start in a stage that ends it.
 */
function RoutingSection({
  connectionId,
  activeTab,
}: {
  connectionId: string;
  activeTab: 'binding' | 'advanced' | 'diagnostics';
}) {
  const routing = useGetConnectionRoutingQuery(connectionId);
  const pipelines = useGetPipelinesQuery(undefined);
  const staff = useGetStaffAvailabilityQuery({ limit: 100 });
  const [refreshPipelines, refreshState] = useRefreshPipelinesMutation();
  const [save, saveState] = useUpdateConnectionRoutingMutation();
  const [funnelId, setFunnelId] = useState('');
  const [statusId, setStatusId] = useState('');
  const [normalizePhone, setNormalizePhone] = useState(false);
  const [alertStaffId, setAlertStaffId] = useState('');
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const current = routing.data;
  useEffect(() => {
    if (!current) return;
    setFunnelId(current.funnelId);
    setStatusId(current.statusId ?? '');
    setNormalizePhone(current.normalizePhone);
    setAlertStaffId(current.alertStaffId ?? '');
  }, [current]);

  if (routing.isLoading) {
    return <p className={uiStyles.muted}>Загружаем маршрутизацию…</p>;
  }

  if (routing.isError) {
    if ((routing.error as NormalizedApiError)?.code !== 'NOT_FOUND') {
      return (
        <ErrorState
          title="Не удалось загрузить маршрутизацию"
          message={describeError(routing.error)}
          onRetry={() => void routing.refetch()}
        />
      );
    }
    return (
      <Alert tone="neutral" title="Канал не привязан к CRM">
        У канала ещё нет маршрута. Сначала задайте мастерскую, ответственного и технический источник
        — после этого здесь появится выбор воронки и этапа.
      </Alert>
    );
  }

  const funnel = pipelines.data?.items.find((item) => item.id === funnelId);
  const stages = (funnel?.stages ?? []).filter((stage) => !stage.isFinal);
  const validSelection =
    Boolean(funnel) && (statusId === '' || stages.some((stage) => stage.id === statusId));

  const refresh = async () => {
    setMessage(null);
    try {
      await refreshPipelines().unwrap();
    } catch (error) {
      setMessage({ tone: 'error', text: describeError(error) });
    }
  };

  const submit = async () => {
    if (!current || !validSelection || pipelines.isError) return;
    setMessage(null);
    try {
      await save({
        id: connectionId,
        body: {
          funnelId,
          statusId: statusId === '' ? null : statusId,
          normalizePhone,
          alertStaffId: alertStaffId || null,
          expectedVersion: current.version,
        },
      }).unwrap();
      setMessage({ tone: 'success', text: 'Маршрутизация сохранена.' });
    } catch (error) {
      setMessage({
        tone: 'error',
        text: isVersionConflict(error)
          ? `${describeError(error)} Карточка устарела — обновите список.`
          : describeError(error),
      });
    }
  };

  return (
    <div className={styles.toggles} hidden={activeTab === 'diagnostics'}>
      <div
        role="tabpanel"
        id={`connection-${connectionId}-binding`}
        aria-labelledby={`connection-${connectionId}-binding-tab`}
        hidden={activeTab !== 'binding'}
      >
        <h3 className={styles.cardTitle}>Маршрутизация</h3>

        <Field id={`funnel-${connectionId}`} label="Воронка для новых сделок">
          <select
            id={`funnel-${connectionId}`}
            className={uiStyles.select}
            value={funnelId}
            disabled={pipelines.isLoading || Boolean(pipelines.isError)}
            onChange={(event) => {
              setFunnelId(event.target.value);
              setStatusId('');
            }}
          >
            <option value="">— не выбрана —</option>
            {(pipelines.data?.items ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>

        <Field
          id={`stage-${connectionId}`}
          label="Этап, на который падает новый клиент"
          hint={
            funnelId === ''
              ? 'Сначала выберите воронку.'
              : 'По умолчанию — «Неразобранное», без назначения сотрудника. Закрывающие этапы не показываются.'
          }
        >
          <select
            id={`stage-${connectionId}`}
            className={uiStyles.select}
            value={statusId}
            disabled={stages.length === 0}
            onChange={(event) => setStatusId(event.target.value)}
          >
            <option value="">Неразобранное — без ответственного</option>
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
        </Field>

        <Field
          id={`alerts-${connectionId}`}
          label="Получатель алертов канала"
          hint="Получает уведомления об отключении канала и ошибках доставки."
        >
          <select
            id={`alerts-${connectionId}`}
            className={uiStyles.select}
            value={alertStaffId}
            disabled={saveState.isLoading || staff.isFetching}
            onChange={(event) => setAlertStaffId(event.target.value)}
          >
            <option value="">Не уведомлять</option>
            {alertStaffId && !staff.data?.items.some((item) => item.id === alertStaffId) ? (
              <option value={alertStaffId}>{alertStaffId}</option>
            ) : null}
            {(staff.data?.items ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.id}
              </option>
            ))}
          </select>
        </Field>
        {staff.isError ? (
          <p className={uiStyles.muted}>
            Список сотрудников недоступен. Текущий получатель сохранится.
          </p>
        ) : null}
        <p className={uiStyles.hint}>
          Новые обращения свободны: автоматическое назначение сотрудника не выполняется.
        </p>
      </div>

      <div
        role="tabpanel"
        id={`connection-${connectionId}-advanced`}
        aria-labelledby={`connection-${connectionId}-advanced-tab`}
        hidden={activeTab !== 'advanced'}
      >
        <h3 className={styles.cardTitle}>Дополнительные настройки</h3>
        <Switch
          id={`normalize-${connectionId}`}
          label="Приводить 8XXXXXXXXXX к +7XXXXXXXXXX"
          description="Клиент, написавший с 8, найдётся в контакте, заведённом с +7."
          checked={normalizePhone}
          disabled={saveState.isLoading}
          onChange={setNormalizePhone}
        />
        <p className={uiStyles.hint}>
          Секреты канала хранятся на сервере и не отображаются в карточке. Доступ к amoCRM
          управляется на странице интеграции с CRM.
        </p>
      </div>

      {pipelines.isError ? (
        <Alert tone="error" title="Справочник воронок недоступен">
          Не удалось получить воронки из amoCRM: {describeError(pipelines.error)}
        </Alert>
      ) : null}

      <div className={uiStyles.row}>
        <Button
          size="small"
          onClick={() => void submit()}
          disabled={
            saveState.isLoading ||
            !validSelection ||
            pipelines.isFetching ||
            pipelines.isError ||
            refreshState.isLoading
          }
        >
          {saveState.isLoading ? 'Сохраняем…' : 'Сохранить маршрут'}
        </Button>
        <Button
          size="small"
          onClick={() => void refresh()}
          disabled={pipelines.isFetching || refreshState.isLoading}
        >
          <RefreshCw size={16} aria-hidden="true" />
          {pipelines.isFetching || refreshState.isLoading ? 'Обновляем…' : 'Обновить воронки'}
        </Button>
      </div>

      {message ? (
        <Alert tone={message.tone} title={message.tone === 'error' ? 'Не выполнено' : 'Готово'}>
          {message.text}
        </Alert>
      ) : null}
    </div>
  );
}
