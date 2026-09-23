# Estación de impresión WMS (Zebra por USB)

Para impresoras Zebra conectadas por USB a una PC (sin red). La PC corre este agente: cada 3 s pregunta al WMS si hay etiquetas para su impresora, las imprime por la cola RAW de Windows y reporta. No abre puertos.

1. En el WMS: Datos maestros → Impresoras → Nueva → modo **Estación (USB)** → guardar → **Generar token** (se muestra una sola vez).
2. En la PC: instalar Python 3.10+ (marcar *Add Python to PATH*), copiar a `C:\wms-print\` el `run_agent.bat` descargado del WMS (ya trae el token) y `wms_print_agent.py`. Las librerías `requests` y `pywin32` se instalan solas la primera vez que se ejecuta.
3. Doble clic en `run_agent.bat`. Debe decir "Impresora WMS: … · 0 en cola".
4. Arranque automático: acceso directo de `run_agent.bat` en `shell:startup`.

El WMS muestra en Impresoras la última vez que la estación se conectó y desde qué PC. Una etiqueta que la estación no confirma en 2 minutos vuelve a la cola.
