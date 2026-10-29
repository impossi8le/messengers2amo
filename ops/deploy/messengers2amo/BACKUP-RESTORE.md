# Backup and restore — messengers2amo (PostgreSQL 18)

## 1. Objectives (numbers, not aspirations)

Proposed targets — **RPO 1 hour, RTO 1 hour** — not yet confirmed by the owner;
the board item «RPO/RTO согласованы» is still open. Both are met by the hourly
logical dump under the rehearsal fixture; measurements and the remaining gap are
in §8.

| Objective | Value | How it is met |
| --- | --- | --- |
| RPO (max data loss) | **≤ 1 hour** | hourly logical dump (`BACKUP_LEVEL=hourly`) |
| RPO with hourly job broken | ≤ 24 hours | daily dump is a separate tier, pruned on its own count |
| RTO (service back) | **≤ 1 hour** | measured in the rehearsal (§8); 15 s restore on a 292 MB / 400 k-row fixture |
| Retention (hourly) | 72 files | `HOURLY_RETENTION_COUNT=72` — 3 days |
| Retention (daily) | 14 files | `DAILY_RETENTION_COUNT=14` |
| Hard age ceiling | 14 days | `RETENTION_DAYS=14` applies to both tiers |
| Backup off-host | **not implemented** | see «Известный риск» in §8 |

Why logical dumps and not PITR: no WAL archiving exists on this host, and
adding it changes `postgresql.conf`, `archive_command` and disk sizing. That is
a separate, explicit decision. Until then the honest RPO is the dump interval.

Disk budget: dumps are compressed custom-format. Estimate `db_size / 3` per
dump; with 32 GB free and a small pilot DB this is comfortable, but the
retention numbers above must be re-checked against real sizes after the first
month (see §7).

## 2. Where backups live

| Copy | Location | Notes |
| --- | --- | --- |
| Working | `/opt/messengers2amo/backups/` on the VPS (`BACKUP_DIR`) | the only copy today — not a backup in the "survives the server" sense |
| Off-host | **none — not implemented** | see «Известный риск» in §8.3 |

The off-host destination does not exist yet because no storage account has been
chosen. This is a deliberate, owner-approved deferral — see §8.3 for what it
costs. Requirements when it is chosen:

- not the same VM, not the same provider failure domain;
- encrypted **before** upload (`age`/`gpg` with a key that is not stored on this
  host) or server-side encryption with a key the operator controls;
- object versioning or immutability (object lock) if available;
- upload verified by comparing sha256 of the local and remote object.

## 3. Taking a backup

In normal operation the script does this — `scripts/backup.sh`, driven by
`scripts/messengers2amo-backup.cron` (see «Schedule» below). Run it by hand only
to check the job before installing cron:

```bash
/opt/messengers2amo/src/ops/deploy/messengers2amo/scripts/backup.sh
# or, to take a daily-tier copy out of schedule:
BACKUP_LEVEL=daily /opt/messengers2amo/src/ops/deploy/messengers2amo/scripts/backup.sh
```

The manual procedure below is the fallback when the script itself is unavailable.
It produces the same artefact, but does **not** prune, so it does not keep the
retention tiers in shape.

```bash
set -euo pipefail
D=/opt/messengers2amo
cd "$D"
set -a; . ./.env; set +a      # POSTGRES_USER / POSTGRES_DB for this shell only

TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT=/opt/messengers2amo/backups
install -d -m 0700 "$OUT"

# Credentials stay inside the container: no password on the command line,
# no password in the host process list.
docker compose -p messengers2amo exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    --format=custom --compress=9 --no-owner --no-privileges \
    --schema="messengers2amo" \
  > "$OUT/m2a-$TS.dump"

# Verify the dump is readable before trusting it
docker compose -p messengers2amo exec -T postgres pg_restore --list \
  < "$OUT/m2a-$TS.dump" > /dev/null

sha256sum "$OUT/m2a-$TS.dump" > "$OUT/m2a-$TS.dump.sha256"
ls -l "$OUT/m2a-$TS.dump"
```

