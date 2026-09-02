#!/bin/sh
# Full logical backup of the WMS database (custom format, compressed).
# Usage: scripts/backup.sh [output_dir]
# Env: PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE (or DATABASE_URL), BACKUP_RETENTION_DAYS (default 30)
set -eu
OUT_DIR="${1:-./backups}"
RETENTION="${BACKUP_RETENTION_DAYS:-30}"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$OUT_DIR/wms-$STAMP.dump"
if [ -n "${DATABASE_URL:-}" ]; then
  pg_dump --format=custom --compress=6 --no-owner --no-privileges --file="$FILE" "$DATABASE_URL"
else
  pg_dump --format=custom --compress=6 --no-owner --no-privileges --file="$FILE"
fi
sha256sum "$FILE" > "$FILE.sha256" 2>/dev/null || shasum -a 256 "$FILE" > "$FILE.sha256"
SIZE=$(wc -c < "$FILE")
echo "[backup] wrote $FILE ($SIZE bytes)"
# retention
find "$OUT_DIR" -name 'wms-*.dump' -mtime +"$RETENTION" -print -delete | sed 's/^/[backup] pruned /' || true
find "$OUT_DIR" -name 'wms-*.dump.sha256' -mtime +"$RETENTION" -delete || true
echo "$FILE"
