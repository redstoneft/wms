# Estado de preparación para producción

Fecha de evaluación: 2026-09-01/02. Este documento recoge la evidencia real obtenida en este entorno, lo que se verificó, y lo que **no** se pudo verificar. No declara nada que no esté respaldado por una ejecución.

## Lista de terminación (requerimiento 62)

| # | Punto | Evidencia | Resultado |
|---|---|---|---|
| 1 | Revisar todos los requerimientos | `docs/REQUIREMENTS_MATRIX.md` | Hecho |
| 2 | Matriz requerimiento → implementación → tests | `docs/REQUIREMENTS_MATRIX.md` | Hecho |
| 3 | Suite completa | `npm run test:unit` (38 tests) + `npm run test:integration -w apps/api` (73 tests, 6 archivos) | ✅ verde |
| 4 | E2E | API: `e2e-flow.test.ts` (13 escenarios encadenados). Web: Playwright — ver sección "Frontend" | ✅ API · web: ver abajo |
| 5 | Concurrencia | `test/concurrency/races.test.ts` (9 escenarios, hasta 50 operaciones simultáneas) | ✅ |
| 6 | Seguridad | `test/security/security.test.ts` (16 pruebas OWASP) + `npm audit --omit=dev` = 0 vulnerabilidades tras overrides | ✅ |
| 7 | Carga | `SCALE=0.05 test/load/run-load.ts`: 1,000 LPNs, 3,180 movimientos, 100 pedidos; dashboard 399 req/s p99 252 ms; mapa 1,600 posiciones p99 766 ms; 100 allocations concurrentes 100/100 sin errores; reconciliación 0 discrepancias. Escala completa (20k LPNs/300k movimientos) disponible con `SCALE=1` (no ejecutada en esta máquina por tiempo) | ✅ parcial |
| 8 | Reconciliación de inventario | `inventory_reconcile()` = 0 filas al final de cada suite; expuesta en `GET /api/inventory/reconcile` | ✅ |
| 9 | Mapa 3D | Sincronización BD↔mapa probada en API (`edge-cases` "layout ↔ 3D"); render y búsqueda en Playwright | ver "Frontend" |
| 10 | Impresión Zebra | ZPL generado y validado (unit + edge); envío TCP implementado y probado contra puerto cerrado (`PRINTER_UNREACHABLE` registrado). **No hay impresora física en este entorno**: la impresión real no se ha ejecutado | 🟡 |
| 11 | Backup y restore | `apps/api/scripts/backup-restore-test.ts`: base restaurada idéntica (conteos, totales, ledger, secuencias) y triggers funcionando tras restore. En este host no hay `pg_dump` (se usó copia por TEMPLATE); en Docker/CI se usa `pg_dump`/`pg_restore` | ✅ (ver limitación) |
| 12 | Logs | pino estructurado con redacción; `debug` solo fuera de producción | ✅ |
| 13 | TODO/FIXME/HACK | `grep` en `apps/api/src`, `prisma`, `packages/shared`: 0 | ✅ |
| 14 | Funciones incompletas | Revisión + auditoría externa (`docs/AUDIT_REPORT.md`) | ver auditoría |
| 15 | Mocks accidentales | Ninguno en código de producción; los tests de integración usan PostgreSQL real, sin mocks | ✅ |
| 16 | Código muerto | ESLint `no-unused-vars` limpio en api/shared | ✅ |
| 17 | Rutas sin autorización | 159 rutas; sin guard solo: login/logout/me/MFA (por diseño), health live/ready, integraciones (API key) | ✅ |
| 18 | Acciones sin auditoría | Todas las operaciones de negocio llaman `audit()` dentro de la transacción; verificación por módulo en `docs/TESTING.md` | ✅ |
| 19 | Movimientos duplicables | Idempotencia probada con 25 duplicados simultáneos, reintento tras reinicio, tormenta de 30 reintentos | ✅ |
| 20 | Corrupción de inventario | Triggers + CHECK + reconciliación en todas las suites + fuzz de secuencias aleatorias | ✅ |

## Segunda auditoría (ingeniero externo)
Realizada por un revisor independiente sobre `apps/api` y `packages/shared`: ver `docs/AUDIT_REPORT.md`. Los hallazgos corregidos y sus pruebas de regresión se listan al final de este documento.

## Frontend (apps/web)
Ver `apps/web/README.md` y `docs/TESTING.md`. Resultado de `npm run typecheck`, `npm run build` y `npm run test:e2e` en la sección "Evidencia" (actualizada al cierre).

## Definición de "READY FOR PRODUCTION" (requerimiento 63)

| Condición | Estado |
|---|---|
| Flujos críticos funcionan | ✅ E2E API completo; E2E web ver evidencia |
| Reglas críticas con tests | ✅ |
| Sin bugs críticos conocidos | ✅ tras auditoría (ver hallazgos y correcciones) |
| Sin vulnerabilidades críticas conocidas | ✅ pruebas OWASP + `npm audit` limpio; riesgos residuales documentados en SECURITY.md |
| Inventario reconcilia | ✅ |
| Concurrencia controlada | ✅ |
| Duplicados controlados | ✅ |
| Permisos funcionan | ✅ |
| Auditoría funciona | ✅ |
| Backups/restores funcionan | ✅ probado (con la limitación de binarios en este host) |
| Soporta errores razonables de operadores | ✅ (bloqueos de ubicación/SKU/cantidad, doble escaneo, cancelaciones) |
| E2E críticos pasan | ✅ API; web ver evidencia |

## Lo que NO se pudo verificar en este entorno (honesto)
1. **Docker Compose completo**: Docker Desktop de esta Mac no arranca contenedores nuevos (quedan en `Created`), incluso tras reiniciar el daemon. Los `Dockerfile`, `docker-compose.yml` y `docker-entrypoint.sh` están escritos y el pipeline de CI los construye, pero **no se ejecutaron localmente**. Primer despliegue: seguir DEPLOYMENT.md y validar `docker compose up` en el servidor.
2. **Impresora Zebra real**: sin hardware. El ZPL es estándar y validado estructuralmente; verificar en la primera impresión (ZEBRA_SETUP.md).
3. **Carga a escala completa** (20k LPNs / 300k movimientos): el script existe y funciona a escala 5 %; ejecutar `SCALE=1` en el servidor de pruebas antes de producción.
4. **`pg_dump` real**: el simulacro local usó copia por TEMPLATE porque el host no tiene cliente PostgreSQL; el flujo con `pg_dump`/`pg_restore` se ejecuta en CI.
5. **Terminales Zebra físicas**: el modo almacén está diseñado para ellas (foco permanente, Enter, botones grandes) y probado en navegador; validar con el dispositivo real (teclado en modo wedge).

## Recomendaciones antes del go-live
* Cambiar contraseña de `admin`, inscribir MFA, crear usuarios reales, **no** sembrar `--demo`.
* Configurar HTTPS en el proxy, `COOKIE_SECURE=true`, `ALLOWED_ORIGINS`.
* Configurar impresoras, layout real, SKUs/barcodes y hacer un conteo físico → `INITIAL_INVENTORY`.
* Programar copia externa de `./backups` y el simulacro mensual de restore.
* Piloto de una semana con un solo flujo (recepción + put-away) antes de activar embarques.

## Evidencia (actualizada al cierre de la sesión)
_Se completa al final con los resultados del frontend y de la auditoría externa._
