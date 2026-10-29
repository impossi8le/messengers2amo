# Deploy runbook — messengers2amo (DEP03 + DEP04)

Target: Ubuntu 24.04, `203.0.113.10`, root, existing nginx on 80/443 shared
with dzen, geo, map, pogodafon, litellm, neurowriter, lr-messenger.

**These commands are for the operator during a rollout. The rollout has since
been performed: on 2026-10-22 the public `/health/live` and `/health/ready`
answered `200`. The procedure is kept as-is so it can be re-run on a rebuild or
a new host. Every step has an explicit verification and a rollback anchor.**

Conventions: `$D=/opt/messengers2amo`, `$DOMAIN=messengers.example.com`,
`$SITE=/etc/nginx/sites-available/$DOMAIN.conf`.

## 0. Preconditions (all must pass before touching anything)

```bash
set -euo pipefail
D=/opt/messengers2amo
DOMAIN=messengers.example.com

# 0.1 DNS resolves to this host
dig +short "$DOMAIN" @8.8.8.8

# 0.2 Port 18767 is free (nothing else may own the upstream)
ss -lntp | grep ':18767' && { echo "PORT 18767 BUSY - STOP"; exit 1; } || echo "18767 free"

# 0.3 No vhost claims this name yet
nginx -T 2>/dev/null | grep -n "server_name.*$DOMAIN" || echo "no vhost for $DOMAIN (expected)"

# 0.4 No certificate yet
certbot certificates 2>/dev/null | grep -n "$DOMAIN" || echo "no cert for $DOMAIN (expected)"

# 0.5 Resources
free -m; df -h /; nproc; docker --version; docker compose version
```

Stop if 0.2/0.3/0.4 contradict expectations: something changed since preparation
and the plan must be re-derived.

## 1. Save the current nginx state (rollback anchor)

```bash
TS=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p /root/nginx-backup-$TS
cp -a /etc/nginx /root/nginx-backup-$TS/nginx
nginx -T > /root/nginx-backup-$TS/nginx-T.before.txt 2>&1
ls -l /etc/nginx/sites-enabled/ > /root/nginx-backup-$TS/sites-enabled.before.txt
certbot certificates > /root/nginx-backup-$TS/certbot.before.txt 2>&1
sha256sum /root/nginx-backup-$TS/nginx-T.before.txt
```

Record the checksum in `RELEASE-MANIFEST.md` §7. This snapshot is what §10
falls back to if a reload goes wrong.

## 2. Prepare the application directory

```bash
install -d -m 0755 "$D"
# Sources are delivered as the release artefact (git archive of the release tag
# or an rsync of the built tree). TODO: record the exact delivery method and
# the archive sha256 in RELEASE-MANIFEST.md.
cd "$D"

# Environment file: 0600, root-owned, never committed.
install -m 0600 ops/deploy/messengers2amo/.env.example .env
$EDITOR .env
```

Fill `.env` per the comments. Minimum to start:

- `POSTGRES_USER`, `POSTGRES_DB`, `POSTGRES_PASSWORD` (URL-safe!),
- `SESSION_SECRET` — `openssl rand -hex 32`,
- `IMAGE_TAG` — the release tag,
- `OUTBOUND_ENABLED=false`,
- `DB_SCHEMA` — must equal `M2A_SCHEMA` (`messengers2amo`); the API defaults
  to `public` otherwise and `/metrics` returns 503,
- `METRICS_TOKEN` — `openssl rand -hex 24`; empty disables `/metrics`.

Verify before building:

```bash
grep -E '^(POSTGRES_|SESSION_SECRET=|IMAGE_TAG=|DB_SCHEMA=|METRICS_TOKEN=)' .env \
  | sed 's/=.*/=<set>/'
# every listed name must show "<set>"; no empty required value
# (METRICS_TOKEN may stay empty only if /metrics is intentionally disabled)
```

## 3. Build and start

```bash
cd "$D"
docker compose -p messengers2amo config -q          # renders without errors
docker compose -p messengers2amo build --pull api
docker compose -p messengers2amo up -d
docker compose -p messengers2amo ps
```

Expected: `postgres` healthy, `migrate` exited 0, `api` healthy.

If `migrate` exited non-zero, **stop**: `docker compose -p messengers2amo logs migrate`
and follow `MIGRATION.md` §4. `api` will not have started.

Record digests:

