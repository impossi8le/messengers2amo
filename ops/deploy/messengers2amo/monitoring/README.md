# Prometheus wiring for messengers2amo — template

## Status: template, not a running system

**No Prometheus, Alertmanager, blackbox_exporter or notification channel is
provisioned for this service yet.** The company has not confirmed an external
monitoring host. This directory contains a ready-to-use scrape configuration
and alert rules so that connecting one later is a copy-paste job, not a design
exercise.

Until it is connected, monitoring is manual: `/health/ready` polls, the daily
checks in `../MONITORING.md` §6, and the read-only SQL in §3 of the same
document.

Files:

| File | Purpose |
| --- | --- |
| `alerts.yml` | Prometheus alert rules (`groups: - name: messengers2amo`) |
| `grafana-dashboard.json` | importable Grafana dashboard (schema v39+) for the `m2a_*` metrics |
| this README | how to wire them, verify the scrape, import the dashboard, and respond per alert |

The application side already exists: `GET /metrics` on the public vhost,
protected by the `METRICS_TOKEN` bearer token. See `../MONITORING.md` §1.

## 1. Prerequisites

1. A Prometheus 2.x instance outside the monitored VM (a Prometheus on the same
   host cannot alert when the host is down).
2. Network access from that instance to
   `https://messengers.example.com/metrics`.
3. The value of `METRICS_TOKEN` from `/opt/messengers2amo/.env` on the VPS,
   stored on the Prometheus host as a file readable only by the Prometheus user.
4. Optional: `blackbox_exporter` for the readiness alert (`M2A_NOT_READY`),
   because the application does not export a readiness metric.

## 2. Scrape configuration

Append to `prometheus.yml` on the monitoring host:

```yaml
scrape_configs:
  - job_name: messengers2amo
    scrape_interval: 60s
    scrape_timeout: 10s
    metrics_path: /metrics
    scheme: https
    authorization:
      type: Bearer
      # Preferred over inline `credentials`: the token never appears in
      # prometheus.yml, in `ps`, or in a config backup.
      credentials_file: /etc/prometheus/secrets/m2a_metrics_token
    static_configs:
      - targets:
          - messengers.example.com
        labels:
          environment: production
```

Create the token file on the monitoring host (no trailing newline):

```bash
sudo install -d -m 0750 -o prometheus -g prometheus /etc/prometheus/secrets
printf '%s' '<METRICS_TOKEN from the VPS .env>' \
  | sudo tee /etc/prometheus/secrets/m2a_metrics_token > /dev/null
sudo chown prometheus:prometheus /etc/prometheus/secrets/m2a_metrics_token
sudo chmod 0640 /etc/prometheus/secrets/m2a_metrics_token
```

Do not put the token in `params`, in a URL, or in `curl` history.

### Optional: readiness probe (needed for `M2A_NOT_READY`)

```yaml
  - job_name: messengers2amo-readiness
    metrics_path: /probe
    params:
      module: [http_2xx]
    static_configs:
      - targets:
          - https://messengers.example.com/health/ready
    relabel_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      - target_label: __address__
        replacement: 127.0.0.1:9115   # blackbox_exporter address
```

`blackbox_exporter` needs a module that accepts a valid TLS certificate and
returns success on HTTP 200; the default `http_2xx` module is sufficient.

If blackbox_exporter is not deployed, **delete the `M2A_NOT_READY` rule**: with
no `probe_success` series it will simply never fire, which is silent rather
than wrong, but a rule that cannot fire should not be trusted. A database
outage is still caught by `M2A_API_DOWN`, because `/metrics` itself queries
PostgreSQL.

## 3. Rules and Alertmanager

```yaml
# prometheus.yml
rule_files:
  - /etc/prometheus/rules/m2a-alerts.yml
```

```bash
sudo install -m 0644 alerts.yml /etc/prometheus/rules/m2a-alerts.yml
promtool check rules /etc/prometheus/rules/m2a-alerts.yml
promtool check config /etc/prometheus/prometheus.yml
sudo systemctl reload prometheus
```

Alert delivery is intentionally not configured here: the on-call channel
(e-mail, Telegram, Slack, pager) has not been chosen. A minimal Alertmanager
route once it is chosen:

```yaml
route:
  receiver: m2a-oncall
  group_by: [alertname]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
receivers:
  - name: m2a-oncall
    # TODO: choose and configure the real integration.
```

