@echo off
title Estacion de impresion WMS
cd /d %~dp0
:loop
python wms_print_agent.py
echo.
echo La estacion se detuvo. Reiniciando en 5 segundos... (cierra esta ventana para salir)
timeout /t 5 >nul
goto loop
