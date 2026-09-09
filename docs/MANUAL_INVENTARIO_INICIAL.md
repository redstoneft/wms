# Manual de llenado · Archivo de inventario inicial

Para la persona que captura el conteo físico y lo carga al WMS. Plantilla: **Importaciones → tipo `INITIAL_INVENTORY` → Descargar plantilla Excel (con catálogo de SKUs)**.

## 1. Qué trae el archivo

| Pestaña | Para qué sirve |
|---|---|
| `INITIAL_INVENTORY` (primera) | **La única que se captura.** Una fila por producto contado en una ubicación |
| `SKUs` | Catálogo de nuestros productos: Código WMS, descripción, GTIN, todas las claves de SAE (alias), piezas por caja, cajas por pallet, si requiere lote o caducidad |
| `Ubicaciones` | Todos los códigos de ubicación que existen (los mismos que dicen las etiquetas de los racks) |
| `Instrucciones` | Resumen de cada columna y los pasos |

El sistema solo lee la primera pestaña. Las demás son de consulta: no se borran ni se editan, pero tampoco importa lo que tengan.

## 2. Columnas de la pestaña `INITIAL_INVENTORY`

| Columna | Obligatoria | Qué se escribe | Ejemplo |
|---|---|---|---|
| `location_code` | Sí | **Escanea la etiqueta del hueco directamente**: el lector escribe `LOC-ALM-A-R01-N01-P01` y así se acepta. También vale escribir el código sin `LOC-` | `LOC-ALM-A-R01-N01-P01` |
| `sku` | Sí | Clave de SAE tal como viene en la caja, GTIN o Código WMS. Cualquiera de la pestaña SKUs | `636570` |
| `qty` | Sí | Cantidad contada, entero, en la unidad de `uom_code` | `40` |
| `uom_code` | No | `PIECE` piezas (vacío = piezas), `CASE` cajas, `INNER`, `PALLET` | `CASE` |
| `pieces_per_case` | Si `CASE` | Piezas que trae cada caja contada **en esa fila**. El mismo artículo puede venir con distinto factor de empaque, por eso se escribe aquí. Vacío = se usa "Piezas por caja" del catálogo | `6` |
| `lot` | Según SKU | Lote impreso en el producto; obligatorio si la pestaña SKUs dice "Requiere lote = SÍ" | `L2409` |
| `expiry_date` | Según SKU | Caducidad `AAAA-MM-DD`; obligatoria si "Requiere caducidad = SÍ" | `2027-03-31` |
| `lpn` | No | Nombre de la tarima. Vacío = una tarima nueva por fila. El mismo texto en varias filas = tarima mixta | `TARIMA-07` |

Reglas:

* No mover ni renombrar los encabezados de la fila 1. Sin filas vacías intermedias.
* `qty` sin decimales, sin comas ni letras. Si contaste cajas: `uom_code = CASE`, `qty` = número de cajas y `pieces_per_case` = piezas por caja de esa fila. Piezas guardadas = `qty × pieces_per_case`. Si el mismo artículo está en cajas de 6 y en cajas de 12, son dos filas.
* Las celdas de `sku`, `location_code`, `lot` y `lpn` están en formato texto para que Excel no quite ceros ni convierta a número. No cambiar el formato de la columna.
* Una ubicación puede tener varias filas (varios productos en el mismo hueco). Cada fila, o cada grupo con el mismo `lpn`, se convierte en una tarima real con etiqueta LPN.

## 3. Cómo encontrar el SKU

1. En la pestaña `SKUs` usa **Buscar (Ctrl+F)** con la clave que trae la caja o el GTIN del código de barras.
2. La columna "Claves SAE / alias" trae todas las claves que SAE usa para ese mismo producto (`636570`, `.SIC20G`, `SIC20G-GRIS-1`…). Cualquiera de ellas se puede escribir en `sku`; también el Código WMS o el GTIN.
3. Si al escribir el `sku` Excel muestra una advertencia amarilla, es normal cuando escribiste una clave de SAE o un GTIN: acepta. Si escribiste algo que no aparece en la pestaña SKUs, corrígelo.
4. Si la clave no está en ninguna parte, ese producto no existe en el WMS: anótalo aparte y avisa al supervisor. No lo inventes.

La lista de `location_code` contiene las etiquetas tal como las escribe el lector (`LOC-…`); si escribes el código sin `LOC-` Excel avisa, acepta y sigue. `uom_code` sí bloquea valores incorrectos.

## 4. Cómo llenar el conteo

1. Recorre rack por rack en el mismo orden de las etiquetas: módulo 1, columna izquierda de abajo hacia arriba, luego la derecha.
2. En cada hueco con mercancía: escribe el `location_code` de la etiqueta, la clave de la caja en `sku`, la cantidad y la unidad. Si hay más de un producto en el hueco, una fila por producto; si comparten tarima, mismo `lpn`.
3. Huecos vacíos no se capturan.
4. Al terminar guarda como `.xlsx` (no CSV, no Google Sheets sin descargar).

## 5. Subir y validar

1. WMS → **Importaciones** → tipo `INITIAL_INVENTORY` → seleccionar el archivo → **Validar**.
2. Si hay errores, aparece una tabla con fila, columna y error. Nada se cargó. Corrige exactamente esas filas, guarda y vuelve a validar.
3. Cuando diga "Sin errores", **Aplicar**. Un mismo archivo no se puede aplicar dos veces.
4. Después: **Etiquetas → LPN** para imprimir la etiqueta de cada tarima creada y pegarla en la tarima.

| Error que marca | Causa | Corrección |
|---|---|---|
| `unknown location` | El código no existe o tiene un typo (con o sin `LOC-` da igual) | Volver a escanear la etiqueta o copiar el código de la pestaña Ubicaciones |
| `unknown sku` | La clave no está en ninguna pestaña SKUs ni alias | Buscar en SKUs; si no existe, avisar |
| `must be a positive integer` | `qty` con decimales, comas o texto | Solo números enteros |
| `sku X requires lot` / `requires expiry` | El SKU exige lote o caducidad | Llenar `lot` o `expiry_date` (formato `AAAA-MM-DD`) |
| `sku X has no default pieces per case; fill pieces_per_case` | Contaste cajas y el catálogo no tiene factor para ese producto | Escribir `pieces_per_case` en la fila |
| `pieces_per_case only applies with uom_code = CASE` | Llenaste piezas por caja pero la unidad es piezas | Poner `uom_code = CASE` si contaste cajas, o borrar `pieces_per_case` |
| `must be YYYY-MM-DD` | Caducidad con otro formato o Excel la volvió fecha | Escribir `2027-03-31` con la columna en formato texto |

## 6. Antes de aplicar

* Todos los racks recorridos; ningún hueco con mercancía sin fila.
* Cantidades en la unidad correcta (piezas vs. cajas).
* Lotes y caducidades en los SKUs que lo requieren.
* Validación sin errores; respaldo del archivo guardado con fecha.
