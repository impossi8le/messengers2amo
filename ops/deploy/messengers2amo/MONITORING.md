# Monitoring and alerting — messengers2amo

## 1. What actually exists today

| Signal | Endpoint | Behaviour |
| --- | --- | --- |
| Liveness | `GET /health/live` | `200 {"status":"ok"}`. Does not touch PostgreSQL. |
| Readiness | `GET /health/ready` | `200 {"status":"ready"}`; `503 {"status":"unavailable","dependency":"database"}` when `SELECT 1` fails. |
| Prometheus metrics | `GET /metrics` | `200 text/plain; version=0.0.4` with `Authorization: Bearer $METRICS_TOKEN`; `401` for a missing or wrong token; `404` when `METRICS_TOKEN` is empty (the route is not registered at all); `503` when the database queries behind it fail. |
| Structured logs | stdout of the `api` container | one JSON object per line (`apps/api/src/platform/logger.ts`) |
| Docker health | `docker inspect --format '{{.State.Health.Status}}'` | from the image `HEALTHCHECK` (liveness only) |

`/metrics` is implemented in `apps/api/src/observability/metrics.ts` and
registered in `apps/api/src/app.ts`. Every value is an aggregate gauge
recomputed from PostgreSQL on each request. No company, conversation, message
or person identifiers are emitted; `apps/api/test/metrics.test.ts` asserts that
the rendered body contains none of them. The endpoint is therefore safe to
scrape, but it is still **token-protected** and should not be exposed to the
public without one.

Because `/metrics` runs `SELECT` queries, a scrape failure means either the
process or the database path is broken. Prometheus records that as `up == 0`
(see §4).

### 1.1 Metric reference

All metrics are gauges, not counters: they are recomputed from the tables, so
`rate()` does not apply. Use the value itself, `delta()` or `deriv()` over a
window. State-labelled metrics always emit one series per known state, with `0`
when no row has that state — an absent series is not "zero", it means the
scrape failed.

| Metric | Labels | Meaning | Starting threshold | What to do |
| --- | --- | --- | --- | --- |
| `m2a_up` | — | `1` whenever a scrape succeeded: the API answered and its database queries worked. | `up == 0` for 2 min (page) | Container down, nginx upstream broken, or PostgreSQL unreachable. Check `docker compose -p messengers2amo ps`, `docker compose logs --tail=100 api postgres`, `/health/ready`. |
| `m2a_outbox_jobs{state="pending"}` | `state` | Jobs waiting to be dispatched. | Growing for 10 min, or oldest > 300 s (SQL §3.2) | Dispatcher/worker is not draining. Check `m2a_outbox_overdue_jobs`, `m2a_outbox_jobs{state="leased"}`. |
| `m2a_outbox_jobs{state="leased"}` | `state` | Jobs currently held by a worker lease. | Stuck with expired leases (SQL §3.2) for 10 min | A worker died holding the lease. Wait for lease expiry or restart the worker; never delete rows by hand. |
| `m2a_outbox_jobs{state="failed"}` | `state` | Terminal job failures. | Any sustained growth | Inspect the failure code; re-send only as a new job with a new idempotency key. |
| `m2a_outbox_jobs{state="unknown"}` | `state` | Job outcome unknown. | `> 0` | Reconcile against the provider. Never retry blindly (`ROLLBACK.md` §5). |
| `m2a_outbox_jobs{state="completed"}` / `{state="cancelled"}` | `state` | Informational. | — | No action. |
| `m2a_inbox_events{state="pending"}` | `state` | Inbound events waiting to be processed. | Oldest > 300 s (SQL §3.1) | Ingest/processing stalled; check the API log for webhook errors. |
| `m2a_inbox_events{state="processing"}` | `state` | Events being processed right now. | Oldest > 300 s | Stuck handler; capture logs before restarting anything. |
| `m2a_inbox_events{state="failed"}` | `state` | Events that failed processing. | `> 5` (alert) | Read the failure reason; fix the cause, then replay deliberately. |
| `m2a_inbox_events{state="quarantined"}` | `state` | Payloads rejected and set aside. | `> 0` for 15 min | Manual review required; do not replay into effects. |
| `m2a_inbox_events{state="processed"}` | `state` | Informational. | — | No action. |
| `m2a_send_operations{state="accepted"}` / `{state="queued"}` | `state` | Accepted but not yet handed to a provider. | Growing backlog | Downstream provider slow or dispatcher stalled. |
| `m2a_send_operations{state="dispatching"}` | `state` | Attempt in flight. | Oldest > 120 s (SQL §3.3) | Stuck attempt; wait for the deadline, then reconcile to `sent`/`unknown`. |
| `m2a_send_operations{state="failed"}` | `state` | Provider rejected the send. | Sustained growth | Inspect the provider error; a retry is a new operation. |
| `m2a_send_operations{state="unknown"}` | `state` | Provider outcome unknown — the dangerous state. | `> 0` (page) | Manual reconciliation only; `ROLLBACK.md` §5. |
| `m2a_send_operations{state="sent"}` / `{state="cancelled"}` | `state` | Informational. | — | No action. |
| `m2a_outbox_overdue_jobs` | — | Pending jobs whose `available_at` passed more than 5 minutes ago. | `> 0` for 10 min | The queue is not moving: dispatcher stopped, worker crashed, or the database is slow. |
| `m2a_open_obligations` | — | `attention_obligations` in state `open`: inbound messages still waiting for a reply. | > 25 for 30 min and rising | Staffing/SLA problem or replies are not being sent. Check the operator UI and send pipeline. |

