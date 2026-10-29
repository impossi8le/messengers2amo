import { Link2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useGetCrmBindingsQuery,
  useGetCrmDiagnosticsQuery,
  useGetCrmIntegrationStatusQuery,
} from '@/api/baseApi';
import { describeError } from '@/api/errors';
import { Alert, Badge, Button, ErrorState, LoadingState, uiStyles } from '@/components/ui';
import { AMOCRM_AUTHORIZE_URL, isAmocrmOAuthMessage, startAmocrmAuthorization } from '@/lib/amocrm';
import { formatDateTime } from '@/lib/format';
import { CRM_BINDING_STATE_LABELS, CRM_BINDING_STATE_TONE } from '@/lib/labels';
import styles from './crm.module.scss';

export interface AmocrmConnectionPanelProps {
  /** Подключение к amoCRM начинает только администратор. */
  isAdmin: boolean;
}

type AuthorizationPhase = 'idle' | 'pending' | 'ok' | 'error' | 'blocked';

/**
 * Подключение к amoCRM.
 *
 * OAuth читается из состояния аккаунта независимо от привязок диалогов.
 * Диагностика первого диалога показывает отдельное состояние синхронизации.
 *
 * Кнопка открывает серверный адрес OAuth во всплывающем окне. Callback-страница
 * сервера присылает результат через `postMessage` и закрывается сама, поэтому
 * консоль не перезагружается: она просто перезапрашивает связки и диагностику.
 * Если окно закрыли вручную, тот же перезапрос делается один раз по `focus`
 * или по `window.closed`.
 */
