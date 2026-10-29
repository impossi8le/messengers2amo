# Update and rollback — messengers2amo

## 1. Principles

1. **A rollback that has not been rehearsed is a plan, not a capability.**
   Rehearse it (§3) before `OUTBOUND_ENABLED=true` is ever set.
2. **Volumes are never deleted.** `docker compose -p messengers2amo down`
   **without `-v`**. `down -v` destroys `messengers2amo_pgdata` and there is no
   undo.
3. **External effects are paused before the code changes**, not after. A message
   already accepted by Telegram/WhatsApp/MAX cannot be recalled.
4. **`unknown` is a real state, not an error to retry.** See §4.
5. The database is forward-only. Rolling back the image is normal; rolling back
   the schema means restoring a dump (§5).

## 2. What must be recorded before any update

Fill these into `RELEASE-MANIFEST.md` §3/§7 **before** touching the containers:

```bash
cd /opt/messengers2amo
set -a; . ./.env; set +a      # POSTGRES_USER / POSTGRES_DB for this shell only

# Current (running) image identity
docker compose -p messengers2amo images
docker image inspect "$(docker compose -p messengers2amo images -q api)" \
  --format '{{.Id}} {{index .RepoDigests 0}}'
docker image inspect postgres:18 --format '{{index .RepoDigests 0}}'

# Current release tag and git commit of the deployed tree
cat IMAGE_TAG.txt 2>/dev/null || echo "TODO: keep the deployed tag in a file"
git -C /opt/messengers2amo rev-parse HEAD 2>/dev/null || echo "deployed as archive"

# Schema version
docker compose -p messengers2amo exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -A -t -c \
  'SELECT max(version) FROM "messengers2amo"."schema_migrations";'

# Fresh backup — the rollback anchor for data
# (BACKUP-RESTORE.md §3, then verify it with §5 of that document)
```

Keep the previous image tag on the host (`docker tag ... messengers2amo/api:previous`).
Do not rely on being able to rebuild it: the build context may have moved on.

## 3. Rehearsal (do this once, before enabling outbound)

Purpose: prove that an update can be applied and reverted, and measure the
downtime. It is safe to run because outbound is disabled and no real message is
sent.

```
T0  Record §2 values. Take a backup.
T1  docker compose -p messengers2amo stop api migrate
T2  OUTBOUND_ENABLED=false in .env (must already be false)
T3  Build the candidate image:  docker compose -p messengers2amo build api
T4  docker compose -p messengers2amo up -d        # migrate runs, api starts
T5  Smoke: /health/live, /health/ready, HTTPS through nginx, §5 checks
T6  ROLLBACK: docker compose -p messengers2amo down     # NO -v
T7  IMAGE_TAG=<previous tag> in .env
T8  docker compose -p messengers2amo up -d
T9  Smoke again; compare schema version and row counts with T0
```

Record T0→T5 and T6→T9 durations; the second number is the rollback RTO. It must
be ≤ 4 hours (`BACKUP-RESTORE.md` §1), and in practice should be minutes because
no data is restored.

Acceptance of the rehearsal:

- no volume was removed (`docker volume ls | grep messengers2amo_pgdata` still
  present after T6);
- the previous tag starts and `/health/ready` returns 200;
- the schema version after rollback is either the same or newer (forward-only);
- no message was sent to any provider (check provider side, not just logs).

## 4. Pausing and draining external effects

### 4.1 Pause

```bash
cd /opt/messengers2amo
# Stop the ability to send, keep the process serving read traffic.
sed -i 's/^OUTBOUND_ENABLED=.*/OUTBOUND_ENABLED=false/' .env
docker compose -p messengers2amo up -d api      # recreate api only
```

`OUTBOUND_ENABLED` is read at startup (`apps/api/src/platform/config.ts`), so a
restart is required for the change to take effect. TODO(DEP05): there is no
runtime pause endpoint; add one so draining does not require a restart.

### 4.2 Drain

Wait until nothing is mid-flight. Do not guess — query:

```sql
-- in-flight sends
SELECT count(*) FROM "messengers2amo".send_operations
WHERE state IN ('accepted','queued','dispatching');

-- leased outbox jobs (a worker still holds them)
SELECT count(*) FROM "messengers2amo".outbox_jobs
WHERE state='leased' AND lease_until > now();

-- processing inbox events
SELECT count(*) FROM "messengers2amo".inbox_events WHERE state='processing';
```

Proceed when all three return 0, or when the only remaining rows are past their
`deadline` / `lease_until` (those are handled in §4.3).

