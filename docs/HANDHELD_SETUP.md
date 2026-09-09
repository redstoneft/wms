# Instalación de handhelds (Bisofice K57 · Android)

El WMS no se instala como APK: es una aplicación web que se **agrega a la pantalla de inicio** desde Chrome y abre a pantalla completa en `https://wms.104-248-116-147.sslip.io/wm` (modo almacén). Tiempo por equipo: 10 minutos.

## 1. Android

1. Encender, conectar al **Wi-Fi de la bodega** (misma red donde imprimen las Zebra no es necesaria: el servidor imprime, no el handheld). Marcar la red como "no medida" para que no bloquee datos.
2. Ajustes → Pantalla: **tiempo de espera 10 min** o más; brillo automático apagado si están en zonas oscuras.
3. Ajustes → Fecha y hora: **automática** (la sesión depende de la hora correcta).
4. Ajustes → Idioma: Español (México). Teclado: dejar Gboard, pero **desactivar "sugerencias" y "corrección automática"** (Ajustes → Sistema → Idiomas → Gboard → Corrección de texto) para que no altere claves ni lotes.
5. Google Play → Chrome → **Actualizar**. Si el equipo no trae Play, usar el Chrome que viene y no cambiarlo.

## 2. Escáner (modo teclado)

Abrir la app del lector (en la K57 se llama "Scan Settings" / "Configuración de escaneo"):

| Ajuste | Valor |
|---|---|
| Modo de salida | **Teclado / Keyboard** (no Broadcast, no Clipboard) |
| Sufijo / terminador | **Enter** (`\n`). El WMS toma el Enter como "listo" |
| Prefijo | Ninguno |
| Sonido y vibración | Activados |
| Modo continuo | Apagado |
| Códigos habilitados | Code 128, EAN-13, EAN-8, UPC-A, QR, DataMatrix |
| Tecla de escaneo | Botón lateral (gatillo) |

Prueba: abrir el Bloc de notas o la barra de Chrome y escanear una etiqueta de rack: debe escribir `LOC-ALM-A-R01-N01-P01` y saltar de línea.

## 3. Agregar el WMS a la pantalla de inicio

1. Chrome → `https://wms.104-248-116-147.sslip.io/wm`.
2. Menú ⋮ → **Agregar a pantalla principal** (o "Instalar app") → nombre `WMS` → Agregar.
3. Cerrar Chrome y abrir desde el ícono **WMS**: debe abrir sin barra de direcciones, fondo oscuro, botones grandes.
4. Dejar el ícono en la pantalla principal; quitar los que no se usan (Play Store, YouTube…) para que el operador no se distraiga.

## 4. Usuario por operador

Cada persona entra con **su** usuario: la auditoría registra quién hizo cada movimiento.

1. En oficina, `Administración → Usuarios → Nuevo`: usuario corto (`jperez`), nombre completo, rol según lo que hace, contraseña temporal. Roles: `RECEIVING` recibe y arma, `FORKLIFT` ubica y traslada, `PICKER` surte, `VERIFIER` verifica, `LOADER` carga, `INVENTORY_CONTROL` cuenta, ajusta y arma, `SUPERVISOR` todo lo operativo.
2. En el handheld: abrir WMS → usuario y contraseña → configurar el **2FA** (escanear el QR con Google Authenticator en el mismo handheld o en el teléfono del operador) → marcar **"Confiar en este dispositivo 30 días"**. Después solo pide contraseña.
3. Cambiar la contraseña temporal en `Mi cuenta`.
4. La sesión dura 12 horas; al terminar el turno tocar **Salir** para que el siguiente entre con su usuario.

## 5. Prueba de aceptación por equipo

1. Modo almacén → **Ubicar**: escanear una etiqueta de rack → debe leerse sin teclear nada.
2. **Traslados** → escanear un LPN existente → debe mostrar su contenido.
3. **Armado** → escanear la estación `LOC-HID-ARM-01` → debe pasar al paso 2.
4. Poner el equipo en reposo 5 minutos, despertar y volver a escanear: la sesión sigue activa.
5. Anotar en la etiqueta del equipo: número (HH-01, HH-02…), usuario asignado y fecha.

## 6. Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| Escanea pero no pasa nada | El lector no manda Enter, o el foco no está en el campo | Sufijo Enter en Scan Settings; tocar el campo "Escanea…" |
| Escribe el código con letras cambiadas | Autocorrección de Gboard | Desactivar corrección de texto (paso 1.4) |
| Pide 2FA cada vez | No se marcó "confiar en este dispositivo" o se borraron datos de Chrome | Volver a marcarlo al entrar; no usar modo incógnito |
| "Sin conexión" en la barra | Wi-Fi cayó; la app espera y reintenta | Verificar cobertura; los movimientos no se pierden, se reintentan |
| Abre con barra de direcciones | Se abrió desde Chrome y no desde el ícono | Usar el ícono WMS de la pantalla principal |
| Etiqueta no imprime | Impresora Zebra apagada o sin red | El servidor imprime por IP; revisar en `Etiquetas → Impresoras` |
