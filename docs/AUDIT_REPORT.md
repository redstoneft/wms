# Auditoría externa del backend WMS (`apps/api` + `packages/shared`)

Fecha: 2026-09-01 · Alcance: `apps/api` y `packages/shared` (solo lectura; `apps/web` excluido) · Base: commit `6e10810` (branch `main`).

Convenciones: cada hallazgo indica **CONFIRMADO** (reproducido contra la BD de pruebas o trazado sin ambigüedad en el código) o **PLAUSIBLE** (razonamiento sobre el código, no reproducido). Las rutas son relativas a `apps/api/` salvo que se indique `packages/shared/`.

---

## 1. Resumen ejecutivo

El núcleo de integridad está bien diseñado y **no encontré ninguna ruta que rompa `ledger == balances`, genere saldo negativo o deje un LPN en dos ubicaciones**: los saldos sólo los escribe el trigger `wms_apply_movement`, el `CHECK (qty >= 0)` aborta la transacción, la ubicación vive en la fila del LPN y los `FOR UPDATE` en LPN/saldos serializan a operadores concurrentes. La suite de integración (73 pruebas, incluidas carreras de 20/25/50 peticiones) pasa y reconcilia al final de cada escenario. Los `$queryRaw` usan exclusivamente plantillas etiquetadas (parametrizadas); no hay interpolación de entrada de usuario en SQL.

Los problemas graves están en la **capa alrededor del ledger** (trazabilidad, reglas de negocio y herramientas de control), y varios contradicen directamente el objetivo declarado del sistema:

| # | Hallazgo | Severidad | Estado |
|---|---|---|---|
| A1 | `GET /inventory/reconcile` **siempre responde 500**: la consulta de discrepancias de `order_lines` es SQL inválido, el `.catch(() => [])` traga el error pero la transacción ya quedó abortada. La herramienta de reconciliación expuesta por la API no funciona. | CRÍTICO | CONFIRMADO |
| A2 | Incidencias y auditorías de **intentos bloqueados se pierden por rollback**: `LOADING_ERROR` al cargar un pallet en el embarque equivocado, auditorías `pick.blocked_*` / `verification.blocked_*`, el estado `BLOCKED` + `release_check` + auditoría `shipment.release_blocked` de una liberación rechazada. Todo se escribe y luego se lanza el error dentro de la misma transacción. Los KPIs de precisión de carga y errores por usuario quedan silenciosamente en 100 % / vacíos. | CRÍTICO | CONFIRMADO |
| A3 | Un SUPERVISOR puede **surtir, auto-autorizarse `SAME_USER_VERIFICATION` y verificar su propio surtido**. `consumeAuthorization` no comprueba que el supervisor sea distinto de quien ejecuta la excepción; aplica a todas las excepciones (override de ubicación, cancelación en surtido, ajustes). | CRÍTICO | CONFIRMADO |
| A4 | El usuario `integration` se crea con **rol SUPERVISOR real y contraseña determinista** (`sha256(INTEGRATION_API_KEY)` en hex). Quien conozca la API key inicia sesión por `/auth/login` con todos los permisos de supervisor, no con los 5 permisos que el módulo pretende restringir. | CRÍTICO (seguridad) | CONFIRMADO |
| A5 | La idempotencia depende de que el cliente envíe `Idempotency-Key`; el servidor **no la exige**. Un reintento de red sin cabecera duplica recepciones y surtidos (reproducido: dos `QTY 6` sin clave → `picked_qty = 12`). | ALTO | CONFIRMADO |
| A6 | `POST /putaway/start` + `/putaway/confirm` funcionan como **mover cualquier pallet almacenado sin transferencia en dos fases**, incluso con inventario ALLOCATED (con autorización de override). Deja `pick_task_lines.location_id` obsoleto y contradice la regla "solo AVAILABLE se transfiere". | ALTO | CONFIRMADO |
| A7 | `transfers/start` sobre un LPN con tarea de put-away pendiente la deja **PENDING para siempre y la ubicación sugerida queda RESERVED** (fuga de capacidad). | ALTO | CONFIRMADO |
| A8 | Orden de bloqueo inconsistente entre `allocateOrder` (saldos → LPN) y el resto (LPN → saldos): deadlock posible bajo carga; mitigado por 2 reintentos. | MEDIO | PLAUSIBLE |
| A9 | `trustProxy: true` sin lista de proxies: `X-Forwarded-For` falsifica `req.ip` (auditoría, sesiones) y permite eludir el rate-limit de login/MFA. | ALTO (seguridad) | CONFIRMADO (spoof) / PLAUSIBLE (fuerza bruta) |
| A10 | `inventory_balances` y `lpns.current_location_id` no están protegidos contra escrituras directas (sólo convención); con A1 roto nadie lo detectaría. | MEDIO | PLAUSIBLE |

Recomendación prioritaria: corregir A1 y A2 (son bugs pequeños con impacto directo en "nunca silenciosamente"), añadir la regla `supervisor_id ≠ actor` en `consumeAuthorization` (A3), y desactivar el login por contraseña del usuario `integration` (A4).

---

## 2. Hallazgos CRÍTICOS

