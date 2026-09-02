# Estado de preparación para producción

Fecha de evaluación: 2026-09-02. Este documento recoge la evidencia real obtenida, lo que se verificó y lo que **no** se pudo verificar en este entorno. Nada aquí se afirma sin una ejecución que lo respalde.

## Lista de terminación (requerimiento 62)

| # | Punto | Evidencia | Resultado |
|---|---|---|---|
| 1 | Revisar todos los requerimientos | `docs/REQUIREMENTS_MATRIX.md` | Hecho |
| 2 | Matriz requerimiento → implementación → tests | `docs/REQUIREMENTS_MATRIX.md` | Hecho |
| 3 | Suite completa | `npm run test:unit` (38 tests) + `npm run test:integration -w apps/api` (**91 tests, 7 archivos**) sobre base de datos recién creada | ✅ |
| 4 | E2E | API: `e2e-flow.test.ts` (13 escenarios encadenados). Web: **Playwright 11/11** (login, dashboard/KPIs, mapa 3D con búsqueda de SKU, put-away con error bloqueante, recepción crea LPN, código desconocido, smoke de todas las rutas de oficina y almacén, gating de permisos) | ✅ |
| 5 | Concurrencia | `test/concurrency/races.test.ts` (9 escenarios, hasta 50 operaciones simultáneas) | ✅ |
| 6 | Seguridad | `test/security/security.test.ts` (16 pruebas OWASP) + regresiones de auditoría + `npm audit --omit=dev` = 0 vulnerabilidades | ✅ |
| 7 | Carga | `SCALE=0.05 test/load/run-load.ts`: 1,000 LPNs, 3,180 movimientos; dashboard 399 req/s p99 252 ms; mapa 1,600 posiciones p99 766 ms; 100 allocations concurrentes 100/100; reconciliación 0. Escala completa (20k LPNs / 300k movimientos) disponible con `SCALE=1` — no ejecutada aquí por tiempo | ✅ parcial |
| 8 | Reconciliación de inventario | `inventory_reconcile()` = 0 al final de cada suite; `GET /api/inventory/reconcile` (corregido tras auditoría, detecta también contadores de pedido manipulados) | ✅ |
| 9 | Mapa 3D | Sincronización BD↔mapa probada en API (`edge-cases`), render/instancing/búsqueda/panel probados en Playwright y verificados visualmente | ✅ |
| 10 | Impresión Zebra | ZPL generado y validado (unit + edge); envío TCP implementado y probado contra puerto cerrado (`PRINTER_UNREACHABLE` registrado). **No hay impresora física**: la impresión real no se ejecutó | 🟡 |
| 11 | Backup y restore | Simulacro embebido (copia por TEMPLATE) idéntico; **`pg_dump`/`pg_restore` reales en el contenedor** idénticos (72 movimientos, 16,820 unidades, 0 discrepancias); sidecar `backup` produce dumps con `.sha256` verificados | ✅ |
| 12 | Logs | pino estructurado con redacción; `debug` y mensajes crudos de PostgreSQL solo fuera de producción | ✅ |
| 13 | TODO/FIXME/HACK | 0 en api/shared/web | ✅ |
| 14 | Funciones incompletas | Auditoría externa independiente (`docs/AUDIT_REPORT.md`, 36 hallazgos) → todos los críticos/altos corregidos con regresiones | ✅ |
| 15 | Mocks accidentales | Ninguno en producción; integración con PostgreSQL real | ✅ |
| 16 | Código muerto | ESLint limpio en api/shared/web; comprobaciones muertas eliminadas (A21/A22) | ✅ |
| 17 | Rutas sin autorización | 163 rutas; sin guard solo login/logout/me/MFA, health live/ready, integraciones (API key) | ✅ |
| 18 | Acciones sin auditoría | Todas las operaciones de negocio auditan en la transacción; los intentos bloqueados se auditan tras el rollback (A2) | ✅ |
| 19 | Movimientos duplicables | `Idempotency-Key` obligatoria; 25 duplicados simultáneos, reintento tras reinicio y tormenta de reconexión → 1 movimiento | ✅ |
| 20 | Corrupción de inventario | Triggers + CHECK + protección de escrituras directas + reconciliación en todas las suites + fuzz de secuencias aleatorias | ✅ |