The thresholds are starting points sized for a pilot, not an SLA. Review them
after the first week of real traffic and record the change.

What `/metrics` does **not** expose (still SQL-only, §3): age of the oldest row,
expired leases, delivery latency percentiles, CRM `creation_unknown`,
connection/credential state, media assets. Do not assume the metric table is
complete.

### 1.2 Querying `/metrics` by hand

```bash
cd /opt/messengers2amo
set -a; . ./.env; set +a          # METRICS_TOKEN for this shell only

# Through nginx (the same path Prometheus will use)
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" \
  https://messengers.example.com/metrics

# Without a token: expect 401. Empty METRICS_TOKEN in .env: expect 404.
curl -s -o /dev/null -w '%{http_code}\n' \
  https://messengers.example.com/metrics

# From inside the container, bypassing nginx and the host network boundary.
# The token is read from the container environment, not from the command line.
docker compose -p messengers2amo exec -T api node -e \
  'fetch("http://127.0.0.1:3000/metrics",{headers:{authorization:"Bearer "+process.env.METRICS_TOKEN}}).then(async r=>{console.log(r.status);console.log(await r.text())})'
```

Expected shape of the body:

```
# HELP m2a_up API process is running
# TYPE m2a_up gauge
m2a_up 1
# HELP m2a_outbox_jobs Outbox jobs by state
# TYPE m2a_outbox_jobs gauge
m2a_outbox_jobs{state="pending"} 0
m2a_outbox_jobs{state="leased"} 0
...
m2a_outbox_overdue_jobs 0
m2a_open_obligations 0
```

Rules for handling the token:

- send it only in the `Authorization` header, never in a query string;
- never paste it into a ticket, chat or screenshot — rotate it instead
  (`openssl rand -hex 24`, update `.env`, `docker compose up -d api`);
- the API logger redacts `token`/`authorization` keys and nginx does not log
  request headers, but the token is still a secret.

If `/metrics` returns `503 UPSTREAM_UNAVAILABLE` while `/health/ready` returns
`200`, the route cannot see the queue tables: it resolves the schema from
`DB_SCHEMA` (default `public`), while migrations create tables in `M2A_SCHEMA`
(`messengers2amo`). Check `docker compose -p messengers2amo exec -T api
printenv DB_SCHEMA`; it must match `M2A_SCHEMA`.

## 2. Health checks: what to poll, and what not to restart on

- Poll **`/health/ready`** from outside (it proves the database path works).
- Use **`/health/live`** for container restart decisions. Never wire a restart
  policy to `/health/ready`: a database outage would then restart-loop the API
  and turn a recoverable dependency failure into a crash loop.

```bash
curl -fsS -m 5 https://messengers.example.com/health/live
curl -fsS -m 5 https://messengers.example.com/health/ready
docker compose -p messengers2amo ps
docker inspect --format '{{.Name}} {{.State.Health.Status}}' $(docker ps -q --filter name=messengers2amo)
```

Scrape `/metrics` no more often than every 30–60 s: each request runs five
aggregate queries. 60 s is the recommended interval.

## 3. Queue and latency signals (read-only SQL)

The metrics endpoint exposes counts; it does not expose age, leases or latency.
For those, run read-only SQL against the production database. Every query is
bounded and index-friendly; do not add `SELECT *` here.

```bash
cd /opt/messengers2amo
# $POSTGRES_USER / $POSTGRES_DB come from .env; export them for this shell only.
set -a; . ./.env; set +a

psql_q() {
  docker compose -p messengers2amo exec -T postgres \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -A -F' | ' -c "$1"
}
```

### 3.1 Inbox backlog and age

