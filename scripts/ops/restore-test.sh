#!/usr/bin/env bash
# Prove the latest backup restores (H6). Restores into a throwaway database, runs sanity
# queries, and drops it again. Never touches the source database.
#
#   ADMIN_DATABASE_URL=postgres://user:pass@host:5432/postgres scripts/ops/restore-test.sh [dump]
#
# Env:
#   ADMIN_DATABASE_URL  required. A role that may CREATE/DROP DATABASE, pointed at a maintenance
#                       DB (postgres). Use a staging/scratch server, not production, if you can.
#   BACKUP_DIR          where to find the latest lxs-*.dump (default /var/backups/lxs)
#   BACKUP_S3_URI       if set and no local dump exists, the newest object there is downloaded
#   RESTORE_DB          scratch database name (default lxs_restore_test_<epoch>)
#   MIN_EVENTS          fail if the restored events table has fewer rows (default 0)
set -euo pipefail

: "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/lxs}"
RESTORE_DB="${RESTORE_DB:-lxs_restore_test_$(date -u +%s)}"
MIN_EVENTS="${MIN_EVENTS:-0}"
[[ "$MIN_EVENTS" =~ ^[0-9]+$ ]] || { echo "restore-test: MIN_EVENTS must be an integer" >&2; exit 2; }

if [[ ! "$RESTORE_DB" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  echo "restore-test: RESTORE_DB must be a plain lowercase identifier" >&2
  exit 2
fi

dump="${1:-}"
workdir=""
if [[ -z "$dump" ]]; then
  dump="$(ls -1t "$BACKUP_DIR"/lxs-*.dump 2>/dev/null | head -n1 || true)"
fi
if [[ -z "$dump" && -n "${BACKUP_S3_URI:-}" ]]; then
  key="$(aws s3 ls "${BACKUP_S3_URI%/}/" | awk '$4 ~ /^lxs-.*\.dump$/ {print $4}' | sort | tail -n1)"
  [[ -n "$key" ]] || { echo "restore-test: no dumps in $BACKUP_S3_URI" >&2; exit 1; }
  workdir="$(mktemp -d)"
  dump="$workdir/$key"
  aws s3 cp --only-show-errors "${BACKUP_S3_URI%/}/$key" "$dump"
fi
[[ -n "$dump" && -f "$dump" ]] || { echo "restore-test: no dump found" >&2; exit 1; }

# Swap the database name in the admin URL to address the scratch DB.
scratch_url="$(printf '%s' "$ADMIN_DATABASE_URL" | sed -E "s#(postgres(ql)?://[^/]+/)[^?]*#\1$RESTORE_DB#")"

cleanup() {
  psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -qc "drop database if exists $RESTORE_DB with (force)" || true
  [[ -n "$workdir" ]] && rm -rf "$workdir"
}
trap cleanup EXIT

echo "restore-test: restoring $dump into $RESTORE_DB"
started=$(date +%s)
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -qc "create database $RESTORE_DB"
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$scratch_url" "$dump"
echo "restore-test: restored in $(( $(date +%s) - started ))s"

echo "restore-test: applied migrations"
psql "$scratch_url" -v ON_ERROR_STOP=1 -c \
  "select id, hash, to_timestamp(created_at / 1000) as applied_at from drizzle.__drizzle_migrations order by id"

echo "restore-test: row counts per table (exact)"
psql "$scratch_url" -v ON_ERROR_STOP=1 -At -F $'\t' <<'SQL'
select table_schema || '.' || table_name,
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint
from information_schema.tables
where table_type = 'BASE TABLE' and table_schema in ('public')
order by 1;
SQL

echo "restore-test: sanity checks"
psql "$scratch_url" -v ON_ERROR_STOP=1 -q <<SQL
do \$\$
declare n bigint;
begin
  if (select count(*) from drizzle.__drizzle_migrations) = 0 then
    raise exception 'no migrations recorded';
  end if;
  if exists (select 1 from incidents i left join projects p on p.id = i.project_id where p.id is null) then
    raise exception 'incidents reference missing projects';
  end if;
  select count(*) into n from events;
  if n < $MIN_EVENTS then
    raise exception 'events table has % rows, expected at least $MIN_EVENTS', n;
  end if;
  raise notice 'events: % rows', n;
end \$\$;
SQL

echo "restore-test: PASS ($dump)"
