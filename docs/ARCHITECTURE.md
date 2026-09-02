# Arquitectura

## Principio rector

**Integridad del inventario + trazabilidad + prevención de errores.** Toda decisión de diseño se subordina a que el inventario sea correcto y a que cada unidad pueda rastrearse desde el contenedor hasta el camión.

## Vista general

```
 Zebra / RF / Tablet / PC
        │  HTTPS (cookie de sesión firmada, X-Requested-With, Idempotency-Key, X-Device-Id)
        ▼
 ┌──────────────────────────┐        ┌──────────────────────────────┐
 │  apps/web  (React SPA)   │  /api  │  apps/api  (Fastify + Prisma) │
 │  Vite · Tailwind · R3F   │ ─────▶ │  módulos por dominio          │
 │  Modo oficina / almacén  │        │  reglas de negocio en services │
 │  Gemelo digital 3D       │        │  ledger de inventario          │
 └──────────────────────────┘        └──────────────┬───────────────┘
                                                    │ SQL (transacciones, FOR UPDATE, triggers)
                                                    ▼
                                     ┌──────────────────────────────┐
                                     │ PostgreSQL 18                 │
                                     │ ledger append-only + saldos   │
                                     │ constraints · triggers · vistas│
                                     └──────────────────────────────┘
 packages/shared: enums, esquemas zod, conversiones UoM, regla de liberación, ZPL (compartidos por API y web)
```

Monorepo con npm workspaces:

| Paquete | Rol |
|---|---|
| `packages/shared` | Contratos puros: enums de estados, esquemas zod de cada request, `UomTable` (conversiones exactas en `bigint`), `evaluateRelease` (regla absoluta de liberación), `renderZpl`. Sin dependencias de runtime. |
| `apps/api` | Fastify 5 + Prisma 7 (driver adapter `pg`). Un módulo por dominio (`src/modules/*`: `service.ts` = reglas, `routes.ts` = HTTP). `src/inventory/ledger.ts` es la única puerta al inventario. |
| `apps/web` | SPA React 19 + Vite. Modo oficina (tablas/detalle) y **modo almacén** (`/wm/*`, pantalla completa, botones grandes, escaneo con foco permanente, feedback sonoro). Mapa 3D con React Three Fiber (instancing + LOD). |

### Por qué estas decisiones

* **Fastify + Prisma en lugar de Next.js full-stack**: separa nítidamente UI de reglas de negocio, permite pruebas de integración con `app.inject()` sin red y facilita despliegue como servicio independiente detrás de nginx.
* **Prisma 7 + SQL crudo**: Prisma da tipado y migraciones; los puntos críticos (bloqueos `FOR UPDATE`, `pg_advisory_xact_lock`, triggers, vistas) se escriben en SQL dentro de las migraciones. La verificación `prisma migrate diff` confirma que no hay drift.
* **React + Vite (SPA) en lugar de Next.js**: la aplicación es interna y autenticada; el 3D (Three.js) no se beneficia de SSR y el arranque es más simple en terminales Zebra.
* **Sin colas externas**: toda la coherencia vive en PostgreSQL (transacciones, constraints, índices únicos parciales). Los trabajos de fondo (`src/jobs.ts`) son idempotentes y pueden ejecutarse en varias instancias.

## Modelo de inventario: ledger + saldos

* `inventory_movements` es un **ledger append-only** (trigger prohíbe UPDATE/DELETE/TRUNCATE). Cada fila registra tipo, SKU, cantidad en unidad base, UoM escaneada, LPN origen/destino, ubicación origen/destino, estado origen/destino, usuario, dispositivo, fecha, documento/pedido/recepción/embarque/tarea/incidencia, motivo e `idempotency_key`.
* `inventory_balances` (LPN × SKU × estado) es una **proyección** mantenida por el trigger `wms_apply_movement` **en la misma transacción**. La aplicación nunca escribe saldos. `CHECK (qty >= 0)` aborta cualquier transacción que dejara inventario negativo.
* La **ubicación física vive en el LPN** (`lpns.current_location_id`) y el trigger la actualiza con el movimiento: un pallet no puede estar en dos lugares.
* `inventory_reconcile()` reconstruye los saldos desde el ledger y devuelve discrepancias; `lpn_location_reconcile()` compara la última ubicación del ledger con el LPN. `GET /api/inventory/reconcile` las expone y todas las suites de prueba las verifican al terminar cada escenario.

