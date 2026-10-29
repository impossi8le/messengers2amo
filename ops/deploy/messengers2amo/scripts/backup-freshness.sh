#!/usr/bin/env bash
# messengers2amo — RPO guard: is the newest dump recent enough?
#
# Exit 0 when the newest dump is within the threshold, exit 1 when it is older
# (or when there is no dump at all). Designed to be the single check wired into
# monitoring: a non-zero exit is the alert.
#
# Variables:
#   BACKUP_DIR      directory to inspect, default /opt/messengers2amo/backups
#   PG_DB           dump name prefix, default messengers2amo
#   MAX_AGE_MINUTES freshness threshold, default 65 (RPO 1 h + 5 min slack)
#
# Exit codes:
#   0  fresh: newest dump is within MAX_AGE_MINUTES
#   1  stale or missing: newest dump is older than the threshold, or none found
#   2  usage/config error
#
# Usage:
#   backup-freshness.sh                 # check the default directory
#   BACKUP_DIR=/tmp/fx MAX_AGE_MINUTES=5 backup-freshness.sh
#   backup-freshness.sh --quiet         # only print on failure (for cron/monitor)
#
# A dump whose .sha256 sidecar is missing is still counted as fresh, but the
# script says so: the artefact exists, its integrity cannot be re-verified.
set -uo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/messengers2amo/backups}"
PG_DB="${PG_DB:-messengers2amo}"
MAX_AGE_MINUTES="${MAX_AGE_MINUTES:-65}"
quiet=0

for arg in "$@"; do
  case "$arg" in
    --quiet|-q) quiet=1;;
    --help|-h)
      sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0;;
    *) echo "unknown argument: $arg" >&2; exit 2;;
  esac
done

[[ "$MAX_AGE_MINUTES" =~ ^[0-9]+$ ]] && ((MAX_AGE_MINUTES >= 1)) ||
  { echo "invalid MAX_AGE_MINUTES: $MAX_AGE_MINUTES" >&2; exit 2; }
[[ "$PG_DB" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "invalid PG_DB: $PG_DB" >&2; exit 2; }

say() { ((quiet)) || echo "$@"; }
fail() { echo "STALE $*" >&2; exit 1; }

if [[ ! -d "$BACKUP_DIR" ]]; then
  fail "backup directory does not exist: $BACKUP_DIR"
fi

# Newest dump of either tier, by mtime. Hourly and daily share the prefix.
newest=""
newest_mtime=0
while IFS=$'\t' read -r mtime path; do
  [[ -n "$path" ]] || continue
  mtime=${mtime%%.*}          # %T@ is fractional; keep integer seconds
  [[ "$mtime" =~ ^[0-9]+$ ]] || continue
  if (( mtime > newest_mtime )); then newest_mtime=$mtime; newest=$path; fi
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name "${PG_DB}_*.dump" -printf '%T@\t%p\n' 2>/dev/null)

if [[ -z "$newest" ]]; then
  fail "no dumps matching ${PG_DB}_*.dump in $BACKUP_DIR — RPO is not being met"
fi

now=$(date +%s)
age_seconds=$(( now - newest_mtime ))
(( age_seconds < 0 )) && age_seconds=0
age_minutes=$(( age_seconds / 60 ))
age_human=$(printf '%dh%02dm' $(( age_seconds / 3600 )) $(( (age_seconds % 3600) / 60 )))

sidecar_note=""
[[ -f "$newest.sha256" ]] || sidecar_note=" (warning: no .sha256 sidecar)"

if (( age_seconds > MAX_AGE_MINUTES * 60 )); then
  fail "newest dump $(basename -- "$newest") is ${age_human} old, threshold is ${MAX_AGE_MINUTES}m — RPO breached${sidecar_note}"
fi

say "FRESH newest=$(basename -- "$newest") age=${age_human} threshold=${MAX_AGE_MINUTES}m dir=${BACKUP_DIR}${sidecar_note}"
exit 0
