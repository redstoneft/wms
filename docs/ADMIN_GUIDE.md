# Guía del administrador

## Usuarios y roles (`Admin → Usuarios`, permiso `users.manage`)
* Crear usuario: nombre de usuario, nombre completo, contraseña inicial (≥ 12), uno o varios roles. Un usuario puede tener varios roles (p. ej. `PICKER` + `VERIFIER`), pero **nunca podrá verificar su propio surtido** sin autorización.
* Desactivar (revoca sesiones), desbloquear (tras intentos fallidos), restablecer contraseña, **resetear MFA**.
* No puede desactivarse a sí mismo. Roles del sistema y permisos se ven en `Roles`.

## MFA
Obligatorio para `ADMIN`: al primer acceso el sistema exige inscribir una app TOTP (QR + secreto). Los códigos toleran ±30 s. Si un administrador pierde el dispositivo, otro administrador le resetea MFA.

## Configuración (`Admin → Configuración`, `settings.manage`)
* `allocation_strategy` por defecto (`FIFO`, `FEFO`, `LPN`, `LOCATION`, `FULL_PALLET`, `CASE_PIECE`, `FINISH_PALLET`). **`FINISH_PALLET` es la regla acordada (19-oct-2026):** al sugerir surtido, 1) acabar tarimas: toda tarima que la línea pueda vaciar se toma completa, de la más chica a la más grande, para que desaparezcan tarimas parciales y se liberen posiciones; 2) cajas completas: solo se abre UNA tarima (la última), la más chica que cubra el resto, y entre iguales la que queda en cajas cerradas.
* Impresión de etiquetas: nunca automática; siempre con el botón Imprimir (el setting `auto_print_lpn_labels` ya no tiene efecto).
* `require_mfa_for_admin`.
* `mfa_trusted_device_days` (30): días que un navegador puede saltarse el segundo factor tras marcar *Recordar este dispositivo*; 0 desactiva la opción. Un reset de MFA o un cambio de contraseña revocan todos los dispositivos recordados del usuario.
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
**Entrada automática desde SAE** (`Admin → Integración SAE`): cada 30 minutos el WMS lee los espejos de SAE en Supabase y actualiza artículos (**un SKU por producto físico**: la identidad es el GTIN y, si no lo hay, el modelo; todas las claves de SAE quedan como códigos alias del mismo SKU con su nivel caja/pieza), clientes, proveedores, órdenes de compra abiertas y pedidos de clientes retail. El botón *Sincronizar ahora* fuerza una corrida; cada corrida muestra filas origen, creados, actualizados y errores por referencia (por ejemplo, un pedido cuya clave no existe en SAE). *Comparar existencias* muestra SAE vs WMS por clave sin modificar nada. Detalle de reglas en `docs/INTEGRATION_SAE.md`.

**Salida hacia otros sistemas**: configure `INTEGRATION_API_KEY` en el servidor. El conector externo envía pedidos a `POST /api/integrations/sae/orders` (cabecera `X-Api-Key`), consulta `GET /api/integrations/sae/orders/:numero/status` y `GET /api/integrations/inventory`. Los pedidos se crean como `source=SAE` y jamás se duplican por número. El WMS funciona igual sin SAE.

## Mantenimiento
* Backups automáticos (BACKUPS.md) y simulacro de restore mensual.
* Actualizaciones: respaldo → `docker compose build && up -d` → verificar salud y reconciliación.
* Revisar `npm audit` y registros (`ERROR_WEBHOOK_URL`).

## Capacitación aislada

Todo lo que se hace en el almacén escuela (`ESCUELA`: recepciones, pedidos, embarques, tareas, traslados, conteos, incidencias, armados) se marca automáticamente `is_training` por triggers de base de datos y **no aparece** en las pantallas ni en el tablero. Solo lo ve quien está en medio de un ejercicio de capacitación (paso preparado y no terminado) y quien lo pide explícitamente con `?include_training=true` en la API. La capacitación es obligatoria u opcional según `Configuración → Capacitación guiada obligatoria`; cuando es opcional, el operador la encuentra en el inicio del modo almacén como "Capacitación guiada (opcional)".

## Nombres de SKU

`Datos maestros → SKUs → clic en el SKU → Descripción`. Un nombre editado a mano queda **fijado**: la sincronización con SAE (cada 30 min) actualiza todo lo demás pero no lo sobrescribe. La casilla "Conservar este nombre aunque SAE mande otro" muestra el estado y permite liberar el nombre para que SAE vuelva a mandar.


## Surtido libre y surtido automático por cliente (14-oct-2026)

- **Surtido libre** (Configuración): permite armar un pedido en la handheld escaneando tarimas sin capturar sus modelos. Apagado (valor actual): todo pedido debe tener sus modelos antes de surtirse (Capturar pedido o importación de SAE); la handheld lo explica y el API responde `FREE_PICK_DISABLED`.
- **Clientes con surtido automático** (Configuración, códigos separados por coma; hoy Walmart: 3, 206, 207, 208, 209, WMT): sus pedidos, al importarse de SAE o capturarse en oficina, se aceptan, se planean con lo que hay y se crea su tarea de surtido de inmediato; aparecen en Surtir sin pasar por oficina. Queda auditado como `order.auto_pick`.
- **Reabrir surtido** (ficha del pedido): cuando la tarea de surtido se cerró con faltantes (o por error) y hay que regresar lo pendiente al surtidor, sin ajustar cantidades. Planea lo que haya en existencia y crea/abre la tarea; lo que no tiene existencia lo reporta y se vuelve a presionar cuando entre mercancía. Disponible en pedidos asignados, surtidos, en staging o verificados sin tarea activa.
- **Importar conteo físico (Excel)** (Almacenaje → Conteos cíclicos → *Importar conteo*): archivo con `ubicacion`, `sku`, `cantidad` y opcionalmente `lpn`, más la **fecha y hora en que se contó**. Primero *Previsualizar* (diferencias, tarimas nuevas, no encontradas); *Crear conteo* deja una tarea PENDING_APPROVAL que el supervisor aprueba como cualquier conteo. Regla de oro: una tarima o ubicación con movimientos (acomodo, surtido, división, traslado) **posteriores a la fecha del conteo** nunca se ajusta; queda en RECONTEO. Así un conteo de la mañana no da de baja lo que se acomodó por la tarde. Las tarimas que se encontraron sin LPN se crean al aprobar (imprimir etiqueta). En el handheld, la hora del conteo de cada línea es el momento en que se **escaneó la ubicación** (se muestra en pantalla y en la columna *Contado el* de la oficina). Lección 13/14-oct-2026: una conciliación manual sin esta regla dio de baja 4 tarimas recién acomodadas (534, 541, 542, 543).
- **Pedidos importados directo a surtir** (Configuración, activo): todo pedido que entre de la plataforma de pedidos (SAE) arranca su surtido al importarse. La importación corre cada 30 min y toma los pedidos **validados** en la plataforma cuya fecha de pedido o de alta sea igual o posterior a la fecha de arranque configurada (hoy 2026-10-14).
