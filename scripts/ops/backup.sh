#!/usr/bin/env bash
# Nightly logical backup of the LXS platform database (H6).
#
#   DATABASE_URL=postgres://... scripts/ops/backup.sh
#
# Writes BACKUP_DIR/lxs-<UTC timestamp>.dump (pg_dump custom format, compressed), uploads it to
# BACKUP_S3_URI when set, then prunes local dumps older than BACKUP_RETENTION_DAYS.
#
# Env:
#   DATABASE_URL           required. Connection string of the platform DB.
#   BACKUP_DIR             default /var/backups/lxs
#   BACKUP_RETENTION_DAYS  default 14 (local copies; S3 retention belongs to a bucket lifecycle rule)
#   BACKUP_S3_URI          optional, e.g. s3://lxs-backups/prod/  (needs the aws CLI and credentials,
#                          ideally an instance role scoped to s3:PutObject on that prefix)
#   BACKUP_S3_SSE          optional, default AES256. Set to aws:kms to use a KMS key (BACKUP_S3_KMS_KEY_ID).
#   PG_DUMP                default pg_dump. Use a client >= the server major version.
#
# Exit code is non-zero on any failure so cron/systemd can alert on it.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/lxs}"
RETENTION="${BACKUP_RETENTION_DAYS:-14}"
PG_DUMP="${PG_DUMP:-pg_dump}"

umask 077
mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/lxs-$stamp.dump"
tmp="$out.partial"
trap 'rm -f "$tmp"' EXIT

echo "backup: dumping to $out"
"$PG_DUMP" --format=custom --compress=6 --no-owner --no-privileges \
  --file="$tmp" "$DATABASE_URL"
mv "$tmp" "$out"
size="$(wc -c <"$out" | tr -d ' ')"
echo "backup: wrote $size bytes"

# A dump whose table of contents cannot be read is not a backup.
if command -v pg_restore >/dev/null 2>&1; then
  pg_restore --list "$out" >/dev/null
fi

if [[ -n "${BACKUP_S3_URI:-}" ]]; then
  dest="${BACKUP_S3_URI%/}/$(basename "$out")"
  sse=(--sse "${BACKUP_S3_SSE:-AES256}")
  [[ -n "${BACKUP_S3_KMS_KEY_ID:-}" ]] && sse+=(--sse-kms-key-id "$BACKUP_S3_KMS_KEY_ID")
  echo "backup: uploading to $dest"
  aws s3 cp --only-show-errors "${sse[@]}" "$out" "$dest"
fi

echo "backup: pruning local dumps older than $RETENTION days in $BACKUP_DIR"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'lxs-*.dump' -mtime +"$RETENTION" -print -delete

echo "backup: done $out"
