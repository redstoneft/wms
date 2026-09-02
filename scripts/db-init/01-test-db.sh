#!/bin/sh
# Creates the test database next to the main one (used by integration tests).
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE DATABASE wms_test OWNER "$POSTGRES_USER";
EOSQL
