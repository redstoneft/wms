#!/bin/sh
# Applies pending migrations (idempotent, safe to run on every start) and
# seeds BASE data (roles/permissions/admin) — never demo data — then starts.
set -e
cd /app/apps/api
echo "[entrypoint] applying migrations"
npx prisma migrate deploy
echo "[entrypoint] seeding base data"
node dist/prisma/seed.js
echo "[entrypoint] starting API"
exec node dist/src/server.js
