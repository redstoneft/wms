# Manual de operación (personal de piso)

Todas las pantallas de piso están en **Modo Almacén** (botón en la parte superior o menú `Almacén`). Reglas generales:

* El cuadro de escaneo siempre está activo: escanee y listo (no toque la pantalla para escribir).
* **Verde + bip corto = correcto.** **Rojo + bip largo = error**: lea el mensaje, pulse **OK** y corrija. El sistema nunca deja pasar un error "a la fuerza": si algo no cuadra, avise al supervisor.
* Nunca marque nada como terminado a mano: el sistema lo hace cuando las cantidades coinciden.
* Si se va el Wi-Fi verá una barra naranja "Sin conexión". Espere a que vuelva; el escaneo pendiente se reenvía solo y **no se duplica**.

---

## RECEPCIÓN

Recepción abierta por error (sin pallets recibidos): el supervisor la cancela desde la oficina (`Recepciones → detalle → Cancelar recepción`, con motivo). El folio no se reutiliza y la cancelación queda en auditoría; no afecta inventario.

1. `Almacén → Recibir`. Elija la recepción abierta (contenedor). Si no existe, el supervisor la crea desde oficina.
2. Escanee el **código de barras del producto** (caja o pieza). La pantalla muestra SKU y descripción.
3. Teclee la **cantidad** y la unidad (CAJAS / PIEZAS). Pulse **NUEVO PALLET** para iniciar un pallet o **MISMO PALLET** para agregar al pallet actual (pallet mixto).
4. El sistema crea el **LPN** (`PLT-2026-00000184`) e imprime la etiqueta automáticamente. Péguela en el pallet **antes** de moverlo.
5. Producto golpeado: marque **DAÑADO** antes de escanear la cantidad; se registra aparte y se abre una incidencia.
6. Al terminar el pallet: **CERRAR PALLET** (ya no acepta más producto y queda listo para ubicar).
7. Al terminar el contenedor: **COMPLETAR RECEPCIÓN**. Si hay faltantes o sobrantes aparecerá la comparación *Esperado vs Recibido*; confirme para que se generen las incidencias.

**Me equivoqué (producto escaneado dos veces, cantidad de más):** en la pantalla del pallet registrado, botón **Me equivoqué: deshacer este registro**; o en la pantalla de escaneo, en *Contenido del pallet actual*, toque **✕ Quitar** junto al producto e indique cuántas piezas quitar (todas = el producto sale del pallet). Se puede corregir mientras el pallet siga en el andén, aunque ya esté cerrado; si el pallet queda vacío se cancela. Una vez ubicado en rack ya no se corrige aquí: use *Re-recibir tarima* o un conteo.

Errores comunes: `Código no encontrado` (producto sin código de barras registrado → avisar a inventarios), `SKU no esperado` (se recibe pero queda marcado con incidencia).

## PUT-AWAY (ubicar pallets)

1. `Almacén → Ubicar`. Escanee el **LPN** del pallet.
2. La pantalla muestra en grande la **ubicación destino** (p. ej. `A-03-R05-N02-P04`) y el contenido.
3. Lleve el pallet y escanee la **etiqueta de la ubicación**.
4. Verde: pallet ubicado. Rojo `UBICACIÓN INCORRECTA`: está en el lugar equivocado; vaya a la ubicación indicada. Si no puede (rack ocupado/dañado), pida al supervisor una **autorización de override** y vuelva a escanear la nueva ubicación.
5. **Elegir otro destino sin autorización:** antes de escanear, **Otra ubicación (automática)** pide al sistema el siguiente mejor hueco, y **Elegir ubicación de la lista** muestra un menú con las ubicaciones que aceptan el pallet (primero las que ya tienen ese producto, con ocupación `n/capacidad`). Al elegir una, esa pasa a ser el destino y se confirma escaneándola. Solo aparecen ubicaciones válidas (tipo, capacidad, peso, compatibilidad), por eso no requiere supervisor.
6. Nunca deje un pallet sin escanear su ubicación: para el sistema seguiría en el andén.

## PICKING (surtido)

