# Migrations — messengers2amo

## 1. Model

Migrations are **forward-only, one-shot, and separate from application start.**

- Runner: `packages/database/src/migrate.mjs` (`runMigrations`) — advisory lock,
  checksum history, one transaction per migration.
- Migration set: `apps/api/src/platform/migrate.ts` (`loadDomainMigrations`),
  the same list the API and its tests use:
  - versions 1–4 — `packages/database/migrations/001-core.sql`,
    `002-hardening.sql`, `003-receipts.sql`, `004-proof-guards.sql` (shared domain);
  - versions 5–7 — `apps/api/migrations/005-auth.sql`, `006-amocrm.sql`,
    `007-attention-assignment.sql` (application-owned).
- Container entrypoint: `ops/deploy/messengers2amo/migrate-entrypoint.mjs`. It
  imports `loadDomainMigrations` rather than keeping its own list, so the ledger
  checksums cannot drift from what the application expects.
- `packages/database/src/domain-migrations.mjs` still lists only 1–4 and is
  **not** used by production; do not point a deployment at it.
- The API (`apps/api/src/index.ts`) never applies DDL. `src/platform/migrate.ts`
  contains an equivalent in-process migrator used by tests; production uses the
  advisory-lock runner above.

Guarantees of the runner:

| Property | Implementation |
| --- | --- |
| Single writer | `pg_try_advisory_lock(704422809371)`; a second runner fails fast with `MIGRATION_LOCK_BUSY` instead of waiting |
| Atomicity | one transaction per migration: SQL + ledger row commit together |
| Idempotency | ledger comparison by `version`, `name` and sha256 `checksum`; applied migrations are skipped |
| Tamper detection | if an already-applied migration's SQL changed, the run aborts with `MIGRATION_HISTORY_MISMATCH` |
| Ordered | versions must be strictly increasing; duplicates are rejected |
| Schema safety | schema name must match `^[a-z_][a-z0-9_]{0,62}$` |

Ledger: `"messengers2amo"."schema_migrations" (version, name, checksum, applied_at)`.

## 2. When migrations run

`docker-compose.yml` defines the `migrate` service with `restart: "no"` and
`depends_on: postgres (service_healthy)`. `api` declares
`depends_on: migrate (service_completed_successfully)`, so:

```
docker compose -p messengers2amo up -d
```

1. `postgres` starts and becomes healthy.
2. `migrate` runs, applies missing migrations, exits 0 or non-zero.
3. `api` starts **only** if step 2 exited 0.

Because the runner is idempotent, `up -d` is safe to repeat: already-applied
migrations are skipped and the ledger is unchanged.

### Manual run

```bash
cd /opt/messengers2amo
docker compose -p messengers2amo run --rm migrate
echo "exit=$?"
```

Success output is a single JSON line:

```json
{"event":"database.migrations","outcome":"succeeded","schema":"messengers2amo","applied":[1,2,3,4,5,6,7],"expected":[1,2,3,4,5,6,7]}
```

`applied: []` means the schema was already current. `expected` is the full list
from `loadDomainMigrations`; if `applied` is a subset, the earlier versions were
already in the ledger.

### Inspect the current version

```bash
docker compose -p messengers2amo exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -c \
  'SELECT version, name, left(checksum, 12) AS checksum, applied_at
     FROM "messengers2amo"."schema_migrations" ORDER BY version;'
```

## 3. Deployment ordering (mandatory)

1. **Backup first.** `BACKUP-RESTORE.md` §3. Never migrate without a fresh dump.
2. Stop external effects: `OUTBOUND_ENABLED=false` in `.env`, then
   `docker compose -p messengers2amo up -d api` to apply it (only `api` is
   recreated; PostgreSQL keeps running).
3. Drain: wait until no send operation is in flight (`MONITORING.md` §3).
4. Run `migrate`.
5. Start/recreate `api`, run smoke checks (`DEPLOY-RUNBOOK.md` §8).
6. Re-enable outbound only after verification.

### Locking warning

`002-hardening.sql` takes `ACCESS EXCLUSIVE` locks on
`send_operations`, `reply_snapshot_items`, `reply_snapshots` and is explicitly
**not an online migration**. With the API stopped (step 2–3) this is instant.
Never run it against a live, writing database.

## 4. Incompatible or failed migration

The runner reports only safe codes. Map them to actions:

| Code | Meaning | Action |
| --- | --- | --- |
| `MIGRATION_LOCK_BUSY` | another runner holds the lock | Find it: `SELECT pid, application_name, query FROM pg_stat_activity WHERE query LIKE '%pg_try_advisory_lock%';` Wait for it, or stop the stale container. Do **not** kill a running migration mid-transaction. |
| `MIGRATION_HISTORY_MISMATCH` | an applied migration's SQL/name/checksum changed, or the ledger has extra rows | **Do not edit SQL to "make it pass".** Compare the ledger with `packages/database/migrations/` at the deployed commit. Either restore the original file, or add a new migration with a higher version that corrects the schema. |
| `MIGRATION_FAILED` | SQL error inside a migration transaction | The transaction was rolled back; the ledger is unchanged. Read the PostgreSQL log, fix forward in a **new** migration file, redeploy. |
| `MIGRATION_ROLLBACK_FAILED` | rollback itself failed | Treat the schema as unknown: stop `api`, restore the pre-deploy dump (§3), then re-run. |
| `MIGRATION_COMMIT_UNKNOWN` | connection lost during COMMIT | The migration may or may not be applied. Re-run `migrate` once: if the ledger now contains the version, the commit succeeded. If it does not, the transaction rolled back. Never assume. |
| `MIGRATION_CONNECTION_FAILED` | cannot connect | Check `postgres` health, `DATABASE_URL`, and that `POSTGRES_PASSWORD` is URL-safe (see `.env.example`). |
| `SCHEMA_INVALID` / `DATABASE_URL_MISSING` | bad configuration | Fix `.env`; no database change happened. |

### When the new release is not compatible with the old schema

The schema is forward-only; there is no down-migration. If a release requires a
schema change that the previous application version cannot tolerate:

1. Do not start the new `api` (it is blocked anyway: `migrate` gates it).
2. Roll back to the previous image tag (`ROLLBACK.md` §4) **without** restoring
   the dump — additive migrations are usually tolerated by the old code.
3. If the old code is genuinely incompatible (dropped/renamed column), restore
   the pre-deploy dump into the **production** database as the last resort, with
   the API stopped, and record it in the release log. This loses all data
   written after the dump; that is why §3 requires the dump immediately before
   migrating.

## 5. Adding a migration

1. New file with the next integer version:
   - shared domain change → `packages/database/migrations/00N-name.sql`;
   - application change → `apps/api/migrations/00N-name.sql`.
2. Register it in `apps/api/src/platform/migrate.ts` (`MIGRATIONS`). That is the
   only list production reads. Keep `packages/database/src/domain-migrations.mjs`
   in step if you also want the shared package's own tooling to see it, but
   production does not use that file.
3. Never modify an already-released migration file; checksums are enforced and a
   changed file aborts the next start with `MIGRATION_HISTORY_MISMATCH`.
4. Rehearse on a restored copy first (`BACKUP-RESTORE.md` §5).
5. CI: the `integration` job in `.github/workflows/api.yml` runs the full suite
   (including the migration test) against a real PostgreSQL 18.
6. The Dockerfile must include any new SQL directory: `apps/api/migrations` and
   `packages/database/migrations` are copied explicitly.
