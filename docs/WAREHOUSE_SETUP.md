# Configuración del almacén (WAREHOUSE_SETUP)

Todo se configura sin tocar código: por la pantalla **Layout** o por plantillas CSV (**Importaciones**). Los cambios se guardan en base de datos y el mapa 3D los refleja al instante.

## 1. Almacén
`Layout → Almacenes → Nuevo`: código (`CEDIS-01`), nombre, dimensiones en metros (ancho × fondo × alto). Las dimensiones definen el piso del gemelo digital.

## 1b. Geometría del edificio (`features`) — para que el 3D siga el plano

`PATCH /api/warehouses/:id` acepta `features` (esquema `zWarehouseFeatures` en `packages/shared`) e `is_default` (el almacén que abre el mapa 3D). Marco local: `x` a lo largo de la fachada (0 … `width_m`), `y` hacia el fondo (0 = fachada/`FRONT`, `depth_m` = `BACK`), alturas en metros.

| Campo | Qué dibuja |
|---|---|
| `source` | Texto del origen (plano, fecha, escala); aparece en la leyenda del mapa |
| `north_deg` | Azimut del eje `+y`; dibuja la flecha de norte |
| `columns[]` | Columnas estructurales (`x`,`y`,`size`); `estimated: true` se dibuja translúcido |
| `openings[]` | Portones, puertas, rampas y andenes sobre un lado (`FRONT/BACK/LEFT/RIGHT`, `from`, `width`) |
| `context[]` | Áreas fuera del paño: patio de maniobras, vecinos (`VECINO` = no forma parte), oficinas |
| `exclusions[]` | Áreas dentro del paño no utilizables (oficinas interiores, sanitarios) |
| `roof.spans_x[]` | Líneas de cumbrera de las naves |

**Nave HIDRO (Lerma)** ya está cargada desde el levantamiento topográfico (ADC, agosto 2026): 39.91 × 38.57 × 7.10 m, columnas de fachada medidas a 9.91/10.07/9.95/9.98 m, dos naves a dos aguas, patio de maniobras al frente y el predio vecino de 833.109 m² excluido. Portones, rampa y columnas interiores están marcados como aproximados hasta confirmarlos en sitio. Zonas creadas como propuesta: `REC` con `HID-DOCK-01/02` frente a los portones y `STG` con `HID-STG-01..04`; los racks se crean cuando se defina el layout (sección 3).

## 2. Zonas
Una zona es un rectángulo del piso con un tipo:

| Tipo | Uso |
|---|---|
| `RECEIVING` | Andenes de recepción (ubicaciones `RECEIVING`) |
| `STORAGE` | Racks de reserva |
| `PICKING` | Racks/posiciones de picking (caras de surtido con reabasto min/max) |
| `STAGING` | Carriles de staging por pedido |
| `SHIPPING` | Andenes de embarque |
| `QUARANTINE`, `RETURNS`, `DAMAGED` | Áreas de retención, devoluciones y dañado |

Campos: código (corto, p.ej. `A`), nombre, tipo, color, posición `x_m`/`y_m` y tamaño `width_m`/`depth_m`.

## 3. Pasillos y racks
Dentro de una zona de almacenamiento: `Pasillo` (código `01`, `02`, …) → `Rack` con:
* `bays` (bahías), `levels` (niveles), `positions_per_bay` (posiciones por bahía)
* geometría: `bay_width_m` (2.7), `level_height_m` (1.8), `depth_m` (1.2)
* posición en el piso `x_m`, `y_m` y `rotation_deg`
* tipo de ubicación generada (`RESERVE`/`PICKING`), capacidad de pallets por posición y peso máximo

Al crear el rack se generan automáticamente todas las ubicaciones con código

```
<ZONA>-<PASILLO>-R<RACK>-N<NIVEL>-P<POSICIÓN>     ej. A-03-R05-N02-P04
```

y barcode `LOC-A-03-R05-N02-P04`. Cambiar la geometría recalcula coordenadas; **encoger un rack con pallets es rechazado**.

Secuencia de picking (`pick_sequence`) = pasillo → rack → bahía → nivel → posición; se usa para ordenar la ruta de surtido.

## 4. Áreas (ubicaciones sin rack)
`Layout → Ubicaciones → Nueva área`: andenes (`DOCK-01`), staging (`STG-01`…), embarque (`SHIP-01`), cuarentena (`QAR-01`), devoluciones (`RET-01`), dañado (`DMG-01`). Indique posición y tamaño en el piso y capacidad de pallets.

## 5. Ubicaciones: estados y restricciones
* `admin_status`: `ACTIVE`, `BLOCKED` (motivo obligatorio), `QUARANTINE`.
* Ocupación derivada: `FREE`, `PARTIAL`, `OCCUPIED`, `RESERVED` (una tarea de put-away o transferencia va hacia ella).
* Restricciones JSON: familias permitidas, grupos de compatibilidad permitidos, altura máxima. El motor de slotting y los escaneos las respetan.

## 6. Etiquetas de ubicación
`Etiquetas → LOCATION` imprime el barcode de la ubicación (Code128 + QR). Imprima y coloque una etiqueta por posición antes de operar.

## 7. Maestros
* **SKUs**: código, descripción, familia, grupo de compatibilidad, clase ABC, peso unitario, altura de pallet, requiere lote/caducidad, conversiones `1 PALLET = N CASE`, `1 CASE = N PIECE`, barcodes por nivel de empaque.
* Clientes, proveedores, transportistas.
* Impresoras Zebra (ZEBRA_SETUP.md).
* Motivos de cuarentena (`Admin → Motivos`).

Plantillas CSV: `Importaciones → Plantillas` (`SKUS`, `BARCODES`, `CUSTOMERS`, `SUPPLIERS`, `LOCATIONS`, `RACKS`, `INITIAL_INVENTORY`, `ORDERS`, `PURCHASE_ORDERS`). Flujo: subir → **validar** (errores por fila) → aplicar. Nada se aplica si hay una sola fila inválida; un mismo archivo no puede aplicarse dos veces.

## 8. Reabasto
`Reabasto → Reglas`: SKU + ubicación de picking + mínimo + máximo. Cuando la cara baja al mínimo, el sistema genera la tarea y elige el pallet de reserva (el más pequeño que cubre el hueco, FIFO).

## 9. Slotting
`Admin → Slotting`: pesos de los criterios (mismo SKU, proximidad ABC, zona, consolidación de rack, nivel bajo para pesados, afinidad de familia) con condiciones opcionales por familia/clase. Cada tarea de put-away guarda la explicación de por qué se eligió la ubicación y las alternativas.

## 10. Inventario inicial
Tras el conteo físico, plantilla `INITIAL_INVENTORY` (ubicación, SKU, cantidad, UoM, lote, caducidad, grupo de LPN para pallets mixtos). Cada fila/grupo genera un LPN real (`PLT-…`) con movimiento `INITIAL_LOAD`; imprima las etiquetas de LPN y péguelas en los pallets.