1. `Almacén → Surtir` → **Mis tareas** → elija la tarea (pedido) → **INICIAR**.
2. Por cada línea, en orden de ruta:
   * Escanee la **UBICACIÓN** indicada.
   * Escanee el **LPN** del pallet (o el código del producto).
   * Teclee la **CANTIDAD** tomada (cajas/piezas).
3. Si el sistema pide un pallet completo, escanee el LPN y confirme la cantidad total: ese pallet será el que se embarca.
4. Si es parcial, el producto va al **pallet de salida** que indica la pantalla (LPN nuevo): pegue su etiqueta.
5. Errores: `UBICACIÓN INCORRECTA`, `SKU INCORRECTO`, `CANTIDAD EXCEDIDA` bloquean y suenan. Corrija y repita.
6. Si no hay producto suficiente en la ubicación: **no invente cantidades**. Pulse **FALTA PRODUCTO** para avisar; el supervisor cerrará la línea como corta y se abrirá una incidencia.
7. La tarea termina sola cuando todas las líneas están completas.

## STAGING

1. `Almacén → Staging`. Escanee el **LPN** del pallet surtido.
2. Escanee el **carril de staging** que indica la pantalla (cada pedido tiene el suyo). Carril equivocado = rojo.
3. Cuando todos los pallets del pedido están en su carril, el pedido pasa a *Listo para verificar*.

## VERIFICACIÓN (doble validación)

Quien verifica **no puede ser quien surtió**. Si el sistema le dice `SURTIDOR = VERIFICADOR`, pida a otro compañero o al supervisor.

1. `Almacén → Verificar` → pedido → **INICIAR**.
2. Por cada pallet del carril: escanee el **LPN**, escanee el **producto**, teclee la **cantidad** que ve. El sistema no muestra lo esperado (conteo ciego).
3. Cuando todo cuadra, **COMPLETAR** → *VERIFICADO*. Si algo no coincide: *FALLIDA*, se abre una incidencia y el supervisor decide (resurtir o corregir).

## CARGA DEL CAMIÓN

1. `Almacén → Cargar` → elija el embarque (transportista, placas).
2. Escanee cada **LPN** al subirlo al camión. La pantalla muestra cargado/pendiente por pedido.
3. Pallet ya cargado → `YA CARGADO`. Pallet de otro pedido/embarque → `EMBARQUE INCORRECTO` (se abre incidencia). Pedido sin verificar → no se puede cargar.
4. Si subió un pallet por error: **DESCARGAR** (motivo obligatorio) y vuelva a dejarlo en su carril.
5. La **liberación** la hace el supervisor: solo es posible cuando **cada SKU de cada pedido** tiene cargado exactamente lo requerido. Un total coincidente no basta.

## INVENTARIOS CÍCLICOS

1. `Almacén → Contar` → tarea asignada.
2. En cada ubicación: escanee la **ubicación**, el **LPN**, el **producto** y teclee lo que **realmente ve** (no verá la cantidad del sistema).
3. Al terminar: **FINALIZAR**. Si hay diferencias, otra persona hará el **recuento**. Los ajustes los aprueba el supervisor; nada cambia solo.

## TRANSFERENCIAS Y REABASTO

1. `Almacén → Mover`: escanee el **LPN** y la **ubicación destino** → el pallet queda *en tránsito*.
2. Al llegar, escanee el **LPN** y la **ubicación** → completado. Destino equivocado = rojo. Si no puede completar, pida cancelar (el pallet vuelve a su origen).
3. Reabasto: `Almacén → Reabasto` muestra las caras de picking bajas; **INICIAR** indica qué pallet de reserva llevar; el resto es igual a una transferencia.

## CONSULTAR (qué contiene una tarima o una ubicación)

`Almacén → Consultar`: escanee un **LPN** y verá su ubicación, estado, lote/caducidad, pedido o recepción, y cada producto con sus piezas. Escanee una **etiqueta de ubicación** y verá las tarimas que hay en ese hueco con su contenido. Solo consulta: no mueve nada.

## CAPTURAR PEDIDO (pedido manual desde el handheld)

`Almacén → Capturar pedido`: número de pedido (la orden de compra del cliente), cliente, y luego escanee cada producto y teclee la cantidad (piezas o cajas); escrito el motivo, **Guardar y surtirlo ahora** (asigna inventario y abre la tarea de surtido a su nombre) o **Solo guardar** (queda aceptado para surtirse después desde Surtir o Nueva tarea). El pedido aparece en la oficina como cualquier otro.

