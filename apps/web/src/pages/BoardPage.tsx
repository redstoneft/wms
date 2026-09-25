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

  const groups = groupByDay(data?.items ?? []);
  const now = new Date();
  return (
    <div className="min-h-screen bg-slate-950 p-6 text-white" style={{ fontSize: 'clamp(16px, 1.6vw, 28px)' }}>
      <div className="mb-4 flex items-end justify-between border-b border-slate-700 pb-3">
        <div>
          <div className="text-[1.6em] font-black uppercase tracking-wide">Entregas</div>
          <div className="text-[0.8em] text-slate-400">{data?.board ?? 'Tablero'} · actualizado {now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}</div>
        </div>
        <div className="text-right text-[1.1em] text-slate-300">{now.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
      </div>
      {!token && <div className="text-[1.2em] text-rose-400">Falta el enlace del tablero. Genera uno en Entregas → Ver en TV.</div>}
      {error && <div className="text-[1.2em] text-rose-400">{error}{data ? ' · mostrando la última información' : ''}</div>}
      {data && groups.length === 0 && <div className="mt-10 text-center text-[1.6em] text-slate-400">Sin entregas programadas</div>}
      <div className="grid gap-5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(28em, 1fr))' }} data-tick={tick}>
        {groups.map((g) => {
          const { name, rel } = dayLabel(g.date);
          return (
            <section key={g.date} className={`rounded-2xl border-2 p-4 ${rel === 'HOY' ? 'border-amber-400 bg-amber-400/10' : rel === 'ATRASADA' ? 'border-rose-600 bg-rose-900/20' : 'border-slate-700 bg-slate-900'}`}>
              <div className="mb-3 flex items-center gap-3">
                <span className="text-[1.4em] font-black capitalize">{name}</span>
                {rel && <span className={`rounded-full px-3 py-0.5 text-[0.7em] font-black ${rel === 'ATRASADA' ? 'bg-rose-600 text-white' : 'bg-amber-400 text-amber-950'}`}>{rel}</span>}
              </div>
              <ul className="grid gap-2">
                {g.items.map((d) => (
                  <li key={d.id} className={`rounded-xl bg-slate-800/80 px-4 py-3 ${d.status === 'DONE' ? 'opacity-50' : ''}`}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className={`text-[1.5em] font-black ${d.status === 'DONE' ? 'line-through' : ''}`}>{d.title}</span>
                      {d.delivery_time && <span className="font-mono text-[1.5em] font-black text-amber-300">{d.delivery_time}</span>}
                    </div>
                    {d.notes && <div className="mt-1 text-[1em] text-slate-300">{d.notes}</div>}
                    {d.status === 'DONE' && <div className="text-[0.8em] font-bold text-emerald-400">ENTREGADO</div>}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
