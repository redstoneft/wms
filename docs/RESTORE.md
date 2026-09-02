# Procedimiento de restore

## Requisitos
Cliente PostgreSQL (`psql`, `pg_restore`) con acceso al clúster, o ejecutar dentro del contenedor `db`.

## 1. Elegir el backup y verificar integridad
```bash
ls -la backups/
shasum -a 256 -c backups/wms-20260902T060000Z.dump.sha256
```

## 2. Restaurar en una base de PRUEBA primero
```bash
PGHOST=localhost PGUSER=wms PGPASSWORD=*** scripts/restore.sh backups/wms-20260902T060000Z.dump wms_verify
PGPASSWORD=*** psql -h localhost -U wms -d wms_verify -c "SELECT count(*) FROM inventory_reconcile();"   # 0
PGPASSWORD=*** psql -h localhost -U wms -d wms_verify -c "SELECT count(*) FROM inventory_movements, (SELECT 1) x;"
```

## 3. Restaurar en producción (solo tras el paso 2)
```bash
docker compose stop api web
FORCE_PRODUCTION_RESTORE=yes PGHOST=localhost PGUSER=wms PGPASSWORD=*** scripts/restore.sh backups/wms-20260902T060000Z.dump wms
docker compose up -d api web
curl -s localhost:4000/api/health/ready
```
El `docker-entrypoint.sh` de la API aplica migraciones pendientes al arrancar.

## 4. Verificar
* `GET /api/inventory/reconcile` → `ok: true`.
* Dashboard: contenedores/pedidos/embarques coinciden con lo esperado.
* Lanzar un conteo cíclico (`POST /api/counts` tipo `ZONE`) sobre zonas con actividad reciente.

## Dentro de Docker (sin cliente en el host)
```bash
docker compose exec -T db pg_restore -U wms --no-owner --no-privileges --exit-on-error -d wms_verify < backups/wms-....dump
```

## Simulacro automatizado
`npx tsx apps/api/scripts/backup-restore-test.ts` (ver BACKUPS.md). Debe terminar con `identical=true triggers_work=true`.