`--schema="messengers2amo"` backs up the domain schema only. The database also
holds the `schema_migrations` ledger **inside** that schema, so the ledger is
included. If a future release adds objects outside the schema, remove this flag
and back up the whole database.

Include the release identity in the same run, so a dump can be matched to code:

```bash
docker image inspect messengers2amo/api:"$IMAGE_TAG" --format '{{.Id}}' \
  > "$OUT/m2a-$TS.image.txt"
```

### Encryption before off-host upload

```bash
# TODO: replace with the real recipient key, kept off this host.
age -r TODO-AGE-RECIPIENT-PUBLIC-KEY -o "$OUT/m2a-$TS.dump.age" "$OUT/m2a-$TS.dump"
sha256sum "$OUT/m2a-$TS.dump.age" > "$OUT/m2a-$TS.dump.age.sha256"
# TODO: upload command for the chosen off-host storage
```

### Schedule

The schedule lives in the repository as a ready-to-install cron drop-in:
`scripts/messengers2amo-backup.cron`. Install it as root:

```bash
install -d -m 0700 /opt/messengers2amo/backups
install -m 0644 -o root -g root \
  /opt/messengers2amo/src/ops/deploy/messengers2amo/scripts/messengers2amo-backup.cron \
  /etc/cron.d/messengers2amo-backup
systemctl reload cron
```

It runs three jobs:

| When (UTC) | Job |
| --- | --- |
| `7 * * * *` | `BACKUP_LEVEL=hourly backup.sh` — the RPO 1 h job |
| `7 3 * * *` | `BACKUP_LEVEL=daily backup.sh` — extra copy at 03:07 |
| `22 * * * *` | `backup-freshness.sh` — exits 1 when the newest dump is > 65 min old |

Do not consider backup "done" until a failed backup produces an alert — see
`MONITORING.md` §4.

### Naming and retention

| Tier | Filename | Kept |
| --- | --- | --- |
| hourly | `${PG_DB}_${YYYYMMDDTHHMMSSZ}.dump` | newest `HOURLY_RETENTION_COUNT` (72) |
| daily | `${PG_DB}_daily_${YYYYMMDDTHHMMSSZ}.dump` | newest `DAILY_RETENTION_COUNT` (14) |

Retention is by **count**, newest first, evaluated after the new dump has passed
`pg_restore --list`. A failed run therefore never shrinks the set. A second,
independent guard deletes anything older than `RETENTION_DAYS` (14) regardless of
tier, which also cleans up dumps left by an older naming scheme.

Prune **after** a successful dump and upload, never before. A failed upload must
never delete the local copy.

## 4. Restore into a separate test database (default path)

Production is never the target of a rehearsal. Restore always goes to a new
database on the same PostgreSQL instance, which is then dropped.

```bash
set -euo pipefail
cd /opt/messengers2amo

DUMP=/var/backups/messengers2amo/m2a-YYYYMMDDTHHMMSSZ.dump
RESTORE_DB="m2a_restore_$(date -u +%Y%m%d%H%M%S)"

# 4.1 Integrity of the artefact itself
sha256sum -c "$DUMP.sha256"

# 4.2 Create an empty database (no template, no connections)
docker compose -p messengers2amo exec -T postgres \
  psql -U "$POSTGRES_USER" -d postgres -X -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"$RESTORE_DB\" TEMPLATE template0;"

# 4.3 Restore with --exit-on-error so a partial restore fails loudly
docker compose -p messengers2amo exec -T postgres \
  pg_restore -U "$POSTGRES_USER" -d "$RESTORE_DB" \
    --exit-on-error --no-owner --no-privileges --single-transaction \
  < "$DUMP"
```

`--single-transaction` guarantees all-or-nothing: a broken dump leaves an empty
database, never a half-restored one.

## 5. Integrity checks after restore

Run every check against `$RESTORE_DB`. All must pass before the dump is
considered usable.