`severity: critical` should page; `severity: warning` can go to a chat channel.

## 4. Verify that the scrape works

On the monitoring host, before touching Prometheus:

```bash
# Expect 200 and a body starting with "# HELP m2a_up".
curl -fsS --max-time 10 \
  -H "Authorization: Bearer $(cat /etc/prometheus/secrets/m2a_metrics_token)" \
  https://messengers.example.com/metrics | head -5

# Expect 401: proves the endpoint is not open.
curl -s -o /dev/null -w '%{http_code}\n' \
  https://messengers.example.com/metrics
```

In the Prometheus UI (`http://<prometheus>:9090`):

1. **Status → Targets**: both jobs show `UP`; `messengers2amo` last scrape error
   is empty.
2. Query `up{job="messengers2amo"}` → `1`.
3. Query `m2a_up` → `1` and `scrape_duration_seconds{job="messengers2amo"}` is
   well under the 10 s timeout (each scrape runs five aggregate queries).
4. **Status → Rules**: all six `M2A_*` rules are loaded and `Health = ok`.
5. Query a state series, e.g. `m2a_outbox_jobs` — every known state must be
   present, including zeros.

Common failures:

| Symptom | Cause |
| --- | --- |
| `401` | Wrong or stale token; `credentials_file` unreadable by Prometheus; token file has a trailing newline. |
| `404` | `METRICS_TOKEN` is empty in the VPS `.env`, so the route is not registered. |
| `503` | The metrics queries fail. Usually the schema: `/health/ready` returns 200 but `/metrics` cannot see the tables — `DB_SCHEMA` must match `M2A_SCHEMA` (`messengers2amo`). |
| `up == 0`, connection refused/timeout | nginx or the loopback publish is broken; check `/health/ready` from outside first. |
| Rule `M2A_NOT_READY` never evaluates | blackbox job is not configured. |

## 5. Importing the dashboard (Импорт дашборда)

`grafana-dashboard.json` is a self-contained dashboard definition. It reads
only the `m2a_*` series that Prometheus already scrapes, so it adds no load of
its own.

**Requirements.** Grafana **10.0 or newer** (the JSON declares
`schemaVersion: 39`). Grafana 9.x can import it but may drop newer panel
options; Grafana 11.x is what it was authored against. The Prometheus data
source must already exist in Grafana and point at the instance configured in
§2. The dashboard does **not** create the data source.

**Import through the UI.**

1. Grafana → **Dashboards** → **New** → **Import**.
2. **Upload JSON file** → choose `grafana-dashboard.json` (or paste its
   contents into the text area).
3. On the import screen, pick the Prometheus data source in the
   **Datasource** selector (the dashboard defines a `datasource` variable of
   type `prometheus` for exactly this).
4. **Import**. The dashboard opens as `messengers2amo — queues and delivery`
   with UID `m2a-queues`.

**Import through provisioning (optional, repeatable).** On the Grafana host:

```bash
sudo install -d -m 0755 /etc/grafana/provisioning/dashboards
sudo install -m 0644 grafana-dashboard.json \
  /var/lib/grafana/dashboards/m2a-queues.json
```

```yaml
# /etc/grafana/provisioning/dashboards/m2a.yml
apiVersion: 1
providers:
  - name: messengers2amo
    folder: messengers2amo
    type: file
    options:
      path: /var/lib/grafana/dashboards
```

With provisioning the `datasource` variable has no saved value on first load:
select the Prometheus source once in the dashboard's variable drop-down. It is
remembered per dashboard afterwards.

**Check that the panels receive data.** Panels are empty until Prometheus has
scraped at least once after import; the dashboard refreshes every minute.

1. **API status** shows `UP` in green. `DOWN`/`No data` means the scrape is
   broken — work through §4 before blaming the dashboard.
2. **Overdue outbox jobs** shows a number (usually `0`, not blank). A blank
   panel means the query returned nothing.
3. **Outbox queue by state** and **Inbox events by state** show one line per
   state, including zeros (`pending`, `leased`, `completed`, `failed`,
   `unknown`, `cancelled` for outbox). If a state line is missing entirely,
   the series is absent from the scrape.
4. **Send operations by state** and **Unanswered obligations** show lines with
   a legend table underneath.
5. To confirm a single query independently, open a panel → **Edit** →
   **Query inspector** → **Refresh**, or run the same expression in
   Prometheus (`Status → Targets` should be `UP` first).

