r"""
ESTACION DE IMPRESION DEL WMS  (impresora Zebra conectada por USB a esta PC)
============================================================================
No abre puertos ni recibe conexiones: cada pocos segundos le PREGUNTA al WMS si hay
etiquetas en cola para esta impresora, las manda a la Zebra por USB (cola RAW de
Windows) y reporta el resultado. Funciona en cualquier PC con Windows y la Zebra
instalada como impresora.

INSTALACION (en la PC con la Zebra):
  1. Instalar Python 3.10 o mas nuevo (python.org, marcar "Add to PATH").
  2. Copiar este archivo y run_agent.bat (descargado del WMS, ya trae el token) a C:\wms-print\.
     Las librerias (requests, pywin32) se instalan solas la primera vez que se ejecuta.
     El TOKEN se genera en el WMS: Datos maestros -> Impresoras -> la impresora -> "Generar token".
  3. Doble clic en run_agent.bat (o: python wms_print_agent.py).
  4. Para que arranque solo al prender la PC: acceso directo de run_agent.bat en
     la carpeta Inicio (Win+R -> shell:startup).

PRUEBA: doble clic en prueba_impresora.bat (o: python wms_print_agent.py --test) imprime una
etiqueta de prueba sin pasar por el WMS. Luego, en el WMS imprime cualquier etiqueta eligiendo
esa impresora; aqui debe salir "IMPRESA" y la Zebra debe imprimir en menos de 5 segundos.
Si Windows dice que imprimio pero no sale nada: la cola esta "sin conexion"/en pausa, es otra
cola Zebra (mira el puerto USB), o la impresora estaba en modo EPL (la estacion la pone en ZPL).
"""
import json
import os
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ====== CONFIG (se puede sobreescribir con variables de entorno del mismo nombre) ======
WMS_URL = os.environ.get("WMS_URL", "https://wms.104-248-116-147.sslip.io")
TOKEN = os.environ.get("WMS_PRINT_TOKEN", "PEGA_AQUI_EL_TOKEN")   # wmsp_...
PRINTER_NAME = os.environ.get("WMS_WINDOWS_PRINTER", "")           # vacio = autodetecta la Zebra
POLL_SECONDS = float(os.environ.get("WMS_POLL_SECONDS", "3"))
MAX_RETRIES = 3

def _ensure_libraries():
    """Instala requests/pywin32 con el mismo Python que ejecuta este archivo (evita el error
    'Falta requests' cuando pip instalo en otro Python)."""
    missing = []
    for mod, pkg in (("requests", "requests"), ("win32print", "pywin32")):
        if pkg == "pywin32" and os.name != "nt":
            continue
        try:
            __import__(mod)
        except ImportError:
            missing.append(pkg)
    if not missing:
        return
    import subprocess
    print(f"Instalando librerias que faltan: {' '.join(missing)} ...")
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", *missing])
    except Exception as e:  # noqa: BLE001
        print(f">> No se pudieron instalar ({e}). Ejecuta a mano:  {sys.executable} -m pip install {' '.join(missing)}")
        sys.exit(1)
    print("Librerias instaladas.")


_ensure_libraries()
import requests  # noqa: E402


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
    """Prefiere la cola del driver oficial (ZDesigner, la misma que usa ZebraDesigner) sobre la generica 'ZEBRA'."""
    printers = list_printers()
    for pref in ("zdesigner", "gk420", "zd4", "zt2", "zt4", "zebra"):
        for p in printers:
            if pref in p.lower():
                return p
    return ""


def printer_info(printer_name: str):
    """Puerto y estado de la cola de Windows: detecta 'Usar impresora sin conexion' y colas en pausa."""
    if os.name != "nt":
        return {"port": "", "offline": False, "paused": False}
    import win32print
    h = win32print.OpenPrinter(printer_name)
    try:
        d = win32print.GetPrinter(h, 2)
    finally:
        win32print.ClosePrinter(h)
    status = int(d.get("Status", 0) or 0)
    attrs = int(d.get("Attributes", 0) or 0)
    offline = bool(status & 0x80) or bool(attrs & 0x400)   # PRINTER_STATUS_OFFLINE / PRINTER_ATTRIBUTE_WORK_OFFLINE
    paused = bool(status & 0x1) or bool(status & 0x400)    # PRINTER_STATUS_PAUSED / PRINTER_STATUS_NOT_AVAILABLE
    return {"port": str(d.get("pPortName", "") or ""), "offline": offline, "paused": paused}


def looks_like_zebra(name: str) -> bool:
    n = name.lower()
    return any(k in n for k in ("zebra", "zdesigner", "gk420", "zd4", "zt2", "zt4", "gx4", "lp28", "tlp28"))