## RE-RECIBIR UNA TARIMA (tarima revuelta o mal capturada)

`Almacén → Re-recibir tarima` (también desde Nueva tarea): escanee el **LPN**, luego escanee **cada producto que trae de verdad** y teclee su cantidad (lo que no escanee se toma como que no está), escriba el motivo y registre. Si su rol aprueba ajustes (supervisor, control de inventarios), el sistema corrige la tarima al momento, con incidencia y auditoría. Si no, queda como **conteo terminado** en esa ubicación: otra persona lo recuenta en `Conteo` y el supervisor lo aprueba; el inventario cambia hasta entonces.

**Nueva recepción desde el handheld**: `Nueva tarea → Recibir mercancía`, escriba el motivo y listo: la recepción se abre en el andén de recibo del almacén (el que esté libre) y pasa directo a `Recibir`. No hay que escanear el andén.

## NUEVA TAREA (el operador crea su propia tarea)

`Almacén → Nueva tarea` permite empezar trabajo sin esperar a que el supervisor lo asigne: **recibir mercancía** (abre una recepción en el andén que escanee), **surtir un pedido** (escanee o escriba el número; si el pedido ya existe el sistema asigna inventario y la tarea queda a su nombre; si **no existe**, elija el cliente y el pedido se crea ahí mismo en **surtido libre**), **contar una ubicación** (conteo a ciegas de ese hueco) o **ubicar una tarima** que quedó sin tarea de acomodo. Siempre pide **para qué** se hace (mínimo 5 letras): queda en la tarea y en la auditoría con su usuario. Solo puede crear tareas del tipo que su rol ejecuta.

## ELEGIR LA TARIMA AL SURTIR

En cualquier paso de una línea de surtido, el botón **Tomar de otra tarima** muestra una lista con las demás tarimas que tienen ese producto (LPN, ubicación, piezas disponibles). Al elegir una, la línea se reasigna a esa tarima y el surtido sigue en su ubicación; la tarima original vuelve a quedar disponible.

**Buscar un producto por nombre**: en los campos de producto del handheld (surtido libre, capturar pedido, re-recibir) se puede escanear la caja o escribir dos o más letras de la clave o del nombre; aparece la lista de coincidencias y se elige con un toque.

**Cuando la tarima no alcanza** (por ejemplo la línea pide 30 y en la tarima solo hay 18): en el paso de cantidad se surte lo que hay (18). La línea queda abierta con lo que falta y aparece el botón **Tomar el resto (12) de otra tarima**. Al elegir la otra tarima, lo ya surtido queda registrado de la primera y el resto se convierte en una **línea nueva** en la tarima elegida (con su ubicación y LPN). Si la segunda tampoco alcanza, se surte lo que tenga y se repite con una tercera. En cada división el sistema levanta una incidencia de *diferencia de inventario* sobre la tarima que no alcanzó, para que se revise su existencia real.

En **surtido libre**, además de escanear un LPN, se puede escanear o escribir el **producto**: aparece la lista de tarimas que lo tienen para elegir una.

## SURTIDO COMPARTIDO (varias personas en el mismo pedido)

En `Surtir` todos los surtidores ven todos los pedidos abiertos, con el nombre de quien lo empezó. Cualquiera puede entrar al mismo pedido: cada línea (o tarima, en surtido libre) queda a nombre de quien la escanea y el sistema no deja que dos personas trabajen la misma línea; el handheld le propone a cada uno la siguiente línea libre. El pedido se cierra cuando todas las líneas están surtidas (o, en surtido libre, cuando alguien lo cierra). Si no hay carril de staging libre, el surtido sigue igual: el carril se asigna cuando se libera uno o, si no, el carril donde llegue la primera tarima queda como carril del pedido (un carril ocupado por otro pedido se rechaza).

## SURTIDO LIBRE (pedido armado con el escáner, en varios momentos)

Para pedidos que no vienen de la plataforma: en `Nueva tarea → Surtir` con un número nuevo, elija el cliente y escriba para qué. La tarea queda en `Surtir` marcada **SURTIDO LIBRE**.