```sql
SELECT state, count(*) AS events,
       round(max(extract(epoch FROM now() - received_at))) AS oldest_seconds
FROM "messengers2amo".inbox_events
WHERE state IN ('pending','processing','failed','quarantined')
GROUP BY state ORDER BY state;
```

Alert: `pending` oldest > 300 s, or `quarantined` > 0 for more than 15 minutes.

### 3.2 Outbox backlog, leases and stalls

```sql
SELECT state, count(*) AS jobs,
       round(max(extract(epoch FROM now() - created_at))) AS oldest_seconds,
       count(*) FILTER (WHERE state='leased' AND lease_until < now()) AS expired_leases
FROM "messengers2amo".outbox_jobs
WHERE state IN ('pending','leased','failed','unknown')
GROUP BY state ORDER BY state;
```

Alert: `expired_leases` > 0 sustained for 10 minutes (worker died holding a
lease), or `pending` oldest > 300 s.

### 3.3 Send operations: unknown / failed

```sql
SELECT state, count(*) AS operations,
       round(max(extract(epoch FROM now() - created_at))) AS oldest_seconds
FROM "messengers2amo".send_operations
WHERE state IN ('accepted','queued','dispatching','failed','unknown')
GROUP BY state ORDER BY state;
```

`unknown` is the dangerous state: the provider may or may not have accepted the
message. Alert on **any increase** of `unknown`, and on `dispatching` older than
120 s (a stuck attempt).

```sql
-- individual stuck dispatches
SELECT company_id, id, state, created_at, deadline
FROM "messengers2amo".send_operations
WHERE state='dispatching' AND created_at < now() - interval '2 minutes'
ORDER BY created_at LIMIT 20;
```

### 3.4 Delivery latency (accepted → sent)

```sql
SELECT date_trunc('hour', o.created_at) AS hour,
       count(*) AS operations,
       round(avg(extract(epoch FROM a.completed_at - o.created_at))) AS avg_seconds,
       round(percentile_cont(0.95) WITHIN GROUP (
         ORDER BY extract(epoch FROM a.completed_at - o.created_at))) AS p95_seconds
FROM "messengers2amo".send_operations o
JOIN "messengers2amo".send_attempts a
  ON a.company_id=o.company_id AND a.operation_id=o.id
WHERE a.completed_at IS NOT NULL AND o.created_at > now() - interval '24 hours'
GROUP BY 1 ORDER BY 1 DESC;
```

Target from the architecture doc: p95 receive→visible-in-CRM ≤ 5 s under healthy
external APIs. This query measures the send half only.

### 3.5 CRM creation intents

```sql
SELECT state, count(*) AS intents,
       round(max(extract(epoch FROM now() - created_at))) AS oldest_seconds
FROM "messengers2amo".crm_create_intents
WHERE state IN ('pending','dispatching','failed','creation_unknown')
GROUP BY state ORDER BY state;
```

`creation_unknown` must never be retried blindly — see `ROLLBACK.md` §5.

### 3.6 Channel and credential health

```sql
SELECT state, count(*) AS connections
FROM "messengers2amo".connections GROUP BY state ORDER BY state;
```

Alert: any connection in `degraded` or `auth_required` for > 30 minutes.
TODO(DEP05): token refresh age is not persisted as a first-class column in
`001..004`; add a metric when the OAuth refresher lands.

### 3.7 Media pipeline

```sql
SELECT state, count(*) AS assets, coalesce(sum(byte_size),0) AS bytes
FROM "messengers2amo".media_assets GROUP BY state ORDER BY state;
```

Alert: `failed`/`rejected` growth, or `quarantined` assets older than 24 h
(unreviewed quarantine).

## 4. Alerts

**Prometheus and Alertmanager are not deployed by this repository.** The rule
file `monitoring/alerts.yml` is a ready template; `monitoring/README.md`
describes how to wire it to a real Prometheus and what to do per alert. Until
that happens, the checks in §4.2 and §6 are manual.

### 4.1 Prometheus rules (`monitoring/alerts.yml`)

