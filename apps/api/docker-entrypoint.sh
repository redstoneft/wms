#!/bin/sh
# Applies pending migrations (idempotent, safe to run on every start) and
# seeds BASE data (roles/permissions/admin) — never demo data — then starts.
set -e
cd /app/apps/api
echo "[entrypoint] applying migrations"
npx prisma migrate deploy
echo "[entrypoint] seeding base data"
node --import tsx prisma/seed.ts 2>/dev/null || npx tsx prisma/seed.ts
echo "[entrypoint] starting API"
exec node dist/server.js