### A1 — `GET /inventory/reconcile` siempre falla con 500 · CONFIRMADO
**Archivo:** `src/modules/inventory/service.ts:161-168` (y `:169`, `:117` en `routes.ts`).

La consulta `orderLineDiffs` usa `HAVING` con columnas no agregadas y sin `GROUP BY` → PostgreSQL responde `42803 column "o.order_number" must appear in the GROUP BY clause`. El `.catch(() => [] as never)` esconde el error, pero como todo corre dentro de `withTx`, la transacción ya está abortada y la siguiente consulta (`totals`) falla con `25P02 current transaction is aborted`, que llega al handler global como `INTERNAL_ERROR`.

**Escenario:** cualquier supervisor abre la pantalla de reconciliación → 500. Nadie puede detectar desde la API una discrepancia ledger/saldos ni ubicación LPN/ledger. Además la comprobación de `order_lines.picked_qty` vs ledger (la única que cubre los contadores no protegidos por trigger) nunca se ejecuta; corrompí a mano `picked_qty` y el endpoint no lo reportó (falló antes).

**Reproducción:** `GET /api/inventory/reconcile` con cualquier usuario con `inventory.read` → `{"error":"INTERNAL_ERROR", debug: "...25P02..."}`.

**Corrección:** reescribir la consulta con una subconsulta agregada por `(order_id, sku_id)` y comparar en `WHERE`; eliminar el `.catch` (un error de SQL debe ser visible, no silenciado); cubrir el endpoint con una prueba de integración que compruebe `ok === true` y que detecte una corrupción inducida de `picked_qty`.

### A2 — Incidencias y auditorías de intentos bloqueados se pierden por rollback · CONFIRMADO
**Archivos:**
- `src/modules/shipments/service.ts:87-90` — `createIncident(LOADING_ERROR)` seguido de `throw RuleError('WRONG_SHIPMENT')`.
- `src/modules/shipments/service.ts:196-200` — al fallar la liberación: `update release_check`, `status: 'BLOCKED'`, `audit('shipment.release_blocked')` y luego `throw RuleError('RELEASE_BLOCKED')`.
- `src/modules/picking/service.ts:118-119, 141-143, 156-158` (`blockedScan` → `audit` → `throw`).
- `src/modules/verification/service.ts:51-52, 58-59, 62-63` (audit → throw).

Todas estas operaciones se ejecutan dentro de `withTx`/`runIdempotent`; el `throw` provoca rollback de la transacción completa, así que la incidencia/auditoría/estado **nunca se persiste** aunque el código lo intente. El propio código y la documentación asumen lo contrario:
- `dashboard/routes.ts:72-73` calcula `loading_accuracy_pct` contando auditorías `shipment.release_blocked` → siempre 100 %.
- `dashboard/routes.ts:84` `errors_by_user` cuenta `pick.blocked_%`/`verification.blocked_%` → siempre vacío (además tiene un bug de precedencia `OR ... OR ... AND fecha`).
- `dashboard/routes.ts:33-34` alerta de embarques `BLOCKED` → nunca se activa; `shipments.release_check` nunca se guarda.

**Reproducción (script de auditoría):** escaneo de ubicación incorrecta → 422 y `count(audit_logs where action like 'pick.blocked_%') = 0`; carga de un pallet en otro embarque → 422 `WRONG_SHIPMENT` e `incidents LOADING_ERROR = 0`; liberación con un pallet sin cargar → 422 `RELEASE_BLOCKED`, `shipments.status = 'LOADING'`, `release_check IS NULL`, `audit release_blocked = 0`.

**Impacto:** contradice "el sistema nunca debe omitir silenciosamente una incidencia"; se pierde la trazabilidad de errores de operador (base de los KPIs de calidad); un embarque rechazado no queda marcado.

**Corrección:** registrar los intentos bloqueados **fuera** de la transacción de negocio (p. ej. `withTx` separado tras capturar el `RuleError` en la ruta, o una cola en memoria que se vacía en `onResponse`), o bien no lanzar excepción y devolver un resultado `{blocked: true, ...}` con `status 422` desde la ruta después de hacer commit. Añadir pruebas que verifiquen la persistencia de cada uno.

### A3 — Auto-autorización de excepciones (verificar el propio surtido) · CONFIRMADO
**Archivos:** `src/modules/authorizations/routes.ts:15-30` (`consumeAuthorization` no recibe `ctx` ni compara `supervisor_id` con el actor), `:32-46` (`createAuthorization` permite `requested_by === supervisor_id`), `src/modules/verification/service.ts:24-30`.

`SUPERVISOR` tiene `picking.execute`, `verification.execute` y `exceptions.authorize` (`packages/shared/src/permissions.ts:76`). **Reproducido:** un único supervisor crea el pedido, surte, estaciona, `POST /authorizations {SAME_USER_VERIFICATION, order, id}` (201, `supervisor_id === requested_by`), `POST /verifications/start {authorization_id}` → 201 `same_user_authorized: true`. El mismo patrón aplica a `PUTAWAY_LOCATION_OVERRIDE`, `ORDER_CANCEL_DURING_PICKING` y `COUNT_ADJUSTMENT`.

