# Guía de usuario (modo oficina)

## Segundo factor recordado
Si tu cuenta pide código de autenticación, al capturarlo puedes marcar *Recordar este dispositivo durante 30 días*. Ese navegador ya no pedirá el código (la contraseña sí). Hazlo solo en equipos propios; en *Mi cuenta → Dispositivos de confianza* puedes quitar cualquiera.

## Acceso
`https://wms.suempresa.com` → usuario y contraseña. Los administradores completan además el código TOTP (Google Authenticator/Authy). Sesión de 12 h; **Cerrar sesión** la revoca en el servidor.

El menú muestra solo lo que su rol permite (`ADMIN, SUPERVISOR, RECEIVING, FORKLIFT, PICKER, VERIFIER, LOADER, INVENTORY_CONTROL`). El botón **Modo Almacén** abre las pantallas de piso (ver MANUAL_OPERACION.md).

## Dashboard
Tarjetas en tiempo real (15 s): contenedores esperando, recepciones abiertas, pallets sin ubicación, tareas de put-away, pedidos por estado, picking, staging usado/total, embarques, incidencias por severidad, conteos, ocupación y **alertas**. Sección KPIs con periodo seleccionable: exactitud de inventario/recepción/picking/carga, dock-to-stock, productividad, utilización, ciclo de pedido, tasa de incidencias, errores por usuario/SKU/cliente, discrepancias de stock.

## Mapa 3D (gemelo digital)
Rotar (arrastrar), zoom (rueda), desplazar (clic derecho/dos dedos). Colores: libre, parcial, ocupado, reservado, bloqueado, cuarentena. Clic en una posición → panel con código, capacidad, ocupación, pallets/LPNs, SKUs, cantidades, peso y último movimiento. Buscar **SKU** resalta todas sus posiciones; **LPN** o **ubicación** lleva la cámara hasta ella; **pedido** resalta su carril de staging y sus pallets reservados. Filtros por zona, tipo, estado, SKU y disponibilidad; porcentaje de ocupación por almacén, zona y rack. Con permiso de layout, **modo edición** permite mover racks.

## Inbound
* **Contenedores**: alta (número, proveedor, OC, transportista, placas, sello, cita), transiciones `PROGRAMADO → LLEGÓ → EN DESCARGA → DESCARGADO → EN RECEPCIÓN → RECIBIDO → CERRADO` con fecha/hora automática, fotos, observaciones, incidencias.
* **Recepciones**: esperado vs recibido por SKU con colores (pendiente/parcial/completo/sobrante), LPNs creados, cierre.

## Inventario
* Por **SKU** (disponible, reservado, en salida, retenido, en tránsito), por **LPN** (ubicación, contenido, estado), por **zona**.
* **Detalle de LPN**: contenido y **línea de tiempo** completa (recibido, etiqueta, put-away, reservado, surtido, staging, verificado, cargado, embarcado; quién y cuándo).
* **Movimientos**: ledger completo con filtros (LPN, SKU, tipo, pedido, fechas).
* **Ajustes** (motivo obligatorio; requiere supervisor o autorización) y **cambios de estado** (cuarentena, bloqueo, daño y sus liberaciones) siempre generan incidencia.
* **Reconciliación**: botón que compara ledger vs saldos y ubicaciones; debe decir *OK*.

## Pedidos
Lista con estado y prioridad; importación CSV/XLSX; alta manual. Detalle con columnas separadas **REQUERIDO / RESERVADO / SURTIDO / VERIFICADO / CARGADO** por SKU. Acciones: aceptar, **reservar** (estrategia FIFO/FEFO/LPN/ubicación/pallet completo/caja-pieza; parcial explícito), crear tarea de picking (asignar surtidor), cancelar (con autorización si ya se surte), ver carril de staging, verificaciones y embarque.

## Embarques
Alta (transportista, unidad, placas, chofer, destino, andén, pedidos). Detalle con **panel de liberación**: por pedido y SKU, requerido/surtido/verificado/cargado y problemas (`FALTANTE`, `SOBRANTE`, `SKU OMITIDO`, `NO VERIFICADO`, `SKU INCORRECTO`, incidencias abiertas). **Liberar** solo se habilita cuando todo cumple; **Salida** registra la partida y da de baja el inventario. **Descargar** devuelve un pallet al staging con motivo.

## Incidencias, devoluciones, etiquetas, importaciones
* Incidencias: lista/filtros, alta con foto, comentarios, asignación, resolución y cierre.
* Devoluciones: alta por cliente (referencia al pedido original), recepción a cuarentena, clasificación (reintegrar / cuarentena / dañado / baja), cierre.
* Etiquetas: previsualizar/imprimir cualquier etiqueta; reimpresión con motivo; historial.
* Importaciones: plantillas, validación con errores por fila, aplicación, historial.
