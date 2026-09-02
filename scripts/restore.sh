#!/bin/sh
# Restores a backup into a target database (which is DROPPED and recreated).
# Usage: scripts/restore.sh <dump_file> <target_database_name>
# Env: PGHOST PGPORT PGUSER PGPASSWORD (connection to the cluster)
# Refuses to restore into a database named 'wms' unless FORCE_PRODUCTION_RESTORE=yes.
set -eu
DUMP="$1"
TARGET="$2"
if [ ! -f "$DUMP" ]; then echo "[restore] dump not found: $DUMP"; exit 1; fi
if [ -f "$DUMP.sha256" ]; then
  (sha256sum -c "$DUMP.sha256" >/dev/null 2>&1 || shasum -a 256 -c "$DUMP.sha256" >/dev/null 2>&1) || { echo "[restore] CHECKSUM MISMATCH for $DUMP"; exit 1; }
  echo "[restore] checksum OK"
fi
if [ "$TARGET" = "wms" ] && [ "${FORCE_PRODUCTION_RESTORE:-no}" != "yes" ]; then
  echo "[restore] refusing to overwrite production database 'wms' without FORCE_PRODUCTION_RESTORE=yes"; exit 1
fi
echo "[restore] recreating database $TARGET"
psql -v ON_ERROR_STOP=1 -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$TARGET' AND pid <> pg_backend_pid();" >/dev/null
psql -v ON_ERROR_STOP=1 -d postgres -c "DROP DATABASE IF EXISTS \"$TARGET\";"
psql -v ON_ERROR_STOP=1 -d postgres -c "CREATE DATABASE \"$TARGET\";"
pg_restore --no-owner --no-privileges --exit-on-error -d "$TARGET" "$DUMP"
echo "[restore] restored $DUMP into $TARGET"