```bash
docker image inspect messengers2amo/api:$IMAGE_TAG --format '{{.Id}}'
docker image inspect postgres:18 --format '{{index .RepoDigests 0}}'
```

## 4. Verify the network boundary

```bash
# Only loopback, only 18767
ss -lntp | grep 18767
# must be: 127.0.0.1:18767  (NOT 0.0.0.0:18767, NOT [::]:18767)

# PostgreSQL must not be published at all
docker compose -p messengers2amo ps --format '{{.Service}} {{.Ports}}'

# Direct app checks
curl -fsS http://127.0.0.1:18767/health/live   # {"status":"ok"}
curl -fsS http://127.0.0.1:18767/health/ready  # {"status":"ready"}

# Must be unreachable from outside before nginx is configured
curl -sS --max-time 5 http://203.0.113.10:18767/health/live || echo "closed (expected)"
```

## 5. nginx — phase 1 (HTTP bootstrap) and certificate issuance

```bash
# 5.1 Install the bootstrap vhost (HTTP only, no TLS paths referenced)
install -m 0644 "$D/ops/deploy/messengers2amo/templates/messengers2amo.bootstrap.http.nginx.conf" "$SITE"
ln -sfn "$SITE" "/etc/nginx/sites-enabled/$DOMAIN.conf"

# 5.2 Validate BEFORE reload
nginx -t

# 5.3 Reload only after a clean test
systemctl reload nginx

# 5.4 ACME reachability from the outside is what matters; check locally first
curl -sSI "http://$DOMAIN/.well-known/acme-challenge/probe" | head -1   # 404 is fine
```

Issue the certificate **for this single name only**, using the nginx plugin in
`certonly` mode so certbot does not rewrite our vhost:

```bash
certbot certonly --nginx -d "$DOMAIN" \
  --non-interactive --agree-tos \
  --cert-name "$DOMAIN" \
  -m TODO-ACME-CONTACT-EMAIL
```

Notes:
- Do **not** pass other `-d` names, do not use `--expand`, do not touch existing
  lineages. `--cert-name "$DOMAIN"` pins the lineage to this one name.
- `certonly --nginx` uses the existing HTTP server block for validation and does
  not modify files under `/etc/nginx/sites-*`.
- If HTTP-01 fails, check that nothing else answers for this `server_name`
  (`nginx -T | grep -n "$DOMAIN"`) and that the A record still points here.

Verify the lineage:

```bash
certbot certificates --cert-name "$DOMAIN"
openssl x509 -in "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" -noout -subject -dates -ext subjectAltName
```

Expected SAN: `DNS:messengers.example.com` and nothing else.

## 6. nginx — phase 2 (full vhost with HTTPS)

```bash
install -m 0644 "$D/ops/deploy/messengers2amo/templates/messengers2amo.http.nginx.conf" "$SITE"
nginx -t
systemctl reload nginx
```

Now the HTTPS block's certificate paths exist, so `nginx -t` passes.

Enable HSTS only after §7–§8 pass: uncomment the `add_header
Strict-Transport-Security` line, `nginx -t`, reload.

## 7. Verify TLS: SAN, SNI, chain, redirect

```bash
# Certificate presented for this SNI
echo | openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" 2>/dev/null \
  | openssl x509 -noout -subject -ext subjectAltName

# SNI isolation: a different name must NOT receive this certificate
echo | openssl s_client -connect 203.0.113.10:443 -servername example.com 2>/dev/null \
  | openssl x509 -noout -subject     # must not be $DOMAIN

# Chain and expiry via the public entrypoint
curl -fsSI "https://$DOMAIN/health/live"

# HTTP -> HTTPS
curl -sSI "http://$DOMAIN/health/live" | head -3
# expect: HTTP/1.1 301 Moved Permanently + Location: https://$DOMAIN/health/live

# ACME path must still answer over plain HTTP (renewal depends on it)
curl -sSI "http://$DOMAIN/.well-known/acme-challenge/probe" | head -1
```

## 8. Smoke checks

