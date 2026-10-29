import { RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useGetSystemStatusQuery } from '@/api/baseApi';
import { describeError, isForbidden } from '@/api/errors';
import type { SystemHealth, SystemStatus } from '@/api/types';
import { Badge, type BadgeTone, Button, LoadingState } from '@/components/ui';
import { useDocumentVisible, useRefetchOnVisible } from '@/lib/document-visibility';
import { formatDateTime } from '@/lib/format';
import { useSessionStore } from '@/store/session';
import styles from './system-status-panel.module.scss';

/**
 * Период опроса состояния системы.
 *
 * Раз в минуту, и только пока вкладка видима и сессия подтверждена: сводка
 * агрегированная и не требует частоты уведомлений, а фоновая вкладка или
 * истёкшая cookie иначе шлют запрос впустую.
 */
export const SYSTEM_STATUS_POLL_INTERVAL_MS = 60_000;

const HEALTH_LABELS: Record<SystemHealth, string> = {
  ok: 'Система работает нормально',
  degraded: 'Есть проблемы',
  critical: 'Критическое состояние',
};

const HEALTH_TONE: Record<SystemHealth, BadgeTone> = {
  ok: 'success',
  degraded: 'warning',
  critical: 'danger',
};

const HEALTH_HINT: Record<SystemHealth, string> = {
  ok: 'Отклонений нет: очереди разгружаются, подключения активны.',
  degraded: 'Система отвечает, но часть возможностей работает нештатно.',
  critical: 'Отправка или приём уже нарушены — нужно вмешательство сейчас.',
};

/**
 * Сводка «Состояние системы» для страницы диагностики.
 *
 * Ошибка запроса не выносится в громкий баннер: раздел живёт рядом с другими
 * диагностическими блоками и показывает нейтральный текст. 403 объясняется
 * отдельно — раздел доступен только администратору.
 */
export function SystemStatusPanel() {
  const authenticated = useSessionStore((state) => state.status === 'authenticated');
  const visible = useDocumentVisible();
  const query = useGetSystemStatusQuery(undefined, {
    // Без подтверждённой сессии запрос не подписывается вовсе.
    skip: !authenticated,
    // Ноль выключает таймер RTK Query; возврат на вкладку обновляет сразу.
    pollingInterval: authenticated && visible ? SYSTEM_STATUS_POLL_INTERVAL_MS : 0,
  });
  useRefetchOnVisible(query.refetch, { enabled: authenticated, visible });

  const forbidden = isForbidden(query.error);

  return (
    <section className={styles.section} aria-labelledby="system-status-title">
      <div className={styles.header}>
        <h2 id="system-status-title" className={styles.sectionTitle}>
          Состояние системы
        </h2>
        <Button
          size="small"
          onClick={() => void query.refetch()}
          disabled={!authenticated || query.isFetching}
        >
          <RefreshCw size={14} aria-hidden="true" />
          Обновить
        </Button>
      </div>

      {!authenticated ? (
        <p className={styles.muted}>Войдите, чтобы увидеть состояние системы.</p>
      ) : null}

      {query.isLoading ? <LoadingState label="Проверяем состояние системы…" /> : null}

      {query.isError && !forbidden ? (
        <p className={styles.muted}>
          Не удалось загрузить состояние системы: {describeError(query.error)}
        </p>
      ) : null}

      {forbidden ? (
        <p className={styles.muted}>Состояние системы доступно администратору.</p>
      ) : null}

      {query.data ? <SystemStatusBody status={query.data} /> : null}
    </section>
  );
}

function SystemStatusBody({ status }: { status: SystemStatus }) {
  return (
    <>
      <div className={styles.summary}>
        <Badge tone={HEALTH_TONE[status.health]}>{HEALTH_LABELS[status.health]}</Badge>
        <p className={styles.muted}>{HEALTH_HINT[status.health]}</p>
      </div>

      <p className={styles.checked}>
        Проверено: <time dateTime={status.checkedAt}>{formatDateTime(status.checkedAt)}</time>
      </p>

      {status.issues.length > 0 ? (
        <ul className={styles.issues} aria-label="Проблемы системы">
          {status.issues.map((issue) => (
            <li key={issue.code} className={styles.issue}>
              <div className={styles.issueHeader}>
                <strong>{issue.title}</strong>
                <Badge tone={issue.severity === 'critical' ? 'danger' : 'warning'}>
                  {issue.severity === 'critical' ? 'Критично' : 'Внимание'}
                </Badge>
              </div>
              <p className={styles.muted}>{issue.detail}</p>
            </li>
          ))}
        </ul>
      ) : null}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className="visually-hidden">Очереди и активность системы</caption>
          <tbody>
            <Row label="База данных" value={databaseValue(status)} />
            <Row label="Входящие без обработки" value={String(status.queues.inboxPending)} />
            <Row label="В очереди отправки" value={String(status.queues.outboxPending)} />
            <Row label="В работе (аренда)" value={String(status.queues.outboxLeased)} />
            <Row label="Проваленные отправки" value={String(status.queues.outboxFailed)} />
            <Row
              label="Отправки с неизвестным результатом"
              value={String(status.queues.sendUnknown)}
            />
            <Row
              label="Последнее входящее"
              value={
                status.activity.lastInboundAt ? (
                  <time dateTime={status.activity.lastInboundAt}>
                    {formatDateTime(status.activity.lastInboundAt)}
                  </time>
                ) : (
                  '—'
                )
              }
            />
            <Row
              label="Последняя успешная отправка"
              value={
                status.activity.lastSendAt ? (
                  <time dateTime={status.activity.lastSendAt}>
                    {formatDateTime(status.activity.lastSendAt)}
                  </time>
                ) : (
                  '—'
                )
              }
            />
            <Row
              label="Подключения"
              value={`${status.connections.total} всего · ${status.connections.active} активны · ${status.connections.degraded} сбоят · ${status.connections.authRequired} требуют входа`}
            />
          </tbody>
        </table>
      </div>
    </>
  );
}

function databaseValue(status: SystemStatus): string {
  if (!status.database.reachable) return 'недоступна';
  return status.database.latencyMs === null
    ? 'доступна'
    : `доступна (${status.database.latencyMs} мс)`;
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{value}</td>
    </tr>
  );
}