## 5. Handling pending / in-flight / unknown

Before stopping, classify every non-terminal row:

| State | Meaning | On rollback |
| --- | --- | --- |
| `accepted`, `queued` | Not yet handed to a provider | Safe to leave; the previous version will pick them up. If the previous version does not understand them, mark `cancelled` explicitly and tell the operator. |
| `dispatching` | Request may be in flight | Wait for the deadline. If the process dies here, the row stays `dispatching`; the next start must reconcile it to `sent` or `unknown`, never re-send blindly. |
| `unknown` | Provider outcome unknown | **Never retry automatically.** Reconcile against the provider (receipt, read-back, webhook) or ask the operator. `provider_receipt_evidence` may resolve it later. |
| `failed` | Provider rejected | Terminal; re-send only as a new operation with a new idempotency key. |
| `creation_unknown` (CRM) | amoCRM entity may exist | Reconcile by idempotency key / search before creating again. |
| `quarantined` (inbox) | Rejected payload | Leave for manual review; do not replay into effects. |

Queries:

```sql
SELECT company_id, id, state, created_at, deadline
FROM "messengers2amo".send_operations
WHERE state IN ('dispatching','unknown') ORDER BY created_at LIMIT 50;

SELECT company_id, id, state, created_at
FROM "messengers2amo".crm_create_intents
WHERE state='creation_unknown' ORDER BY created_at LIMIT 50;
```

Rule of thumb: a rollback must never increase the number of external effects. If
the old version cannot represent a state written by the new one, stop and choose
between (a) forward-fix, (b) restore the pre-update dump (§5), or (c) explicitly
cancel the affected rows with a recorded decision.

## 6. Rollback procedure

### 6.1 Application-only rollback (the normal case)

```bash
cd /opt/messengers2amo

# 1. Pause and drain (§4)
# 2. Take a backup even now — the data written since the update is real data
#    (BACKUP-RESTORE.md §3)
# 3. Stop the project WITHOUT deleting volumes
docker compose -p messengers2amo down            # NEVER `down -v`

# 4. Point at the previous image
sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=<previous tag>/' .env
grep '^IMAGE_TAG=' .env

# 5. Start again. `migrate` re-runs and must report applied: [] —
#    if it reports anything else, STOP and read MIGRATION.md §4.
docker compose -p messengers2amo up -d
docker compose -p messengers2amo logs migrate

# 6. Verify
curl -fsS http://127.0.0.1:18767/health/live
curl -fsS http://127.0.0.1:18767/health/ready
curl -fsS https://messengers.example.com/health/ready
docker volume ls | grep messengers2amo_pgdata      # must still exist
```

Post-rollback: keep `OUTBOUND_ENABLED=false` until the cause is understood and
the pending/unknown rows from §5 are resolved.

### 6.2 Database rollback (last resort)

Only when the previous application version cannot run against the new schema.
Procedure: `BACKUP-RESTORE.md` §6. This discards everything written after the
chosen dump, so it is a data-loss decision that must be recorded with a
timestamp and an approver.

## 7. Verification after rollback

```bash
docker compose -p messengers2amo ps
docker compose -p messengers2amo exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -A -t -c \
  'SELECT version, name FROM "messengers2amo"."schema_migrations" ORDER BY version;'
curl -fsS https://messengers.example.com/health/ready
curl -sSI https://messengers.example.com/health/live | head -1
nginx -t
```

Also confirm:

- no orphaned containers: `docker ps -a --filter name=messengers2amo`;
- no duplicate network: `docker network ls | grep messengers2amo_internal`;
- nginx still serves the neighbours (`DEPLOY-RUNBOOK.md` §8 cross-site check);
- the incident and the rollback are written into the release log with times.

## 8. Prohibited actions

| Do not | Why |
| --- | --- |
| `docker compose down -v` | Deletes `messengers2amo_pgdata`; unrecoverable |
| `docker volume rm messengers2amo_pgdata` | Same |
| `docker compose down --rmi all` | Removes the previous image you need to roll back to |
| Restoring a dump without taking a safety dump first | Destroys the evidence and the newer data |
| Re-running `unknown` sends "to see if it works" | Duplicate messages to real customers |
| `certbot renew --force-renewal` | Rate limits and unnecessary risk to other lineages |
| Editing an already-applied migration file | `MIGRATION_HISTORY_MISMATCH` on the next start |
| Deleting the nginx `sites-available` file during a rollback | Re-enable then needs a re-deploy; remove only the symlink |
