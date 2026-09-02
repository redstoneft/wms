# Base de datos

PostgreSQL 18. Esquema gestionado con Prisma Migrate (`apps/api/prisma/migrations`). Convención `snake_case` en tablas, columnas y campos Prisma para que el SQL crudo no necesite identificadores entrecomillados. IDs UUIDv7 (`uuidv7()` nativo de PG 18). Cantidades siempre `BIGINT` en unidad base (PIECE).

## Migraciones

| Migración | Contenido |
|---|---|
| `20260902023346_init` | Tablas generadas desde `schema.prisma` |
| `20260902023500_integrity` | Capa de integridad: CHECKs, triggers append-only, trigger de aplicación del ledger, secuencias de documentos, índices únicos parciales, funciones de reconciliación, vistas |

Comandos:

```bash
npm run db:migrate -w apps/api        # prisma migrate deploy (producción, idempotente)
npm run db:migrate:dev -w apps/api    # desarrollo: crea/aplica migraciones
npm run db:seed -w apps/api           # datos base (roles, permisos, admin)
npx tsx prisma/seed.ts --demo         # + almacén demo (NUNCA en producción)
```

## Tablas principales

### Seguridad
`users`, `roles`, `permissions`, `role_permissions`, `user_roles`, `sessions` (token hasheado, expiración, revocación, `mfa_verified`), `audit_logs` (append-only), `idempotency_keys`, `authorizations`, `settings`.

### Estructura física
`warehouses` → `zones` (tipo, huella x/y/ancho/fondo) → `aisles` → `racks` (bahías, niveles, posiciones, geometría y rotación) → `locations` (código `A-03-R05-N02-P04`, barcode `LOC-…`, tipo, capacidad de pallets, peso máximo, altura, restricciones JSON, coordenadas x/y/z para el gemelo 3D, `admin_status`, `pick_sequence`).

Tipos de ubicación: `RESERVE, PICKING, RECEIVING, STAGING, SHIPPING, QUARANTINE, RETURNS, DAMAGED`. El estado de ocupación (`FREE/PARTIAL/OCCUPIED/RESERVED/BLOCKED/QUARANTINE`) es **derivado** en la vista `v_location_occupancy`.

### Maestros
`skus` (familia, grupo de compatibilidad, clase ABC, peso, dimensiones, `allow_negative` explícito), `sku_barcodes` (código → SKU + nivel de empaque), `sku_uoms` (1 UoM = N PIECE, exacto; `CHECK` PIECE=1), `customers`, `suppliers`, `carriers`, `printers`, `quarantine_reasons`.

### Inbound
`purchase_orders` + `purchase_order_lines`, `containers` (estados y timestamps de check-in, descarga, cierre; `version`), `receipts` + `receipt_lines` (esperado/recibido/dañado por SKU), `attachments` (fotos, content-addressed).

### Inventario
`lpns` (código `PLT-YYYY-NNNNNNNN` desde `lpn_seq` sin ciclo — jamás se reutiliza; `DELETE` prohibido por trigger), `inventory_balances`, `inventory_movements`.

### Tareas
`putaway_tasks` (ubicación sugerida + `explanation` JSON del motor de slotting + override), `slotting_rules`, `transfers`, `replenishment_rules`, `replenishment_tasks`, `count_tasks` + `count_lines` (snapshot ciego, recuento, aprobación, movimiento de ajuste).

### Outbound
`orders` + `order_lines` (`required/allocated/picked/verified/loaded` separados, con CHECKs `picked ≤ required`, `verified ≤ picked`, `loaded ≤ verified`), `allocations`, `pick_tasks` + `pick_task_lines` (máquina de estados de escaneo), `staging_assignments`, `verifications` + `verification_lines`, `shipments` (con `release_check` persistido).

### Otros
`incidents` + `incident_comments`, `returns` + `return_lines`, `label_prints` (ZPL exacto enviado, reimpresión y motivo), `import_jobs` (errores por fila, sha256 del archivo), `sequences_meta`.

## Triggers y funciones

| Objeto | Propósito |
|---|---|
| `wms_forbid_change()` / `wms_forbid_truncate()` | Append-only en `inventory_movements`, `audit_logs`; no borrar `lpns` |
| `wms_validate_movement()` (BEFORE INSERT) | Forma del movimiento (lados IN/OUT/interno), no-ops, LPN congelado (`SHIPPED/CANCELLED`) |
| `wms_apply_movement()` (AFTER INSERT) | Resta al origen (falla si no hay saldo), suma al destino (`ON CONFLICT`), borra saldos en cero, mueve el LPN |
| `next_lpn_code()`, `next_doc_number(prefix, seq)` | Numeración `PLT-`, `RCV-`, `SHP-`, `INC-`, `RET-` |
| `inventory_reconcile()` | Ledger vs saldos |
| `lpn_location_reconcile()` | Última ubicación del ledger vs LPN |
| `v_lpn_contents`, `v_location_occupancy`, `v_sku_inventory` | Vistas de consulta para API y mapa |

## Índices únicos parciales (reglas "solo uno activo")

`ux_authorizations_once`, `ux_transfers_one_active_per_lpn`, `ux_putaway_one_active_per_lpn`, `ux_staging_one_active_per_order`, `ux_pick_task_one_active_per_order`, `ux_verification_one_active_per_order`, `ux_replen_one_active_per_rule`, `ux_import_jobs_applied_once`, `ux_movements_idempotency`.

## Roles de base de datos en producción

El usuario de la aplicación no debería ser superusuario. Recomendado:

```sql
CREATE ROLE wms_app LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE wms TO wms_app;
GRANT USAGE ON SCHEMA public TO wms_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wms_app;
REVOKE UPDATE, DELETE, TRUNCATE ON inventory_movements, audit_logs FROM wms_app;
REVOKE DELETE ON lpns FROM wms_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO wms_app;
```

Los triggers ya impiden esas operaciones incluso al owner; los `REVOKE` son defensa en profundidad. Las migraciones se ejecutan con el owner (`wms`).

## Reconstrucción del inventario

```sql
SELECT * FROM inventory_reconcile();       -- debe devolver 0 filas
SELECT * FROM lpn_location_reconcile();    -- debe devolver 0 filas
```

Si alguna vez devolvieran filas (p.ej. tras una intervención manual), los saldos pueden regenerarse desde el ledger:

```sql
BEGIN;
ALTER TABLE inventory_balances DISABLE TRIGGER ALL;
TRUNCATE inventory_balances;
INSERT INTO inventory_balances (id, lpn_id, sku_id, status, qty)
SELECT uuidv7(), lpn_id, sku_id, status, sum(delta) FROM (
  SELECT from_lpn_id AS lpn_id, sku_id, from_status AS status, -qty AS delta FROM inventory_movements WHERE from_lpn_id IS NOT NULL
  UNION ALL SELECT to_lpn_id, sku_id, to_status, qty FROM inventory_movements WHERE to_lpn_id IS NOT NULL) x
GROUP BY lpn_id, sku_id, status HAVING sum(delta) <> 0;
ALTER TABLE inventory_balances ENABLE TRIGGER ALL;
COMMIT;
```