Estados de inventario: `AVAILABLE, ALLOCATED, PICKING, STAGING, LOADED, QUARANTINE, DAMAGED, BLOCKED, IN_TRANSFER`. Solo `AVAILABLE` es reservable.

### Flujo de una unidad

```
RECEIPT (AVAILABLE @ DOCK, LPN nuevo)
 → PUTAWAY (mismo LPN, ubicación destino)
 → ALLOCATE (AVAILABLE→ALLOCATED, en sitio)
 → PICK (ALLOCATED@LPN origen → PICKING@LPN saliente)   (pallet completo: cambio de estado en sitio)
 → STAGE (PICKING→STAGING @ carril de staging del pedido)
 → [verificación: no mueve inventario, fija verified_qty]
 → LOAD (STAGING→LOADED @ andén)
 → SHIP (LOADED → fuera; LPN SHIPPED, congelado)
```

Transferencias: `TRANSFER_START` (AVAILABLE→IN_TRANSFER en origen, destino reservado) y `TRANSFER_COMPLETE` (IN_TRANSFER→AVAILABLE en destino). El inventario nunca desaparece entre los dos pasos.

## Prevención de errores y concurrencia

| Riesgo | Mecanismo |
|---|---|
| Inventario negativo | `CHECK qty >= 0` + comprobación previa con `FOR UPDATE` |
| Doble allocation | Candidatos bloqueados `FOR UPDATE OF b` en orden de estrategia; el segundo pedido ve el saldo ya reducido |
| Dos operadores sobre el mismo pallet | `lockLpn` (`SELECT … FOR UPDATE`) al inicio de toda operación |
| Escaneo repetido / reintento de red | `Idempotency-Key` por usuario: `pg_advisory_xact_lock(hashtext(key))` + fila en `idempotency_keys` escrita **en la misma transacción** que el movimiento; réplica exacta de la respuesta (`Idempotent-Replayed: true`); mismo key con otro payload → 409 |
| Duplicado de movimientos a nivel BD | índice único parcial en `inventory_movements.idempotency_key` |
| Dos supervisores autorizando la misma excepción | índice único parcial `authorizations(exception_type, entity_type, entity_id) WHERE status='APPROVED'` |
| Dos tareas activas sobre un LPN/pedido | índices únicos parciales (`putaway_tasks`, `transfers`, `pick_tasks`, `verifications`, `staging_assignments`) |
| Importación duplicada | índice único parcial `(import_type, file_sha256) WHERE status='APPLIED'` |
| Deadlock / serialización | `withTx` reintenta `40001`/`40P01`; orden de bloqueo LPN → ubicación → saldos |
| Versión obsoleta | `version` optimista en contenedores, embarques, pedidos |

## Regla absoluta de liberación

`evaluateRelease` (compartida) exige para **cada pedido y cada SKU**: `loaded == required`, `picked ≥ required`, `verified ≥ required`; sin SKUs extra cargados, sin incidencias HIGH/CRITICAL abiertas, todos los pedidos verificados por segunda persona. Los totales son irrelevantes. Además el servidor compara los contadores de línea con el ledger (`LOADED` real de los LPNs del embarque). Si falla, el embarque queda `BLOCKED` y la razón exacta se persiste en `release_check`.

## Seguridad (resumen; ver SECURITY.md)

Sesiones opacas firmadas en cookie `HttpOnly; SameSite=Strict`, scrypt para contraseñas, TOTP obligatorio para ADMIN, RBAC granular (≈50 permisos) verificado en cada ruta en el backend, CSRF por cabecera personalizada + Origin, rate limiting, validación zod de todo input, auditoría append-only con `before/after/why`.

## Extensibilidad prevista

* **Aspel SAE**: los pedidos tienen `source='SAE'` y `external_ref`; la capa de importación (`modules/imports`) y `createOrder()` son el punto de entrada. Nada del núcleo depende de SAE.
* **Multi-almacén**: todo cuelga de `warehouse_id`; el mapa y los fixtures ya crean almacenes aislados.
* **Zebra**: ZPL nativo por TCP 9100 (`labels/service.ts`), impresoras configurables, previsualización PNG con `bwip-js`.
* **TMS / APIs externas**: la API es REST + JSON con errores estructurados y `request_id`; los webhooks pueden añadirse en `jobs.ts`.
