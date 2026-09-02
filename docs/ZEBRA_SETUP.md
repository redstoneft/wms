# Impresoras Zebra (ZPL)

## Impresoras compatibles
Cualquier Zebra con ZPL II y puerto raw TCP 9100 (ZT411/ZT230/ZD421/ZD620/GK420, etc.). Resoluciones soportadas: 203 dpi (por defecto) y 300 dpi. Etiqueta por defecto 100 × 150 mm (4 × 6 in); configurable por impresora (`label_width_mm`, `label_height_mm`).

## Alta en el sistema
`Admin → Impresoras → Nueva`: código (`ZEBRA-REC`), nombre, IP/host, puerto (9100), dpi, tamaño de etiqueta, `is_default`. La API abre una conexión TCP, envía el ZPL y cierra. Si la impresora no responde en 5 s la impresión queda registrada como `FAILED` con el error y el operador ve `PRINTER_UNREACHABLE`.

Configure la IP fija de la impresora (menú de red de la Zebra o Zebra Setup Utilities). Verifique desde el servidor:
```bash
printf '^XA^FO50,50^A0N,50,50^FDWMS OK^FS^XZ' | nc -w 3 192.168.1.50 9100
```

## Tipos de etiqueta
| Tipo | Contenido |
|---|---|
| `LPN` | LPN grande + Code128 + QR, fecha, recepción, contenedor, proveedor, cajas, lote/caducidad, tabla de SKUs (código, descripción, cantidad, cajas), pie con ubicación |
| `LOCATION` | Código de ubicación + barcode `LOC-…`, tipo, zona, nivel, capacidad |
| `CASE` | SKU, barcode de caja, contenido (piezas por caja), familia |
| `ORDER` | Pedido, cliente, destino, líneas, piezas, prioridad |
| `STAGING` | Carril + pedido asignado + cliente + destino |
| `SHIPMENT` | Embarque, transportista, unidad, placas, chofer, pedidos, destino |

Impresión automática: al crear un LPN durante la recepción se envía su etiqueta a la impresora por defecto (setting `auto_print_lpn_labels`). Además puede imprimirse desde la pantalla de recepción, el detalle de LPN o **Etiquetas**.

## Previsualización
`POST /api/labels/preview` genera el ZPL y un PNG del código de barras y del QR (bwip-js) a partir del mismo modelo. La pantalla muestra la etiqueta renderizada y el ZPL. Opcionalmente puede pegarse el ZPL en https://labelary.com para ver el render exacto de Zebra.

## Reimpresión
Si ya existe una impresión exitosa de la misma etiqueta, volver a imprimir es una **reimpresión**: requiere el permiso `labels.reprint` y un motivo; queda en `label_prints` (`is_reprint`, `reprint_reason`, usuario) y en la auditoría (`label.reprint`). El historial está en `Etiquetas → Historial`.

## Codificación
ZPL con `^CI28` (UTF-8). Caracteres especiales se escapan en hexadecimal (`^FH`), por lo que descripciones con acentos/ñ imprimen correctamente en firmware reciente. Símbolos `^ ~ \ _` se escapan siempre.

## Escáneres
Los lectores (USB HID o terminales Zebra TC/MC en modo teclado) deben enviar `Enter` tras el código. El campo de escaneo del modo almacén conserva el foco y descarta escaneos idénticos en menos de 400 ms (doble disparo).