```bash
curl -fsS "https://$DOMAIN/health/live"
curl -fsS "https://$DOMAIN/health/ready"
curl -sS -o /dev/null -w '%{http_code}\n' "https://$DOMAIN/health/ready"   # 200
curl -sS -o /dev/null -w '%{http_code}\n' "https://$DOMAIN/does-not-exist" # app 404/401, not nginx 502

# Correlation id round-trip
curl -sSI "https://$DOMAIN/health/live" | grep -i x-correlation-id

# Security headers
curl -sSI "https://$DOMAIN/health/live" | grep -iE 'x-content-type-options|referrer-policy|x-frame-options'

# Webhook path must NOT ask for Basic auth
curl -sSI "https://$DOMAIN/webhooks/probe" | grep -i 'www-authenticate' && echo "UNEXPECTED AUTH - STOP"

# TLS grade / config sanity (optional)
ss -lntp | grep -E ':(80|443)\b'
```

### 8.1 Channel webhook and internal route boundary

A channel webhook must exist and reject an unauthenticated call with `401`, not
`404`. In this probe a `404` means the path is wrong; `503` means the channel
block is not configured in `.env` (the route is effectively off).

```bash
# Every configured channel: POST without a signature/secret -> 401
for ch in whatsapp max vk; do
  printf '%s: ' "$ch"
  curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
    -H 'Content-Type: application/json' -d '{}' \
    "https://$DOMAIN/webhooks/$ch/probe"
done
# expect 401 for each configured channel; 503 for one left unconfigured

# WhatsApp GET handshake without the verify token -> 403 when configured
curl -sS -o /dev/null -w '%{http_code}\n' \
  "https://$DOMAIN/webhooks/whatsapp/probe?hub.mode=subscribe&hub.challenge=1"

# VK GET without type=confirmation -> 403 when configured
curl -sS -o /dev/null -w '%{http_code}\n' "https://$DOMAIN/webhooks/vk/probe"
# 503 on either GET means the channel block is empty, not that the route is missing
```

The internal CRM group is a separate identity. With `INTERNAL_SERVICE_TOKEN`
set, an unauthenticated call answers `401`; with the token empty the group is
not registered and the path answers `404`. Both are intentional.

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  "https://$DOMAIN/api/v2/internal/crm/bindings"
# 401 = token configured and required; 404 = adapter group disabled by config
```

These checks prove the routes and secrets are wired in the application. They do
**not** prove that a provider subscription points at this host: verify that in
the provider console and later through `health.lastInboundAt`.

Cross-site regression check — the neighbours must be untouched:

```bash
for h in dzen geo map pogodafon litellm neurowriter lr-messenger; do
  printf '%s: ' "$h"
  curl -sS -o /dev/null -w '%{http_code}\n' --max-time 8 "https://$h.example.com" || echo "no-dns"
done
```

Any non-2xx/3xx here means the shared nginx was disturbed: go to §10.

## 9. Post-deploy

1. Fill `RELEASE-MANIFEST.md` §7 evidence.
2. Take the first backup: `BACKUP-RESTORE.md` §3.
3. Install monitoring: scrape `/metrics` with `METRICS_TOKEN` and load
   `monitoring/alerts.yml` — see `monitoring/README.md`; manual signals and
   host-level checks are in `MONITORING.md` §4.
4. Rehearse rollback **before** enabling outbound: `ROLLBACK.md` §2.
5. Only then set `OUTBOUND_ENABLED=true` and record the decision.

## 10. Rollback (nginx part)

Removes **only** this project's symlink. Does not touch other sites, does not
delete certificates, does not restore the whole `/etc/nginx` snapshot.

```bash
DOMAIN=messengers.example.com
rm -f "/etc/nginx/sites-enabled/$DOMAIN.conf"     # symlink only
nginx -t
systemctl reload nginx

# Verify the neighbours are healthy and this name no longer answers with our vhost
nginx -T 2>/dev/null | grep -n "$DOMAIN" || echo "vhost disabled"
```

The file in `sites-available` is left in place for a fast re-enable
(`ln -sfn ...`). Delete it only when the project is permanently retired.

If nginx itself is broken and will not reload, restore from §1:

```bash
cp -a /root/nginx-backup-$TS/nginx/. /etc/nginx/
nginx -t && systemctl reload nginx
```

Application rollback: `ROLLBACK.md`. Never `docker compose down -v`.

## 11. Do not touch

- other vhosts in `/etc/nginx/sites-enabled/`, `conf.d/`, and the `default_server`
  block;
- other certbot lineages (`certbot certificates` lists them; never `--cert-name`
  them, never `--expand`, never `certbot renew --force-renewal` globally);
- other Compose projects and their volumes/networks;
- `/etc/letsencrypt/renewal-hooks/` (add a hook only if the task explicitly
  requires it).
