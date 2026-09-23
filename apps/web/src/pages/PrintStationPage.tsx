// /print-station — WebUSB print station: this browser tab, on the PC that has the Zebra on USB, pulls the queued
// labels of an AGENT printer and writes them straight to the printer through WebUSB (Chrome/Edge). No install:
// it works with the Zebra bound to the WinUSB driver (the one WebUSB apps like the SAE label app need), which is
// exactly the case where the Windows print queue can no longer print.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { labelsApi } from '../api/labels';
import { masterdataApi } from '../api/masterdata';
import { errorMessage } from '../api/client';
import { fmtDateTime } from '../lib/format';

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
const POLL_MS = 3000;

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
      // chunked: some printers stall on very large single transfers
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

interface LogRow { t: string; msg: string; ok: boolean }

export default function PrintStationPage() {
  const printers = useQuery({ queryKey: ['printers'], queryFn: masterdataApi.printers });
  const agents = (printers.data ?? []).filter((p) => p.mode === 'AGENT' && p.is_active);
  const [printerId, setPrinterId] = useState<string>('');
  const [device, setDevice] = useState<UsbDevice | null>(null);
  const [running, setRunning] = useState(false);
  const [queued, setQueued] = useState<number | null>(null);
  const [log, setLog] = useState<LogRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [printed, setPrinted] = useState(0);
  const busy = useRef(false);
  const supported = !!usb();
  const secure = window.isSecureContext;
  const printer = agents.find((p) => p.id === printerId) ?? null;

  const say = useCallback((msg: string, ok = true) => setLog((l) => [{ t: new Date().toLocaleTimeString(), msg, ok }, ...l].slice(0, 60)), []);

  useEffect(() => {
    if (!printerId && agents.length) setPrinterId((agents.find((p) => p.is_default) ?? agents[0]!).id);
  }, [agents, printerId]);

  // remembered device (permission granted before) → resume automatically
  useEffect(() => {
    const u = usb();
    if (!u) return;
    void u.getDevices().then((ds) => {
      const z = ds.find((d) => d.vendorId === ZEBRA_VENDOR) ?? ds[0];
      if (z) {
        setDevice(z);
        say(`Zebra recordada: ${z.productName ?? 'USB'}${z.serialNumber ? ' · ' + z.serialNumber : ''}`);
      }
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
      const m = errorMessage(e);
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
      const m = errorMessage(e);
      setError(m);
      say(`Prueba falló: ${m}`, false);
    }
  };

  // polling loop
  useEffect(() => {
    if (!running || !device || !printerId) return;
    let alive = true;
    let timer: number | null = null;
    const tick = async () => {
      if (!alive || busy.current) return;
      busy.current = true;
      let delay = POLL_MS;
      try {
        const r = await labelsApi.station.jobs(printerId, 5);
        if (r.jobs.length) {
          for (const job of r.jobs) {
            try {
              await writeToZebra(device, job.zpl);
              await labelsApi.station.result(printerId, job.id, { ok: true });
              setPrinted((n) => n + 1);
              say(`IMPRESA ${job.label_type} ${job.entity}${job.is_reprint ? ' (reimpresión)' : ''}`);
            } catch (e) {
              const m = errorMessage(e);
              await labelsApi.station.result(printerId, job.id, { ok: false, error: m }).catch(() => undefined);
              say(`ERROR ${job.label_type} ${job.entity}: ${m}`, false);
              setError(m);
            }
          }
          delay = 300;
        }
        const ping = await labelsApi.station.ping(printerId);
        setQueued(ping.queued);
        setError((prev) => (prev && /transfer|USB|interfaz|endpoint|open|claim/i.test(prev) ? prev : null));
      } catch (e) {
        setError(errorMessage(e));
        delay = 8000;
      } finally {
        busy.current = false;
        if (alive) timer = window.setTimeout(() => void tick(), delay);
      }
    };
    say(`Estación activa · impresora ${printer?.name ?? ''}`);
    void tick();
    return () => { alive = false; if (timer) window.clearTimeout(timer); };
  }, [running, device, printerId, printer?.name, say]);

  // keep the screen awake while the station runs
  useEffect(() => {
    if (!running) return;
    let lock: { release: () => Promise<void> } | null = null;
    const wl = (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock;
    wl?.request('screen').then((l) => { lock = l; }).catch(() => undefined);
    return () => { void lock?.release(); };
  }, [running]);

  return (
    <div className="mx-auto max-w-3xl p-4">
      <h1 className="text-2xl font-bold text-slate-800">Estación de impresión por USB (navegador)</h1>
      <p className="mt-1 text-sm text-slate-600">
        Abre esta página en <b>Chrome o Edge en la computadora que tiene la Zebra conectada por USB</b>, elige la impresora y déjala abierta. Todo lo que se imprima desde el WMS (handhelds incluidos) sale aquí, sin instalar nada. Funciona aunque la Zebra tenga el driver WinUSB que usan otras apps de etiquetas.
      </p>
      {!secure && <div className="mt-3 rounded-md bg-rose-50 p-3 text-sm text-rose-800">Esta página debe abrirse por HTTPS para poder usar USB.</div>}
      {!supported && <div className="mt-3 rounded-md bg-rose-50 p-3 text-sm text-rose-800">Este navegador no soporta WebUSB. Usa Google Chrome o Microsoft Edge en Windows.</div>}

      <div className="mt-4 grid gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-semibold text-slate-700">Impresora del WMS</span>
          <select value={printerId} onChange={(e) => setPrinterId(e.target.value)} disabled={running} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2" data-testid="station-printer">
            {agents.map((p) => (
              <option key={p.id} value={p.id}>{p.name} ({p.code})</option>
            ))}
          </select>
          {agents.length === 0 && <div className="mt-1 text-xs text-amber-700">No hay impresoras en modo "estación (USB)". Créala en Impresoras.</div>}
        </label>
        <div className="text-sm">
          <div className="font-semibold text-slate-700">Zebra por USB</div>
          <div className="mt-1 rounded-md bg-slate-50 px-2 py-2" data-testid="station-device">
            {device ? (
              <span className="text-emerald-700">{device.productName ?? 'Impresora USB'}{device.serialNumber ? ` · ${device.serialNumber}` : ''}</span>
            ) : (
              <span className="text-slate-500">sin elegir</span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="rounded-md bg-sky-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" onClick={connect} disabled={!supported || !secure || running} data-testid="station-connect">
          {device ? 'Cambiar de Zebra' : 'Elegir la Zebra (USB)'}
        </button>
        <button type="button" className="rounded-md bg-slate-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" onClick={test} disabled={!device || running} data-testid="station-test">
          Imprimir etiqueta de prueba
        </button>
        {!running ? (
          <button type="button" className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" onClick={() => setRunning(true)} disabled={!device || !printerId} data-testid="station-start">
            Iniciar estación
          </button>
        ) : (
          <button type="button" className="rounded-md bg-rose-600 px-3 py-2 text-sm font-semibold text-white" onClick={() => setRunning(false)} data-testid="station-stop">
            Detener
          </button>
        )}
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-md bg-white p-3 shadow-sm"><div className="text-xs uppercase text-slate-500">Estado</div><div className={`text-lg font-bold ${running ? 'text-emerald-700' : 'text-slate-500'}`}>{running ? 'ACTIVA' : 'detenida'}</div></div>
        <div className="rounded-md bg-white p-3 shadow-sm"><div className="text-xs uppercase text-slate-500">En cola</div><div className="text-lg font-bold text-slate-800" data-testid="station-queued">{queued ?? '—'}</div></div>
        <div className="rounded-md bg-white p-3 shadow-sm"><div className="text-xs uppercase text-slate-500">Impresas aquí</div><div className="text-lg font-bold text-slate-800">{printed}</div></div>
      </div>
      {error && <div className="mt-3 rounded-md bg-rose-50 p-3 text-sm text-rose-800" data-testid="station-error">{error}</div>}
      {printer?.agent_last_seen_at && !running && <div className="mt-2 text-xs text-slate-500">Última estación vista: {printer.agent_host ?? ''} · {fmtDateTime(printer.agent_last_seen_at)}</div>}

      <div className="mt-4 rounded-lg border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-3 py-2 text-xs font-semibold uppercase text-slate-500">Actividad</div>
        <ul className="max-h-72 overflow-auto px-3 py-2 font-mono text-xs" data-testid="station-log">
          {log.length === 0 && <li className="text-slate-400">Sin actividad todavía.</li>}
          {log.map((r, i) => (
            <li key={i} className={r.ok ? 'text-slate-700' : 'text-rose-700'}>{r.t} {r.msg}</li>
          ))}
        </ul>
      </div>
      <div className="mt-4 text-xs text-slate-500">
        La primera vez, "Elegir la Zebra" abre una ventanita del navegador: selecciona la Zebra y "Conectar". Después el navegador la recuerda. Si otra app (por ejemplo la de etiquetas SAE) está usando la impresora en ese momento, la etiqueta se reintenta en el siguiente ciclo. Para que arranque sola: fija esta pestaña y agrega la página a "Abrir al iniciar" en el navegador.
      </div>
    </div>
  );
}
