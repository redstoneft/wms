# Pruebas

Filosofía: **intentar romper el sistema**. Cada suite termina verificando que el ledger y los saldos coinciden (`inventory_reconcile()` vacío), que no hay inventario negativo y que la ubicación de cada LPN coincide con su historial.

## Cómo ejecutar

```bash
# PostgreSQL local (Docker) o embebido:
docker compose up -d db                      # crea wms y wms_test
# o sin Docker:
npx tsx apps/api/scripts/dev-db.ts           # PostgreSQL 18 embebido en ./.pgdata (crea wms y wms_test)

npm run build -w packages/shared
npm run test:unit                            # shared + api (vitest, sin BD)
npm run test:integration -w apps/api         # integración + concurrencia + seguridad + fuzz + propiedades (usa wms_test)
npm run test:e2e -w apps/web                 # Playwright contra API (4000) + Vite (5173) con datos demo
SCALE=0.1 npm run test:load -w apps/api      # carga (usa wms_test)
npx tsx apps/api/scripts/backup-restore-test.ts   # simulacro backup → restore → verificación
```

El proyecto `integration` de vitest aplica migraciones y seed base en `DATABASE_URL_TEST` (global setup) y ejecuta los archivos **en serie** (comparten base). Cada archivo crea su propio almacén aislado (`makeFixture`) con códigos únicos, por lo que los datos de una suite no interfieren con otra salvo donde se comparte SKU a propósito.

## Suites

| Suite | Archivo | Qué prueba |
|---|---|---|
| Unit shared | `packages/shared/src/*.test.ts` | Conversiones UoM exactas (+ property-based), regla absoluta de liberación (+ propiedades: totales iguales nunca liberan con SKU desigual), ZPL válido con cualquier texto (property), matriz RBAC/separación de funciones |
| Unit API | `apps/api/test/unit/*.test.ts` | scrypt, TOTP (vectores RFC 6238), AES-GCM, geometría de layout, reglas de ubicación (capacidad, peso, altura, familias, compatibilidad) |
| E2E API | `test/integration/e2e-flow.test.ts` | Flujo completo contenedor → recepción (idempotencia, sobrante) → put-away dirigido (ubicación incorrecta bloqueada, override con autorización única) → pedido → allocation FIFO (doble allocation rechazada) → picking dirigido (ubicación/SKU/cantidad incorrectos bloqueados, parcial + pallet completo) → staging (carril incorrecto bloqueado) → verificación ciega (surtidor≠verificador) → embarque → carga (duplicado bloqueado) → regla de liberación → salida → timeline → append-only y LPN congelado |
| Casos extremos | `test/integration/edge-cases.test.ts` | Pallet mixto, dañado, SKU no esperado, faltante; rack lleno/bloqueado/peso/altura; ubicación ocupada no se desactiva; transferencia en dos fases con cancelación; cuarentena/bloqueo/daño no reservables; ajustes con motivo/autorización y nunca negativos; conteo ciego → recuento por otra persona → aprobación de supervisor → ajuste por ledger; conteo que coincide se cierra solo; hallazgo inesperado; cancelar pedido durante picking (autorización, devolución a stock, tarea de put-away); allocation parcial explícita; línea corta por supervisor; devoluciones con clasificación; reabasto min/max con elección de pallet; etiquetas (preview, reimpresión con permiso y motivo, auditoría); sincronización mapa 3D ↔ BD (ocupación, reservado, libre, bloqueado, geometría de rack, encogimiento rechazado); identidad de LPN |
| Concurrencia | `test/concurrency/races.test.ts` | 20 pedidos por el mismo pallet (exactamente lo disponible), 25 escaneos idénticos en paralelo (1 movimiento), dos montacarguistas confirmando el mismo put-away, picking vs transferencia, 3 pickers sobre la misma tarea, 50 transferencias paralelas + 50 a la misma ubicación (1 gana), dos supervisores aprobando el mismo conteo, conteo con movimiento intermedio, dos importaciones idénticas simultáneas |
| Red | `test/integration/network-and-integrations.test.ts` | Duplicado retardado, **reinicio del servidor** entre original y reintento, tormenta de reconexión (30 reintentos, 3 keys → 3 movimientos), sin key = sin protección (documentado), key por usuario; transferencia almacén→almacén; capa de integración SAE |
| Seguridad | `test/security/security.test.ts` | Ver SECURITY.md |
| Sincronización SAE | `test/integration/sae-sync.test.ts` | PostgREST simulado en memoria (filtros `eq/in/gte`, paginación por `Range`): SKUs con modelo/capa/CASE/GTIN y desactivación sin inventario, clientes SAE + plataforma, proveedores, OC con líneas agregadas y OC recibida intocable, pedidos con resolución de clave (exacta, `.`, GTIN, BASE), pedido rechazado completo si una línea no resuelve, cancelación → cancelado o incidencia, segunda corrida idempotente, comparación de existencias, fuentes sin configurar → error claro |
| Regresiones de auditoría | `test/integration/audit-regressions.test.ts` | Un test por hallazgo corregido de `docs/AUDIT_REPORT.md`: reconciliación detecta contadores manipulados (A1); auditoría/incidencia/estado BLOCKED persisten tras rollback (A2); auto-autorización, autorizador ≠ surtidor, tipos inválidos, liberación forzada (A3); identidad de integración sin login (A4); `Idempotency-Key` obligatoria en 13 endpoints (A5); put-away solo desde recepción y recepción solo sale por put-away (A6/A7); `X-Forwarded-For` ignorado y bloqueo por fuerza bruta MFA (A9); escrituras directas a saldos/ubicación rechazadas por BD (A10); transferencia de cuarentena preservando estado (A11); pedidos IMPORTED no reservables (A12); LPN obligatorio si hay dos pallets del SKU (A13); segunda ola de surtido (A14); cambio de contraseña conserva sesión (A15); OC con SKU repetido (A26); barcode exacto gana (A35) |
| Fuzz / propiedades | `test/fuzz/fuzz.test.ts` | Payloads arbitrarios en todos los endpoints de escaneo (nunca 500), barcodes aleatorios (nunca crean inventario), bytes aleatorios en importaciones, CSV con celdas aleatorias (errores por fila), secuencias aleatorias de operaciones manteniendo `ledger == saldos` |
| Carga | `test/load/run-load.ts` | Genera SKUs/LPNs/movimientos a escala (por defecto 2,000 SKUs, 20,000 LPNs, ≈300k movimientos), mide reconciliación, consultas del mapa y latencia HTTP con 50–100 usuarios concurrentes (autocannon); tormenta de 400 allocations concurrentes; comprueba reconciliación final |
| E2E web | `apps/web/e2e/*.spec.ts` | Login, dashboard, recepción en modo almacén, put-away con error de ubicación, mapa 3D con búsqueda de SKU |

