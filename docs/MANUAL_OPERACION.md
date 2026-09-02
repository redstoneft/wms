# Manual de operación (personal de piso)

Todas las pantallas de piso están en **Modo Almacén** (botón en la parte superior o menú `Almacén`). Reglas generales:

* El cuadro de escaneo siempre está activo: escanee y listo (no toque la pantalla para escribir).
* **Verde + bip corto = correcto.** **Rojo + bip largo = error**: lea el mensaje, pulse **OK** y corrija. El sistema nunca deja pasar un error "a la fuerza": si algo no cuadra, avise al supervisor.
* Nunca marque nada como terminado a mano: el sistema lo hace cuando las cantidades coinciden.
* Si se va el Wi-Fi verá una barra naranja "Sin conexión". Espere a que vuelva; el escaneo pendiente se reenvía solo y **no se duplica**.

---

## RECEPCIÓN

1. `Almacén → Recibir`. Elija la recepción abierta (contenedor). Si no existe, el supervisor la crea desde oficina.
2. Escanee el **código de barras del producto** (caja o pieza). La pantalla muestra SKU y descripción.
3. Teclee la **cantidad** y la unidad (CAJAS / PIEZAS). Pulse **NUEVO PALLET** para iniciar un pallet o **MISMO PALLET** para agregar al pallet actual (pallet mixto).
4. El sistema crea el **LPN** (`PLT-2026-00000184`) e imprime la etiqueta automáticamente. Péguela en el pallet **antes** de moverlo.
5. Producto golpeado: marque **DAÑADO** antes de escanear la cantidad; se registra aparte y se abre una incidencia.
6. Al terminar el pallet: **CERRAR PALLET** (ya no acepta más producto y queda listo para ubicar).
7. Al terminar el contenedor: **COMPLETAR RECEPCIÓN**. Si hay faltantes o sobrantes aparecerá la comparación *Esperado vs Recibido*; confirme para que se generen las incidencias.

Errores comunes: `Código no encontrado` (producto sin código de barras registrado → avisar a inventarios), `SKU no esperado` (se recibe pero queda marcado con incidencia).

## PUT-AWAY (ubicar pallets)

1. `Almacén → Ubicar`. Escanee el **LPN** del pallet.
2. La pantalla muestra en grande la **ubicación destino** (p. ej. `A-03-R05-N02-P04`) y el contenido.
3. Lleve el pallet y escanee la **etiqueta de la ubicación**.
4. Verde: pallet ubicado. Rojo `UBICACIÓN INCORRECTA`: está en el lugar equivocado; vaya a la ubicación indicada. Si no puede (rack ocupado/dañado), pida al supervisor una **autorización de override** y vuelva a escanear la nueva ubicación.
5. Nunca deje un pallet sin escanear su ubicación: para el sistema seguiría en el andén.

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

## INCIDENCIAS

Cualquier operador puede **reportar** (`Incidencias → Nueva`): tipo (faltante, sobrante, SKU incorrecto, dañado, diferencia, ubicación incorrecta, etiqueta, pallet perdido, error de surtido/carga, otro), descripción, foto. Ponga siempre el LPN o la ubicación. El supervisor asigna y resuelve.

## Qué NO hacer
* Mover un pallet sin escanear destino.
* Tapar o despegar etiquetas de LPN; si se daña, pida **reimpresión** (queda registrada).
* Usar la cuenta de otro compañero: cada movimiento queda a nombre de quien está conectado.
* Teclear códigos a mano cuando se puede escanear.
