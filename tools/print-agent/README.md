# Estación de impresión WMS (Zebra por USB)

Para impresoras Zebra conectadas por USB a una PC (sin red). La PC corre este agente: cada 3 s pregunta al WMS si hay etiquetas para su impresora, las imprime por la cola RAW de Windows y reporta. No abre puertos.

1. En el WMS: Datos maestros → Impresoras → Nueva → modo **Estación (USB)** → guardar → **Generar token** (se muestra una sola vez).
2. En la PC: instalar Python 3.10+ (marcar *Add Python to PATH*), copiar a `C:\wms-print\` el `run_agent.bat` descargado del WMS (ya trae el token) y `wms_print_agent.py`. Las librerías `requests` y `pywin32` se instalan solas la primera vez que se ejecuta.
3. Doble clic en `run_agent.bat`. Debe decir "Impresora WMS: … · 0 en cola".
4. Arranque automático: acceso directo de `run_agent.bat` en `shell:startup`.

El WMS muestra en Impresoras la última vez que la estación se conectó y desde qué PC. Una etiqueta que la estación no confirma en 2 minutos vuelve a la cola.

## Si dice "impresa" pero no sale nada

1. Doble clic en `prueba_impresora.bat` (se descarga junto con `run_agent.bat`): manda una etiqueta de prueba directo a la cola de Windows.
2. En la ventana de la estación revisa la línea "Impresora Windows: … (puerto USBxxx)". Si hay varias Zebra instaladas, fija la correcta en `run_agent.bat` (`set WMS_WINDOWS_PRINTER=...`).
3. En Windows abre la impresora → "Ver lo que se está imprimiendo" → menú Impresora: deben estar desmarcados "Pausar impresión" y "Usar impresora sin conexión". La estación avisa si detecta cualquiera de los dos.
4. La estación manda al arrancar el comando que deja la Zebra en modo ZPL; si estaba en modo EPL, ignoraba las etiquetas sin marcar error.

## Si Windows marca la impresora en "Error" (trabajos atorados, ni la página de prueba sale)

Descarga `reparar_impresora.bat` desde Datos maestros → Impresoras → Generar token, guárdalo en la carpeta `wms-print` junto a `run_agent.bat` y ejecútalo (pide permisos de administrador). Descarga `reparar_impresora.ps1` del WMS y:

1. Lista los dispositivos USB de la Zebra y reinicia los que tengan error.
2. Detecta el puerto USB00x real de la Zebra (registro USBPRINT).
3. Reinicia la cola de impresión y borra los trabajos atorados.
4. Crea la impresora `ZEBRA` con el driver "Generic / Text Only" en ese puerto (manda el ZPL tal cual).
5. Imprime una etiqueta de prueba y avisa si se queda atorada (entonces es cable o puerto USB).
6. Deja `run_agent.bat` con `set WMS_WINDOWS_PRINTER=ZEBRA`.

## Una sola estación para el WMS y la app de etiquetas SAE

Desde la v2.0 la estación Python (`wms_print_agent.py`) también expone el servicio local `http://127.0.0.1:9101` con la misma interfaz que `EstacionZebra.exe` (`/estado`, `/imprimir`, `/impresora`). La app web de etiquetas SAE la detecta sola y le manda sus etiquetas; el WMS imprime por el mismo proceso y el mismo driver de Windows, con un candado que serializa ambos. Con `estacion_wms.bat` (descargado de Impresoras → Generar token) basta: si hay Python corre este programa; si no, abre la estación del navegador.

## En segundo plano, sin ventana

`estacion_wms.bat` (con Python) deja la estación corriendo oculta con `pythonw` desde `%LOCALAPPDATA%\wms-print\` y pone en la carpeta Inicio un lanzador que la arranca al iniciar sesión. Solo corre una copia por PC (puerto de guardia 9199). Todo lo que imprimiría en consola va a `estacion.log` (rota a 2 MB). `detener_estacion.bat` la detiene; volver a ejecutar `estacion_wms.bat` la reinicia y actualiza el script desde el WMS.