## Bugs encontrados por las pruebas y corregidos (regresiones)
1. Cookie de sesión no parseada (`hook: false`) → 401 en toda ruta autenticada. Regresión: toda la suite E2E.
2. Cuerpo JSON vacío con `Content-Type: application/json` → 400 en endpoints sin body. Corregido con parser tolerante.
3. `sum(bigint)` devuelve `numeric` → comparaciones `bigint` vs `Decimal` silenciosamente falsas (pallet completo no detectado, verificación de carga). Corregido con `::bigint` en todos los agregados usados en lógica.
4. SQLSTATE de errores de triggers no se extraía con el adapter de Prisma 7 → 500 en lugar de 422. Corregido en `sqlState()`.
5. Objetos `Decimal` en la auditoría → fallo de inserción (500 en PATCH /locations). Corregido en `scrub()`.
6. `allocations.qty = 0` al liberar una allocation no surtida → violación de CHECK. Corregido.
7. **Bytes NUL** en cualquier string → error PostgreSQL 22021 → 500 (hallazgo de fuzzing). Ahora 400.
8. Agotamiento del pool con 25 transacciones simultáneas esperando bloqueo → 500. Ahora pool mayor, `pg_advisory_xact_lock` por key de idempotencia (los duplicados esperan y replican sin ejecutar) y `503 SERVICE_BUSY` explícito.
9. **Auditoría externa** (`docs/AUDIT_REPORT.md`, 36 hallazgos): `GET /inventory/reconcile` devolvía 500 por SQL inválido silenciado; incidencias/auditorías de intentos bloqueados se perdían en el rollback; un supervisor podía autoverificar su surtido; la identidad de integración era un supervisor con contraseña derivable de la API key; la clave de idempotencia era opcional; put-away servía para mover cualquier pallet; transferir un pallet con put-away pendiente dejaba capacidad reservada para siempre; `X-Forwarded-For` falsificaba la IP y no había bloqueo por fuerza bruta de TOTP; orden de bloqueos inconsistente en allocation (deadlocks); `.pgdata` versionado. Todo corregido con regresiones en `audit-regressions.test.ts` y el historial local reescrito para eliminar `.pgdata`.
10. **Catálogo real de SAE (1,241 SKUs) rompió dos E2E de Playwright**: el modo almacén de recepción resolvía códigos de barras contra una lista de 500 SKUs descargada al cliente (los SKUs demo quedaban fuera → `BARCODE_UNKNOWN` falso); ahora resuelve en el servidor con `GET /skus/by-barcode`. El mapa 3D tomaba como almacén por defecto el más antiguo (la nave HIDRO, todavía sin racks); ahora toma el que tiene layout (más ubicaciones), y el resto sigue disponible por `warehouse_id`.

## Resultados de la última ejecución completa (2026-09-02)

| Suite | Resultado |
|---|---|
| Unit shared | 22 tests ✅ |
| Unit API | 16 tests ✅ |
| Integración (8 archivos: e2e, edge, concurrencia, seguridad, red/integraciones, fuzz, regresiones de auditoría, sincronización SAE) | **98 tests ✅** sobre base de datos recién creada |
| Playwright web (Chromium, contra API y Vite reales con datos demo) | **11 tests ✅** |
| Carga `SCALE=0.05` | 0 discrepancias; 100/100 allocations concurrentes |
| Backup/restore | idéntico (embebido por TEMPLATE y real `pg_dump`/`pg_restore` en contenedor) |
| ESLint + tsc (api, shared, web) | limpio |
| `npm audit --omit=dev` | 0 vulnerabilidades (overrides `uuid`, `mysql2`, `deepmerge-ts`) |

## Cobertura de requerimientos
Ver [REQUIREMENTS_MATRIX.md](REQUIREMENTS_MATRIX.md): requerimiento → implementación → prueba.
