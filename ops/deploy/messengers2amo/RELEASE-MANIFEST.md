# Release manifest — messengers2amo

Status: **deployed; release evidence partially recorded.** The service answers
on the public URL: on 2026-10-22 an external check of `/health/live` and
`/health/ready` returned `200` (`{"status":"ok"}` and `{"status":"ready"}`).
Values marked `TODO` below were not filled in from the rollout and must still
be recovered from the host; their absence means "not recorded here", not "not
done". Backup/restore and rollback rehearsals are **not** confirmed by this
manifest — see §9.

## 1. Identity

| Field | Value |
| --- | --- |
| Service | messengers2amo (internal messenger gateway → amoCRM) |
| Compose project | `messengers2amo` |
| Target host | Ubuntu 24.04, `203.0.113.10` |
| Deploy directory | `/opt/messengers2amo` |
| Source branch | `feat/production-core` |
| Release tag | TODO: `v0.<minor>.<patch>` (must equal `IMAGE_TAG`) |
| Source commit | TODO: `git rev-parse HEAD` at build time |
| Release date (UTC) | TODO |
| Operator | TODO |

## 2. Public surface

| Field | Value |
| --- | --- |
| Public URL | `https://messengers.example.com` |
| DNS | A record → `203.0.113.10` (verified externally via 8.8.8.8) |
| TLS | Let's Encrypt, certbot nginx plugin, single-name certificate |
| Certificate lineage | `/etc/letsencrypt/live/messengers.example.com/` |
| Upstream | `127.0.0.1:18767` → container port `3000` |
| Host port status | free at preparation time (verified) |
| nginx vhost | `/etc/nginx/sites-available/messengers.example.com.conf` |
| nginx symlink | `/etc/nginx/sites-enabled/messengers.example.com.conf` |
| Existing vhost for this name | none (`nginx -T` grep found nothing) — this is the cause of `ERR_CERT_COMMON_NAME_INVALID` |

## 3. Images

| Image | Reference | Digest |
| --- | --- | --- |
| API | `messengers2amo/api:<IMAGE_TAG>`, built on the host from `apps/api/Dockerfile` | TODO: `docker image inspect --format '{{index .RepoDigests 0}}'` |
| Base (build+runtime) | `node:24-bookworm-slim` | TODO: pin `@sha256:...` in the Dockerfile before rollout |
| PostgreSQL | `postgres:18` | TODO: pin `@sha256:...` in `docker-compose.yml` before rollout |

No image is pulled from a private registry and no registry credentials exist on
the host. The API image is built locally; record its image ID as well:

```bash
docker image inspect messengers2amo/api:$IMAGE_TAG --format '{{.Id}}'
```

## 4. Containers

| Service | Image | Ports | Restart | Limits (cpu / RAM / pids) |
| --- | --- | --- | --- | --- |
| `api` | `messengers2amo/api:<tag>` | `127.0.0.1:18767:3000` | `unless-stopped` | 1.00 / 512M / 256 |
| `postgres` | `postgres:18` | none published | `unless-stopped` | 1.00 / 768M / 200 |
| `migrate` | `messengers2amo/api:<tag>` | none | `no` (one-shot) | 0.50 / 256M / 128 |
| `worker` | `messengers2amo/api:<tag>` | none | `unless-stopped` | 0.50 / 256M / 128 |

Volumes: `messengers2amo_pgdata` → `/var/lib/postgresql` (PostgreSQL 18 layout).
Network: `messengers2amo_internal` (bridge). No `privileged`, no `network_mode:
host`, no `/var/run/docker.sock`, no host paths mounted.

## 5. Environment variables

Names only; values live in `/opt/messengers2amo/.env` (mode 0600) and are never
committed. The template is `.env.example`.

Required (the API exits if missing/invalid):
`DATABASE_URL` (built by Compose), `SESSION_SECRET` (≥ 32 chars).

Compose-level: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`,
`M2A_SCHEMA`, `IMAGE_TAG`.

Application: `PORT`, `HOST`, `SESSION_TTL_SECONDS`, `SECURE_COOKIES`,
`TRUSTED_PROXY`, `ADMIN_BOOTSTRAP_TOKEN`, `S3_BUCKET`, `S3_ENDPOINT`,
`S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`,
`AMOCRM_CLIENT_ID`, `AMOCRM_CLIENT_SECRET`, `AMOCRM_REDIRECT_URI`,
`AMOCRM_ACCOUNT_DOMAIN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
`TELEGRAM_API_BASE`, `OUTBOUND_ENABLED`.