Adicionalmente `zAuthorize.exception_type` es texto libre (`packages/shared/src/schemas.ts:432-438`): se aceptan tipos inexistentes (reproducido: `NOT_A_REAL_EXCEPTION` → 201) y `FORCE_RELEASE_NOT_ALLOWED`, que según `enums.ts:238` "existe solo para ser rechazado explícitamente", no se rechaza en ningún sitio.

**Corrección:** pasar `ctx` a `consumeAuthorization` y rechazar si `a.supervisor_id === ctx.userId` (y, para verificación, si `supervisor_id === order.picker_id`); rechazar en `createAuthorization` que `requested_by === supervisor_id`; validar `exception_type` contra `EXCEPTION_TYPES` y rechazar `FORCE_RELEASE_NOT_ALLOWED` con 422 explícito. Considerar separar `verification.execute` de `picking.execute` en el rol SUPERVISOR (segregación de funciones).

### A4 — Usuario `integration` con rol SUPERVISOR y contraseña derivada de la API key · CONFIRMADO (código)
**Archivo:** `src/modules/integrations/routes.ts:41-45, 50`.

Al primer uso se crea `users.integration` con `user_roles = SUPERVISOR` y `password_hash = hashPassword(sha256hex(INTEGRATION_API_KEY))`. La restricción a 5 permisos (`:50`) sólo aplica al `ActorContext` construido en la ruta de integración; el usuario en BD es un supervisor completo que puede autenticarse en `/auth/login` con `username=integration, password=hex(sha256(apiKey))`, obtener cookie y liberar embarques, ajustar inventario, autorizar excepciones, etc. La API key (un secreto de sistema externo, normalmente en un conector Windows) se convierte así en una credencial de supervisor.

**Corrección:** crear el usuario con `is_active=false` o con contraseña aleatoria no derivable (y `locked_until` lejano), o mejor un rol dedicado `INTEGRATION` sin permisos de operación; añadir prueba que intente `POST /auth/login` con esa contraseña y espere 401.

---

## 3. Hallazgos ALTOS

### A5 — El servidor no exige `Idempotency-Key` en los endpoints de escaneo · CONFIRMADO
**Archivos:** `src/lib/idempotency.ts:39-43`; rutas `inbound/routes.ts:126`, `picking/routes.ts:41`, `shipments/routes.ts:43`, etc.

Sin cabecera, `runIdempotent` ejecuta directamente. **Reproducido:** dos `POST /picking/scan {step:'QTY', qty:6}` idénticos sin clave → ambos 200 y `picked_qty` pasa a 12 (el operador quería 6). La prueba `network-and-integrations.test.ts:69-75` documenta el comportamiento en vez de prevenirlo. Con un handheld que reintenta tras timeout y omite la cabecera (o un cliente de terceros) se produce exactamente el "doble registro de un escaneo accidental" que el sistema promete evitar. El ledger sigue consistente, pero el inventario físico y el pedido no.

**Corrección:** en las 15 rutas que usan `runIdempotent` responder 400 si falta la cabecera (`ctx.idempotencyKey === null`), o exigirla mediante un `preHandler` común; documentarlo en el contrato del cliente.

### A6 — Put-away como "mover libre" que elude la transferencia en dos fases · CONFIRMADO
**Archivos:** `src/modules/putaway/service.ts:211-233` (`startPutaway` acepta cualquier LPN `STORED`, aunque ya esté en un rack, y crea una tarea nueva), `:241-303` (`confirmPutaway` mueve **todos** los estados del LPN con `moveLpn` sin filtrar `only_status`), `:89-120` (`suggestLocation` excluye al propio LPN y por tanto puede sugerir su ubicación actual).

**Reproducido:**
1. Pallet `STORED` en `P02` sin asignaciones: `FORKLIFT` hace `putaway/start` (200, sugiere `P01`) y `putaway/confirm` (200) → el pallet se mueve sin `TRANSFER_START/COMPLETE`, sin reserva de destino ni escaneo de confirmación intermedio.
2. Pallet con 12 ALLOCATED + 48 AVAILABLE: `transfers/start` se rechaza correctamente (`LPN_NOT_AVAILABLE`), pero `putaway/start` (200) + autorización de override + `putaway/confirm` (200) lo mueven a otro slot con el inventario ALLOCATED dentro. La `pick_task_line` sigue apuntando a la ubicación vieja (el surtidor recibirá `LPN_MOVED` o `WRONG_LOCATION` al escanear, y no hay incidencia).

Efectos colaterales: tareas de put-away sobre pallets ya almacenados que reservan capacidad (`reserved_count`) y ensucian el KPI dock-to-stock; el movimiento queda en el ledger como `PUTAWAY` (trazable, pero semánticamente incorrecto).

**Corrección:** en `startPutaway`/`createPutawayTask` exigir que el LPN esté en ubicación `RECEIVING`/`RETURNS` (o sin ubicación) y sin saldos ALLOCATED/PICKING/IN_TRANSFER; en `confirmPutaway` validar lo mismo bajo lock. Movimientos entre ubicaciones de almacenamiento sólo vía `transfers`.

