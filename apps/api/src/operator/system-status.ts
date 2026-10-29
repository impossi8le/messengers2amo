// Aggregate system health for the operator console.
//
// One read model, one query: every counter and both activity timestamps are
// correlated subqueries over the existing tables, so the endpoint never
// degenerates into a per-connection N+1 loop. Nothing here writes and nothing
// leaves the company scope. The response is aggregate only — no company,
// connection, conversation or person identifiers — so it is safe to render in
// the console.

import type { Db } from '../platform/db.ts';

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Pending outbox jobs older than this are treated as stuck. The dispatcher
 * polls every few seconds, so fifteen minutes without progress means the worker
 * is down or wedged, not that the queue is merely busy.
 */
export const OUTBOX_STUCK_MINUTES = 15;

/**
 * Unprocessed inbound events above this are a backlog. Normal bursts stay in
 * the hundreds; a thousand pending events means processing stopped and clients
 * are waiting for replies.
 */
export const INBOX_PENDING_DEGRADED_THRESHOLD = 1000;

/**
 * No inbound traffic for this long while at least one connection is active
 * almost always means broken webhooks or an expired channel session. Six hours
 * is longer than any normal quiet period in a support channel, including night.
 */
export const INBOUND_IDLE_HOURS = 6;

export type SystemHealth = 'ok' | 'degraded' | 'critical';
export type SystemIssueSeverity = 'warning' | 'critical';

export type SystemIssue = {
  code: string;
  severity: SystemIssueSeverity;
  title: string;
  detail: string;
};

export type SystemStatus = {
  checkedAt: string;
  database: { reachable: boolean; latencyMs: number | null };
  queues: {
    inboxPending: number;
    outboxPending: number;
    outboxLeased: number;
    outboxFailed: number;
    sendUnknown: number;
  };
  activity: {
    lastInboundAt: string | null;
    lastSendAt: string | null;
  };
  connections: {
    total: number;
    active: number;
    degraded: number;
    authRequired: number;
  };
  health: SystemHealth;
  issues: SystemIssue[];
};

export type SystemStatusScope = {
  schema: string;
  companyId: string;
};

type StatusRow = {
  inbox_pending: string;
  outbox_pending: string;
  outbox_stuck: string;
  outbox_leased: string;
  outbox_failed: string;
  send_unknown: string;
  last_inbound_at: Date | null;
  last_send_at: Date | null;
  conn_total: string;
  conn_active: string;
  conn_degraded: string;
  conn_auth_required: string;
};

function assertSchema(schema: string): string {
  if (!SCHEMA_PATTERN.test(schema)) throw new Error('INVALID_SCHEMA');
  return schema;
}

function qualified(schema: string, table: string): string {
  return `"${assertSchema(schema)}"."${table}"`;
}

function isoOrNull(value: Date | null): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function idleSince(lastInboundAt: string | null, now: Date): boolean {
  if (!lastInboundAt) return true;
  const parsed = Date.parse(lastInboundAt);
  if (!Number.isFinite(parsed)) return true;
  return now.getTime() - parsed > INBOUND_IDLE_HOURS * 60 * 60 * 1000;
}

function emptyQueues(): SystemStatus['queues'] {
  return { inboxPending: 0, outboxPending: 0, outboxLeased: 0, outboxFailed: 0, sendUnknown: 0 };
}

/**
 * Reads the whole system state in a single query. A failure of that query is the
 * "database unreachable" signal: the endpoint still answers 200 with
 * `reachable: false` and a critical health, because the console itself is alive
 * and the operator must see the outage in place.
 */
