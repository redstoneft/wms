// /wm/deliveries — the delivery whiteboard, kept from the handheld: upcoming deliveries by day, add / edit / done /
// cancel, and the TV board link ("Ver en TV").
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { dayLabel, deliveriesApi, groupByDay, type Delivery } from '../api/deliveries';
import { masterdataApi } from '../api/masterdata';
import { useAuth } from '../auth/AuthContext';
import { BigButton, StepBar, useWm, WmShell } from './WmShell';

export default function WmDeliveriesPage() {
  return (
    <WmShell title="Entregas">
      <Flow />
    </WmShell>
  );
}

const today = () => new Date(new Date().getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

function Flow() {
  const wm = useWm();
  const qc = useQueryClient();
  const { can } = useAuth();
  const list = useQuery({ queryKey: ['deliveries'], queryFn: () => deliveriesApi.list(30), refetchInterval: 30_000 });
  const [mode, setMode] = useState<'LIST' | 'FORM' | 'TV'>('LIST');
  const [editing, setEditing] = useState<Delivery | null>(null);
  const [title, setTitle] = useState('');
  const [customerCode, setCustomerCode] = useState('');
  const [customerQ, setCustomerQ] = useState('');
  const [date, setDate] = useState(today());
  const [time, setTime] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const customers = useQuery({ queryKey: ['customers', 'all'], queryFn: () => masterdataApi.parties('customers', { limit: 500 }), enabled: mode === 'FORM' });
  const customerRows = useMemo(() => {
    const raw = customers.data as unknown as { items?: { code: string; name: string }[] } | { code: string; name: string }[] | undefined;
    const all = Array.isArray(raw) ? raw : raw?.items ?? [];
    const q = customerQ.trim().toLowerCase();
    return q.length < 2 ? [] : all.filter((c) => c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)).slice(0, 8);
  }, [customers.data, customerQ]);
  const groups = groupByDay(list.data ?? []);

  const openNew = () => { setEditing(null); setTitle(''); setCustomerCode(''); setCustomerQ(''); setDate(today()); setTime(''); setNotes(''); setMode('FORM'); };
  const openEdit = (d: Delivery) => { setEditing(d); setTitle(d.title); setCustomerCode(''); setCustomerQ(''); setDate(d.delivery_date); setTime(d.delivery_time ?? ''); setNotes(d.notes ?? ''); setMode('FORM'); };
  const save = async () => {
    setBusy(true);
    try {
      const body = { title: title.trim(), customer_code: customerCode || undefined, delivery_date: date, delivery_time: time || undefined, notes: notes.trim() || undefined };
      if (editing) await deliveriesApi.update(editing.id, body);
      else await deliveriesApi.create(body);
      wm.ok(editing ? 'ENTREGA ACTUALIZADA' : 'ENTREGA AGREGADA');
      void qc.invalidateQueries({ queryKey: ['deliveries'] });
      setMode('LIST');
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const setStatus = async (d: Delivery, status: Delivery['status']) => {
    setBusy(true);
    try {
      if (status === 'CANCELLED') await deliveriesApi.remove(d.id);
      else await deliveriesApi.update(d.id, { status });
      wm.ok(status === 'DONE' ? `ENTREGADO · ${d.title}` : status === 'CANCELLED' ? `QUITADA · ${d.title}` : `PENDIENTE · ${d.title}`);
      void qc.invalidateQueries({ queryKey: ['deliveries'] });
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const makeLink = async () => {
    setBusy(true);
    try {
      const r = await deliveriesApi.boardLink('TV almacén');
      setLink(`${window.location.origin}/board?k=${r.token}`);
      wm.ok('ENLACE DEL TABLERO GENERADO');
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'FORM')
    return (
      <div>
        <StepBar text={editing ? `EDITAR · ${editing.title}` : 'NUEVA ENTREGA'} />
        <label className="block">
          <div className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-300">Cliente / entrega</div>
          <input value={title} onChange={(e) => { setTitle(e.target.value); setCustomerQ(e.target.value); }} placeholder="Coppel, Walmart, H.E.B…" className="w-full rounded-lg border-2 border-slate-500 bg-slate-900 px-3 py-3 text-2xl text-white" data-testid="delivery-title" />
        </label>
        {customerRows.length > 0 && !customerCode && (
          <div className="mt-1 grid gap-1">
            {customerRows.map((c) => (
              <button key={c.code} type="button" className="rounded-xl bg-slate-800 px-3 py-2 text-left" onClick={() => { setTitle(c.name); setCustomerCode(c.code); setCustomerQ(''); }}>
                <span className="font-bold text-white">{c.name}</span> <span className="text-xs text-slate-400">{c.code}</span>
              </button>
            ))}
          </div>
        )}
        {customerCode && <div className="mt-1 text-xs text-emerald-300">Cliente del catálogo: {customerCode}</div>}
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="block">
            <div className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-300">Fecha</div>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full rounded-lg border-2 border-slate-500 bg-slate-900 px-3 py-3 text-xl text-white" data-testid="delivery-date" />
          </label>
          <label className="block">
            <div className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-300">Hora (opcional)</div>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="w-full rounded-lg border-2 border-slate-500 bg-slate-900 px-3 py-3 text-xl text-white" data-testid="delivery-time" />
          </label>
        </div>
        <label className="mt-3 block">
          <div className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-300">Notas (naves, sucursales, horarios)</div>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Nave 1 5:00pm · Nave 3 · Sta. Bárbara 8:00am · Chalco" className="w-full rounded-lg border-2 border-slate-500 bg-slate-900 px-3 py-3 text-lg text-white" data-testid="delivery-notes" />
        </label>
        <BigButton tone="success" className="mt-3" disabled={busy || !title.trim() || !date} onClick={save} testId="delivery-save">
          {editing ? 'Guardar cambios' : 'Agregar al calendario'}
        </BigButton>
        <BigButton tone="neutral" className="mt-3" onClick={() => setMode('LIST')}>
          Regresar
        </BigButton>
      </div>
    );

  if (mode === 'TV')
    return (
      <div>
        <StepBar text="VER EN TV" />
        <div className="rounded-2xl bg-slate-900 p-3 text-sm text-slate-200">
          <p>El tablero es una página que se abre en el navegador de la TV (o de la computadora conectada a la TV) y se actualiza sola cada 30 segundos. No pide usuario: usa un enlace propio, de solo lectura.</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>Genera el enlace (una sola vez) y cópialo.</li>
            <li>En la TV abre ese enlace y ponlo en pantalla completa. Guárdalo como favorito o página de inicio.</li>
            <li>Para que la TV esté siempre encendida con el calendario: una PC (o mini PC) conectada por HDMI con <b>tablero_tv.bat</b> (abajo); o un Android TV con la app Fully Kiosk Browser apuntando al enlace. En la TV, apaga el temporizador de apagado automático.</li>
            <li>Para proyectar desde este handheld: abre el tablero aquí y usa "Transmitir pantalla" de Android a la TV.</li>
          </ol>
        </div>
        {can('orders.manage') ? (
          <BigButton tone="primary" className="mt-3" onClick={makeLink} disabled={busy} testId="board-link">
            Generar enlace para la TV
          </BigButton>
        ) : (
          <div className="mt-3 text-sm text-amber-300">El enlace lo genera un supervisor desde esta misma pantalla.</div>
        )}
        {link && (
          <div className="mt-3 rounded-2xl border-2 border-emerald-500 bg-slate-900 p-3">
            <div className="mb-1 text-xs uppercase text-slate-400">Enlace del tablero (se muestra una sola vez)</div>
            <div className="select-all break-all font-mono text-sm text-emerald-300" data-testid="board-url">{link}</div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <BigButton tone="neutral" onClick={() => { void navigator.clipboard?.writeText(link); wm.ok('COPIADO'); }}>
                Copiar
              </BigButton>
              <BigButton tone="success" onClick={() => window.open(link, '_blank')}>
                Abrir tablero
              </BigButton>
            </div>
            <a
              className="mt-2 block rounded-2xl bg-sky-700 px-4 py-3 text-center text-sm font-bold text-white"
              href={URL.createObjectURL(new Blob([`@echo off\r\nrem Tablero de entregas del WMS para la PC conectada a la TV. Doble clic una vez: la PC ya no se apaga ni apaga la pantalla,\r\nrem se copia a la carpeta Inicio y abre el tablero en pantalla completa (kiosco) cada vez que se prende.\r\nset "URL=${link}"\r\nset "INICIO=%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\"\r\nif /i not "%~dp0"=="%INICIO%" copy /y "%~f0" "%INICIO%tablero_tv.bat" >nul 2>nul\r\npowercfg /change monitor-timeout-ac 0 >nul 2>nul\r\npowercfg /change standby-timeout-ac 0 >nul 2>nul\r\npowercfg /change hibernate-timeout-ac 0 >nul 2>nul\r\nif /i "%~dp0"=="%INICIO%" timeout /t 20 >nul\r\nstart "" msedge --kiosk "%URL%" --edge-kiosk-type=fullscreen --no-first-run 2>nul || start "" chrome --kiosk "%URL%" --no-first-run 2>nul || start "" "%URL%"\r\n`], { type: 'application/octet-stream' }))}
              download="tablero_tv.bat"
              data-testid="board-kiosk-bat"
            >
              Descargar tablero_tv.bat (PC Windows conectada a la TV: pantalla completa, sin apagarse, arranca solo)
            </a>
          </div>
        )}
        <BigButton tone="neutral" className="mt-3" onClick={() => setMode('LIST')}>
          Regresar
        </BigButton>
      </div>
    );

  return (
    <div>
      <StepBar text="CALENDARIO DE ENTREGAS" />
      <div className="grid grid-cols-2 gap-2">
        <BigButton tone="success" onClick={openNew} testId="delivery-new">
          + Nueva entrega
        </BigButton>
        <BigButton tone="primary" onClick={() => setMode('TV')} testId="delivery-tv">
          Ver en TV
        </BigButton>
      </div>
      {groups.length === 0 && <div className="mt-4 text-center text-lg text-slate-300">{list.isLoading ? 'Cargando…' : 'Sin entregas programadas'}</div>}
      <div className="mt-3 grid gap-3" data-testid="delivery-list">
        {groups.map((g) => {
          const { name, rel } = dayLabel(g.date);
          return (
            <div key={g.date} className="rounded-2xl bg-slate-900 p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-lg font-black capitalize text-white">{name}</span>
                {rel && <span className={`rounded-full px-2 text-xs font-bold ${rel === 'ATRASADA' ? 'bg-rose-600 text-white' : 'bg-amber-400 text-amber-950'}`}>{rel}</span>}
              </div>
              <ul className="grid gap-2">
                {g.items.map((d) => (
                  <li key={d.id} className={`rounded-xl px-3 py-2 ${d.status === 'DONE' ? 'bg-slate-800/60 opacity-60' : 'bg-slate-800'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-xl font-black ${d.status === 'DONE' ? 'line-through' : ''}`}>{d.title}</span>
                      {d.delivery_time && <span className="font-mono text-xl font-black text-amber-300">{d.delivery_time}</span>}
                    </div>
                    {d.notes && <div className="text-sm text-slate-300">{d.notes}</div>}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {d.status !== 'DONE' ? (
                        <button type="button" className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-bold text-white" onClick={() => void setStatus(d, 'DONE')} disabled={busy}>
                          ✓ Entregado
                        </button>
                      ) : (
                        <button type="button" className="rounded-lg bg-slate-600 px-3 py-1.5 text-sm font-bold text-white" onClick={() => void setStatus(d, 'PLANNED')} disabled={busy}>
                          Reabrir
                        </button>
                      )}
                      <button type="button" className="rounded-lg bg-slate-700 px-3 py-1.5 text-sm font-bold text-white" onClick={() => openEdit(d)} disabled={busy}>
                        Editar
                      </button>
                      <button type="button" className="rounded-lg bg-rose-800 px-3 py-1.5 text-sm font-bold text-white" onClick={() => { if (window.confirm(`¿Quitar ${d.title} del calendario?`)) void setStatus(d, 'CANCELLED'); }} disabled={busy}>
                        Quitar
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