| Alert | Expression | For | Severity | First action |
| --- | --- | --- | --- | --- |
| `M2A_API_DOWN` | `up{job="messengers2amo"} == 0` | 2m | critical | `docker compose ps`; `docker compose logs --tail=100 api`; check nginx upstream and PostgreSQL. |
| `M2A_NOT_READY` | `probe_success{job="messengers2amo-readiness"} == 0` | 2m | critical | Database path broken: disk, connections, `docker compose logs postgres`. Needs `blackbox_exporter`; without it a DB outage still surfaces as `M2A_API_DOWN`, because `/metrics` itself queries the database. |
| `M2A_OUTBOX_OVERDUE` | `m2a_outbox_overdue_jobs > 0` | 10m | warning | Queue is not draining. Check `m2a_outbox_jobs{state="leased"}`, expired leases (SQL §3.2), dispatcher logs. |
| `M2A_SEND_UNKNOWN` | `m2a_send_operations{state="unknown"} > 0` | 1m | critical | Stop and reconcile manually. Never retry automatically: `ROLLBACK.md` §5. |
| `M2A_INBOX_FAILED` | `m2a_inbox_events{state="failed"} > 5` | 5m | warning | Read the failure reason in the logs; fix the cause, then replay deliberately. |
| `M2A_OPEN_OBLIGATIONS_HIGH` | `m2a_open_obligations > 25 and deriv(m2a_open_obligations[30m]) > 0.02` | 30m | warning | Unanswered queue is growing: staffing/SLA or the send pipeline is broken. |

### 4.2 Not covered by the metrics endpoint (host-level checks)

| # | Condition | Severity | Action |
| --- | --- | --- | --- |
| 1 | `/health/live` fails 5× in a row (150 s) | page | Docker restarts the container; inspect `docker compose logs api` before it loops. |
| 2 | disk `/` > 85 % | warn | Prune dumps, check log growth (`docker system df`, `/var/backups`). |
| 3 | RAM available < 300 MB for 15 min | warn | Host is oversubscribed (no swap). |
| 4 | newest backup older than 90 min | page | Backup job broken — RPO breached. `BACKUP-RESTORE.md` §3. |
| 5 | TLS cert expires in < 14 days | warn | `certbot renew --dry-run`, check the timer. |
| 6 | nginx 5xx rate > 1 % for 10 min | warn | Upstream down or reload failed. |

Alerting must not depend on the monitored VM: use an **external** prober or a
push-based dead-man's-switch (TODO: choose the provider and the on-call channel).
A cron job on the same host that mails on failure fails silently when the host
is down, which is exactly the case that matters.

Minimal external check (any HTTP prober):

```
GET https://messengers.example.com/health/ready
expect 200 within 5 s, every 60 s, from at least two locations
```

## 5. Logs: what is safe to keep

The application logger (`apps/api/src/platform/logger.ts`) already:

- emits JSON Lines to stdout, one event per line;
- redacts keys `password, secret, token, authorization, cookie, set-cookie,
  access_token, refresh_token, client_secret, bot_token, webhook_secret,
  session, text, body, content, phone, email, name`;
- truncates strings at 512 chars and arrays at 50 items;
- generates/reuses a correlation id (`x-correlation-id`) per request.

Therefore application logs are safe to ship off-host **as they are**. What must
not be added:

- message text, captions, phone numbers, e-mail addresses, contact names;
- provider request/response bodies, access or refresh tokens, bot tokens;
- session cookies, `Authorization` headers, signed media URLs;
- raw webhook payloads (they contain personal data — keep them in the database
  inbox, not in logs).

### nginx access logs

The shipped vhost templates use the `messengers2amo_safe` format (no query
string, no headers). Verify the **installed** vhost does too: the default
`combined` format logs the full request line including the query string, which
is the usual place for tokens to leak.

```nginx
# /etc/nginx/conf.d/00-m2a-log-format.conf
log_format messengers2amo_safe '$time_iso8601 $request_method $status '
                               '$body_bytes_sent $request_time';
```

Then reference it from both server blocks:
`access_log /var/log/nginx/messengers2amo.access.log messengers2amo_safe;`
`nginx -t`, reload. TODO(DEP05): confirm on the host and record it.

### Retention and access

| Log | Location | Retention | Access |
| --- | --- | --- | --- |
| API stdout | `docker compose logs` (json-file, 10 MB × 3 per service) | ~30 MB per service, rotated by Docker | root |
| nginx access/error | `/var/log/nginx/messengers2amo.*.log` | TODO: 14 days via logrotate | root |
| PostgreSQL | container stderr | same as API | root |

`log_min_duration_statement` and `log_statement` must stay at defaults: enabling
them would write message parameters into the PostgreSQL log.

## 6. Daily checks (5 minutes)

```bash
cd /opt/messengers2amo
set -a; . ./.env; set +a
docker compose -p messengers2amo ps
curl -fsS https://messengers.example.com/health/ready
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" \
  https://messengers.example.com/metrics | grep -E 'm2a_(up|outbox_overdue|open_obligations)'
ls -lt /var/backups/messengers2amo | head -5
df -h /; free -m
docker compose -p messengers2amo logs --since 24h api | grep -c '"level":"error"'
certbot certificates --cert-name messengers.example.com | grep -E 'Expiry|VALID'
```

Record anything anomalous in the release log; do not "just restart" a failing
dependency without capturing its logs first.