export async function getSystemStatus(
  db: Db,
  scope: SystemStatusScope,
  now: Date = new Date(),
): Promise<SystemStatus> {
  const checkedAt = now.toISOString();
  const started = performance.now();

  let row: StatusRow | undefined;
  let reachable = true;
  try {
    const { rows } = await db.query<StatusRow>(
      `SELECT
         (SELECT count(*) FROM ${qualified(scope.schema, 'inbox_events')}
           WHERE company_id = $1 AND state IN ('pending','processing')) AS inbox_pending,
         (SELECT count(*) FROM ${qualified(scope.schema, 'outbox_jobs')}
           WHERE company_id = $1 AND state = 'pending') AS outbox_pending,
         (SELECT count(*) FROM ${qualified(scope.schema, 'outbox_jobs')}
           WHERE company_id = $1 AND state = 'pending'
             AND created_at <= $2::timestamptz - ($3::int * interval '1 minute')) AS outbox_stuck,
         (SELECT count(*) FROM ${qualified(scope.schema, 'outbox_jobs')}
           WHERE company_id = $1 AND state = 'leased') AS outbox_leased,
         (SELECT count(*) FROM ${qualified(scope.schema, 'outbox_jobs')}
           WHERE company_id = $1 AND state = 'failed') AS outbox_failed,
         (SELECT count(*) FROM ${qualified(scope.schema, 'send_operations')}
           WHERE company_id = $1 AND state = 'unknown') AS send_unknown,
         (SELECT max(e.received_at) FROM ${qualified(scope.schema, 'inbox_events')} e
           WHERE e.company_id = $1) AS last_inbound_at,
         (SELECT max(o.created_at) FROM ${qualified(scope.schema, 'send_operations')} o
           WHERE o.company_id = $1 AND o.state = 'sent') AS last_send_at,
         (SELECT count(*) FROM ${qualified(scope.schema, 'connections')}
           WHERE company_id = $1) AS conn_total,
         (SELECT count(*) FROM ${qualified(scope.schema, 'connections')}
           WHERE company_id = $1 AND state = 'active') AS conn_active,
         (SELECT count(*) FROM ${qualified(scope.schema, 'connections')}
           WHERE company_id = $1 AND state = 'degraded') AS conn_degraded,
         (SELECT count(*) FROM ${qualified(scope.schema, 'connections')}
           WHERE company_id = $1 AND state = 'auth_required') AS conn_auth_required`,
      [scope.companyId, checkedAt, OUTBOX_STUCK_MINUTES],
    );
    row = rows[0];
  } catch {
    reachable = false;
  }

  const latencyMs = reachable ? Math.max(0, Math.round(performance.now() - started)) : null;

  if (!reachable || !row) {
    return {
      checkedAt,
      database: { reachable: false, latencyMs: null },
      queues: emptyQueues(),
      activity: { lastInboundAt: null, lastSendAt: null },
      connections: { total: 0, active: 0, degraded: 0, authRequired: 0 },
      health: 'critical',
      issues: [
        {
          code: 'DATABASE_UNREACHABLE',
          severity: 'critical',
          title: 'База данных недоступна',
          detail: 'Не удалось прочитать состояние очередей. Проверьте PostgreSQL и соединение API.',
        },
      ],
    };
  }

  const queues = {
    inboxPending: Number(row.inbox_pending),
    outboxPending: Number(row.outbox_pending),
    outboxLeased: Number(row.outbox_leased),
    outboxFailed: Number(row.outbox_failed),
    sendUnknown: Number(row.send_unknown),
  };
  const outboxStuck = Number(row.outbox_stuck);
  const activity = {
    lastInboundAt: isoOrNull(row.last_inbound_at),
    lastSendAt: isoOrNull(row.last_send_at),
  };
  const connections = {
    total: Number(row.conn_total),
    active: Number(row.conn_active),
    degraded: Number(row.conn_degraded),
    authRequired: Number(row.conn_auth_required),
  };

  const issues: SystemIssue[] = [];

  // Critical: delivery is already broken or unverifiable. These need a person
  // before anything else, because repeating a send blindly can duplicate a
  // message to a client.
  if (queues.outboxFailed > 0) {
    issues.push({
      code: 'OUTBOX_FAILED',
      severity: 'critical',
      title: 'Есть проваленные задания отправки',
      detail: `${queues.outboxFailed} заданий в очереди отправки перешли в failed. Проверьте журнал воркера и разберите ошибки.`,
    });
  }
  if (queues.sendUnknown > 0) {
    issues.push({
      code: 'SEND_UNKNOWN',
      severity: 'critical',
      title: 'Есть отправки с неизвестным результатом',
      detail: `${queues.sendUnknown} операций в состоянии unknown. Проверьте чат у клиента: повтор вслепую запрещён.`,
    });
  }
  if (outboxStuck > 0) {
    issues.push({
      code: 'OUTBOX_STUCK',
      severity: 'critical',
      title: 'Очередь отправки стоит',
      detail: `${outboxStuck} заданий ждут дольше ${OUTBOX_STUCK_MINUTES} минут. Проверьте, запущен ли воркер и нет ли блокировки.`,
    });
  }

  // Degraded: the system still delivers, but something will fail soon if it is
  // not addressed.
  if (connections.degraded > 0) {
    issues.push({
      code: 'CONNECTIONS_DEGRADED',
      severity: 'warning',
      title: 'Подключения деградировали',
      detail: `${connections.degraded} подключений в состоянии degraded. Проверьте здоровье каналов на странице «Подключения».`,
    });
  }
  if (connections.authRequired > 0) {
    issues.push({
      code: 'CONNECTIONS_AUTH_REQUIRED',
      severity: 'warning',
      title: 'Требуется повторная авторизация',
      detail: `${connections.authRequired} подключений ждут входа в канал. Перепривяжите их на странице «Подключения».`,
    });
  }
  if (queues.inboxPending > INBOX_PENDING_DEGRADED_THRESHOLD) {
    issues.push({
      code: 'INBOX_BACKLOG',
      severity: 'warning',
      title: 'Очередь входящих переполнена',
      detail: `${queues.inboxPending} событий не обработаны (порог ${INBOX_PENDING_DEGRADED_THRESHOLD}). Проверьте воркер и ошибки обработки.`,
    });
  }
  if (connections.active > 0 && idleSince(activity.lastInboundAt, now)) {
    issues.push({
      code: 'INBOUND_IDLE',
      severity: 'warning',
      title: 'Нет входящих сообщений',
      detail: `Активные подключения не получали сообщений более ${INBOUND_IDLE_HOURS} часов. Проверьте вебхуки и сессии каналов.`,
    });
  }

  const health: SystemHealth = issues.some((issue) => issue.severity === 'critical')
    ? 'critical'
    : issues.length > 0
      ? 'degraded'
      : 'ok';

  return {
    checkedAt,
    database: { reachable: true, latencyMs },
    queues,
    activity,
    connections,
    health,
    issues,
  };
}
