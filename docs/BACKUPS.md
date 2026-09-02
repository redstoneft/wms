# Backups y recuperación

## Qué se respalda
Toda la verdad está en PostgreSQL (`wms`): ledger, saldos, LPNs, pedidos, auditoría, layout. Los adjuntos (fotos) viven en `UPLOAD_DIR` (volumen `wms_uploads` en Docker) y se respaldan por separado como archivos.

## Automático (docker compose)
El servicio `backup` (`scripts/backup-loop.sh`) ejecuta cada `BACKUP_INTERVAL_SECONDS` (6 h por defecto) un `pg_dump --format=custom --compress=6` a `./backups/wms-<UTC>.dump` con `.sha256`, y aplica retención `BACKUP_RETENTION_DAYS` (30). Copie la carpeta `backups/` a un destino externo (rclone/rsync/S3) cada día.

## Manual
```bash
# desde el host con cliente de PostgreSQL
DATABASE_URL=postgresql://wms:***@localhost:5432/wms scripts/backup.sh ./backups
# dentro del contenedor de base de datos
docker compose exec db pg_dump -U wms -Fc wms > backups/manual.dump
```

## Restore
Ver [RESTORE.md](RESTORE.md). En resumen: `scripts/restore.sh <dump> <bd_destino>` recrea la base destino y ejecuta `pg_restore --exit-on-error`. Restaurar sobre `wms` exige `FORCE_PRODUCTION_RESTORE=yes`.

## El restore se prueba
Un backup que nunca se ha restaurado no está probado. Por eso existe `apps/api/scripts/backup-restore-test.ts`:

1. Toma una instantánea de conteos, totales por estado, suma del ledger, `max(id)`, `lpn_seq` y `inventory_reconcile()` de la base origen.
2. Hace el backup y lo restaura en `wms_restore_test` (con `pg_dump`/`pg_restore` si existen; si no, copia por `TEMPLATE` y exporta el ledger en JSON).
3. Repite la instantánea en la base restaurada y exige **igualdad exacta**.
4. Ejecuta una escritura de prueba a través de los triggers en la base restaurada (y la deshace) para confirmar que la lógica de integridad funciona tras el restore.
5. Escribe `backups/LAST_RESTORE_TEST.json` con el resultado.

Se ejecuta en CI (`.github/workflows/wms-ci.yml`) en cada push y debe ejecutarse **mensualmente** contra un backup real de producción en un servidor de pruebas:

```bash
DATABASE_URL=postgresql://wms:***@host:5432/wms npx tsx apps/api/scripts/backup-restore-test.ts
```

Resultado de la última ejecución local (base de pruebas, 3,280 movimientos): `identical=true triggers_work=true`.

## Retención y almacenamiento recomendados
* Diario 30 días (automático), semanal 12 semanas, mensual 12 meses (copiar el primero de cada mes fuera del servidor).
* Cifrar en reposo el destino externo; verificar `.sha256` antes de confiar en un archivo.
* Guardar junto al backup la versión de la aplicación (git SHA) para restaurar con el esquema correcto; `prisma migrate deploy` aplicará migraciones posteriores si se restaura en una versión más nueva.

## Disaster recovery (RPO / RTO)
* **RPO**: ≤ 6 h con el intervalo por defecto (reducir `BACKUP_INTERVAL_SECONDS` o activar WAL archiving/PITR si se requiere menos).
* **RTO objetivo**: < 1 h. Pasos: levantar `db` limpio → `scripts/restore.sh <último dump> wms` con `FORCE_PRODUCTION_RESTORE=yes` → restaurar `uploads` → `docker compose up -d api web` → verificar `GET /api/health/ready` y `GET /api/inventory/reconcile` (0 discrepancias) → conteo cíclico de verificación en zonas con movimientos posteriores al RPO.
* Los movimientos ocurridos entre el último backup y el fallo deben reconstruirse desde las etiquetas físicas (cada LPN lleva su código) mediante conteos; el ledger nunca se edita a mano.