### A7 — Transferencia de un LPN con tarea de put-away pendiente: fuga de reserva · CONFIRMADO
**Archivo:** `src/modules/transfers/service.ts:15-58` (no consulta `putaway_tasks` activas).

**Reproducido:** recepción → `receipts/lpn/close` (crea tarea PENDING con sugerencia `P02`) → `transfers/start` a `P05` (201) → `transfers/complete` (200). La tarea sigue `PENDING`, `GET /locations/P02` muestra `status: RESERVED, reserved_count: 1`. La ubicación no volverá a sugerirse hasta que un supervisor cancele la tarea manualmente; en `v_location_occupancy` aparece como reservada.

**Corrección:** en `startTransfer` (y en `confirmPutaway`, ver A6) cancelar o rechazar cuando exista una tarea de put-away activa para el LPN; o marcar la tarea `COMPLETED` con `final_location_id` del transfer. Añadir un job que detecte tareas activas cuyo LPN ya no esté en RECEIVING.

### A9 — `trustProxy: true` sin restricción · CONFIRMADO (IP) / PLAUSIBLE (fuerza bruta)
**Archivos:** `src/app.ts:63`, `:99-105` (rate-limit por `req.ip`), `src/modules/auth/routes.ts:14,59`.

**Reproducido:** login con `X-Forwarded-For: 203.0.113.7` → `sessions.ip = '203.0.113.7'`; lo mismo se propaga a `audit_logs.ip`. Consecuencias: (1) la IP de auditoría es falsificable por cualquier cliente que llegue directo al puerto del API; (2) el rate-limit de `/auth/login` (10/min) y `/auth/mfa/verify` (10/min) se elude rotando la cabecera, lo que hace viable la fuerza bruta del TOTP de 6 dígitos (ventana ±1 → 3 códigos válidos cada 30 s) porque `verifyMfa` (`auth/service.ts:158-172`) **no tiene contador de intentos ni bloqueo**.

**Corrección:** `trustProxy` con la lista de IPs del proxy (o `false` si el API no está detrás de proxy); bloquear la sesión/usuario tras N códigos MFA fallidos; el `keyGenerator` del rate-limit usa `req.actor` que aún no existe en `onRequest` (`app.ts:103`), así que siempre es por IP: mover la clave a sesión cuando exista.

---

## 4. Hallazgos MEDIOS

### A8 — Orden de bloqueo inconsistente: posible deadlock allocate vs. transfer/quarantine · PLAUSIBLE
**Archivos:** `src/modules/orders/service.ts:114-137` (bloquea `inventory_balances FOR UPDATE OF b` y luego `lockLpn`), frente a `transfers/service.ts:16,24`, `inventory/service.ts:76,82`, `putaway/service.ts:253`, `picking/service.ts:112` (LPN primero, saldos después).

Escenario: T1 asigna un pedido y bloquea el saldo AVAILABLE del LPN X; T2 inicia transferencia de X, bloquea la fila `lpns` y espera el saldo; T1 pide `lockLpn(X)` → deadlock (`40P01`). `withTx` reintenta 2 veces con backoff aleatorio (`db.ts:58-76`), así que en la práctica termina en éxito o `409 CONCURRENT_MODIFICATION`; no hay corrupción pero sí fallos intermitentes bajo carga. Además la asignación bloquea **todas** las filas de saldo AVAILABLE del SKU (sin `LIMIT`), serializando cualquier operación sobre ese SKU mientras dura.

**Corrección:** en `allocateOrder` recorrer candidatos sin `FOR UPDATE`, y por cada candidato hacer `lockLpn` → `getBalance` (que ya usa `FOR UPDATE`) → releer cantidad; o limitar el `FOR UPDATE ... SKIP LOCKED` al conjunto necesario.

### A10 — Saldos y ubicación no protegidos frente a escrituras directas · PLAUSIBLE (defensa en profundidad)
**Archivo:** `prisma/migrations/20260902023500_integrity/migration.sql` (no hay trigger sobre `inventory_balances` ni sobre `lpns.current_location_id`).

El comentario `:117` dice "la aplicación nunca escribe `inventory_balances` directamente", pero es sólo convención: el rol de conexión puede `UPDATE inventory_balances` o `UPDATE lpns SET current_location_id` y romper la invariante sin dejar rastro en el ledger (hoy el único detector sería `/inventory/reconcile`, roto por A1). Recomendación: trigger `BEFORE INSERT/UPDATE/DELETE ON inventory_balances` que rechace si `pg_trigger_depth() = 0`; lo mismo para `current_location_id` (permitir sólo `createLpn`, p. ej. cuando `OLD.current_location_id IS NULL` o dentro del trigger).

### A11 — Inventario en cuarentena/bloqueado/dañado no se puede transferir · CONFIRMADO (código)
`transfers/service.ts:26-29` exige que todo el LPN esté AVAILABLE, pero `:76` convierte a QUARANTINE/DAMAGED al completar hacia una ubicación de ese tipo. Un pallet ya puesto en QUARANTINE con `/inventory/status` no puede llevarse a la zona de cuarentena por `transfers`; el único camino es el atajo de A6 (que además sólo permite destinos RESERVE/PICKING). Recomendación: permitir transferir LPNs cuyos saldos sean todos de un mismo estado "estático" (AVAILABLE, QUARANTINE, BLOCKED, DAMAGED) preservando estado; seguir rechazando ALLOCATED/PICKING/IN_TRANSFER.