export function AmocrmConnectionPanel({ isAdmin }: AmocrmConnectionPanelProps) {
  const integration = useGetCrmIntegrationStatusQuery();
  const bindings = useGetCrmBindingsQuery({ limit: 1 });
  const first = bindings.data?.items[0] ?? null;

  const diagnostics = useGetCrmDiagnosticsQuery(
    { accountId: first?.crmAccountId ?? '', conversationId: first?.conversationId ?? '' },
    { skip: !first },
  );

  const [phase, setPhase] = useState<AuthorizationPhase>('idle');
  const [authError, setAuthError] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState<string>(AMOCRM_AUTHORIZE_URL);
  const popupRef = useRef<Window | null>(null);
  const settledRef = useRef(false);
  const firstRef = useRef(first);
  firstRef.current = first;

  const refreshConnection = useCallback(() => {
    void integration.refetch();
    void bindings.refetch();
    // Диагностика привязана к первому диалогу: без связки её просто нечего спросить.
    if (firstRef.current) void diagnostics.refetch();
  }, [bindings.refetch, diagnostics.refetch, integration.refetch]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (
        event.origin !== new URL(AMOCRM_AUTHORIZE_URL, window.location.href).origin ||
        !popupRef.current ||
        event.source !== popupRef.current
      )
        return;
      if (!isAmocrmOAuthMessage(event.data)) return;
      settledRef.current = true;
      popupRef.current = null;
      if (event.data.status === 'ok') {
        setPhase('ok');
        setAuthError(null);
      } else {
        setPhase('error');
        setAuthError(event.data.message?.trim() || 'Код авторизации отклонён или истёк.');
      }
      refreshConnection();
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [refreshConnection]);

  useEffect(() => {
    if (phase !== 'pending') return undefined;
    const popup = popupRef.current;
    let settled = false;
    const settle = () => {
      if (settled || settledRef.current) return;
      settled = true;
      settledRef.current = true;
      popupRef.current = null;
      setPhase('idle');
      refreshConnection();
    };
    const onFocus = () => {
      if (popup?.closed) settle();
    };
    const timer = window.setInterval(() => {
      if (!popup || popup.closed) settle();
    }, 700);
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [phase, refreshConnection]);

  function handleStart() {
    const result = startAmocrmAuthorization();
    if (!result.opened) {
      popupRef.current = null;
      setManualUrl(result.url);
      setAuthError(null);
      setPhase('blocked');
      return;
    }
    popupRef.current = result.popup;
    settledRef.current = false;
    setAuthError(null);
    setPhase('pending');
  }

  const configured = Boolean(first);
  const authorized =
    integration.data?.accounts.some((account) => account.state === 'active') ?? false;
  const hasAccount =
    integration.data?.accounts.some((account) => account.state !== 'setup') ?? false;
  const lastSuccessAt = diagnostics.data?.sync?.lastSuccessAt ?? null;

  return (
    <section className={styles.section} aria-labelledby="crm-amocrm-title">
      <div className={styles.sectionHeader}>
        <h2 id="crm-amocrm-title" className={styles.sectionTitle}>
          Подключение к amoCRM
        </h2>
        {bindings.data ? (
          <Badge tone={configured ? 'success' : 'warning'}>
            {configured ? 'Связка настроена' : 'Связка не настроена'}
          </Badge>
        ) : null}
      </div>
      <p className={uiStyles.hint}>
        Доступ к amoCRM выдаёт владелец аккаунта на странице согласия. Токены хранятся на сервере в
        зашифрованном виде и в браузер не попадают.
      </p>

      {integration.isLoading ? <LoadingState label="Проверяем OAuth amoCRM…" /> : null}
      {integration.isError ? (
        <ErrorState
          title="Статус OAuth недоступен"
          message={describeError(integration.error)}
          onRetry={() => void integration.refetch()}
        />
      ) : null}
      {integration.data ? (
        <>
          <div className={uiStyles.row}>
            <span>OAuth</span>
            <Badge tone={authorized ? 'success' : 'warning'}>
              {authorized ? 'Доступ выдан' : 'Доступ не выдан'}
            </Badge>
          </div>
          {integration.data.accounts.map((account) => (
            <dl className={styles.meta} key={account.id}>
              <div>
                <dt>Аккаунт</dt>
                <dd>{account.id}</dd>
              </div>
              <div>
                <dt>Авторизация</dt>
                <dd>
                  {
                    {
                      setup: 'Не подключён',
                      active: 'Доступ выдан',
                      revoked: 'Доступ отозван',
                      disabled: 'Отключён',
                    }[account.state]
                  }
                </dd>
              </div>
              <div>
                <dt>Последняя авторизация</dt>
                <dd>{formatDateTime(account.lastAuthorizedAt)}</dd>
              </div>
              <div>
                <dt>Последнее обновление токена</dt>
                <dd>{formatDateTime(account.lastRefreshedAt)}</dd>
              </div>
              {account.refreshFailureCount > 0 ? (
                <div>
                  <dt>Ошибки обновления подряд</dt>
                  <dd>{account.refreshFailureCount}</dd>
                </div>
              ) : null}
            </dl>
          ))}
          {!integration.data.authorizationEnabled ? (
            <p className={uiStyles.hint}>OAuth не настроен на сервере.</p>
          ) : null}
          {isAdmin ? (
            <div className={uiStyles.row}>
              <Button
                variant="primary"
                onClick={handleStart}
                disabled={!integration.data.authorizationEnabled || phase === 'pending'}
              >
                <Link2 size={16} aria-hidden="true" />
                {hasAccount ? 'Переподключить amoCRM' : 'Подключить amoCRM'}
              </Button>
            </div>
          ) : (
            <p className={uiStyles.hint}>Подключение выполняет администратор.</p>
          )}
        </>
      ) : null}

      {phase === 'ok' ? (
        <Alert tone="success" title="amoCRM подключена">
          Токены получены и сохранены на сервере. Данные связки обновлены.
        </Alert>
      ) : null}

      {phase === 'blocked' ? (
        <Alert tone="error" title="Браузер заблокировал всплывающее окно">
          <p>Разрешите всплывающие окна для этой страницы или откройте согласие вручную.</p>
          <a href={manualUrl} target="_blank" rel="noopener noreferrer">
            Открыть страницу согласия вручную
          </a>
        </Alert>
      ) : null}

      {phase === 'error' ? (
        <Alert tone="error" title="Не удалось подключить amoCRM">
          {authError}
        </Alert>
      ) : null}

      {bindings.isLoading ? <LoadingState label="Проверяем связку с amoCRM…" /> : null}

      {bindings.isError ? (
        <ErrorState
          title="Состояние связки недоступно"
          message={describeError(bindings.error)}
          onRetry={() => void bindings.refetch()}
        />
      ) : null}

      {bindings.data && !configured ? (
        <p className={uiStyles.muted}>
          Ни один диалог ещё не привязан к CRM. Состояние OAuth показано отдельно.
        </p>
      ) : null}

      {first ? (
        <div className={styles.diagnostics}>
          <dl className={styles.meta}>
            <div>
              <dt>Состояние связки</dt>
              <dd>
                <Badge tone={CRM_BINDING_STATE_TONE[first.state]}>
                  {CRM_BINDING_STATE_LABELS[first.state]}
                </Badge>
              </dd>
            </div>
            <div>
              <dt>Последняя успешная синхронизация</dt>
              <dd>{formatDateTime(lastSuccessAt)}</dd>
            </div>
          </dl>

          {diagnostics.data?.sync?.errorCode ? (
            <Alert tone="warning" title="Ошибка синхронизации">
              {diagnostics.data.sync.errorCode}
            </Alert>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
