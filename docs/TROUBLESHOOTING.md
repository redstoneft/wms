# Solución de problemas

| Síntoma | Causa probable | Acción |
|---|---|---|
| `401 UNAUTHORIZED` en todo | Sesión expirada/revocada, cookie no enviada (dominio distinto) | Revisar `ALLOWED_ORIGINS`, que el frontend use el mismo origen o proxy `/api`, y `COOKIE_SECURE` acorde a HTTP/HTTPS |
| `403 FORBIDDEN details.code=CSRF` | Falta `X-Requested-With: wms-client` u `Origin` no permitido | Añadir la cabecera en el cliente; revisar `ALLOWED_ORIGINS` |
| `403 MFA_REQUIRED` | Usuario ADMIN sin MFA verificado | Completar inscripción/verificación TOTP; un admin puede resetear MFA de otro (`/users/:id/mfa/reset`) |
| `423 ACCOUNT_LOCKED` | 10 intentos fallidos | Esperar 15 min o `POST /users/:id/unlock` |
| `409 IDEMPOTENCY_KEY_REUSED` | El cliente reutilizó un key con otro payload | Generar un key nuevo por acción; reutilizar solo para reintentos idénticos |
| `409 CONCURRENT_MODIFICATION` / `STALE_VERSION` | Otro usuario cambió el registro | Recargar y repetir |
| `503 SERVICE_BUSY` | Pool de conexiones saturado | Reintentar; subir `max_connections`/pool; revisar bloqueos largos (`pg_stat_activity`) |
| `422 INSUFFICIENT_INVENTORY` | Saldo AVAILABLE insuficiente en ese LPN/estado | Verificar inventario del LPN; quizá esté ALLOCATED/QUARANTINE |
| `422 WRONG_LOCATION` | Escaneo de ubicación distinta a la indicada | Ir a la ubicación correcta o pedir autorización de override (put-away) |
| `422 LOCATION_REJECTED` | Ubicación llena, bloqueada, sobrepeso, altura o incompatibilidad | Ver `details.reasons`; elegir otra ubicación o ajustar capacidad |
| `422 RELEASE_BLOCKED` | La regla absoluta falló | Ver `blocking_reasons` (SKU faltante/sobrante/omitido, no verificado, incidencia HIGH/CRITICAL) y corregir cargando/descargando pallets |
| `422 SAME_USER` | Surtidor intenta verificar su pedido | Otro verificador, o autorización `SAME_USER_VERIFICATION` de supervisor |
| `422 PRINTER_UNREACHABLE` | Zebra apagada/IP incorrecta | Probar `nc -w 3 IP 9100`; revisar `printers` |
| `422 NO_LOCATION_AVAILABLE` | Ningún hueco cumple reglas para el pallet | Revisar racks bloqueados/llenos, restricciones, peso del pallet; `resuggest` tras liberar espacio |
| `422 INVENTORY_MOVED_SINCE_COUNT` (línea omitida al aprobar) | Hubo movimiento tras el conteo | Recontar la línea |
| Reconciliación con discrepancias (`GET /api/inventory/reconcile`) | Intervención manual en BD | Nunca editar saldos a mano; ver DATABASE.md "Reconstrucción" y auditar |
| Mapa 3D no refleja un cambio | Caché de React Query (10 s) | Botón de refrescar; comprobar `GET /api/map` |
| `prisma migrate deploy` falla | BD sin permisos o migración parcialmente aplicada | Revisar `_prisma_migrations`; restaurar backup si la migración quedó a medias |
| Docker: contenedor `db` no arranca | Puerto 5432 ocupado o volumen corrupto | Cambiar `POSTGRES_PORT`; revisar `docker compose logs db` |
| Tests de integración fallan al inicio | `wms_test` no existe o `DATABASE_URL_TEST` incorrecta | `CREATE DATABASE wms_test` (el script `db-init` lo hace en Docker; `dev-db.ts` también) |

## Diagnóstico rápido
```bash
curl -s localhost:4000/api/health/ready
docker compose logs --tail 200 api | grep -i error
docker compose exec db psql -U wms -d wms -c "SELECT * FROM inventory_reconcile();"
docker compose exec db psql -U wms -d wms -c "SELECT pid, state, wait_event_type, left(query,80) FROM pg_stat_activity WHERE datname='wms' AND state <> 'idle';"
```
Cada respuesta de error incluye `request_id`; búsquelo en los logs de la API (`grep <request_id>`) y en la auditoría.
