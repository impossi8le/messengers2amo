#!/usr/bin/env bash
# Only database clients run. No API, worker, migrations, provider calls or SSH.
set -euo pipefail
umask 077
usage() {
  echo 'Usage: restore-rehearsal.sh --source-db NAME --schema NAME --transport local|docker (--fresh | --dump PATH)'
  echo 'local: libpq PGHOST/PGPORT/PGUSER/PGPASSWORD or .pgpass; docker: PG_CONTAINER or PROJECT/PG_SERVICE, PG_USER.'
  echo 'Existing dumps must be trusted custom-format pg_dump archives; source must still match them.'
}
die() { echo "FAIL $*" >&2; exit 1; }
source_db= schema= transport= dump= mode=
while (($#)); do
  case "$1" in
    --source-db|--schema|--transport|--dump)
      (($# >= 2)) && [[ -n "$2" && "$2" != --* ]] || die "missing value for $1"
      case "$1" in
        --source-db) [[ -z "$source_db" ]] || die 'duplicate source'; source_db=$2;;
        --schema) [[ -z "$schema" ]] || die 'duplicate schema'; schema=$2;;
        --transport) [[ -z "$transport" ]] || die 'duplicate transport'; transport=$2;;
        --dump) [[ -z "$mode" ]] || die 'choose exactly one dump mode'; mode=dump; dump=$2;;
      esac; shift 2;;
    --fresh) [[ -z "$mode" ]] || die 'choose exactly one dump mode'; mode=fresh; shift;;
    --help) usage; exit 0;;
    *) usage >&2; die 'unknown argument';;
  esac