1. Escanee la **tarima** que va al pedido. Si es de un solo producto, elija **Tarima completa** o **Solo una cantidad…** (piezas o cajas); si es mixta, solo completa.
2. Cada tarima escaneada queda asignada y surtida al pedido en ese momento; las líneas del pedido se construyen con lo que escanea.
3. Puede **Guardar y seguir después**: la tarea sigue en "Mis tareas" y se puede continuar otro día. Nadie más la ve como pendiente.
4. Al terminar, **Cerrar surtido**: el pedido queda surtido y sigue el flujo normal (staging, verificación, carga). No se puede cerrar sin al menos una tarima.
5. **Editar**: en la lista de tarimas surtidas, **Quitar** regresa esa tarima (o esa cantidad) a su lugar en el inventario; para cambiar una cantidad, quítela y vuelva a escanearla.
6. **Eliminar el surtido**: botón rojo al final, pide el motivo. Todo lo escaneado regresa al inventario, la tarea se cancela y, si el pedido nació en el handheld, el pedido queda cancelado. Queda en auditoría con su usuario.

## ARMADO (insumo → producto terminado)

Cuando un insumo se transforma en producto terminado (cuerpos de sartén en master de 24 → sartenes armados en cajas de 12) el pallet de insumo **se consume** y **nacen pallets nuevos**, aunque salgan más tarimas de las que entraron. Si el cuerpo y el sartén armado **usan la misma clave** (caso actual), el sistema lo registra como **reempaque**: la existencia no cambia, solo el empaque y el número de tarimas.

**Cuerpos sin armar**: al recibirlos, bloquee el pallet (`Inventario → LPN → Bloquear`, motivo "sin armar") para que el surtido nunca lo tome como producto terminado. El armado consume pallets bloqueados sin necesidad de desbloquearlos; las tarimas nuevas nacen disponibles.

1. Lleve el pallet de insumo a la **estación de armado** (zona `ARM`) con un traslado normal.
2. `Almacén → Armado`: escanee la **estación**, luego cada **LPN de insumo** y las **piezas consumidas** (puede agregar varios: mangos, tornillería). "Listo, sin más insumos".
3. Escanee el **producto terminado** (caja, clave SAE o GTIN) y capture **tarimas**, **cajas por tarima** y **piezas por caja** de este armado (el factor de empaque es de la corrida, no del catálogo).
4. **Merma**: si se consumieron más piezas de las que salieron, capture la diferencia y el motivo; queda como incidencia. Con un solo insumo la cuenta debe cuadrar: consumido = producido + merma.
4b. **Para qué**: escriba el motivo del armado (obligatorio, mínimo 5 letras); queda en la orden y en la auditoría.
5. Confirme. El sistema crea los LPN nuevos: **imprima y pegue** cada etiqueta en su tarima. Cada tarima trae ya su **tarea de acomodo**: en `Ubicar`, escanee el LPN y llévelo a donde indique.

El pallet de insumo que quedó en cero aparece como `CONSUMIDO`; si sobraron piezas, sigue disponible en su ubicación.

## INCIDENCIAS

Cualquier operador puede **reportar** (`Incidencias → Nueva`): tipo (faltante, sobrante, SKU incorrecto, dañado, diferencia, ubicación incorrecta, etiqueta, pallet perdido, error de surtido/carga, otro), descripción, foto. Ponga siempre el LPN o la ubicación. El supervisor asigna y resuelve.

## Qué NO hacer
* Mover un pallet sin escanear destino.
* Tapar o despegar etiquetas de LPN; si se daña, pida **reimpresión** (queda registrada).
* Usar la cuenta de otro compañero: cada movimiento queda a nombre de quien está conectado.
* Teclear códigos a mano cuando se puede escanear.

### Impresora Zebra por USB desde el navegador

Si la PC de la Zebra usa otra app de etiquetas por WebUSB (driver WinUSB), la estación del WMS se abre en Chrome/Edge en esa PC: Impresoras → Generar token → **Abrir estación USB con este token** → Elegir la Zebra; después se conecta sola cada vez que se abre (y al prender la PC con `estacion_wms.bat` en la carpeta Inicio). Detalle en `docs/ZEBRA_SETUP.md`.
