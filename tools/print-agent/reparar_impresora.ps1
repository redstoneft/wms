# REPARACION DE LA IMPRESORA ZEBRA PARA EL WMS  (se ejecuta desde reparar_impresora.bat, como administrador)
# 1) revisa que Windows vea la Zebra por USB y reinicia los dispositivos con error
# 2) encuentra el puerto USB00x real de la Zebra
# 3) reinicia la cola de impresion y borra trabajos atorados
# 4) crea la impresora "ZEBRA" con el driver generico (manda el ZPL tal cual, sin depender del software de Zebra)
# 5) imprime una etiqueta de prueba y revisa que salga de la cola
# 6) deja run_agent.bat apuntando a la impresora ZEBRA
$ErrorActionPreference = 'Continue'
function Say([string]$m) { Write-Host $m }
function Warn([string]$m) { Write-Host $m -ForegroundColor Yellow }
function Bad([string]$m) { Write-Host $m -ForegroundColor Red }
function Good([string]$m) { Write-Host $m -ForegroundColor Green }

Say "==============================================================="
Say "REPARACION DE LA IMPRESORA ZEBRA PARA EL WMS"
Say "==============================================================="

# ---------- 0. Zebra en WinUSB (Zadig / WebUSB) -> regresar al driver de impresora de Windows ----------
# Las apps por WebUSB cambian el driver de la Zebra a WinUSB; con eso la cola de Windows (y la estacion de SAE
# etiquetas, que imprime por el driver) dejan de funcionar. Aqui se quita ese driver y Windows vuelve a usar
# "Compatibilidad con impresoras USB" (usbprint), que comparten todas las apps.
Say ""; Say "0) Driver USB de la Zebra..."
$zebraUsb = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match '^USB\\VID_0A5F' })
if ($zebraUsb.Count -eq 0) { Warn "   No veo la Zebra conectada por USB (VID 0A5F). Conectala y enciendela; continuo con lo demas." }
foreach ($d in $zebraUsb) {
  $svc = ''; $inf = ''
  try { $svc = [string](Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_Service' -ErrorAction Stop).Data } catch {}
  try { $inf = [string](Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_DriverInfPath' -ErrorAction Stop).Data } catch {}
  Say ("   - {0}  servicio={1}  inf={2}" -f $d.FriendlyName, $svc, $inf)
  if ($svc -match '^(usbprint)$') { Good "   La Zebra ya usa el driver de impresora de Windows (usbprint)."; continue }
  if ($svc -match 'WinUSB|libusb' -or $inf -match '^oem\d+\.inf$') {
    Warn "   La Zebra esta con el driver WinUSB (WebUSB/Zadig). Regresandola al driver de impresora de Windows..."
    # 1) quitar del almacen de drivers el paquete que la ata a WinUSB (el de Zadig/libwdi o el que la instalo)
    $enum = (& pnputil /enum-drivers) -join "`n"
    $blocks = $enum -split "(?m)^\s*$"
    foreach ($b in $blocks) {
      $pub = ''; if ($b -match '(?im)^(Published Name|Nombre publicado)\s*:\s*(\S+)') { $pub = $Matches[2] }
      if (-not $pub) { continue }
      $isZadig = ($b -match '(?im)^(Provider Name|Nombre del proveedor)\s*:\s*(libwdi|Zadig)') -or ($b -match '(?i)winusb') -or ($b -match '(?i)zebra|ZTC|GK420') -or ($inf -and ($pub -ieq $inf))
      $isUsbprint = ($b -match '(?i)usbprint\.inf')
      if ($isZadig -and -not $isUsbprint) {
        Say "     quitando driver $pub del almacen..."
        & pnputil /delete-driver $pub /uninstall /force | Out-Null
      }
    }
    # 2) quitar el dispositivo y volver a detectarlo: Windows le pone usbprint
    & pnputil /remove-device "$($d.InstanceId)" | Out-Null
    Start-Sleep -Seconds 3
    & pnputil /scan-devices | Out-Null
    Start-Sleep -Seconds 8
    $again = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match '^USB\\VID_0A5F' } | Select-Object -First 1
    $svc2 = ''
    if ($again) { try { $svc2 = [string](Get-PnpDeviceProperty -InstanceId $again.InstanceId -KeyName 'DEVPKEY_Device_Service' -ErrorAction Stop).Data } catch {} }
    if ($svc2 -match 'usbprint') { Good "   Listo: la Zebra vuelve a usar el driver de impresora de Windows." }
    else {
      Warn "   Windows aun no la reasigno (servicio='$svc2'). Desconecta el cable USB de la Zebra, espera 5 segundos, conectalo y vuelve a correr este archivo."
      if ($svc2 -match 'WinUSB') { Bad "   Sigue en WinUSB: en Administrador de dispositivos -> la Zebra -> Actualizar controlador -> Elegir de una lista -> 'Compatibilidad con impresoras USB'." }
    }
  } else { Warn "   Driver desconocido ('$svc'); continuo." }
}

# ---------- 1. Dispositivos USB ----------
Say ""; Say "1) Buscando la Zebra en el USB..."
$dev = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object {
  $_.InstanceId -match 'VID_0A5F' -or $_.FriendlyName -match 'Zebra|ZDesigner|GK420|impresoras USB|USB Printing' -or $_.InstanceId -like 'USBPRINT\*'
})
if ($dev.Count -eq 0) {
  Bad "   Windows NO ve ninguna impresora por USB."
  Bad "   Revisa: Zebra encendida, cable USB conectado directo a la PC (prueba OTRO cable y OTRO puerto de la PC)."
} else {
  foreach ($d in $dev) {
    $code = ''
    try { $code = (Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_ProblemCode' -ErrorAction Stop).Data } catch {}
    Say ("   - {0}  [{1}]  estado={2}  problema={3}" -f $d.FriendlyName, $d.Class, $d.Status, $code)
    if ($d.Status -ne 'OK') {
      Warn "     tiene error: reiniciando el dispositivo..."
      Disable-PnpDevice -InstanceId $d.InstanceId -Confirm:$false -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 2
      Enable-PnpDevice -InstanceId $d.InstanceId -Confirm:$false -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 3
      $again = Get-PnpDevice -InstanceId $d.InstanceId -ErrorAction SilentlyContinue
      if ($again -and $again.Status -eq 'OK') { Good "     ahora esta OK" } else { Bad "     sigue con error: desconecta el cable, apaga la Zebra 10 s, cambia de puerto USB y vuelve a correr este archivo." }
    }
  }
}

# ---------- 2. Puerto USB de la Zebra ----------
Say ""; Say "2) Puerto de Windows donde esta la Zebra..."
$port = $null
foreach ($d in $dev) {
  if ($d.InstanceId -like 'USBPRINT\*') {
    $p = Get-ItemProperty -Path ("HKLM:\SYSTEM\CurrentControlSet\Enum\" + $d.InstanceId + "\Device Parameters") -ErrorAction SilentlyContinue
    if ($p -and $p.'Port Name') {
      Say ("   - {0} -> {1}" -f $d.FriendlyName, $p.'Port Name')
      if (-not $port -and (($d.FriendlyName -match 'Zebra|ZDesigner|GK420') -or ($d.InstanceId -match 'Zebra|ZDesigner|GK420'))) { $port = $p.'Port Name' }
    }
  }
}
if (-not $port) {
  $usbPorts = @(Get-PrinterPort -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^USB\d+' })
  $used = @(Get-Printer -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch 'Zebra|ZDesigner|GK420' } | Select-Object -ExpandProperty PortName)
  $free = @($usbPorts | Where-Object { $used -notcontains $_.Name })
  if ($free.Count -ge 1) { $port = $free[0].Name; Warn "   No pude confirmar el puerto por el USB; uso $port (unico USB libre de otras impresoras)." }
  elseif ($usbPorts.Count -ge 1) { $port = $usbPorts[0].Name; Warn "   No pude confirmar el puerto; uso $port." }
  else { Bad "   No existe ningun puerto USB de impresora en Windows: la Zebra no esta detectada (ver punto 1)." }
} else { Good "   La Zebra esta en $port" }

# ---------- 3. Cola de impresion ----------
Say ""; Say "3) Reiniciando la cola de impresion y borrando trabajos atorados..."
Stop-Service -Name Spooler -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Remove-Item -Path "$env:SystemRoot\System32\spool\PRINTERS\*" -Force -ErrorAction SilentlyContinue
Start-Service -Name Spooler -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Good "   cola reiniciada"

# ---------- 4. Impresora ZEBRA con driver generico ----------
Say ""; Say "4) Impresora 'ZEBRA' (driver generico, manda el ZPL tal cual)..."
$ready = $false
if ($port) {
  try {
    $existing = Get-Printer -Name 'ZEBRA' -ErrorAction SilentlyContinue
    if ($existing -and $existing.PortName -ne $port) { Remove-Printer -Name 'ZEBRA' -ErrorAction SilentlyContinue; $existing = $null }
    if (-not $existing) {
      Add-PrinterDriver -Name 'Generic / Text Only' -ErrorAction SilentlyContinue
      Add-Printer -Name 'ZEBRA' -DriverName 'Generic / Text Only' -PortName $port -ErrorAction Stop
    }
    # quitar "usar sin conexion" y pausa
    $w = Get-CimInstance -ClassName Win32_Printer -Filter "Name='ZEBRA'" -ErrorAction SilentlyContinue
    if ($w) { Invoke-CimMethod -InputObject $w -MethodName Resume -ErrorAction SilentlyContinue | Out-Null }
    $ready = $true
    Good "   ZEBRA lista en $port"
  } catch { Bad ("   No se pudo crear la impresora ZEBRA: " + $_.Exception.Message) }
}

# ---------- 5. Etiqueta de prueba ----------
Say ""; Say "5) Etiqueta de prueba..."
$src = @"
using System; using System.Runtime.InteropServices;
public class WmsRaw {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DOCINFO { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName; [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] static extern int StartDocPrinter(IntPtr h, int level, ref DOCINFO di);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool WritePrinter(IntPtr h, byte[] b, int n, out int w);
  public static string Send(string printer, string data) {
    IntPtr h; if (!OpenPrinter(printer, out h, IntPtr.Zero)) return "no se pudo abrir la impresora (error " + Marshal.GetLastWin32Error() + ")";
    var di = new DOCINFO(); di.pDocName = "WMS prueba"; di.pDataType = "RAW";
    if (StartDocPrinter(h, 1, ref di) == 0) { int e = Marshal.GetLastWin32Error(); ClosePrinter(h); return "no se pudo iniciar el documento (error " + e + ")"; }
    StartPagePrinter(h); var b = System.Text.Encoding.UTF8.GetBytes(data); int w; WritePrinter(h, b, b.Length, out w); EndPagePrinter(h); EndDocPrinter(h); ClosePrinter(h);
    return "enviados " + w + " bytes";
  }
}
"@
if ($ready) {
  try {
    Add-Type -TypeDefinition $src -ErrorAction Stop
    $zpl = "! U1 setvar `"device.languages`" `"zpl`"`r`n^XA^CI28^PW812^LL400^LH0,0^FO30,30^A0N,50,50^FDPRUEBA WMS^FS^FO30,100^A0N,32,32^FDSi lees esto, la Zebra imprime ZPL^FS^FO30,160^BY3,3,90^BCN,90,Y,N,N^FDWMS-PRUEBA^FS^XZ"
    $r = [WmsRaw]::Send('ZEBRA', $zpl)
    Say "   $r"
    Start-Sleep -Seconds 6
    $jobs = @(Get-PrintJob -PrinterName 'ZEBRA' -ErrorAction SilentlyContinue)
    $st = (Get-Printer -Name 'ZEBRA' -ErrorAction SilentlyContinue).PrinterStatus
    if ($jobs.Count -eq 0) { Good "   La cola quedo vacia: la etiqueta se entrego a la impresora (estado: $st)." }
    else {
      Bad ("   El trabajo se quedo atorado en la cola (estado impresora: {0}, trabajo: {1})." -f $st, $jobs[0].JobStatus)
      Bad "   Windows no logra escribir en el puerto $port. Causas: cable USB danado (cambialo), puerto USB de la PC, o la Zebra esta en otro puerto."
      Bad "   Haz esto: desconecta el cable, apaga la Zebra 10 s, conectala en OTRO puerto USB con OTRO cable, y vuelve a correr este archivo."
    }
  } catch { Bad ("   No se pudo mandar la prueba: " + $_.Exception.Message) }
}

# ---------- 6. run_agent.bat ----------
Say ""; Say "6) Dejando run_agent.bat apuntando a la impresora ZEBRA..."
$bat = Join-Path $PSScriptRoot 'run_agent.bat'
if ($ready -and (Test-Path $bat)) {
  $lines = Get-Content $bat
  $out = @(); $done = $false
  foreach ($l in $lines) {
    if ($l -match '^\s*(rem\s+)?set\s+WMS_WINDOWS_PRINTER=') { if (-not $done) { $out += 'set WMS_WINDOWS_PRINTER=ZEBRA'; $done = $true } }
    else { $out += $l; if (-not $done -and $l -match '^\s*set\s+WMS_PRINT_TOKEN=') { $out += 'set WMS_WINDOWS_PRINTER=ZEBRA'; $done = $true } }
  }
  Set-Content -Path $bat -Value $out -Encoding ASCII
  Good "   listo: run_agent.bat usara la impresora ZEBRA"
} elseif (-not (Test-Path $bat)) { Warn "   No encontre run_agent.bat en esta carpeta; ponlo junto a este archivo o edita a mano: set WMS_WINDOWS_PRINTER=ZEBRA" }

Say ""
Say "==============================================================="
if ($ready) { Say "Si salio la etiqueta PRUEBA WMS: la Zebra ya imprime por Windows. Abre EstacionZebra.exe (SAE etiquetas) y estacion_wms.bat: las dos apps la comparten." }
Say "Si no salio: toma foto de esta ventana y mandala." 
Say "==============================================================="
