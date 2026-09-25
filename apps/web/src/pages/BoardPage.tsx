// /board?k=<token> — the delivery whiteboard on a TV: full screen, big type, grouped by day, refreshes every 30 s.
// No session: the token in the link is read-only and only returns the calendar.
import { useEffect, useState } from 'react';
import { dayLabel, fetchBoard, groupByDay, type Delivery } from '../api/deliveries';

export default function BoardPage() {
  const token = new URLSearchParams(window.location.search).get('k') ?? '';
  const [data, setData] = useState<{ board: string; items: Delivery[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // TV mode: keep the screen awake (where the browser allows it), hide the cursor, reload on a new deployment
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const wl = (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock;
    const acquire = () => wl?.request('screen').then((l) => { lock = l; }).catch(() => undefined);
    void acquire();
    const onVis = () => { if (document.visibilityState === 'visible') void acquire(); };
    document.addEventListener('visibilitychange', onVis);
    document.body.style.cursor = 'none';
    const current = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(Array.from(document.scripts).map((x) => x.src).join(' '))?.[1] ?? null;
    const upd = window.setInterval(async () => {
      try {
        const html = await (await fetch('/', { cache: 'no-store', credentials: 'omit' })).text();
        const b = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html)?.[1] ?? null;
        if (b && current && b !== current) window.location.reload();
      } catch { /* offline: keep showing the last data */ }
    }, 10 * 60_000);
    return () => { document.removeEventListener('visibilitychange', onVis); window.clearInterval(upd); document.body.style.cursor = ''; void lock?.release(); };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetchBoard(token, 21);
        if (alive) { setData(r); setError(null); }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const id = window.setInterval(() => { void load(); setTick((t) => t + 1); }, 30_000);
    return () => { alive = false; window.clearInterval(id); };
  }, [token]);

  // calendar: this week and next, Monday to Saturday (Sunday deliveries show in Saturday's box)
  const items = data?.items ?? [];
  const now = new Date();
  const todayIso = localIso(now);
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const mondayIso = localIso(monday);
  const days: { iso: string; sundayIso: string | null; d: Date }[] = [];
  for (let w = 0; w < 2; w++) for (let c = 0; c < 6; c++) {
    const d = new Date(monday); d.setDate(monday.getDate() + w * 7 + c);
    const sun = new Date(d); sun.setDate(d.getDate() + 1);
    days.push({ iso: localIso(d), sundayIso: c === 5 ? localIso(sun) : null, d });
  }
  const overdue = items.filter((i) => i.status === 'PLANNED' && i.delivery_date < mondayIso);
  const byDay = groupByDay(items);
  const of = (iso: string) => byDay.find((g) => g.date === iso)?.items ?? [];

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 p-5 text-white" style={{ fontSize: 'clamp(14px, 1.35vw, 26px)' }}>
      <div className="mb-3 flex items-end justify-between border-b border-slate-700 pb-2">
        <div>
          <div className="text-[1.5em] font-black uppercase tracking-wide">Entregas</div>
          <div className="text-[0.75em] text-slate-400">{data?.board ?? 'Tablero'} · actualizado {now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}</div>
        </div>
        <div className="text-right text-[1.05em] text-slate-300">{now.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
      </div>
      {!token && <div className="text-[1.2em] text-rose-400">Falta el enlace del tablero. Genera uno en Entregas → Ver en TV.</div>}
      {error && <div className="text-[1em] text-rose-400">{error}{data ? ' · mostrando la última información' : ''}</div>}
      <div className="grid flex-1 gap-2" style={{ gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gridTemplateRows: 'repeat(2, minmax(0, 1fr))' }} data-tick={tick}>
        {days.map(({ iso, sundayIso, d }) => {
          const isToday = iso === todayIso;
          const past = iso < todayIso;
          const list = [...of(iso), ...(sundayIso ? of(sundayIso).map((i) => ({ ...i, title: `dom · ${i.title}` })) : [])];
          const { name } = dayLabel(iso);
          return (
            <section key={iso} className={`flex min-h-0 flex-col rounded-xl border-2 p-2 ${isToday ? 'border-amber-400 bg-amber-400/10' : past ? 'border-slate-800 bg-slate-900/60' : 'border-slate-700 bg-slate-900'}`}>
              <div className={`mb-1 text-[1em] font-black capitalize ${isToday ? 'text-amber-300' : past ? 'text-slate-500' : 'text-slate-200'}`}>{name}{isToday ? ' · HOY' : ''}</div>
              <ul className="grid min-h-0 gap-1.5 overflow-hidden">
                {list.slice(0, 6).map((i) => (
                  <li key={i.id} className={`rounded-lg bg-slate-800/80 px-2 py-1 ${i.status === 'DONE' ? 'opacity-50' : ''}`}>
                    <div className={`text-[1em] font-black leading-tight ${i.status === 'DONE' ? 'line-through' : ''}`}>{i.delivery_time && <span className="mr-1 text-amber-300">{i.delivery_time}</span>}{i.title}</div>
                    {i.notes && <div className="text-[0.72em] leading-tight text-slate-300">{i.notes}</div>}
                  </li>
                ))}
                {list.length > 6 && <li className="text-[0.75em] text-slate-400">+{list.length - 6} más</li>}
              </ul>
              <span className="hidden">{d.getDate()}</span>
            </section>
          );
        })}
      </div>
      {overdue.length > 0 && <div className="mt-2 text-[0.8em] font-bold text-rose-400">ATRASADAS: {overdue.map((i) => `${i.title} (${i.delivery_date.slice(8, 10)}/${i.delivery_date.slice(5, 7)})`).join(' · ')}</div>}
      {data && items.length === 0 && <div className="mt-2 text-center text-[1.2em] text-slate-400">Sin entregas programadas</div>}
    </div>
  );
}

function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