`OUTBOUND_ENABLED` must be `false` at release time; enabling it is a separate,
recorded decision.

## 6. Database

| Field | Value |
| --- | --- |
| Engine | PostgreSQL 18 |
| Database | `$POSTGRES_DB` (TODO: name chosen at rollout) |
| Domain schema | `messengers2amo` |
| Migrations | shared `001-core`, `002-hardening`, `003-receipts`, `004-proof-guards` (versions 1–4) + application `005-auth`, `006-amocrm`, `007-attention-assignment`, `008-operator-read`, `009-amocrm-workflow`, `010-workshops`, `011-migration-inventory`, `012-migration-pilot`, `013-metrics-indexes` (versions 5–13) |
| Ledger | `"messengers2amo"."schema_migrations"` (version, name, sha256 checksum) |
| Applied versions at release | TODO: paste `applied` from `migrate` output (expected `[1..13]` on a fresh database) |
| Pre-release backup | TODO: path + sha256 + size |

Procedure: `MIGRATION.md`. Backup/restore: `BACKUP-RESTORE.md`.

## 7. Verification evidence (fill during rollout)

| Check | Command | Result |
| --- | --- | --- |
| Compose renders | `docker compose -p messengers2amo config -q` | TODO |
| Containers healthy | `docker compose -p messengers2amo ps` | TODO |
| Loopback only | `ss -lntp \| grep 18767` shows `127.0.0.1:18767` | TODO |
| Liveness | `curl -fsS http://127.0.0.1:18767/health/live` | TODO |
| Readiness | `curl -fsS http://127.0.0.1:18767/health/ready` | TODO |
| Certificate SAN | `openssl x509 -noout -ext subjectAltName` | TODO |
| HTTPS chain | `curl -fsSI https://messengers.example.com/health/live` | TODO |
| HTTP redirect | `curl -sSI http://messengers.example.com/health/live` → 301 | TODO |
| No cross-site regression | neighbouring hosts still 200 | TODO |
| nginx config test | `nginx -t` before reload | TODO |
| Backup + restore rehearsal | `BACKUP-RESTORE.md` §5 | TODO |
| Liveness, public (2026-10-22) | `curl -s https://messengers.example.com/health/live` | `200 {"status":"ok"}` |
| Readiness, public (2026-10-22) | `curl -s https://messengers.example.com/health/ready` | `200 {"status":"ready"}` |

The two public checks were run from an operator workstation on 2026-10-22, not
on the host. They prove the public surface, TLS termination and the database
path are working. The loopback, digest, certificate-SAN and backup rows are
still `TODO` and must be read off the host; a backup/restore or rollback
rehearsal is **not** evidenced by them.

## 8. Rollback

See `ROLLBACK.md`. Rollback does not delete volumes:
`docker compose -p messengers2amo down` (never `-v`).

## 9. Known gaps (reviewed 2026-10-22)

1. Open: `apps/api/package.json` declares `"migrate": "node src/migrate-cli.ts"`,
   but `apps/api/src/migrate-cli.ts` does not exist. Production migrations
   therefore use `ops/deploy/messengers2amo/migrate-entrypoint.mjs` (which wraps
   `packages/database/src/migrate.mjs`). The npm script remains broken and must
   be fixed or removed separately.
2. Open: `packages/database/src/domain-migrations.mjs` still lists only versions
   1–4. Production uses `apps/api/src/platform/migrate.ts` (1–13) through
   `migrate-entrypoint.mjs`; do not point a deployment at the stale module.
3. Resolved: `npx tsc --noEmit` exits 0, and the API suite is 306/306 green
   against a real PostgreSQL 18 (2026-10-22).
4. Resolved: the outbox worker exists (`apps/api/src/worker.ts`) and is defined
   as the `worker` service in `docker-compose.yml`.
5. Resolved: provider webhook routes are registered —
   `POST /webhooks/telegram/{connectionId}` and `POST /webhooks/amocrm/{scopeId}`.
6. Not recorded: `IMAGE_TAG`/commit digests, the `.env` name, applied migration
   versions and the pre-release backup are still `TODO`; they must be read off
   the host, not invented.
