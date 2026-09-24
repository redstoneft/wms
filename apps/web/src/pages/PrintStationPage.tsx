// /print-station — WebUSB print station. A Chrome/Edge tab on the PC that has the Zebra on USB pulls the queued
// labels of one AGENT printer and writes them straight to the printer through WebUSB. It authenticates with the
// printer's station token (stored in this browser), never with a user session, so it keeps working after the
// session expires; and once the Zebra was chosen once, it connects and starts on its own every time it opens.
// Works with the Zebra bound to the WinUSB driver (needed by WebUSB apps such as the SAE label app), which is
// exactly the case where the Windows print queue can no longer print.
import { useCallback, useEffect, useRef, useState } from 'react';

// ---- minimal WebUSB typings (not in lib.dom)
interface UsbEndpoint { endpointNumber: number; direction: 'in' | 'out'; type: 'bulk' | 'interrupt' | 'isochronous' }
interface UsbAlternate { interfaceClass: number; endpoints: UsbEndpoint[] }
interface UsbInterface { interfaceNumber: number; alternates: UsbAlternate[]; claimed: boolean }
interface UsbConfiguration { configurationValue: number; interfaces: UsbInterface[] }
interface UsbDevice {
  vendorId: number;
  productId: number;
  productName?: string;
  manufacturerName?: string;
  serialNumber?: string;
  opened: boolean;
  configuration: UsbConfiguration | null;
  configurations: UsbConfiguration[];
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(v: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  releaseInterface(n: number): Promise<void>;
  transferOut(ep: number, data: BufferSource): Promise<{ status: string; bytesWritten: number }>;
}
interface UsbApi {
  getDevices(): Promise<UsbDevice[]>;
  requestDevice(o: { filters: { vendorId?: number; classCode?: number }[] }): Promise<UsbDevice>;
  addEventListener(t: 'connect' | 'disconnect', h: (e: { device: UsbDevice }) => void): void;
  removeEventListener(t: 'connect' | 'disconnect', h: (e: { device: UsbDevice }) => void): void;
}
const usb = (): UsbApi | null => ((navigator as unknown as { usb?: UsbApi }).usb ?? null);
const ZEBRA_VENDOR = 0x0a5f;
const FORCE_ZPL = '! U1 setvar "device.languages" "zpl"\r\n';
const TEST_LABEL = '^XA^CI28^PW812^LL400^LH0,0^FO30,30^A0N,50,50^FDPRUEBA WMS^FS^FO30,100^A0N,32,32^FDSi lees esto, la Zebra imprime por WebUSB^FS^FO30,160^BY3,3,90^BCN,90,Y,N,N^FDWMS-PRUEBA^FS^XZ';
const LS_TOKEN = 'wms.station.token';
const LS_PAUSED = 'wms.station.paused';
const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ---- talking to the WMS with the station token (no cookie → CSRF-exempt agent endpoints)
interface Job { id: string; label_type: string; entity: string; zpl: string; is_reprint: boolean }
async function agent<T>(token: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await fetch(`/api/print-agent${path}`, {
    method: init?.method ?? 'GET',
    credentials: 'omit',
    headers: { 'X-Agent-Token': token, 'X-Agent-Host': `WebUSB - ${navigator.platform || 'navegador'}`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const j = (await r.json()) as { message?: string; error?: string }; msg = j.message ?? j.error ?? msg; } catch { /* no body */ }
    if (r.status === 401) msg = 'El WMS no acepta el token de esta estación: genera uno nuevo en Impresoras → Generar token y ábrelo con el botón de la estación.';
    throw new Error(msg);
  }
  return (await r.json()) as T;
}

/** Writes raw ZPL to the Zebra: open → claim printer interface → bulk OUT → release/close (so other apps can use it). */
async function writeToZebra(dev: UsbDevice, data: string) {
  if (!dev.opened) await dev.open();
  try {
    if (!dev.configuration) await dev.selectConfiguration(dev.configurations[0]?.configurationValue ?? 1);
    const cfg = dev.configuration!;
    const iface = cfg.interfaces.find((i) => i.alternates.some((a) => a.interfaceClass === 7)) ?? cfg.interfaces[0];
    if (!iface) throw new Error('La impresora no expone una interfaz USB de impresión');
    const alt = iface.alternates.find((a) => a.endpoints.some((e) => e.direction === 'out' && e.type === 'bulk')) ?? iface.alternates[0]!;
    const ep = alt.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
    if (!ep) throw new Error('La impresora no tiene endpoint de salida');
    await dev.claimInterface(iface.interfaceNumber);
    try {
      const bytes = new TextEncoder().encode(data);
      const CHUNK = 16 * 1024;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        const r = await dev.transferOut(ep.endpointNumber, bytes.slice(i, i + CHUNK));
        if (r.status !== 'ok') throw new Error(`USB transfer ${r.status}`);
      }
    } finally {
      await dev.releaseInterface(iface.interfaceNumber).catch(() => undefined);
    }
  } finally {
    await dev.close().catch(() => undefined);
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
interface LogRow { t: string; msg: string; ok: boolean }

export default function PrintStationPage() {
  const [token, setToken] = useState<string>(() => {
    // `#token=wmsp_…` (link from Impresoras → Generar token) stores the token in this browser and is removed from the URL
    const m = /[#&]token=(wmsp_[A-Za-z0-9_-]+)/.exec(window.location.hash);
    if (m) {
      ls.set(LS_TOKEN, m[1]!);
      history.replaceState(null, '', window.location.pathname);
      return m[1]!;
    }
    return ls.get(LS_TOKEN) ?? '';
  });
  const [tokenInput, setTokenInput] = useState('');
  const [printer, setPrinter] = useState<{ printer: string; name: string; queued: number } | null>(null);
  const [device, setDevice] = useState<UsbDevice | null>(null);
  const [paused, setPaused] = useState<boolean>(() => ls.get(LS_PAUSED) === '1');
  const [log, setLog] = useState<LogRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [printed, setPrinted] = useState(0);
  const [ready, setReady] = useState(false); // remembered devices checked
  const busy = useRef(false);
  const supported = !!usb();
  const secure = window.isSecureContext;
  const running = !!token && !!device && !paused;

  const say = useCallback((msg: string, ok = true) => setLog((l) => [{ t: new Date().toLocaleTimeString(), msg, ok }, ...l].slice(0, 80)), []);

  // printer behind the token
  useEffect(() => {
    if (!token) { setPrinter(null); return; }
    agent<{ printer: string; name: string; queued: number }>(token, '/ping').then((p) => { setPrinter(p); setError(null); }).catch((e) => setError(errText(e)));
  }, [token]);

  // remembered device (permission granted before) → resumes automatically
  useEffect(() => {
    const u = usb();
    if (!u) { setReady(true); return; }
    void u.getDevices().then((ds) => {
      const z = ds.find((d) => d.vendorId === ZEBRA_VENDOR) ?? ds[0];
      if (z) { setDevice(z); say(`Zebra recordada: ${z.productName ?? 'USB'}${z.serialNumber ? ' · ' + z.serialNumber : ''}`); }
      setReady(true);
    });
    const onDisc = (e: { device: UsbDevice }) => { say(`Se desconectó ${e.device.productName ?? 'la impresora'}`, false); setDevice((d) => (d === e.device ? null : d)); };
    const onConn = (e: { device: UsbDevice }) => { if (e.device.vendorId === ZEBRA_VENDOR) { setDevice(e.device); say(`Zebra conectada: ${e.device.productName ?? ''}`); } };
    u.addEventListener('disconnect', onDisc);
    u.addEventListener('connect', onConn);
    return () => { u.removeEventListener('disconnect', onDisc); u.removeEventListener('connect', onConn); };
  }, [say]);

  const connect = async () => {
    setError(null);
    try {
      const d = await usb()!.requestDevice({ filters: [{ vendorId: ZEBRA_VENDOR }, { classCode: 7 }] });
      setDevice(d);
      say(`Zebra elegida: ${d.productName ?? 'USB'} (${d.manufacturerName ?? ''})`);
    } catch (e) {
      const m = errText(e);
      if (!/No device selected/i.test(m)) setError(m);
    }
  };
  const test = async () => {
    if (!device) return;
    setError(null);
    try {
      await writeToZebra(device, FORCE_ZPL + TEST_LABEL);
      say('Etiqueta de prueba enviada a la Zebra');
    } catch (e) {
      setError(errText(e));
      say(`Prueba falló: ${errText(e)}`, false);
    }
  };
  const saveToken = () => {
    const t = tokenInput.trim();
    if (!/^wmsp_/.test(t)) { setError('El token empieza con wmsp_'); return; }
    ls.set(LS_TOKEN, t);
    setToken(t);
    setTokenInput('');
  };
  const forget = () => { ls.set(LS_TOKEN, null); setToken(''); setPrinter(null); };

  // work loop, driven by a worker ticker (page timers are throttled when the tab is in the background)
  useEffect(() => {
    if (!running) return;
    let alive = true;
    const tick = async () => {
      if (!alive || busy.current || !device) return;
      busy.current = true;
      try {
        const r = await agent<{ jobs: Job[] }>(token, '/jobs?limit=5');
        for (const job of r.jobs) {
          try {
            await writeToZebra(device, job.zpl);
            await agent(token, `/jobs/${job.id}/result`, { method: 'POST', body: { ok: true } });
            setPrinted((n) => n + 1);
            say(`IMPRESA ${job.label_type} ${job.entity}${job.is_reprint ? ' (reimpresión)' : ''}`);
            setError(null);
          } catch (e) {
            const m = errText(e);
            await agent(token, `/jobs/${job.id}/result`, { method: 'POST', body: { ok: false, error: m } }).catch(() => undefined);
            say(`ERROR ${job.label_type} ${job.entity}: ${m}`, false);
            setError(m);
          }
        }
        const p = await agent<{ printer: string; name: string; queued: number }>(token, '/ping');
        setPrinter(p);
        if (r.jobs.length === 0) setError((prev) => (prev && /USB|interfaz|endpoint|claim|open|transfer/i.test(prev) ? prev : null));
      } catch (e) {
        setError(errText(e));
      } finally {
        busy.current = false;
      }
    };
    say(`Estación activa · ${printer?.name ?? ''}`);
    void tick();
    let worker: Worker | null = null;
    let fallback: number | null = null;
    try {
      worker = new Worker('/station-tick.js');
      worker.onmessage = () => void tick();
    } catch {
      fallback = window.setInterval(() => void tick(), 3000);
    }
    return () => { alive = false; worker?.terminate(); if (fallback) window.clearInterval(fallback); };
  }, [running, device, token, printer?.name, say]);

  // keep the screen awake while the station runs
  useEffect(() => {
    if (!running) return;
    let lock: { release: () => Promise<void> } | null = null;
    const wl = (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock;
    wl?.request('screen').then((l) => { lock = l; }).catch(() => undefined);
    return () => { void lock?.release(); };
  }, [running]);

  const origin = window.location.origin;
  const startupBat = `@echo off\r\nrem Estacion de impresion WMS. Doble clic: se copia a la carpeta Inicio y abre la estacion en su propia ventana.\r\nset "URL=${origin}/print-station"\r\nset "INICIO=%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\"\r\nif /i not "%~dp0"=="%INICIO%" copy /y "%~f0" "%INICIO%estacion_wms.bat" >nul 2>nul\r\nif /i "%~dp0"=="%INICIO%" timeout /t 20 >nul\r\nstart "" msedge --app="%URL%" 2>nul || start "" chrome --app="%URL%" 2>nul || start "" "%URL%"\r\n`;

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800">
      <div className="mx-auto max-w-3xl p-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Estación de impresión USB · WMS</h1>
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${running ? 'bg-emerald-600 text-white' : 'bg-slate-300 text-slate-700'}`} data-testid="station-state">{running ? 'ACTIVA' : paused ? 'EN PAUSA' : 'DETENIDA'}</span>
        </div>
        <p className="mt-1 text-sm text-slate-600">
          Esta ventana, en la PC que tiene la Zebra por USB, imprime todo lo que se manda desde el WMS. Se conecta sola cada vez que se abre: no hay que iniciar sesión ni presionar nada.
        </p>
        {!secure && <div className="mt-3 rounded-md bg-rose-50 p-3 text-sm text-rose-800">Esta página debe abrirse por HTTPS para poder usar USB.</div>}
        {!supported && <div className="mt-3 rounded-md bg-rose-50 p-3 text-sm text-rose-800">Este navegador no soporta WebUSB. Usa Google Chrome o Microsoft Edge en Windows.</div>}

        {/* 1. token */}
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-sm font-semibold text-slate-700">1 · Impresora del WMS</div>
          {token ? (
            <div className="mt-1 flex flex-wrap items-center gap-3 text-sm">
              <span className="text-emerald-700" data-testid="station-printer">{printer ? `${printer.name} (${printer.printer}) · ${printer.queued} en cola` : 'verificando token…'}</span>
              <button type="button" className="text-xs text-slate-500 underline" onClick={forget}>cambiar token</button>
            </div>
          ) : (
            <div className="mt-1 text-sm">
              <div className="text-slate-600">Falta el token de la estación. En el WMS: Datos maestros → Impresoras → la Zebra → <b>Generar token</b> → botón <b>Abrir estación USB con este token</b>. O pégalo aquí:</div>
              <div className="mt-2 flex gap-2">
                <input value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} placeholder="wmsp_…" className="w-full rounded-md border border-slate-300 px-2 py-2 font-mono text-sm" data-testid="station-token" />
                <button type="button" className="rounded-md bg-sky-600 px-3 py-2 text-sm font-semibold text-white" onClick={saveToken} data-testid="station-token-save">Guardar</button>
              </div>
            </div>
          )}
        </div>

        {/* 2. device */}
        <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-sm font-semibold text-slate-700">2 · Zebra por USB</div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-sm">
            <span data-testid="station-device">
              {device ? <span className="text-emerald-700">{device.productName ?? 'Impresora USB'}{device.serialNumber ? ` · ${device.serialNumber}` : ''}</span> : ready ? <span className="text-amber-700">sin elegir (solo la primera vez)</span> : <span className="text-slate-500">buscando…</span>}
            </span>
            <button type="button" className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50" onClick={connect} disabled={!supported || !secure} data-testid="station-connect">
              {device ? 'Cambiar de Zebra' : 'Elegir la Zebra'}
            </button>
            <button type="button" className="rounded-md bg-slate-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50" onClick={test} disabled={!device} data-testid="station-test">
              Imprimir prueba
            </button>
            {device && (paused ? (
              <button type="button" className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white" onClick={() => { ls.set(LS_PAUSED, null); setPaused(false); }} data-testid="station-start">Reanudar</button>
            ) : (
              <button type="button" className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white" onClick={() => { ls.set(LS_PAUSED, '1'); setPaused(true); }} data-testid="station-stop">Pausar</button>
            ))}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-md bg-white p-3 shadow-sm"><div className="text-xs uppercase text-slate-500">Estado</div><div className={`text-lg font-bold ${running ? 'text-emerald-700' : 'text-slate-500'}`}>{running ? 'imprimiendo' : 'detenida'}</div></div>
          <div className="rounded-md bg-white p-3 shadow-sm"><div className="text-xs uppercase text-slate-500">En cola</div><div className="text-lg font-bold" data-testid="station-queued">{printer?.queued ?? '—'}</div></div>
          <div className="rounded-md bg-white p-3 shadow-sm"><div className="text-xs uppercase text-slate-500">Impresas aquí</div><div className="text-lg font-bold">{printed}</div></div>
        </div>
        {error && <div className="mt-3 rounded-md bg-rose-50 p-3 text-sm text-rose-800" data-testid="station-error">{error}</div>}

        <div className="mt-3 rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-3 py-2 text-xs font-semibold uppercase text-slate-500">Actividad</div>
          <ul className="max-h-64 overflow-auto px-3 py-2 font-mono text-xs" data-testid="station-log">
            {log.length === 0 && <li className="text-slate-400">Sin actividad todavía.</li>}
            {log.map((r, i) => (
              <li key={i} className={r.ok ? 'text-slate-700' : 'text-rose-700'}>{r.t} {r.msg}</li>
            ))}
          </ul>
        </div>

        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4 text-sm">
          <div className="font-semibold text-slate-700">Que arranque sola al prender la PC</div>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-slate-600">
            <li>Descarga <a className="font-semibold text-sky-700 underline" href={URL.createObjectURL(new Blob([startupBat], { type: 'application/octet-stream' }))} download="estacion_wms.bat">estacion_wms.bat</a> y dale doble clic: se copia solo a la carpeta Inicio de Windows.</li>
            <li>Listo: al iniciar Windows se abre esta estación en su propia ventana y empieza a imprimir. Si la cierran por error, doble clic en el mismo archivo.</li>
          </ol>
          <div className="mt-2 text-xs text-slate-500">El token y la Zebra quedan guardados en este navegador de esta PC. Si otra app (por ejemplo la de etiquetas SAE) está usando la impresora en ese instante, la etiqueta se reintenta en el siguiente ciclo.</div>
        </div>
      </div>
    </div>
  );
}
