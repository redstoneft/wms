#!/bin/sh
# Backup sidecar loop for docker compose: runs a backup every BACKUP_INTERVAL_SECONDS.
set -eu
INTERVAL="${BACKUP_INTERVAL_SECONDS:-21600}"
while true; do
  START=$(date +%s)
  if pg_isready -q; then
    OUT_DIR=/backups
    RETENTION="${BACKUP_RETENTION_DAYS:-30}"
    mkdir -p "$OUT_DIR"
    STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
    FILE="$OUT_DIR/wms-$STAMP.dump"
    if pg_dump --format=custom --compress=6 --no-owner --no-privileges --file="$FILE"; then
      sha256sum "$FILE" > "$FILE.sha256"
      echo "[backup-loop] $(date -u) wrote $FILE ($(wc -c < "$FILE") bytes)"
      find "$OUT_DIR" -name 'wms-*.dump' -mtime +"$RETENTION" -delete
      find "$OUT_DIR" -name 'wms-*.dump.sha256' -mtime +"$RETENTION" -delete
    else
      echo "[backup-loop] $(date -u) BACKUP FAILED"
    fi
  else
    echo "[backup-loop] $(date -u) database not ready"
  fi
  ELAPSED=$(( $(date +%s) - START ))
  SLEEP=$(( INTERVAL - ELAPSED ))
  [ "$SLEEP" -gt 0 ] && sleep "$SLEEP"
done