### A12 — Asignación desde `IMPORTED` salta la aceptación · CONFIRMADO
`orders/service.ts:100` incluye `'IMPORTED'` aunque el mensaje dice "only accepted orders". Reproducido: `POST /orders/allocate` sobre un pedido recién creado → 200 `ALLOCATED`. Si "aceptar" es un control de negocio (crédito, revisión), se elude. Quitar `IMPORTED` o documentar.

### A13 — El paso LPN del surtido acepta el código de barras del SKU · CONFIRMADO (código)
`picking/service.ts:130-145`: si el escaneo no coincide con el LPN esperado pero resuelve al SKU correcto, se acepta y el movimiento se registra contra `expectedLpn`. En una ubicación con capacidad > 1 y dos pallets del mismo SKU, el operador puede tomar físicamente del pallet vecino y el sistema descuenta del otro → contenido real del LPN diverge del ledger (invisible hasta un conteo). Exigir LPN cuando la ubicación tenga más de un LPN o el SKU exista en más de un pallet ahí.

### A14 — Estados intermedios inconsistentes tras cancelar o cortar surtidos · PLAUSIBLE
- `orders/service.ts:100,168` + `picking/service.ts:19`: un pedido `PARTIALLY_ALLOCATED` puede reasignarse mientras existe una tarea de surtido; la tarea no incorpora las nuevas asignaciones y, al completarse, el pedido pasa a `PICKED` sin forma de crear otra tarea (`createPickTask` exige ALLOCATED/PARTIALLY_ALLOCATED). El stock queda ALLOCATED hasta cancelar.
- `picking/service.ts:35,162`: `full_pallet` se calcula al crear la tarea; tras un surtido parcial sin clave (A5) el resto sigue tratándose como "pallet completo" y convierte el pallet origen en OUTBOUND con menos unidades. Reproducido (pallet de 120 → 12 en el carrito + 108 en el pallet convertido). No hay pérdida, pero el flag es engañoso para el operador y para `verification`.

### A15 — `changePassword` revoca también la sesión actual · CONFIRMADO
`auth/service.ts:184` (`updateMany` sin excluir `sessionId`; el comentario dice "every other session"). Reproducido: tras `POST /auth/password` → `GET /auth/me` = 401. Molesto, no inseguro.

### A16 — Ajustes de conteo hacia LPNs no almacenados · PLAUSIBLE
`counts/service.ts:226-252`: `approveCount` hace `lockLpn` sin validar `status`; un `COUNT_ADJUST_IN` puede añadir AVAILABLE a un LPN `STAGED`/`PICKING` (si la línea de conteo se creó cuando aún estaba en rack), dejando un pallet de salida con estados mezclados que `loadScan` rechazará (`LPN_STATUS`) sin incidencia. Rechazar o marcar `RECOUNT` cuando `lpn.status ∉ {STORED}`.

### A17 — Rol SUPERVISOR excesivamente amplio · CONFIRMADO (código)
`packages/shared/src/permissions.ts:76`: todo salvo `users.manage`/`settings.manage`. Un supervisor puede recibir, surtir, verificar, cargar, liberar, ajustar y autorizarse (A3). Para un sistema cuyo control principal es la "segunda persona", conviene separar al menos `verification.execute` y `exceptions.authorize` de la ejecución operativa, o aplicar la regla `actor ≠ picker ≠ verifier ≠ autorizador` en código (A3).

### A18 — Fingerprint/TTL de idempotencia · PLAUSIBLE
`idempotency.ts:50,94` + `jobs.ts:28`: las claves expiran a las 48 h y se purgan. Un reintento tardío (> 48 h) de `receipts/scan` sin `lpn_code` crea un LPN nuevo y por tanto un sufijo distinto en `ux_movements_idempotency` (`ledger.ts:199`), así que la "segunda barrera" no lo detecta. Caso raro (handheld apagado 2 días con petición pendiente) pero posible. Alinear el TTL con la política de reintentos del cliente o conservar las claves más tiempo.

### A19 — Fecha de caducidad con `Date` JS y cast `::date` · PLAUSIBLE
`ledger.ts:413` (`${p.expiry_date}::date`), `schemas.ts:221` (`z.coerce.date()`), `imports/service.ts:546`. Un `"2026-09-01"` se interpreta como medianoche UTC y el `::date` se resuelve en la zona de la sesión PostgreSQL. Verifiqué que en este entorno (Node y PG en `America/Mexico_City`) el viaje de ida y vuelta es correcto; en Docker (API en UTC, PG en otra zona o viceversa) se puede desplazar un día y afectar FEFO (`orders/service.ts:124-126`). Enviar la fecha como texto `YYYY-MM-DD` y castear en SQL.

---

## 5. Hallazgos BAJOS

