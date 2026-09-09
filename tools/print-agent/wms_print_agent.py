"""
ESTACION DE IMPRESION DEL WMS  (impresora Zebra conectada por USB a esta PC)
============================================================================
No abre puertos ni recibe conexiones: cada pocos segundos le PREGUNTA al WMS si hay
etiquetas en cola para esta impresora, las manda a la Zebra por USB (cola RAW de
Windows) y reporta el resultado. Funciona en cualquier PC con Windows y la Zebra
instalada como impresora.

INSTALACION (en la PC con la Zebra):
  1. Instalar Python 3.10 o mas nuevo (python.org, marcar "Add to PATH").
  2. En una consola:  pip install pywin32 requests
  3. Copiar este archivo a C:\wms-print\ y editar CONFIG (WMS_URL, TOKEN).
     El TOKEN se genera en el WMS: Datos maestros -> Impresoras -> la impresora -> "Generar token".
  4. Doble clic en run_agent.bat (o: python wms_print_agent.py).
  5. Para que arranque solo al prender la PC: acceso directo de run_agent.bat en
     la carpeta Inicio (Win+R -> shell:startup).

PRUEBA: en el WMS imprime cualquier etiqueta eligiendo esa impresora; aqui debe salir
"IMPRESA" y la Zebra debe imprimir en menos de 5 segundos.
"""
import os
import socket
import sys
import time

# ====== CONFIG (se puede sobreescribir con variables de entorno del mismo nombre) ======
WMS_URL = os.environ.get("WMS_URL", "https://wms.104-248-116-147.sslip.io")
TOKEN = os.environ.get("WMS_PRINT_TOKEN", "PEGA_AQUI_EL_TOKEN")   # wmsp_...
PRINTER_NAME = os.environ.get("WMS_WINDOWS_PRINTER", "")           # vacio = autodetecta la Zebra
POLL_SECONDS = float(os.environ.get("WMS_POLL_SECONDS", "3"))
MAX_RETRIES = 3

try:
    import requests
except ImportError:
    print("Falta 'requests'. Ejecuta:  pip install requests")
    sys.exit(1)


# ====== Impresion por USB (cola RAW de Windows) ======
def list_printers():
    try:
        import win32print
        flags = win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
        return [p[2] for p in win32print.EnumPrinters(flags)]
    except ImportError:
        return []
    except Exception as e:  # noqa: BLE001
        print(f"[aviso] no se pudieron listar impresoras: {e}")
        return []


def autodetect_zebra():
    for p in list_printers():
        pl = p.lower()
        if "zebra" in pl or "zdesigner" in pl or "gk420" in pl or "zd4" in pl or "zt2" in pl or "zt4" in pl:
            return p
    return ""


def print_raw(zpl: str, printer_name: str):
    """Manda ZPL crudo a la Zebra. En Windows usa win32print (RAW); en otros sistemas, lp -o raw."""
    data = zpl.encode("utf-8")
    if os.name == "nt":
        import win32print
        h = win32print.OpenPrinter(printer_name, {"DesiredAccess": win32print.PRINTER_ACCESS_USE})
        try:
            win32print.StartDocPrinter(h, 1, ("WMS etiqueta", None, "RAW"))
            win32print.StartPagePrinter(h)
            win32print.WritePrinter(h, data)
            win32print.EndPagePrinter(h)
            win32print.EndDocPrinter(h)
        finally:
            win32print.ClosePrinter(h)
    else:
        import subprocess
        subprocess.run(["lp", "-d", printer_name, "-o", "raw"], input=data, check=True)


# ====== Conversacion con el WMS ======
def headers():
    return {"X-Agent-Token": TOKEN, "X-Agent-Host": socket.gethostname()[:120], "X-Requested-With": "wms-agent"}


def ping():
    r = requests.get(f"{WMS_URL}/api/print-agent/ping", headers=headers(), timeout=15)
    r.raise_for_status()
    return r.json()


def fetch_jobs():
    r = requests.get(f"{WMS_URL}/api/print-agent/jobs", params={"limit": 5}, headers=headers(), timeout=20)
    r.raise_for_status()
    return r.json().get("jobs", [])


def report(job_id: str, ok: bool, error: str = ""):
    for _ in range(3):
        try:
            r = requests.post(f"{WMS_URL}/api/print-agent/jobs/{job_id}/result", json={"ok": ok, "error": error[:500]}, headers=headers(), timeout=15)
            r.raise_for_status()
            return
        except Exception as e:  # noqa: BLE001
            print(f"[aviso] no se pudo reportar {job_id}: {e}")
            time.sleep(1)


def main():
    global PRINTER_NAME
    print("=" * 70)
    print("ESTACION DE IMPRESION WMS")
    print(f"  WMS: {WMS_URL}")
    if TOKEN.startswith("PEGA_AQUI"):
        print("  >> Falta el TOKEN. Generalo en Datos maestros -> Impresoras y pegalo en CONFIG.")
        sys.exit(1)
    if not PRINTER_NAME:
        PRINTER_NAME = autodetect_zebra()
    if PRINTER_NAME:
        print(f"  Impresora Windows: {PRINTER_NAME}")
    else:
        print("  >> No encontre una Zebra instalada. Impresoras disponibles:")
        for p in list_printers():
            print("     -", p)
        print("  Edita PRINTER_NAME con el nombre exacto y vuelve a ejecutar.")
        sys.exit(1)
    try:
        info = ping()
        print(f"  Impresora WMS: {info['printer']} ({info['name']}) · {info['queued']} en cola")
    except Exception as e:  # noqa: BLE001
        print(f"  >> El WMS no acepta el token o no responde: {e}")
        sys.exit(1)
    print("=" * 70)
    print("Esperando etiquetas... (Ctrl+C para salir)")
    backoff = POLL_SECONDS
    while True:
        try:
            jobs = fetch_jobs()
            backoff = POLL_SECONDS
        except Exception as e:  # noqa: BLE001
            print(f"[sin conexion] {e}")
            time.sleep(min(backoff, 30))
            backoff = min(backoff * 2, 30)
            continue
        for job in jobs:
            ok, err = False, ""
            for attempt in range(1, MAX_RETRIES + 1):
                try:
                    print_raw(job["zpl"], PRINTER_NAME)
                    ok = True
                    break
                except Exception as e:  # noqa: BLE001
                    err = str(e)
                    time.sleep(0.5 * attempt)
            stamp = time.strftime("%H:%M:%S")
            print(f"[{stamp}] {job['label_type']} {job['entity']}: {'IMPRESA' if ok else 'ERROR ' + err}")
            report(job["id"], ok, err)
        time.sleep(POLL_SECONDS if not jobs else 0.2)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nEstacion detenida.")