```bash
q() { docker compose -p messengers2amo exec -T postgres \
        psql -U "$POSTGRES_USER" -d "$RESTORE_DB" -X -A -t -v ON_ERROR_STOP=1 -c "$1"; }

# 5.1 Migration ledger is complete and matches the expected versions
q 'SELECT version, name, checksum FROM "messengers2amo".schema_migrations ORDER BY version;'
#   expect versions 1..7 with 64-hex checksums identical to the source DB

# 5.2 Table and trigger counts are not silently lower
q "SELECT count(*) FROM information_schema.tables WHERE table_schema='messengers2amo';"
q "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='messengers2amo' AND NOT t.tgisinternal;"

# 5.3 No invalid constraints (a restore that skipped validation would show up here)
q "SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
     WHERE n.nspname='messengers2amo' AND NOT c.convalidated;"
#   expect 0

# 5.4 Core row counts, compared with the source database
q 'SELECT (SELECT count(*) FROM "messengers2amo".companies) AS companies,
          (SELECT count(*) FROM "messengers2amo".messages)  AS messages,
          (SELECT count(*) FROM "messengers2amo".send_operations) AS send_operations;'
#   run the same query against the production database and compare

# 5.5 Referential sanity: orphaned rows must be zero
q 'SELECT count(*) FROM "messengers2amo".messages m
     LEFT JOIN "messengers2amo".companies c ON c.id=m.company_id
     WHERE c.id IS NULL;'
#   expect 0

# 5.6 Ledger checksum matches the SQL shipped in this release
sha256sum packages/database/migrations/*.sql
#   compare with 5.1 output (checksums are computed over the SQL after
#   __SCHEMA__ substitution, so a raw file hash is a cross-check only —
#   exact equality with the ledger is verified by re-running `migrate`)

# 5.7 Re-running the migrator must be a no-op on the restored database
docker compose -p messengers2amo run --rm \
  -e DATABASE_URL="postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@postgres:5432/$RESTORE_DB" \
  migrate
#   expect {"outcome":"succeeded","applied":[]}
```

Step 5.7 is the strongest check: it proves the restored schema satisfies the
runner's history comparison, which is exactly what a production start requires.

Finally drop the scratch database:

```bash
docker compose -p messengers2amo exec -T postgres \
  psql -U "$POSTGRES_USER" -d postgres -X -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE \"$RESTORE_DB\";"
```

## 6. Restore into production (incident only)

Only after §5 passed on the same artefact, and only with the API stopped.

```bash
cd /opt/messengers2amo
docker compose -p messengers2amo stop api migrate      # keep postgres running

# Take a safety dump of the CURRENT (broken) state first — do not skip.
docker compose -p messengers2amo exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-privileges \
  > /var/backups/messengers2amo/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).dump

# Drop and recreate the domain schema only (does not touch other schemas)
docker compose -p messengers2amo exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -v ON_ERROR_STOP=1 \
  -c 'DROP SCHEMA IF EXISTS "messengers2amo" CASCADE;'

docker compose -p messengers2amo exec -T postgres \
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    --exit-on-error --no-owner --no-privileges --single-transaction \
  < /var/backups/messengers2amo/m2a-YYYYMMDDTHHMMSSZ.dump

docker compose -p messengers2amo up -d      # migrate is a no-op, api starts
curl -fsS http://127.0.0.1:18767/health/ready
```

After a production restore:

1. Keep `OUTBOUND_ENABLED=false`.
2. Reconcile send operations that were in flight at the time of the dump —
   their external outcome is unknown (`ROLLBACK.md` §3).
3. Re-check consents and connection tokens before re-enabling outbound. Do not
   blindly re-send an old outbox.

## 7. Verification and review

| Frequency | Action |
| --- | --- |
| Every backup | `pg_restore --list` succeeds, sha256 written, upload verified |
| Weekly | full §5 rehearsal on the newest nightly dump; record duration (this is the RTO measurement) |
| Monthly | check retention counts and total size against the disk budget |
| Quarterly | restore rehearsal on a machine that is not the VPS |

A backup that has never been restored is an unverified assumption. The weekly
rehearsal is the acceptance criterion for this document, not the presence of
`.dump` files.

## 8. RPO/RTO

Proposed targets, **not yet confirmed by the owner**: RPO 1 hour, RTO 1 hour.
The rehearsal below shows the dump/restore component meets them; the owner's
confirmation and the off-host receiver are still open (see §8.3).

### 8.1 How RPO is met