- **A20** `dashboard/routes.ts:84`: `WHERE a LIKE .. OR a LIKE .. OR a = .. AND fecha` — precedencia incorrecta; el filtro de fechas sólo aplica al tercer término (irrelevante mientras A2 impida que existan esas filas).
- **A21** Ajustes `settings` muertos: `session_ttl_hours`, `require_mfa_for_admin`, `count_variance_recount_threshold` (`settings/routes.ts:6-12`) se guardan pero no se leen en ningún sitio (`config.ts:17`, `plugins/auth.ts:55` usan valores fijos). `skus.allow_negative` se persiste y nunca se consulta (bien para la integridad, pero engaña al administrador). `putaway.override` sólo protege cancelar tareas. Eliminar o implementar.
- **A22** `putaway/service.ts:268` comprueba `putaway.execute` dentro de una ruta que ya lo exige: código muerto.
- **A23** `masterdata/routes.ts:87-92`: el comentario promete validar que los cambios de UoM mantengan válidos los códigos de barras, pero no hay comprobación; un barcode `CASE` puede quedar huérfano y fallar en el escaneo (`UOM_NOT_DEFINED`). Igual en `imports/service.ts:443-444`.
- **A24** Defaults de UoM inconsistentes: `pickScan` QTY asume `PIECE` (`picking/service.ts:152`), `verifyScan` asume la UoM del barcode (`verification/service.ts:55`), `receiveReturnLine` asume `PIECE` (`returns/service.ts:44`). Un cliente que omita `uom_code` en surtido registra piezas cuando el operador contó cajas (surtido corto, detectable en verificación) — unificar: exigir `uom_code` siempre en QTY.
- **A25** `errors.ts:58-101` incluye `details.db` con el mensaje crudo de PostgreSQL (nombres de tablas/constraints, UUIDs) en respuestas 409/422; `app.ts:153` añade `debug` fuera de producción. Información útil para un atacante; recortar en producción.
- **A26** `inbound/service.ts:310-313`: si una OC tiene dos líneas del mismo SKU, `updateMany` incrementa ambas → `received_qty` duplicado en la OC.
- **A27** `imports/service.ts:533-560`: `INITIAL_INVENTORY` no valida capacidad/peso de la ubicación ni estado `ACTIVE` en el momento de aplicar (sólo en validación, misma transacción; aceptable) — puede sobrellenar slots.
- **A28** `replenishment/service.ts:61`: al elegir pallet origen usa `rule.max_qty` como "gap" en lugar de `max − actual`.
- **A29** `app.ts:62` acepta `X-Request-Id` del cliente y lo guarda en `audit_logs.request_id`: trazabilidad falsificable (usar el ID propio y guardar el del cliente aparte).
- **A30** `attachments/service.ts:35-36`: el archivo se escribe en disco antes del `INSERT`; un fallo deja archivos huérfanos. `storage_path` se expone en `GET /containers/:id`.
- **A31** `labels/service.ts:147`: `sendToPrinter(host, port)` con host configurable por `printers.manage` → SSRF/TCP arbitrario interno (requiere rol privilegiado).
- **A32** `orders/service.ts:228`: cancelar sobreescribe `orders.notes` con el motivo.
- **A33** `config.ts:45-48`: `COOKIE_SECURE=false` en producción sólo emite un warning; debería ser fatal salvo `ALLOW_INSECURE_COOKIE` explícito.
- **A34** `wms_apply_movement` no valida que `from_location_id` coincida con `lpns.current_location_id` (`migration.sql:127-139`); un bug de aplicación podría registrar un origen incorrecto en el ledger sin que el trigger lo detecte (sólo trazabilidad).
- **A35** `ledger.ts:127-134` `lockLocationByBarcode` hace `barcode = X OR code = upper(X)` sin `ORDER BY`; si un barcode coincide con el código de otra ubicación se elige arbitrariamente.

- **A36** El directorio de datos de PostgreSQL embebido `.pgdata/` (raíz del repo) está **versionado en git** (no aparece en `.gitignore`) y cambia con cada ejecución de pruebas (`git status` muestra decenas de archivos binarios modificados). Contiene la base de desarrollo/pruebas completa (hashes de contraseñas, semillas MFA cifradas, datos de negocio). Añadirlo a `.gitignore` y purgarlo del historial.

**Aspectos revisados y correctos (sin hallazgo):** parametrización de todo el SQL (`$queryRaw` etiquetado; `$queryRawUnsafe` sólo en tests); CSRF (`SameSite=Strict` + `X-Requested-With` + Origin/Referer); hash de contraseñas scrypt y sesiones opacas con hash; cifrado AES-GCM de semillas TOTP; `scrub()` de secretos en auditoría y redacción en logs; comparación constante de API key; serialización de `BigInt`/`Decimal` y uso consistente de `::bigint` en agregados comparados en TS; `zQty` rechaza negativos/decimales/enormes; validación por magic bytes en adjuntos; sequences `NO CYCLE` y trigger que impide borrar LPNs; job de reposición seguro ante doble ejecución (`FOR UPDATE SKIP LOCKED` + índice parcial único); `ux_import_jobs_applied_once`; regla de liberación (`packages/shared/src/release.ts`) correcta y verificada contra el ledger además de los contadores.

---

## 6. Verificación realizada

