import { withTransaction, type Db } from '../platform/db.ts';

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
const STATEMENT_TIMEOUT_MS = 3_000;

export type MetricSample = {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  labels: Record<string, string>;
  value: number;
};

const OUTBOX_STATES = ['pending', 'leased', 'completed', 'failed', 'unknown', 'cancelled'] as const;
const INBOX_STATES = ['pending', 'processing', 'processed', 'failed', 'quarantined'] as const;
const SEND_STATES = ['accepted', 'queued', 'dispatching', 'sent', 'failed', 'unknown', 'cancelled'] as const;

function assertSchema(schema: string): string {
  if (!SCHEMA_PATTERN.test(schema)) throw new Error('INVALID_SCHEMA');
  return schema;
}

function qualified(schema: string, table: string): string {
  return `"${assertSchema(schema)}"."${table}"`;
}

/**
 * Runs every metric query under a statement timeout in one transaction, so a lock or
 * a slow scan cannot pin a pool connection or hang the scrape indefinitely.
 */
async function readMetrics<T>(db: Db, fn: (query: Db['query']) => Promise<T>): Promise<T> {
  return withTransaction(db, async (tx) => {
    await tx.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    return fn(tx.query.bind(tx) as Db['query']);
  });
}

async function countByState(query: Db['query'], schema: string, table: string) {
  const { rows } = await query<{ state: string; count: string }>(
    `SELECT state, count(*) AS count FROM ${qualified(schema, table)} GROUP BY state`,
  );
  return new Map(rows.map((row) => [row.state, Number(row.count)]));
}

function pushStates(
  samples: MetricSample[],
  name: string,
  help: string,
  states: readonly string[],
  counts: Map<string, number>,
): void {
  for (const state of states) {
    samples.push({ name, help, type: 'gauge', labels: { state }, value: counts.get(state) ?? 0 });
  }
}

/**
 * Queue and delivery counters. Everything is aggregate: no company, conversation,
 * message or person identifiers reach the output, so the endpoint is safe to scrape.
 */
export async function collectMetrics(db: Db, schema = 'public'): Promise<MetricSample[]> {
  assertSchema(schema);
  return readMetrics(db, (query) => collectMetricsWith(query, schema));
}

async function collectMetricsWith(query: Db['query'], schema: string): Promise<MetricSample[]> {
  const samples: MetricSample[] = [
    { name: 'm2a_up', help: 'API process is running', type: 'gauge', labels: {}, value: 1 },
  ];

  pushStates(
    samples,
    'm2a_outbox_jobs',
    'Outbox jobs by state',
    OUTBOX_STATES,
    await countByState(query, schema, 'outbox_jobs'),
  );
  pushStates(
    samples,
    'm2a_inbox_events',
    'Inbound events by state',
    INBOX_STATES,
    await countByState(query, schema, 'inbox_events'),
  );
  pushStates(
    samples,
    'm2a_send_operations',
    'Send operations by state',
    SEND_STATES,
    await countByState(query, schema, 'send_operations'),
  );

  const { rows: overdue } = await query<{ count: string }>(
    `SELECT count(*) AS count FROM ${qualified(schema, 'outbox_jobs')}
      WHERE state = 'pending' AND available_at <= now() - interval '5 minutes'`,
  );
  samples.push({
    name: 'm2a_outbox_overdue_jobs',
    help: 'Pending jobs that became available more than five minutes ago',
    type: 'gauge',
    labels: {},
    value: Number(overdue[0]?.count ?? 0),
  });

  const { rows: openObligations } = await query<{ count: string }>(
    `SELECT count(*) AS count FROM ${qualified(schema, 'attention_obligations')} WHERE state = 'open'`,
  );
  samples.push({
    name: 'm2a_open_obligations',
    help: 'Unanswered obligations waiting for a reply',
    type: 'gauge',
    labels: {},
    value: Number(openObligations[0]?.count ?? 0),
  });

  return samples;
}

function escapeLabelValue(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n');
}

function escapeHelp(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n');
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(',')}}`;
}

export function renderPrometheus(samples: MetricSample[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const sample of samples) {
    if (!seen.has(sample.name)) {
      seen.add(sample.name);
      lines.push(`# HELP ${sample.name} ${escapeHelp(sample.help)}`);
      lines.push(`# TYPE ${sample.name} ${sample.type}`);
    }
    lines.push(`${sample.name}${formatLabels(sample.labels)} ${sample.value}`);
  }
  return lines.join('\n') + '\n';
}
