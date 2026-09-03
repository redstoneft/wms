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

**Nave HIDRO (Lerma)** está cargada desde los vectores del levantamiento topográfico (ADC, agosto 2026), calibrados con las superficies del plano (833.109 y 1,539.402 m²). Planta en **L**: frente de 39.91 m (columnas 9.91/10.07/9.95/9.98) y fondo de 59.5 m; el predio vecino de 833.109 m² (19.98 × 41.7 m) ocupa la esquina frontal izquierda, así que el frente propio es solo la pata de la L (x 19.98–39.91). Portones medidos en x 25.8 y 30.8 (3.1 m); rampa a desnivel aproximada. Dentro de la nave, junto al frente: oficinas de dos niveles (planta baja sanitarios, H 4.90) y dos cubículos de tablaroca (H 3.07 y 2.44), modelados como volúmenes no almacenables. Patio de maniobras, construcciones del patio, caseta y acceso desde Av. Santa Rosa como contexto. Zonas: `REC` (`HID-DOCK-01/02` frente a los portones), `STG` (`HID-STG-01..04`) y `ALM` (almacén general: toda la L; el rectángulo de la zona se recorta al paño real en el 3D). El polígono va en `features.footprint`.

Racks según el croquis del usuario (2026-09-02), todos de 3 niveles, módulos de 2 tarimas lado a lado (2.70 m) salvo Z (1 módulo de 3 tarimas, 3.90 m); códigos de ubicación `ALM-<rack>-R01-N<nivel>-P<posición>`:

| Rack | Módulos | Posiciones | Ubicación en la nave |
|---|---|---|---|
| A | 17 | 102 | Contra el muro exterior derecho, del frente al fondo |
| B / C | 11 + 11 | 66 + 66 | Doble, espalda con espalda, recorridos hacia el fondo (y 24–54) |
| D / E | 11 + 11 | 66 + 66 | Doble, espalda con espalda, recorridos hacia el fondo; entre su remate y el rack X solo queda pasillo de montacargas |
| F | 14 | 84 | Contra el muro medianero con los vecinos |
| X | 7 | 42 | Contra el muro del fondo, mitad izquierda (misma zona `ALM`) |
| Z | 1 (3 tarimas) | 9 | Pegado a las oficinas por el lado de los portones |

Total 501 posiciones de rack. Las coordenadas exactas de cada rack se ajustan en `Mapa 3D → Modo edición`: **arrastrar el rack por su cuerpo y soltarlo** guarda la nueva posición (redondeada a 10 cm, dentro del paño; las ubicaciones se recalculan y conservan su código y su inventario); el clic abre el formulario para teclear X/Y/rotación. La separación entre racks quedó en pasillos de 4.4 m para montacargas.

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

## 6. Etiquetas de ubicación (etiquetar un rack)
`Etiquetas → Etiquetar un rack completo`: elija la zona y el rack (o toda la zona) y use una de tres salidas:

| Salida | Cuándo | Qué produce |
|---|---|---|
| **Hoja para imprimir** | No hay Zebra todavía, o se quiere PDF | Página A4 con etiquetas de 101.6 × 84 mm (3 por hoja, el mismo tamaño que las etiquetas de caja de las otras apps): código grande, Code128 `LOC-…`, nivel, pasillo/rack/módulo/posición. Imprimir al 100 % en cualquier impresora o guardar como PDF |
| **Descargar ZPL** | Zebra fuera de la red del servidor | Archivo `.zpl` con todas las etiquetas (203 dpi, 101.6 × 84 mm), para enviarlo con Zebra Setup Utilities o copiarlo al puerto 9100 |
| **Imprimir en Zebra** | Zebra registrada en `Datos maestros → Impresoras` | Envía una etiqueta por posición; cada una queda en el historial y en auditoría |

Las etiquetas salen en el orden de la ruta de surtido (pasillo → rack → módulo → nivel → posición), que es el orden recomendado para pegarlas:

1. Empezar en el módulo 1 (el más cercano al frente/pasillo de entrada) y avanzar módulo por módulo.
2. En cada módulo pegar las etiquetas de los tres niveles en el poste frontal, a la altura de los ojos, de abajo hacia arriba (N01 abajo, N03 arriba); la etiqueta indica el nivel y la posición (P01 izquierda, P02 derecha vistas de frente).
3. Al terminar el rack, verificar con la terminal: en modo almacén escanear cada etiqueta (`Almacenaje` o `Trazabilidad → Ubicación`) y comprobar que el sistema muestra el código esperado. Una etiqueta que no lee se reimprime desde `Etiquetas` con motivo.

Los `barcode` (`LOC-<código>`) no cambian aunque se mueva el rack en el mapa; solo cambian las coordenadas.

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