| Qué | Resultado |
|---|---|
| `cd apps/api && npx vitest run --project unit` | 2 archivos, 16 pruebas, OK (0.8 s) |
| `cd packages/shared && npx vitest run` | 4 archivos, 22 pruebas, OK |
| `cd apps/api && npx vitest run --project integration` (PostgreSQL 18 embebido en `localhost:5432`, BD `wms_test`) | 6 archivos, **73 pruebas, OK en 30 s** (e2e, edge-cases, races, security, network/integrations, fuzz) |
| `npx tsc --noEmit` (apps/api) y `npx eslint apps/api/src packages/shared/src` | sin errores |
| Script de auditoría propio (`tsx`, contra `wms_test`, usando `test/helpers.ts`) | Reproduce A1, A2 (3 variantes), A3, A5, A6 (3 variantes), A7, A9 (IP), A12, A15 y la validación de tipos de excepción; comprueba que el viaje de ida y vuelta de `expiry_date` es correcto en esta máquina (A19 queda PLAUSIBLE) |

Resultados literales relevantes del script: `GET /inventory/reconcile → 500 (25P02)`; `pick.blocked_* audit rows = 0` tras `WRONG_LOCATION`; `LOADING_ERROR incidents = 0` tras `WRONG_SHIPMENT`; `shipments.status = LOADING, release_check NULL, audit release_blocked = 0` tras `RELEASE_BLOCKED`; auto-autorización `SAME_USER_VERIFICATION` → `verifications/start 201`; dos `QTY 6` sin clave → `picked = 12`; `putaway/confirm` con override mueve pallet con `ALLOCATED 12`; `transfers/start` sobre LPN con put-away pendiente → tarea sigue `PENDING`, ubicación sugerida `RESERVED`; login con `X-Forwarded-For` → `sessions.ip` falsificada.

No se ejecutó la prueba de carga ni se modificó ningún archivo del repositorio (el script y sus salidas viven en el scratchpad de la sesión).

---

## 7. Cobertura de pruebas: huecos

Fortalezas: la suite cubre el flujo completo, carreras reales (20 asignaciones, 25 escaneos idénticos, 50 transferencias, aprobación doble de conteo, import doble), autorización por rol, IDOR de tareas, inyección, fuzzing de escaneos e importaciones, y reconcilia ledger/saldos tras cada escenario. Huecos que habrían detectado los hallazgos anteriores:

1. **Persistencia de incidencias/auditorías de intentos bloqueados** (A2): ninguna prueba consulta `incidents`/`audit_logs` después de un `WRONG_SHIPMENT`, `WRONG_LOCATION`, `WRONG_SKU` o `RELEASE_BLOCKED`; `e2e-flow.test.ts:302-304` sólo comprueba el 422. Tampoco se comprueba `shipments.status = 'BLOCKED'`.
2. **Endpoint `/inventory/reconcile`** (A1): `expectReconciled()` (`test/helpers.ts:175-182`) ejecuta las funciones SQL directamente; el endpoint nunca se llama. Añadir una prueba que corrompa `order_lines.picked_qty` y espere que `order_line_discrepancies` lo reporte.
3. **Auto-autorización** (A3): `e2e-flow.test.ts:253-256` prueba `SAME_USER` sin autorización; falta el caso "el mismo supervisor se autoriza".
4. **Put-away como transferencia** (A6/A7): no hay prueba de `putaway/start` sobre un LPN ya almacenado, ni de `transfers/start` con tarea de put-away pendiente.
5. **Idempotencia obligatoria** (A5): `network-and-integrations.test.ts:69-75` afirma la duplicación como comportamiento esperado; debería ser un 400. No hay prueba de doble `QTY` sin clave en surtido.
6. **Concurrencia allocate vs. transfer sobre el mismo LPN** (A8): `races.test.ts:81-92` lo hace secuencialmente; falta la versión `Promise.all` que ejercite el orden de bloqueo.
7. **Seguridad**: sin prueba de login del usuario `integration` (A4), de fuerza bruta/lockout MFA, ni de `X-Forwarded-For` (A9). `security.test.ts:199-202` ("audit never stores passwords") es una búsqueda de patrón en `audit_logs`, no una verificación por caso.
8. **Aserciones débiles**: `races.test.ts:163-182` termina con `expect([45n, 50n]).toContain(total)` — acepta ambos resultados, así que no prueba la regla "líneas movidas se saltan"; `edge-cases.test.ts:278` usa `toBeGreaterThanOrEqual` por interferencia entre pruebas del mismo fixture.
9. **Contadores no protegidos por trigger**: `expectReconciled()` no compara `order_lines.{allocated,picked,verified,loaded}_qty` ni `allocations.picked_qty` con el ledger; una regresión en `pickScan`/`unloadScan` pasaría inadvertida.
10. **KPIs/dashboard**: sin prueba de `/kpis` (habría detectado que `loading_accuracy_pct` es siempre 100 % y `errors_by_user` vacío).
11. **UoM**: no hay prueba de escaneo de cantidad en surtido con `uom_code: 'CASE'` omitido, ni de conversión con barcode de caja en verificación frente a piezas.
12. **Reglas de estado no probadas**: asignar desde `IMPORTED` (A12), transferir cuarentena (A11), `COUNT_ADJUST_IN` a LPN `STAGED` (A16), cancelar pedido con líneas `SHORT`, `unload` + reintento de `release`.


