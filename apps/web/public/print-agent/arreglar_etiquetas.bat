@echo off
title ARREGLAR ETIQUETAS REPETIDAS - WMS
REM ============================================================================
REM  Doble clic y listo. Pide permisos de administrador (di que SI).
REM  1) cierra la estacion de impresion   2) detiene la cola de Windows y borra lo atorado
REM  3) reinicia la cola                   4) le dice a la Zebra que cancele lo que tiene en memoria
REM  5) vuelve a abrir la estacion de impresion
REM ============================================================================
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Pidiendo permisos de administrador...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo.
echo [1/5] Cerrando la estacion de impresion del WMS...
taskkill /F /IM pythonw.exe >nul 2>&1
taskkill /F /IM python.exe >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq Estacion de impresion WMS*" >nul 2>&1
echo [2/5] Deteniendo la cola de impresion de Windows y borrando lo atorado...
net stop spooler /y >nul 2>&1
timeout /t 2 >nul
del /F /Q "%SystemRoot%\System32\spool\PRINTERS\*.*" >nul 2>&1
echo [3/5] Reiniciando la cola de impresion...
net start spooler >nul 2>&1
timeout /t 3 >nul
echo [4/5] Cancelando lo que la Zebra tiene en memoria...
set "PYS=%TEMP%\wms_cancel_zebra.py"
> "%PYS%" echo import win32print
>> "%PYS%" echo names=[p[2] for p in win32print.EnumPrinters(win32print.PRINTER_ENUM_LOCAL^|win32print.PRINTER_ENUM_CONNECTIONS)]
>> "%PYS%" echo zeb=[n for n in names if 'zdesigner' in n.lower() or 'zebra' in n.lower() or 'gk420' in n.lower()]
>> "%PYS%" echo print('Impresoras Zebra:', zeb or names)
>> "%PYS%" echo for n in zeb:
>> "%PYS%" echo     h=win32print.OpenPrinter(n)
>> "%PYS%" echo     try:
>> "%PYS%" echo         for j in win32print.EnumJobs(h,0,999,1): win32print.SetJob(h,j['JobId'],0,None,win32print.JOB_CONTROL_DELETE)
>> "%PYS%" echo         win32print.StartDocPrinter(h,1,('WMS cancelar',None,'RAW')); win32print.StartPagePrinter(h); win32print.WritePrinter(h,b'~JA\r\n^XA^JUS^XZ'); win32print.EndPagePrinter(h); win32print.EndDocPrinter(h)
>> "%PYS%" echo         print('Cancelado en', n)
>> "%PYS%" echo     finally:
>> "%PYS%" echo         win32print.ClosePrinter(h)
python "%PYS%" 2>nul || echo (sin Python/pywin32: apaga y enciende la Zebra para borrar su memoria)
del /F /Q "%PYS%" >nul 2>&1
echo [5/5] Abriendo de nuevo la estacion de impresion...
set "AG="
if exist "%LOCALAPPDATA%\wms-print\estacion_wms.bat" set "AG=%LOCALAPPDATA%\wms-print\estacion_wms.bat"
if not defined AG if exist "C:\wms-print\estacion_wms.bat" set "AG=C:\wms-print\estacion_wms.bat"
if not defined AG if exist "C:\wms-print\run_agent.bat" set "AG=C:\wms-print\run_agent.bat"
if not defined AG for /f "delims=" %%f in ('where /r "%USERPROFILE%" run_agent.bat 2^>nul') do if not defined AG set "AG=%%f"
if not defined AG for /f "delims=" %%f in ('where /r "C:\" run_agent.bat 2^>nul') do if not defined AG set "AG=%%f"
if defined AG (
  echo    Estacion: %AG%
  start "" "%AG%"
) else (
  echo    No encontre run_agent.bat: abre la estacion de impresion a mano como siempre.
)
echo.
echo ============================================================
echo LISTO. Si la Zebra sigue sacando etiquetas, apagala y
echo enciendela una vez: es lo ultimo que tenia en memoria.
echo ============================================================
pause