# Comando SGD: lo entiende la Zebra en cualquier modo (EPL o ZPL) y la deja en ZPL, que es lo que manda el WMS.
FORCE_ZPL = b'! U1 setvar "device.languages" "zpl"\r\n'
TEST_LABEL = "^XA^CI28^PW812^LL400^LH0,0^FO30,30^A0N,50,50^FDPRUEBA WMS^FS^FO30,100^A0N,32,32^FDSi lees esto, la Zebra imprime ZPL^FS^FO30,160^BY3,3,90^BCN,90,Y,N,N^FDWMS-PRUEBA^FS^XZ"


def print_raw(zpl: str, printer_name: str):
    """Manda ZPL crudo a la Zebra. En Windows usa win32print (RAW); en otros sistemas, lp -o raw."""
    data = zpl if isinstance(zpl, bytes) else zpl.encode("utf-8")
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
AGENT_HOST = socket.gethostname()


def headers():
    return {"X-Agent-Token": TOKEN, "X-Agent-Host": AGENT_HOST[:120], "X-Requested-With": "wms-agent"}


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


# ====== Servicio local para la app de etiquetas SAE (misma interfaz que EstacionZebra.exe: /estado, /imprimir, /impresora) ======
# Asi UNA sola estacion en la PC imprime lo del WMS y lo de la app de etiquetas SAE, las dos por el driver de Windows.
LOCAL_PORT = int(os.environ.get("WMS_LOCAL_PORT", "9101"))
_print_lock = threading.Lock()
VERSION = "2.0-wms"


class LocalHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # noqa: D401
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):  # noqa: N802
        if self.path.startswith("/estado"):
            return self._json(200, {"ok": True, "version": VERSION, "estacion": socket.gethostname(), "impresora": PRINTER_NAME, "impresoras": list_printers(), "wms": True})
        self._json(404, {"error": "no existe"})

    def do_POST(self):  # noqa: N802
        global PRINTER_NAME
        try:
            n = int(self.headers.get("Content-Length") or 0)
            datos = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except Exception as e:  # noqa: BLE001
            return self._json(400, {"error": f"JSON invalido: {e}"})
        if self.path.startswith("/impresora"):
            nombre = (datos.get("nombre") or "").strip()
            if nombre and nombre not in list_printers():
                return self._json(400, {"error": f"No existe la impresora '{nombre}' en Windows"})
            PRINTER_NAME = nombre or autodetect_zebra()
            print(f">> Impresora cambiada desde la app de etiquetas: {PRINTER_NAME}")
            return self._json(200, {"ok": True, "impresora": PRINTER_NAME})
        if self.path.startswith("/imprimir"):
            etiquetas = datos.get("etiquetas") or []
            printer = (datos.get("impresora") or PRINTER_NAME or "").strip()
            if not printer:
                return self._json(400, {"error": "No hay impresora Zebra configurada en la estacion"})
            impresas, fallidas, errores = 0, 0, []
            with _print_lock:
                for i, et in enumerate(etiquetas, 1):
                    zpl = et.get("zpl") if isinstance(et, dict) else str(et)
                    if not zpl:
                        fallidas += 1
                        errores.append(f"etiqueta {i}: sin ZPL")
                        continue
                    ultimo = ""
                    for intento in range(1, MAX_RETRIES + 1):
                        try:
                            print_raw(zpl, printer)
                            impresas += 1
                            break
                        except Exception as e:  # noqa: BLE001
                            ultimo = str(e)
                            time.sleep(0.3 * intento)
                    else:
                        fallidas += 1
                        errores.append(f"etiqueta {i}: {ultimo}")
                        if fallidas >= 3 and impresas == 0:
                            errores.append("La impresora no responde; se detuvo el lote")
                            break
            if impresas:
                print(f"[{time.strftime('%H:%M:%S')}] app de etiquetas -> {printer}: {impresas} etiqueta(s)" + (f", {fallidas} fallidas" if fallidas else ""))
            return self._json(200, {"ok": fallidas == 0, "impresas": impresas, "fallidas": fallidas, "errores": errores[:10], "impresora": printer})
        self._json(404, {"error": "no existe"})


def start_local_service():
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", LOCAL_PORT), LocalHandler)
    except OSError as e:
        print(f"  [aviso] no se pudo abrir el servicio local en 127.0.0.1:{LOCAL_PORT} ({e}). Si ya corre EstacionZebra.exe, no pasa nada.")
        return
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"  Servicio local para la app de etiquetas SAE: http://127.0.0.1:{LOCAL_PORT}")