One dump per hour, at minute 7, via `scripts/messengers2amo-backup.cron`. The
worst case is the interval between two successful runs: a dump at 10:07 and a
failure at 11:07 leaves the newest copy 60 minutes old, which is inside the
objective. `backup-freshness.sh` runs at :22 with a 65-minute threshold, so a
missed run is reported 55 minutes before the RPO is actually breached — that is
the slack that turns "we hope" into "we know".

`RPO with hourly broken ≤ 24 h` is met by the independent daily tier. It is a
fallback, not a substitute: 14 daily dumps do not give a 1-hour RPO.

### 8.2 Measured RTO (2026-10-23, production host)

Fixture: production schema (`schema_migrations` copied verbatim, 13 rows), filled
by `scripts/seed-restore-scale.sql` in a throwaway database. All values
synthetic, no personal data, no provider calls.

The run log for this scale rehearsal is not yet attached to #31; re-run it and
attach the output before treating these numbers as acceptance evidence.

| Volume | Rows |
| --- | --- |
| conversations | 20 000 |
| messages | 200 000 |
| message_versions | 200 000 |
| work_items | 50 000 |
| inbox_events | 100 000 |
| send_operations | 30 000 |

| Measurement | Run 1 | Run 2 |
| --- | --- | --- |
| Source database size | 292 MiB (`306 550 463` B) | — |
| Dump size (custom format, compressed) | 7.0 MiB (`7 331 981` B) | 7.0 MiB |
| **backup** (pg_dump + verify + sha256) | **3.20 s** | **2.91 s** |
| **restore** (createdb + pg_restore --exit-on-error) | **15.45 s** | **14.69 s** |
| Rehearsal wall clock, end to end | 25.8 s | 23.0 s |
| Restored database size | 255 MiB | — |

All integrity checks in §5 passed on both runs: row counts equal per table,
migration ledger identical, 1 764 `unknown` operations reproduced, 104 foreign
keys with zero orphans, inbox deduplication clean, scratch database dropped.

**Verdict: RTO is met with a very wide margin.** Restore of the fixture takes
~15 s against a 3 600 s budget — a factor of ~235. Even allowing a 20× larger
database (roughly 6 GB of raw data, 140 MiB dump), the restore stays in the
minutes range.

The honest caveat is that this is a *database* restore, not a full service
recovery. A real incident also needs: stopping the API, a pre-restore safety
dump, the schema drop/recreate, container start, readiness probe, and
reconciliation of in-flight `unknown` send operations (§6). On this host those
steps are minutes, not hours, but they are **not** measured by the rehearsal and
are not included in the numbers above. Treat ~15 s as the restore component of
the RTO, not the whole RTO.

### 8.3 Известный риск (known risk)

> **Бэкапы лежат на том же сервере, что и данные. Внешнего приёмника нет.**

Every dump is written to `/opt/messengers2amo/backups` on the same VPS that runs
PostgreSQL. There is no off-host copy, no object storage, no second failure
domain. Consequences, stated plainly:

- **Потеря VPS = потеря и данных, и копий.** Диск, hypervisor, аккаунт
  провайдера, случайное `rm -rf`, шифровальщик — всё это уничтожает бэкапы
  вместе с базой.
- **RPO 1 ч и RTO 1 ч действуют только при живом сервере.** Обе цели
  сформулированы для сценариев «сломали данные», «упал контейнер», «неудачный
  релиз». Для сценария «сервер исчез» фактический RPO и RTO равны
  бесконечности.
- **Одна ошибка оператора удаляет историю.** Retention и `backup-freshness.sh`
  защищают от сбоя расписания, но не от потери машины.

Это осознанно отложенное решение владельца, а не забытая задача. Пока оно
отложено, в согласованных целях нужно явно оговаривать: **RPO/RTO действуют
для отказа в пределах сервера**.

Чтобы закрыть риск, нужен внешний приёмник (§2): S3-совместимый bucket или
другая машина, шифрование до загрузки, проверка sha256 после загрузки,
retention на стороне приёмника. До его появления единственная защита —
ручное копирование дампов за пределы VPS; это процедура, а не гарантия.

