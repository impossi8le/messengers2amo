#!/usr/bin/env bash
# messengers2amo — PostgreSQL backup with two-tier retention.
#
# Run from cron on the host. Hourly runs take an hourly dump; the daily run
# (BACKUP_LEVEL=daily) also takes a dump that is exempt from hourly pruning.
# See messengers2amo-backup.cron for a ready-to-install crontab.
#
# Destination defaults to a local directory. Point BACKUP_DIR at a mounted
# external volume (or sync it elsewhere) to satisfy "backup outside the VPS" —
# a local-only copy does not survive loss of the server.
#
# Variables (all optional, existing names keep their meaning):
#   PROJECT                  compose project, default messengers2amo
#   PG_SERVICE               compose service, default postgres
#   PG_USER                  database role, default messengers2amo
#   PG_DB                    database name, default messengers2amo
#   BACKUP_DIR               destination directory, default /opt/messengers2amo/backups
#   BACKUP_TRANSPORT         local | docker, default docker
#   PG_CONTAINER             container override, default $PROJECT-$PG_SERVICE-1
#   PG_SNAPSHOT              exported snapshot id (used by the rehearsal script)
#   BACKUP_LEVEL             hourly | daily, default hourly
#   HOURLY_RETENTION_COUNT   hourly dumps to keep, default 72 (3 days at 1/h)
#   DAILY_RETENTION_COUNT    daily dumps to keep, default 14
#   RETENTION_DAYS           hard age ceiling in days for any dump, default 14
#                            (legacy knob; also the fallback for the daily count)
#
# Naming:
#   ${PG_DB}_${YYYYMMDDTHHMMSSZ}.dump          hourly
#   ${PG_DB}_daily_${YYYYMMDDTHHMMSSZ}.dump    daily
#
# RPO: hourly tier at 1 dump/hour gives an RPO of 1 hour. The daily tier is the
# fallback when the hourly job is broken; it does not improve the RPO.
set -euo pipefail

PROJECT="${PROJECT:-messengers2amo}"
BACKUP_DIR="${BACKUP_DIR:-/opt/messengers2amo/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
PG_SERVICE="${PG_SERVICE:-postgres}"
PG_USER="${PG_USER:-messengers2amo}"
PG_DB="${PG_DB:-messengers2amo}"
BACKUP_TRANSPORT="${BACKUP_TRANSPORT:-docker}"
BACKUP_LEVEL="${BACKUP_LEVEL:-hourly}"
HOURLY_RETENTION_COUNT="${HOURLY_RETENTION_COUNT:-72}"
DAILY_RETENTION_COUNT="${DAILY_RETENTION_COUNT:-$RETENTION_DAYS}"

case "$BACKUP_TRANSPORT" in local|docker) ;; *) echo 'invalid BACKUP_TRANSPORT' >&2; exit 1;; esac
case "$BACKUP_LEVEL" in hourly|daily) ;; *) echo 'invalid BACKUP_LEVEL (hourly|daily)' >&2; exit 1;; esac
for n in "$RETENTION_DAYS" "$HOURLY_RETENTION_COUNT" "$DAILY_RETENTION_COUNT"; do
  [[ "$n" =~ ^[0-9]+$ ]] && ((n >= 1)) || { echo "invalid retention value: $n" >&2; exit 1; }
done
[[ "$PG_DB" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo 'invalid PG_DB' >&2; exit 1; }
pg_command() {
  if [[ "$BACKUP_TRANSPORT" == local ]]; then "$@";
  else docker exec -i "${PG_CONTAINER:-$PROJECT-$PG_SERVICE-1}" "$@"; fi
}
snapshot_args=()
[[ -z "${PG_SNAPSHOT:-}" ]] || snapshot_args=(--snapshot="$PG_SNAPSHOT")

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ "$BACKUP_LEVEL" == daily ]]; then
  target="${BACKUP_DIR}/${PG_DB}_daily_${stamp}.dump"
else
  target="${BACKUP_DIR}/${PG_DB}_${stamp}.dump"
fi

mkdir -p "$BACKUP_DIR"
# An external volume may belong to another account; a failed chmod must not
# abort an otherwise healthy backup.
chmod 700 "$BACKUP_DIR" 2>/dev/null || echo "warning: cannot chmod 700 $BACKUP_DIR" >&2

tmp="${target}.tmp"
trap 'rm -f "$tmp"' EXIT

# Custom format so pg_restore can be selective and parallel. The dump is written
# under a temporary name and renamed only after verification: a truncated or
# unreadable dump must never become the newest *.dump, because that is the file
# the freshness guard inspects.
pg_command pg_dump -U "$PG_USER" -d "$PG_DB" -Fc "${snapshot_args[@]}" > "$tmp"

size="$(stat -c %s "$tmp")"
if [ "$size" -lt 4096 ]; then
  echo "backup too small ($size bytes), refusing to keep: $target" >&2
  exit 1
fi

if ! pg_command pg_restore --list < "$tmp" > /dev/null 2>&1; then
  echo "backup failed verification: $target" >&2
  exit 1
fi

mv "$tmp" "$target"
trap - EXIT
chmod 600 "$target"
sha256sum "$target" | awk '{print $1}' > "$target.sha256"

# --- retention -------------------------------------------------------------
# Prune only after the new dump verified, so a failed run never shrinks the set.
# Tier selection is by filename, then newest-first by mtime. Counts are exact
# (not mtime windows), so the schedule can drift without losing a whole tier.
prune_tier() {
  local label=$1 pattern=$2 keep=$3
  local -a files=()
  mapfile -t files < <(
    find "$BACKUP_DIR" -maxdepth 1 -type f -name "$pattern" -printf '%T@\t%p\n' 2>/dev/null |
      sort -rn | cut -f2-
  )
  local i
  for ((i = keep; i < ${#files[@]}; i++)); do
    rm -f -- "${files[i]}" "${files[i]}.sha256"
    echo "pruned ${label} $(basename -- "${files[i]}")"
  done
}

prune_tier daily "${PG_DB}_daily_*.dump" "$DAILY_RETENTION_COUNT"
prune_tier hourly "${PG_DB}_[0-9]*.dump" "$HOURLY_RETENTION_COUNT"

# Age ceiling applies to both tiers: nothing survives RETENTION_DAYS, including
# copies left over from an older naming scheme.
find "$BACKUP_DIR" -maxdepth 1 -name "${PG_DB}_*.dump" -type f -mtime "+${RETENTION_DAYS}" -delete
find "$BACKUP_DIR" -maxdepth 1 -name "${PG_DB}_*.dump.sha256" -type f -mtime "+${RETENTION_DAYS}" -delete

echo "$(date -u +%FT%TZ) backup ok level=${BACKUP_LEVEL} file=$(basename "$target") size=${size} hourly_keep=${HOURLY_RETENTION_COUNT} daily_keep=${DAILY_RETENTION_COUNT} max_age=${RETENTION_DAYS}d"