done
[[ "$source_db" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die 'explicit source database required (simple identifier)'
[[ "$schema" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die 'explicit schema required (simple identifier)'
[[ "$transport" == local || "$transport" == docker ]] || die 'explicit transport required'
[[ -n "$mode" ]] || die 'choose --fresh or --dump'
# Never accept a target override, connection URI or pg_restore --create/--clean.
unset PGDATABASE PGSERVICE PGOPTIONS
export PGCONNECT_TIMEOUT=10 PGAPPNAME=m2a-restore-rehearsal
PROJECT=${PROJECT:-messengers2amo}; PG_SERVICE=${PG_SERVICE:-postgres}
PG_USER=${PG_USER:-${PGUSER:-messengers2amo}}
pg_command() {
  if [[ "$transport" == local ]]; then "$@";
  else docker exec -i "${PG_CONTAINER:-$PROJECT-$PG_SERVICE-1}" "$@"; fi
}
query() { pg_command psql -X -qAt -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$1" "${@:2}"; }
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
scratch=$(mktemp -d)
target= created=0 snapshot_open=0 failures=0
backup_ms=not_measured restore_ms=not_started
cleanup() {
  rc=$?; trap - EXIT
  if ((snapshot_open)); then
    printf 'ROLLBACK;\n\\q\n' >&"$snapshot_in" || true
    exec {snapshot_in}>&-
    wait "$snapshot_pid" || rc=1
  fi
  if ((created)); then
    # This name was generated here and CREATE DATABASE succeeded in this process.
    if [[ "$target" != "$source_db" && "$target" =~ _restore_[a-f0-9]{16}$ ]] &&
       query postgres -c "DROP DATABASE \"$target\" WITH (FORCE);"; then
      echo "PASS cleanup database=$target"
    else echo "FAIL cleanup database=$target" >&2; rc=1; fi
  fi
  rm -f -- "$scratch"/*; rmdir -- "$scratch"
  echo "backup_ms=$backup_ms restore_ms=$restore_ms"
  if ((rc == 0)); then echo 'PASS overall'; else echo 'FAIL overall'; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
actual=$(query "$source_db" -c 'SELECT current_database();')
[[ "$actual" == "$source_db" ]] || die 'source identity mismatch'
random=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
target="${source_db:0:37}_restore_$random"
[[ "$target" != "$source_db" && ${#target} -le 63 ]] || die 'unsafe target'
echo "source=$source_db schema=$schema temporary_database=$target transport=$transport"
# Keep one read-only source snapshot alive for the dump and every source check.
coproc SNAPSHOT { query "$source_db"; }
snapshot_pid=$SNAPSHOT_PID
exec {snapshot_in}>&"${SNAPSHOT[1]}"
exec {snapshot_out}<&"${SNAPSHOT[0]}"
snapshot_open=1
printf 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n' >&"$snapshot_in"
IFS= read -r snapshot <&"$snapshot_out"
[[ "$snapshot" =~ ^[0-9A-Fa-f-]+$ ]] || die 'source snapshot unavailable'
echo 'PASS source read-only snapshot'
source_query() {
  query "$source_db" -c "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '$snapshot'; $1; COMMIT;"
}
now_ms() { date +%s%3N; }
if [[ "$mode" == fresh ]]; then
  start=$(now_ms)
  BACKUP_TRANSPORT="$transport" BACKUP_DIR="$scratch" PG_DB="$source_db" PG_USER="$PG_USER" \
    PG_SNAPSHOT="$snapshot" PROJECT="$PROJECT" PG_SERVICE="$PG_SERVICE" bash "$here/backup.sh"
  backup_ms=$(( $(now_ms) - start ))
  dumps=("$scratch"/*.dump)
  ((${#dumps[@]} == 1)) && [[ -f "${dumps[0]}" ]] || die 'expected exactly one fresh dump'
  dump=${dumps[0]}
else
  [[ -f "$dump" && -r "$dump" ]] || die 'dump must be a readable regular file'
fi
pg_command pg_restore --list < "$dump" > /dev/null
echo 'PASS archive readable'
digest=$(sha256sum "$dump" | awk '{print $1}')
if [[ -f "$dump.sha256" ]]; then
  expected=$(tr -d '\r\n' < "$dump.sha256")
  [[ "$digest" == "$expected" ]] || die 'archive SHA256 mismatch'
  echo 'PASS archive SHA256 sidecar'
else echo 'INFO archive SHA256 calculated; no sidecar supplied for comparison'; fi
echo "dump_bytes=$(wc -c < "$dump" | tr -d ' ') sha256=$digest"
source_query "SELECT pg_database_size(current_database())" > "$scratch/source-size"
echo "source_database_bytes=$(cat "$scratch/source-size")"
pg_command createdb -U "$PG_USER" --maintenance-db=postgres --template=template0 -- "$target"
created=1
echo 'PASS target distinct and created exclusively'
start=$(now_ms)
pg_command pg_restore --exit-on-error --no-owner --no-privileges -U "$PG_USER" -d "$target" < "$dump"
restore_ms=$(( $(now_ms) - start ))
echo 'PASS pg_restore'
echo "restored_database_bytes=$(query "$target" -c 'SELECT pg_database_size(current_database());')"
compare() {
  local label=$1 sql=$2
  source_query "$sql" > "$scratch/source"
  query "$target" -c "$sql" > "$scratch/restored"
  if cmp -s "$scratch/source" "$scratch/restored"; then echo "PASS $label";
  else echo "FAIL $label"; failures=$((failures+1)); fi
}
for table in inbox_events outbox_jobs send_operations work_items conversations messages audit_events; do
  compare "row_count $table" "SELECT count(*) FROM \"$schema\".$table"
  echo "rows $table source=$(cat "$scratch/source") restored=$(cat "$scratch/restored")"
done
compare 'migration versions/names/checksums' "SELECT jsonb_build_array(version,name,checksum) FROM \"$schema\".schema_migrations ORDER BY version"
compare 'unknown operation identities and states' "SELECT jsonb_build_array(company_id,id,state) FROM \"$schema\".send_operations WHERE state='unknown' ORDER BY company_id COLLATE \"C\",id COLLATE \"C\""
echo "unknown_operations=$(wc -l < "$scratch/source" | tr -d ' ')"
compare 'foreign key definitions' "SELECT jsonb_build_array(c.conrelid::regclass::text,c.conname,pg_get_constraintdef(c.oid)) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE c.contype='f' AND n.nspname='$schema' ORDER BY c.conrelid::regclass::text COLLATE \"C\",c.conname COLLATE \"C\""
duplicates=$(query "$target" -c "SELECT count(*) FROM (SELECT 1 FROM \"$schema\".inbox_events WHERE provider_event_key IS NOT NULL GROUP BY company_id,connection_id,binding_epoch,provider_event_key HAVING count(*)>1) d;")
if [[ "$duplicates" == 0 ]]; then echo 'PASS inbox deduplication (non-NULL provider keys)';
else echo 'FAIL inbox deduplication'; failures=$((failures+1)); fi
if query "$target" -v schema="$schema" < "$here/restore-rehearsal-checks.sql"; then
  echo 'PASS all declared foreign keys have no orphans'
else echo 'FAIL foreign key integrity'; failures=$((failures+1)); fi
((failures == 0)) || exit 1