If every panel says "Datasource not found", the `datasource` variable was not
set at import: **Dashboard settings → Variables → datasource** and choose the
Prometheus source. If a panel shows "No data" while `m2a_up` works in
Prometheus, check the panel's `job="messengers2amo"` label against the job name
in §2 — a renamed scrape job requires editing the panel expressions.

## 6. What to do per alert

All commands run on the VPS in `/opt/messengers2amo`. Read
`../MONITORING.md` §3 for the read-only SQL and §5 for what may be logged.

### `M2A_API_DOWN` (critical)

1. `docker compose -p messengers2amo ps` — is `api` running and healthy?
2. `curl -fsS https://messengers.example.com/health/ready`.
3. `docker compose -p messengers2amo logs --tail=100 api postgres`.
4. If the database is down: treat it as a data incident, check disk and
   `pg_isready`. Do **not** restart-loop the API.
5. If the container is crash-looping and the data is suspect:
   `../ROLLBACK.md` §4 (pause/drain) and §6 (rollback).

### `M2A_NOT_READY` (critical)

1. `docker compose -p messengers2amo exec -T postgres pg_isready`.
2. `df -h /`, `free -m`, connection count.
3. `docker compose -p messengers2amo logs --tail=200 postgres`.
4. If PostgreSQL must be restored: `../BACKUP-RESTORE.md` §6 (production
   restore, incident only). Take a safety dump first.

### `M2A_OUTBOX_OVERDUE` (warning)

1. Run SQL §3.2: are jobs `pending`, `leased`, or is `expired_leases > 0`?
2. `docker compose -p messengers2amo ps` — is the `worker` service running?
   It is defined in `../docker-compose.yml` (`node apps/api/src/worker.ts`);
   if it is stopped or crash-looping, nothing drains the outbox.
3. If the worker died holding a lease, wait for lease expiry or restart it;
   never edit `outbox_jobs` by hand.
4. If sends are backing up and must stop: `../ROLLBACK.md` §4.1.

### `M2A_SEND_UNKNOWN` (critical)

1. SQL §3.3 to list the affected rows.
2. **Do not retry.** Reconcile with the provider (receipt, read-back, webhook)
   or escalate to the operator: `../ROLLBACK.md` §5.
3. Record the decision (reconciled / cancelled / forwarded) in the release log.
4. If the count grows during a deploy: `../ROLLBACK.md` §4 (pause outbound)
   first, then investigate.

### `M2A_INBOX_FAILED` (warning)

1. `docker compose -p messengers2amo logs --since 1h api | grep '"level":"error"'`
   — find the correlation id and the failure code.
2. Fix the cause (payload shape, provider change, database constraint).
3. Replay deliberately; do not mass-update `inbox_events.state`.
4. If payloads are being rejected as untrusted, they belong in `quarantined`,
   not `failed` — review them manually.

### `M2A_OPEN_OBLIGATIONS_HIGH` (warning)

1. Check whether staff are answering (operator UI) or whether replies fail to
   send: `m2a_send_operations{state="failed"}` and SQL §3.3.
2. If the send path is broken, follow `M2A_OUTBOX_OVERDUE`.
3. If it is staffing, escalate to the business owner; there is no automatic
   remediation.

## 7. Security notes

- The token is a bearer secret: anyone who has it can read aggregate queue
  counts. It does not expose message content or identifiers, but it does expose
  operational volume.
- The endpoint is reachable through the public vhost. If that is unacceptable,
  restrict it in nginx (for example `allow <monitoring-ip>; deny all;` inside a
  dedicated `location = /metrics`), but keep the bearer token as the primary
  control.
- Rotate by changing `METRICS_TOKEN` in `/opt/messengers2amo/.env` and running
  `docker compose -p messengers2amo up -d api`; update the Prometheus
  `credentials_file` in the same change window.
- Do not enable nginx `combined` logging for this vhost: it records query
  strings. The shipped template uses a safe format without them
  (`../MONITORING.md` §5).

## 8. What these rules do not cover

Host disk, RAM, backup age, TLS expiry and nginx 5xx are not exported by the
application; they need node_exporter, a textfile collector or an external
prober. They are listed as manual checks in `../MONITORING.md` §4.2. Delivery
latency, expired leases and connection health remain SQL-only (§3).