GUARD_PORT = int(os.environ.get("WMS_GUARD_PORT", "9199"))
_guard_socket = None


def setup_logging():
    """Sin consola (pythonw / en segundo plano): todo lo que se imprime va a estacion.log junto al script."""
    if sys.stdout is not None and sys.stdout.isatty() and os.environ.get("WMS_LOG") != "1":
        return
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "estacion.log")
    try:
        if os.path.exists(path) and os.path.getsize(path) > 2_000_000:
            os.replace(path, path + ".1")
        f = open(path, "a", encoding="utf-8", buffering=1)  # noqa: SIM115
        sys.stdout = f
        sys.stderr = f
        print(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} inicio (sin ventana) =====")
    except Exception:  # noqa: BLE001
        pass


def single_instance():
    """Solo una estacion por PC: un puerto de guardia; si esta ocupado, ya hay otra corriendo."""
    global _guard_socket
    try:
        _guard_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        _guard_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        _guard_socket.bind(("127.0.0.1", GUARD_PORT))
        _guard_socket.listen(1)
        return True
    except OSError:
        print("Ya hay otra estacion de impresion WMS corriendo en esta PC; esta copia se cierra.")
        return False


def main():
    global PRINTER_NAME
    setup_logging()
    if not single_instance():
        sys.exit(3)
    print("=" * 70)
    print("ESTACION DE IMPRESION WMS")
    print(f"  WMS: {WMS_URL}")
    if TOKEN.startswith("PEGA_AQUI"):
        print("  >> Falta el TOKEN. Generalo en Datos maestros -> Impresoras y pegalo en CONFIG.")
        sys.exit(1)
    if not PRINTER_NAME:
        PRINTER_NAME = autodetect_zebra()
    global AGENT_HOST
    if not PRINTER_NAME:
        print("  >> No encontre una Zebra instalada. Impresoras disponibles:")
        for p in list_printers():
            print("     -", p)
        print("  Pon el nombre exacto en run_agent.bat (set WMS_WINDOWS_PRINTER=...) y vuelve a ejecutar.")
        sys.exit(1)
    others = [p for p in list_printers() if p != PRINTER_NAME and looks_like_zebra(p)]
    try:
        info = printer_info(PRINTER_NAME)
    except Exception as e:  # noqa: BLE001
        print(f"  >> La impresora '{PRINTER_NAME}' no existe en Windows ({e}). Impresoras: {', '.join(list_printers())}")
        sys.exit(1)
    print(f"  Impresora Windows: {PRINTER_NAME}  (puerto {info['port'] or '?'})")
    if others:
        print(f"  [aviso] hay otras Zebra instaladas: {', '.join(others)}. Si no imprime, prueba con una de ellas (set WMS_WINDOWS_PRINTER=... en run_agent.bat).")
    if info["offline"]:
        print("  >> LA COLA ESTA 'SIN CONEXION': en Windows abre la impresora (Ver lo que se esta imprimiendo) -> menu Impresora -> desmarca 'Usar impresora sin conexion'.")
    if info["paused"]:
        print("  >> LA COLA ESTA EN PAUSA: en Windows abre la impresora -> menu Impresora -> desmarca 'Pausar impresion'.")
    AGENT_HOST = f"{socket.gethostname()} · {PRINTER_NAME} ({info['port'] or '?'})"
    if looks_like_zebra(PRINTER_NAME):
        try:
            print_raw(FORCE_ZPL, PRINTER_NAME)   # deja la Zebra en modo ZPL (si estaba en EPL ignoraba las etiquetas)
        except Exception as e:  # noqa: BLE001
            print(f"  [aviso] no se pudo mandar el comando de modo ZPL: {e}")
    if "--test" in sys.argv:
        print_raw(TEST_LABEL, PRINTER_NAME)
        print("  Etiqueta de PRUEBA enviada a la cola de Windows. Si no sale: revisa puerto, cola en pausa/sin conexion, y que sea la Zebra correcta.")
        sys.exit(0)
    try:
        info = ping()
        print(f"  Impresora WMS: {info['printer']} ({info['name']}) · {info['queued']} en cola")
    except Exception as e:  # noqa: BLE001
        print(f"  >> El WMS no acepta el token o no responde: {e}")
        sys.exit(1)
    print("=" * 70)
    start_local_service()
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
                    # otras apps pueden dejar la Zebra en modo EPL: forzar ZPL antes de cada etiqueta (inofensivo si ya esta en ZPL)
                    with _print_lock:
                        print_raw(FORCE_ZPL + job["zpl"].encode("utf-8"), PRINTER_NAME)
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
