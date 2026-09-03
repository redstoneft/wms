# Manual de etiquetado de racks · Nave HIDRO

Para la persona que pega las etiquetas, ya impresas. Total: **501 etiquetas en 8 racks** (zona `ALM`, almacén general).

## 1. Qué dice cada etiqueta

Código de ejemplo: `ALM-A-R01-N02-P05`

| Parte | Significado |
|---|---|
| `ALM` | Zona: almacén general |
| `A` | Rack (letra A a F, X, Z) |
| `R01` | Siempre 01 |
| `N02` | Nivel: N01 abajo, N02 en medio, N03 arriba |
| `P05` | Posición (hueco de tarima); cuenta sin reiniciar a lo largo del rack |

Debajo del código va el código de barras `LOC-…`. Las etiquetas impresas en hoja traen además "Módulo n · Pos n".

**De la posición al módulo** (racks de 2 tarimas por módulo): número impar a la izquierda y par a la derecha viendo el rack de frente; módulo = mitad redondeada hacia arriba (P01/P02 → módulo 1, P03/P04 → módulo 2, P05 → módulo 3). En el rack Z (3 tarimas): P01, P02, P03 de izquierda a derecha.

## 2. Racks y etiquetas

| Rack | Módulos | Niveles | Etiquetas | Dónde está · dónde empieza el módulo 1 |
|---|---|---|---|---|
| `ALM-A` | 17 | 3 | 102 | Muro exterior derecho. Módulo 1 en el extremo del frente (portones), crece hacia el fondo |
| `ALM-B` | 11 | 3 | 66 | Doble con C, en medio de la pata. Módulo 1 del lado del frente |
| `ALM-C` | 11 | 3 | 66 | Espalda con B. Módulo 1 del lado del frente |
| `ALM-D` | 11 | 3 | 66 | Doble con E, junto al pasillo del medianero. Módulo 1 del lado del frente |
| `ALM-E` | 11 | 3 | 66 | Espalda con D. Módulo 1 del lado del frente |
| `ALM-F` | 14 | 3 | 84 | Muro medianero con los vecinos. Módulo 1 del lado del frente |
| `ALM-X` | 7 | 3 | 42 | Muro del fondo, mitad izquierda. Módulo 1 en el extremo izquierdo, crece hacia el rack A |
| `ALM-Z` | 1 | 3 | 9 | Pegado a las oficinas, lado de los portones. Un módulo de 3 tarimas |

**Cuenta antes de pegar.** Si un rack tiene más o menos módulos que la tabla, no pegues nada de ese rack y avisa al supervisor: se corrige el sistema y se reimprime.

## 3. Dónde se pega

* **N01 y N02**: en la viga frontal del nivel, en la esquina izquierda de cada posición, justo debajo del hueco que nombra.
* **N03**: no se sube. En el poste frontal del módulo, a la altura de los ojos, arriba de la etiqueta de N02 del mismo lado.
* Superficie limpia y seca; presionar 5 segundos de extremo a extremo; horizontal, sin arrugas, código de barras completo, sin cinta encima; nunca sobre otra etiqueta, soldaduras o tornillos; del lado por donde entra el montacargas.

## 4. Orden de trabajo

1. Empezar por el rack **Z** (9 etiquetas) para practicar; luego A, B, C, D, E, F y al final X.
2. Frente al módulo 1: `N01-P01`, `N01-P02`, `N02-P01`, `N02-P02`, y las dos de `N03` en el poste.
3. Módulo 2: `P03` y `P04` en cada nivel, y así hasta el último módulo.
4. Al terminar cada rack, verificar (sección 5) antes de pasar al siguiente.

Si una etiqueta no corresponde al hueco donde estás, detente y revisa desde el módulo 1.

## 5. Verificar con la terminal

1. Entrar al WMS → **Mapa 3D**.
2. En el buscador elegir **Ubicación**, poner el cursor en el campo y **escanear la etiqueta** (`LOC-ALM-A-R01-N01-P01`); la búsqueda se lanza sola.
3. El mapa vuela a la posición y la resalta: confirmar rack, módulo y nivel.
4. Verificar las 6 etiquetas del primer módulo y las 6 del último de cada rack; después una al azar cada dos módulos intermedios.

| Qué pasa | Qué hacer |
|---|---|
| No lee | Limpiar; si sigue, anotar para reimpresión sin despegar |
| "Sin resultados" | La etiqueta no existe en el sistema: anotar y avisar |
| Muestra otro rack o módulo | Despegar, desechar y pedir reimpresión de esa posición |
| Sobran etiquetas | Nunca pegar de más; entregarlas al supervisor con el rack anotado |

Las reimpresiones las hace el supervisor en **Etiquetas** con motivo; quedan registradas.

## 6. Hoja de control

| Rack | Etiquetas | Pegadas | Verificadas | Para reimprimir | Fecha y firma |
|---|---|---|---|---|---|
| Z | 9 | | | | |
| A | 102 | | | | |
| B | 66 | | | | |
| C | 66 | | | | |
| D | 66 | | | | |
| E | 66 | | | | |
| F | 84 | | | | |
| X | 42 | | | | |

Antes de entregar: todos los racks completos y sin sobrantes; primer y último módulo de cada rack verificados con escáner; lista de reimpresión entregada; ninguna etiqueta sobre tornillos, soldaduras u otra etiqueta. Firma quien etiquetó y quien revisó.

## 7. Materiales y tiempo

Las 501 etiquetas ordenadas por rack; trapo seco; escalera de dos peldaños para N02 (~1.8 m); lápiz y esta hoja; terminal con escáner o computadora con lector. Unas 3 horas en total; no se necesita montacargas.
