# Guía del administrador

## Usuarios y roles (`Admin → Usuarios`, permiso `users.manage`)
* Crear usuario: nombre de usuario, nombre completo, contraseña inicial (≥ 12), uno o varios roles. Un usuario puede tener varios roles (p. ej. `PICKER` + `VERIFIER`), pero **nunca podrá verificar su propio surtido** sin autorización.
* Desactivar (revoca sesiones), desbloquear (tras intentos fallidos), restablecer contraseña, **resetear MFA**.
* No puede desactivarse a sí mismo. Roles del sistema y permisos se ven en `Roles`.

## MFA
Obligatorio para `ADMIN`: al primer acceso el sistema exige inscribir una app TOTP (QR + secreto). Los códigos toleran ±30 s. Si un administrador pierde el dispositivo, otro administrador le resetea MFA.

## Configuración (`Admin → Configuración`, `settings.manage`)
* `allocation_strategy` por defecto (`FIFO`, `FEFO`, `LPN`, `LOCATION`, `FULL_PALLET`, `CASE_PIECE`).
* `auto_print_lpn_labels`: impresión automática al crear un LPN.
* `require_mfa_for_admin`.
* Motivos de cuarentena, reglas de slotting (pesos y condiciones), impresoras.

## Autorizaciones de excepción (`Admin → Autorizaciones`, `exceptions.authorize`)
Un supervisor crea una autorización indicando el tipo y la entidad exacta:

| Excepción | Entidad | Quién la consume |
|---|---|---|
| `PUTAWAY_LOCATION_OVERRIDE` | `putaway_task` | Montacarguista al escanear otra ubicación |
| `SAME_USER_VERIFICATION` | `order` | Verificador que también surtió |
| `ORDER_CANCEL_DURING_PICKING` | `order` | Cancelación de pedido en surtido |
| `COUNT_ADJUSTMENT` | `lpn` | Ajuste de inventario por control de inventarios |

Cada autorización sirve **una sola vez**, para **una sola entidad**, y solo puede existir una aprobada a la vez (dos supervisores no pueden aprobar lo mismo). Puede revocarse mientras no se use. Todo queda en auditoría con motivo.

## Auditoría (`Admin → Auditoría`, `audit.read`)
Filtros por entidad, usuario, acción y fecha. Cada fila: quién, qué, cuándo, IP/dispositivo, antes/después, motivo. La tabla es **inmutable** (la base de datos rechaza UPDATE/DELETE).

## Layout, maestros e importaciones
Ver WAREHOUSE_SETUP.md. Recomendación: preparar SKUs, barcodes, clientes, proveedores, zonas y racks en plantillas CSV, validar, aplicar, imprimir etiquetas de ubicación y después cargar inventario inicial.

## Operación diaria del supervisor
* Revisar **alertas** del dashboard (incidencias críticas, pallets sin ubicar > 4 h, embarques bloqueados, ocupación alta).
* Asignar tareas de picking, cerrar líneas cortas, autorizar overrides, aprobar conteos (`Conteos → Pendientes de aprobación`), resolver incidencias.
* Liberar embarques únicamente desde el panel de liberación cuando esté todo en verde; el sistema lo impide en cualquier otro caso.
* Programar conteos cíclicos (por ubicación, SKU, zona, ABC, aleatorio) y revisar `Inventario → Reconciliación` (debe ser OK siempre).

## Integraciones (Aspel SAE)
**Entrada automática desde SAE** (`Admin → Integración SAE`): cada 30 minutos el WMS lee los espejos de SAE en Supabase y actualiza artículos (con modelo, capa caja/pieza, conversión y GTIN), clientes, proveedores, órdenes de compra abiertas y pedidos de clientes retail. El botón *Sincronizar ahora* fuerza una corrida; cada corrida muestra filas origen, creados, actualizados y errores por referencia (por ejemplo, un pedido cuya clave no existe en SAE). *Comparar existencias* muestra SAE vs WMS por clave sin modificar nada. Detalle de reglas en `docs/INTEGRATION_SAE.md`.

**Salida hacia otros sistemas**: configure `INTEGRATION_API_KEY` en el servidor. El conector externo envía pedidos a `POST /api/integrations/sae/orders` (cabecera `X-Api-Key`), consulta `GET /api/integrations/sae/orders/:numero/status` y `GET /api/integrations/inventory`. Los pedidos se crean como `source=SAE` y jamás se duplican por número. El WMS funciona igual sin SAE.

## Mantenimiento
* Backups automáticos (BACKUPS.md) y simulacro de restore mensual.
* Actualizaciones: respaldo → `docker compose build && up -d` → verificar salud y reconciliación.
* Revisar `npm audit` y registros (`ERROR_WEBHOOK_URL`).