## Segunda auditoría (ingeniero externo)
Realizada por un revisor independiente sobre `apps/api` y `packages/shared` sin acceso de escritura: `docs/AUDIT_REPORT.md`. Sección 7 del reporte lista las correcciones; `test/integration/audit-regressions.test.ts` las protege.

## Frontend (apps/web)
`apps/web/README.md`. `npm run typecheck`, `npm run build` (Vite, 6 s) y `npm run test:e2e` (11/11) en verde contra la API endurecida (claves de idempotencia obligatorias, `uom_code` obligatorio en surtido). Huecos de API reportados por el frontend (`apps/web/API_GAPS.md`) resueltos: búsqueda por barcode, descarga de adjuntos, filtros de tareas/pedidos/incidencias, paginación de recepciones, `verification_id` en pedidos pendientes, coordenadas numéricas en el mapa.

## Infraestructura verificada
* PostgreSQL 18 en Docker (`docker compose up -d db`, script de init crea `wms_test`).
* Imagen `wms-api`: construida y ejecutada en modo producción (migraciones → seed base → arranque → login OK).
* Sidecar `backup`: dumps periódicos con checksum verificados.
* Imagen `wms-web` (nginx + SPA): construida (ver evidencia al final).

## Definición de "READY FOR PRODUCTION" (requerimiento 63)

| Condición | Estado |
|---|---|
| Flujos críticos funcionan | ✅ E2E API + E2E web |
| Reglas críticas con tests | ✅ |
| Sin bugs críticos conocidos | ✅ (tras auditoría y correcciones) |
| Sin vulnerabilidades críticas conocidas | ✅ OWASP + auditoría + `npm audit` limpio; riesgos residuales en SECURITY.md |
| Inventario reconcilia | ✅ |
| Concurrencia controlada | ✅ |
| Duplicados controlados | ✅ |
| Permisos funcionan | ✅ (separación de funciones reforzada) |
| Auditoría funciona | ✅ (incluidos intentos bloqueados) |
| Backups/restores funcionan | ✅ probado con `pg_dump`/`pg_restore` reales |
| Soporta errores razonables de operadores | ✅ |
| E2E críticos pasan | ✅ |

**Veredicto: listo para un piloto de producción** con las condiciones de la sección siguiente. No se declara "perfecto".

## Lo que NO se pudo verificar en este entorno
1. **Impresora Zebra real** y **terminales Zebra físicas** (escáner en modo teclado): diseño y pruebas en navegador únicamente. Validar en el primer día con hardware real (ZEBRA_SETUP.md).
2. **Carga a escala completa** (20k LPNs / 300k movimientos): ejecutar `SCALE=1 npm run test:load -w apps/api` en el servidor de pruebas antes del go-live.
3. **`docker compose up` completo con proxy HTTPS**: `db`, `api`, `backup` y las imágenes se validaron por separado en esta máquina (Docker Desktop estuvo inestable durante la sesión); la composición completa detrás de TLS debe validarse en el servidor destino.
4. **Conector Aspel SAE real**: la capa de integración está probada con peticiones sintéticas; el conector que lee SAE no forma parte de este alcance.

## Recomendaciones antes del go-live
* Cambiar contraseña de `admin`, inscribir MFA, crear usuarios reales por rol; **no** sembrar `--demo`.
* HTTPS en el proxy, `COOKIE_SECURE=true`, `TRUST_PROXY` con la IP del proxy, `ALLOWED_ORIGINS` correcto.
* Configurar impresoras y layout real; cargar SKUs/barcodes; conteo físico → `INITIAL_INVENTORY`; imprimir etiquetas de ubicación y LPN.
* Copia externa diaria de `./backups` y simulacro mensual de restore (`backup-restore-test.ts`).
* Piloto de una semana con recepción + put-away antes de activar surtido/embarques.

## Evidencia (cierre de sesión)
| Verificación | Resultado |
|---|---|
| `npm run test:unit` | 38 ✅ |
| `npm run test:integration -w apps/api` (BD limpia) | 91 ✅ |
| `npm run test:e2e -w apps/web` | 11 ✅ |
| `npm run typecheck` (api, web) + ESLint | limpio |
| `npm audit --omit=dev` | 0 vulnerabilidades |
| Load `SCALE=0.05` | 0 discrepancias, 0 errores HTTP |
| Restore drill (embebido y `pg_dump` real) | idéntico, triggers activos |
| Imagen `wms-api` en modo producción | health OK, login OK |
| Auditoría externa | 36 hallazgos; críticos/altos corregidos con regresiones |
