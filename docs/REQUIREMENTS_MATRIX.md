# Matriz de requerimientos → implementación → pruebas

Leyenda: ✅ implementado y probado · 🟡 implementado con limitación documentada · ⬜ no implementado.
Rutas de código relativas a `wms/`. Pruebas: `e2e` = `apps/api/test/integration/e2e-flow.test.ts`, `edge` = `edge-cases.test.ts`, `conc` = `test/concurrency/races.test.ts`, `sec` = `test/security/security.test.ts`, `fuzz` = `test/fuzz/fuzz.test.ts`, `net` = `network-and-integrations.test.ts`, `unit` = `packages/shared/src/*.test.ts` + `apps/api/test/unit`, `web-e2e` = `apps/web/e2e`.

| # | Requerimiento | Implementación | Pruebas | Estado |
|---|---|---|---|---|
| P | Integridad: nunca desaparece/duplica inventario, sin negativos, LPN en un solo lugar, sin doble consumo, sin liberación incompleta, sin escaneo doble, sin transferencia a medias, ajustes auditados, red no duplica | `prisma/migrations/*_integrity/migration.sql` (triggers, CHECK, índices únicos parciales), `src/inventory/ledger.ts`, `src/lib/idempotency.ts` | e2e, edge, conc, net, fuzz (`expectReconciled` en todas) | ✅ |
| 1 | Arquitectura React/TS + Node/TS + PostgreSQL + Prisma + Tailwind + Three.js + Docker + tests | monorepo `apps/api`, `apps/web`, `packages/shared`, `docker-compose.yml`, Dockerfiles | CI `.github/workflows/wms-ci.yml` | ✅ |
| 2 | Inventario transaccional por movimientos con todos los campos; reconstruible; ACID; constraints | `inventory_movements`, `inventory_balances`, `wms_apply_movement`, `inventory_reconcile()` | e2e "append-only", conc, fuzz "ledger invariants", `GET /inventory/reconcile` | ✅ |
| 3 | Contenedores: datos, estados, timestamps, fotos, observaciones | `modules/inbound` (`transitionContainer`, `/containers/:id/photos`) | e2e "checks in a container", sec (uploads) | ✅ |
| 4 | Recepción por barcode, esperado vs recibido, faltantes/sobrantes/SKU incorrecto/daño, parcial, incidencias automáticas | `inbound/service.ts` `receiveScan`, `completeReceipt` | e2e, edge "receiving edge cases" | ✅ |
| 5 | LPN único jamás reutilizado, identidad del pallet, historia completa | `lpn_seq`, `next_lpn_code()`, `ck_lpn_code_format`, trigger no-delete, `timeline` | e2e "timeline", edge "LPN identity" | ✅ |
| 6 | Etiquetas Zebra ZPL (pallet, ubicación, caja, pedido, staging, embarque), previsualización, reimpresión con permiso y registro, contenido de etiqueta LPN | `packages/shared/src/labels.ts`, `modules/labels`, impresión automática al crear LPN | unit labels, edge "labels" | ✅ (impresión real requiere impresora en red) |
| 7 | Jerarquía almacén→zona→pasillo→rack→bahía→nivel→posición; atributos y estados de ubicación | `schema.prisma` (`zones/aisles/racks/locations`), `layout/service.ts`, `v_location_occupancy` | unit layout, edge "layout ↔ 3D" | ✅ |
| 8 | Mapa 3D obligatorio conectado a BD, colores, rotar/zoom, selección, búsquedas SKU/LPN/ubicación/pedido, filtros, % ocupación, administrador de layout persistente | API: `GET /map`, `GET /map/search`, `layout/routes.ts`; Web: `apps/web/src/pages/Map3D*` (R3F, instancing, LOD) | edge "layout ↔ 3D" (API), web-e2e (render + búsqueda) | ✅ |
| 9 | Slot assignment automático con motor configurable, explicación y override con motivo | `modules/putaway/service.ts` `suggestLocation` (pesos, factores, rechazados, alternativas), `slotting_rules`, autorización `PUTAWAY_LOCATION_OVERRIDE` | e2e "put-away", "override", edge "put-away constraints" | ✅ |
| 10 | Put-away dirigido: LPN → ubicación → validar; ubicación incorrecta bloquea; excepción solo con autorización | `startPutaway`, `confirmPutaway` | e2e, conc "dos montacarguistas" | ✅ |
| 11 | Inventario en tiempo real por SKU/LPN/ubicación/zona/almacén y estados | `modules/inventory/routes.ts`, vistas | e2e, edge | ✅ |
| 12 | UoM PALLET/CASE/INNER/PIECE, conversiones exactas y auditables | `sku_uoms`, `UomTable`, `uom_code`/`uom_qty` en cada movimiento | unit uom (+ property-based) | ✅ |
| 13 | Transferencias ubicación/rack/zona/almacén por escaneo, transaccionales, con IN_TRANSFER | `modules/transfers` (dos fases), cross-warehouse | edge "transfers", conc "50 transfers", net "warehouse → warehouse" | ✅ |
| 14 | Reabasto RESERVE→PICKING con min/max, tarea automática, pallet óptimo | `modules/replenishment`, job cada 60 s | edge "replenishment" | ✅ |
| 15 | Conteos programados/SKU/ubicación/zona/ABC/aleatorio/por incidencia; blind count; recuento; aprobación; nunca silencioso | `modules/counts` | edge "cycle counts", conc "dos supervisores", "conteo con movimiento" | ✅ |
| 16 | Importar pedidos XLSX/CSV, validación completa, errores por fila, sin parciales silenciosos; capa SAE | `modules/imports` (ExcelJS/Papa, todo-o-nada, sha256 único), `modules/integrations` | sec "malicious imports", fuzz imports, conc "importaciones simultáneas", net "SAE" | ✅ |
| 17 | Reserva sin double allocation; estrategias FIFO/FEFO/LPN/ubicación/pallet completo/caja-pieza | `orders/service.ts` `allocateOrder` (FOR UPDATE) | e2e, conc "20 pedidos" | ✅ |
| 18 | Picking dirigido con ruta; escaneo ubicación→LPN/producto→cantidad; pallet/caja/pieza | `modules/picking` (`pick_sequence`, máquina de estados) | e2e "directed picking", edge | ✅ |
| 19 | SKU/ubicación/cantidad incorrectos bloquean; insuficiente mantiene incompleta; sin "completo" manual | `pickScan`, `shortLine` (solo supervisor, con incidencia) | e2e, edge "short pick" | ✅ |
| 20 | Staging automático, pedidos separados, posiciones identificadas, en mapa 3D | `assignStaging` (FOR UPDATE SKIP LOCKED), `stageLpn`, `GET /map/search?type=ORDER` | e2e "stages", edge | ✅ |
| 21 | Doble validación independiente, surtidor≠verificador, excepción de supervisor registrada | `modules/verification` + `SAME_USER_VERIFICATION` | e2e "verification" | ✅ |
| 22 | Shipment con transportista/unidad/placas/chofer/pedidos/destino/horas; re-escaneo en carga; REQUIRED/PICKED/VERIFIED/LOADED separados; LOADED nunca inferido | `modules/shipments` `loadScan` (movimientos LOAD reales), CHECKs en `order_lines` | e2e "loading" | ✅ |
| 23 | Regla absoluta: todos los SKUs loaded == required; bloquear faltantes/sobrantes/SKU incorrecto/omitido/incidencias/validación incompleta | `packages/shared/src/release.ts`, `releaseCheck` (+ ledger vs contadores) | unit release (caso 20/20 + propiedades), e2e | ✅ |
| 24 | Incidencias: tipos, fotos, comentarios, responsable, prioridad, estado, resolución, autorización | `modules/incidents`, creación automática en recepción/picking/carga/ajustes | e2e, edge, sec | ✅ |
| 25 | Cuarentena: bloqueado no reservable/surtible/cargable; estados y motivos configurables | estados `QUARANTINE/BLOCKED/DAMAGED`, `quarantine_reasons`, allocation solo AVAILABLE | edge "quarantined … never allocated" | ✅ |
| 26 | Devoluciones: recepción → inspección → clasificación → reintegración/cuarentena/daño/baja con pedido original | `modules/returns` | edge "returns" | ✅ |
| 27 | RBAC con roles iniciales y permisos granulares; acciones críticas con autorización | `packages/shared/src/permissions.ts`, `requirePermission`, `authorizations` | unit permissions, sec | ✅ |
| 28 | Autenticación segura, MFA admin, sesiones, rate limit, CSRF/XSS/SQLi, hashing, secrets fuera del repo, validación y permisos backend | `plugins/auth.ts`, `plugins/security.ts`, `lib/crypto.ts`, zod, helmet | sec, unit crypto | ✅ |
| 29 | Auditoría inmutable WHO/WHAT/WHEN/WHERE/BEFORE/AFTER/WHY | `audit_logs` + triggers, `lib/audit.ts` | e2e "append-only", sec "secrets" | ✅ |
| 30 | Dashboard operativo en tiempo real | `GET /dashboard` | web-e2e | ✅ |
| 31 | KPIs listados | `GET /kpis` | (consulta) | ✅ |
| 32 | Timeline completo de SKU/LPN | `inventory/service.ts timeline` | e2e "timeline" | ✅ |
| 33 | Warehouse Mode para Zebra/USB/RF/tablet/PC: botones grandes, poco texto, feedback visual y sonoro, foco permanente | `apps/web/src/...` (ScanInput, feedback.ts, rutas `/wm/*`) | web-e2e | ✅ |
| 34 | Red inestable: idempotency keys, ack, retry seguro, detección de duplicados; qué opera offline | `lib/idempotency.ts` (advisory lock + key en la misma transacción), cliente con reintentos; decisión: **ningún movimiento se ejecuta offline**, se detiene y reintenta | net, conc "25 escaneos" | ✅ |
| 35 | Concurrencia: transacciones, row locking, optimista/pesimista, unique, idempotencia | `ledger.ts` locks, `version`, índices | conc (todas las situaciones pedidas) | ✅ |
| 36 | Backups automáticos, restore, retención, DR, **restore probado** | `docker-compose` servicio `backup`, `scripts/backup*.sh`, `restore.sh`, `apps/api/scripts/backup-restore-test.ts` | ejecución local + CI | ✅ |
| 37 | Observabilidad: logs estructurados, error tracking, health, métricas, alertas, sin secretos en logs | pino + redact, `ERROR_WEBHOOK_URL`, `/health/*`, `/metrics`, `dashboard.alerts` | sec "secrets" | ✅ |
| 38 | Plantillas Excel/CSV para SKUs, barcodes, clientes, proveedores, ubicaciones, racks, inventario inicial, pedidos, OC; validación exhaustiva | `imports/service.ts` `TEMPLATES`, `validateRows` | sec, fuzz, conc | ✅ |
| 39 | Integration layer desacoplada (SAE) | Entrada: `modules/integrations` (API key). **Sincronización real SAE → WMS**: `modules/sae` lee los espejos Supabase de SAE (artículos consolidados en un SKU por producto —GTIN o modelo— con las claves SAE como alias, conversiones caja, clientes, proveedores, órdenes de compra, pedidos retail) cada 30 min, idempotente, sin tocar inventario; comparación de existencias. Ver `docs/INTEGRATION_SAE.md` | net "integration layer", `sae-sync.test.ts` (PostgREST simulado) + corrida real (1,241 SKUs, 214 clientes, 38 proveedores, 16 OC, 4 pedidos) | ✅ |
| 40–55 | Pruebas: unit, integration, E2E, inventario, property-based, fuzz, concurrencia, red, dispositivos/escaneo, seguridad, carga, mapa 3D, casos extremos, adversarial, regresión | ver TESTING.md | — | ✅ (E2E web con Playwright; carga escalable) |
| 56 | CI/CD: lint, typecheck, unit, integration, security, build, E2E críticos | `.github/workflows/wms-ci.yml` | — | 🟡 lint = typecheck estricto (sin ESLint configurado) |
| 57 | Seed realista sin mezclar demo y producción | `prisma/seed.ts` (`--demo` separado) | — | ✅ |
| 58 | Documentación completa | `docs/*` | — | ✅ |
| 59 | Manual de operación | `docs/MANUAL_OPERACION.md` | — | ✅ |
| 62/63 | Criterio de terminación y evidencia | `docs/PRODUCTION_READINESS.md` | — | ver documento |

## Decisiones de negocio tomadas (defaults sensatos)
* Unidad base = PIEZA; todas las cantidades enteras.
* Estrategia de reserva por defecto FIFO por fecha de creación del LPN (configurable).
* Sobrantes en recepción se reciben (quedan en inventario) y generan incidencia; SKU no esperado idem.
* Producto dañado en recepción entra como `DAMAGED` (nunca `AVAILABLE`).
* Un pallet mixto se mueve siempre completo; no se permite mover un estado parcial de un LPN.
* Las devoluciones entran en `QUARANTINE` hasta clasificarse.
* Los ajustes manuales requieren supervisor (o autorización) y siempre generan incidencia resuelta con el movimiento.
* Los operadores de piso no operan offline: cualquier escaneo sin red se retiene en el dispositivo y se reenvía con la misma clave de idempotencia; consultas sí pueden mostrarse desde caché.
* Cancelar un pedido durante picking requiere autorización y devuelve lo surtido a stock como pallet de almacenamiento con tarea de put-away.