---

## 7. Estado de las correcciones (equipo de desarrollo, 2026-09-02)

Todos los hallazgos CRÍTICOS y ALTOS y la mayoría de los MEDIOS/BAJOS fueron corregidos; cada corrección tiene una prueba de regresión en `apps/api/test/integration/audit-regressions.test.ts` (suite completa: 91 pruebas en verde sobre base de datos limpia).

| Hallazgo | Corrección |
|---|---|
| A1 | Consulta reescrita con agregación por (pedido, SKU) y comparación de `picked`/`loaded` con el ledger; sin `.catch`; `ok` incluye discrepancias de líneas |
| A2 | `RuleError.persistAfterRollback`: auditorías de escaneos bloqueados, incidencia `LOADING_ERROR`, estado `BLOCKED` + `release_check` + auditoría se persisten en una transacción posterior; precedencia del filtro de KPIs corregida (A20) |
| A3 | `consumeAuthorization` recibe el actor y rechaza si el supervisor autorizante es el ejecutor o el surtidor; `createAuthorization` rechaza auto-solicitudes; `exception_type` validado contra la lista; `FORCE_RELEASE_NOT_ALLOWED` rechazado; `PUTAWAY_LOCATION_OVERRIDE` exige `putaway.override` |
| A4 | Identidad `integration` sin roles, contraseña aleatoria y bloqueo permanente; se repara automáticamente si existía de una versión anterior |
| A5 | `Idempotency-Key` obligatoria en todos los endpoints de movimiento (`400 IDEMPOTENCY_KEY_REQUIRED`) |
| A6 | Put-away solo para pallets en RECEIVING/RETURNS (o con tarea legítima) y sin stock ALLOCATED/PICKING/STAGING/LOADED/IN_TRANSFER, verificado en start y confirm |
| A7 | Transferencia rechazada desde RECEIVING/RETURNS (`USE_PUTAWAY`) y con tarea de put-away activa (`PUTAWAY_PENDING`) |
| A8 | Allocation ya no bloquea saldos antes del LPN: lee candidatos sin bloqueo y re-lee bajo `lockLpn` → `getBalance` |
| A9 | `TRUST_PROXY` configurable (por defecto `false`); intentos MFA fallidos bloquean la cuenta; `request_id` siempre del servidor (A29) |
| A10/A34 | Triggers que impiden escribir `inventory_balances` y `lpns.current_location_id` fuera del ledger; validación de `from_location` |
| A11 | `transfers.origin_status`: pallets QUARANTINE/BLOCKED/DAMAGED transferibles preservando estado |
| A12 | Allocation exige `ACCEPTED` (o `PARTIALLY_ALLOCATED`/`PICKED` para olas adicionales) |
| A13 | Código de producto en el paso LPN rechazado (`LPN_REQUIRED`) cuando hay más de un pallet del SKU en la ubicación |
| A14 | No se reserva mientras hay tarea de surtido activa; al completar una tarea con reservas pendientes el pedido vuelve a `PARTIALLY_ALLOCATED` para una segunda ola; conversión de pallet completo re-verificada al escanear cantidad |
| A15 | El cambio de contraseña conserva la sesión actual |
| A16 | Ajustes de conteo omitidos (y línea a recuento) si el LPN no está `STORED` |
| A18 | TTL de idempotencia por defecto 168 h |
| A19 | Fechas de caducidad viajan como texto `YYYY-MM-DD` de extremo a extremo |
| A21 | `session_ttl_hours` y `require_mfa_for_admin` implementados (caché 15 s); `count_variance_recount_threshold` y `allow_negative` eliminados de la API |
| A22 | Comprobación muerta eliminada |
| A23 | Cambios de UoM/barcodes validados en API e importaciones (`BARCODE_UOM_ORPHAN`) |
| A24 | `uom_code` obligatorio en el paso QTY del surtido y en recepción de devoluciones |
| A25 | Mensajes crudos de PostgreSQL ocultos en producción |
| A26 | Recepción distribuye cantidades entre líneas de OC del mismo SKU; expectativas agregadas por SKU |
| A27 | Inventario inicial valida capacidad y estado de la ubicación al aplicar |
| A28 | Hueco de reabasto = máximo − actual |
| A30 | Archivo huérfano eliminado si falla el INSERT del adjunto; nuevo `GET /attachments/:id/file` |
| A31 | Host de impresora restringido a IPv4 privada o nombre de LAN |
| A32 | Cancelar anexa el motivo a las notas en vez de sobrescribirlas |
| A33 | `COOKIE_SECURE=false` en producción es fatal salvo `ALLOW_INSECURE_COOKIE=true` |
| A35 | Coincidencia exacta de barcode antes que por código |
| A36 | `.pgdata/` ignorado, sacado del índice y purgado del historial local no publicado |

No corregidos (documentados): A17 (el rol SUPERVISOR sigue siendo amplio; la separación se aplica en código por A3), rate limiting por IP en memoria (SECURITY.md).
