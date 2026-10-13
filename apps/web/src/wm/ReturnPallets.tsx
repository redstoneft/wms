// Pallets of an open return on the handheld: split one into several (cases or pieces per pallet), choose where each
// one goes (its put-away task) and print the labels. Each action takes the whole screen so the keyboard never hides it.
import { useState } from 'react';
import { api } from '../api/client';
import { labelsApi } from '../api/labels';
import { returnsApi } from '../api/returns';
import { putawayApi } from '../api/storage';
import type { PutawayOption } from '../api/types';
import { fmtQty } from '../lib/format';
import { LocationPicker } from './LocationPicker';
import { BigButton, StepBar, useWm } from './WmShell';

type OpenReturn = Awaited<ReturnType<typeof returnsApi.open>>[number];
type Line = OpenReturn['lines'][number];

export function ReturnPallets({ ret, onChanged }: { ret: OpenReturn | null; onChanged: () => void }) {
  const wm = useWm();
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<{ kind: 'LIST' } | { kind: 'SPLIT'; line: Line } | { kind: 'CHOOSE'; taskId: string; lpn: string; list: PutawayOption[]; selected: string }>({ kind: 'LIST' });
  const [parts, setParts] = useState<string[]>([]);
  const [unit, setUnit] = useState<'CASE' | 'PIECE'>('PIECE');
  const [created, setCreated] = useState<string[]>([]);
  if (!ret) return null;
  const withPallet = ret.lines.filter((l) => l.lpn);
  if (!withPallet.length) return null;

  const print = async (codes: string[]) => {
    setBusy(true);
    try {
      for (const c of codes) await labelsApi.print({ label_type: 'LPN', entity_id: c });
      wm.ok(`${codes.length} ETIQUETA(S) ENVIADA(S)`);
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const startSplit = (line: Line) => {
    const caseQty = line.case_qty ? Number(line.case_qty) : 0;
    const total = Number(line.received_qty);
    const useCases = caseQty > 1 && total % caseQty === 0;
    setUnit(useCases ? 'CASE' : 'PIECE');
    const t = useCases ? total / caseQty : total;
    const extra = Number(line.lpn!.on_pallet) - total;
    setParts(extra > 0 ? [String(t)] : [String(Math.ceil(t / 2)), String(Math.floor(t / 2))]);
    setView({ kind: 'SPLIT', line });
  };
  const toPieces = (v: string, line: Line) => (unit === 'CASE' ? (Number(v) || 0) * Number(line.case_qty ?? 1) : Number(v) || 0);
  const doSplit = async (line: Line) => {
    const pieces = parts.map((p) => toPieces(p, line));
    const sum = pieces.reduce((a, b) => a + b, 0);
    const total = Number(line.received_qty);
    const extra = Number(line.lpn!.on_pallet) - total;
    if (extra <= 0 && pieces.length < 2) { wm.warn('ELIGE AL MENOS 2 TARIMAS'); return; }
    if (pieces.some((p) => p <= 0)) { wm.warn('CADA TARIMA DEBE LLEVAR ALGO'); return; }
    if (sum !== total) { wm.warn(`SUMAN ${fmtQty(String(sum))} Y LA TARIMA TIENE ${fmtQty(line.received_qty)}`); return; }
    setBusy(true);
    try {
      const r = await returnsApi.splitPallet({ return_id: ret.id, lpn_code: line.lpn!.code, parts: pieces.map(String) }, api.newKey());
      setCreated(r.data.pallets.map((p) => p.code));
      wm.ok(`${r.data.sku}: ${r.data.pallets.length} TARIMA(S) · ${r.data.pallets.map((p) => `${p.code} ${fmtQty(p.qty)}`).join(' · ')}${Number(r.data.kept_on_original) > 0 ? ` · ${r.data.original} SE QUEDA CON ${fmtQty(r.data.kept_on_original)} QUE NO SON DEVOLUCIÓN` : ''}`);
      setView({ kind: 'LIST' });
      onChanged();
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const openChooser = async (taskId: string, lpn: string) => {
    setBusy(true);
    try {
      const r = await putawayApi.options(taskId);
      if (!r.options.length) { wm.warn('NO HAY UBICACIONES LIBRES PARA ESTA TARIMA'); return; }
      setView({ kind: 'CHOOSE', taskId, lpn, list: r.options, selected: r.options.find((o) => !o.is_current)?.code ?? r.options[0]!.code });
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const choose = async () => {
    if (view.kind !== 'CHOOSE') return;
    setBusy(true);
    try {
      const r = await putawayApi.choose(view.taskId, { location_code: view.selected });
      wm.ok(`${view.lpn} → ${r.target.code} · LLÉVALA Y CONFIRMA EN UBICAR`);
      setView({ kind: 'LIST' });
      onChanged();
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (view.kind === 'CHOOSE')
    return (
      <div className="mt-3" data-testid="return-location-chooser">
        <StepBar text={`UBICACIÓN PARA ${view.lpn}`} />
        <LocationPicker list={view.list} selected={view.selected} onSelect={(code) => setView({ ...view, selected: code })} testId="return-location-select" />
        <div className="mt-2 grid grid-cols-2 gap-2">
          <BigButton tone="neutral" onClick={() => setView({ kind: 'LIST' })}>Cancelar</BigButton>
          <BigButton tone="success" onClick={() => void choose()} disabled={busy} testId="return-location-use">Usar esta ubicación</BigButton>
        </div>
      </div>
    );
  if (view.kind === 'SPLIT') {
    const line = view.line;
    const total = Number(line.received_qty);
    const caseQty = line.case_qty ? Number(line.case_qty) : 0;
    const sum = parts.reduce((a, p) => a + toPieces(p, line), 0);
    const extra = Number(line.lpn!.on_pallet) - total;
    return (
      <div className="mt-3" data-testid="return-split-form">
        <StepBar text={`SEPARAR ${line.lpn!.code} · ${fmtQty(line.received_qty)} PZAS DE ${line.sku_code}`} />
        {extra > 0 && <div className="mb-2 rounded-xl border-2 border-amber-400 bg-amber-900/40 px-3 py-2 text-sm text-amber-100">{line.lpn!.code} tiene además {fmtQty(String(extra))} pzas que no son de la devolución: esas se quedan ahí. Toda la devolución pasa a tarimas nuevas con etiqueta nueva.</div>}
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-300">Tarimas:</span>
            <button type="button" className="h-12 w-12 rounded-xl bg-slate-700 text-2xl font-black" onClick={() => setParts(parts.length > (extra > 0 ? 1 : 2) ? parts.slice(0, -1) : parts)} aria-label="menos">−</button>
            <div className="w-8 text-center font-mono text-3xl font-black">{parts.length}</div>
            <button type="button" className="h-12 w-12 rounded-xl bg-slate-700 text-2xl font-black" onClick={() => setParts(parts.length < 50 ? [...parts, '0'] : parts)} aria-label="más">+</button>
          </div>
          {caseQty > 1 && (
            <button type="button" className="rounded-xl bg-slate-700 px-3 py-2 text-sm font-bold" onClick={() => { const next = unit === 'CASE' ? 'PIECE' : 'CASE'; setParts(parts.map((p) => (unit === 'CASE' ? String((Number(p) || 0) * caseQty) : String(Math.floor((Number(p) || 0) / caseQty))))); setUnit(next); }}>
              {unit === 'CASE' ? `en cajas (${caseQty} pzas)` : 'en piezas'}
            </button>
          )}
        </div>
        <ul className="grid gap-2">
          {parts.map((p, i) => (
            <li key={i} className="flex items-center gap-3 rounded-xl bg-slate-800 px-3 py-2">
              <div className="w-28 text-sm text-slate-300">{extra > 0 ? `Tarima nueva ${i + 1}` : i === 0 ? `${line.lpn!.code.slice(-5)} (actual)` : `Tarima nueva ${i}`}</div>
              <input inputMode="numeric" value={p} onChange={(e) => setParts(parts.map((x, j) => (j === i ? e.target.value.replace(/\D/g, '') : x)))} className="h-12 w-24 rounded-lg bg-slate-900 px-2 text-center font-mono text-2xl font-black text-white" data-testid={`return-part-${i}`} />
              <div className="text-sm text-slate-400">{unit === 'CASE' ? `cajas = ${fmtQty(String(toPieces(p, line)))} pzas` : 'pzas'}</div>
            </li>
          ))}
        </ul>
        <div className={`mt-2 text-center text-lg font-bold ${sum === total ? 'text-emerald-400' : 'text-rose-400'}`}>Suman {fmtQty(String(sum))} de {fmtQty(line.received_qty)} pzas</div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <BigButton tone="neutral" onClick={() => setView({ kind: 'LIST' })}>Cancelar</BigButton>
          <BigButton tone="success" onClick={() => void doSplit(line)} disabled={busy || sum !== total} testId="return-split-go">Separar</BigButton>
        </div>
      </div>
    );
  }
  return (
    <div className="mt-4" data-testid="return-pallets">
      <div className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-400">Tarimas de {ret.return_number}</div>
      <ul className="grid gap-2">
        {withPallet.map((l) => (
          <li key={l.id} className={`rounded-xl px-3 py-2 ${created.includes(l.lpn!.code) ? 'bg-emerald-900/40 ring-2 ring-emerald-500' : 'bg-slate-800'}`}>
            <div className="font-mono text-base font-black">{l.lpn!.code} <span className="text-sm font-normal text-slate-300">· {l.sku_code} · {fmtQty(l.received_qty)} pzas{l.case_qty && Number(l.case_qty) > 1 ? ` (${Math.floor(Number(l.received_qty) / Number(l.case_qty))} cajas)` : ''}</span></div>
            <div className="text-xs text-slate-400">{l.lpn!.location ?? 'sin ubicación'}{l.lpn!.putaway_task_id ? ` · acomodo pendiente → ${l.lpn!.suggested ?? 'por elegir'}` : ''}</div>
            <div className="mt-2 grid grid-cols-3 gap-1">
              {l.lpn!.putaway_task_id ? (
                <button type="button" className="rounded-xl bg-emerald-600 py-2 text-sm font-black text-white disabled:opacity-50" disabled={busy} onClick={() => void openChooser(l.lpn!.putaway_task_id!, l.lpn!.code)} data-testid="return-choose-loc">Ubicación</button>
              ) : <span />}
              <button type="button" className="rounded-xl bg-sky-700 py-2 text-sm font-black text-white disabled:opacity-50" disabled={busy} onClick={() => void print([l.lpn!.code])} data-testid="return-print-one">Etiqueta</button>
              {l.lpn!.status === 'STORED' && Number(l.received_qty) > 1 ? (
                <button type="button" className="rounded-xl bg-violet-600 py-2 text-sm font-black text-white disabled:opacity-50" disabled={busy} onClick={() => startSplit(l)} data-testid="return-split">Separar</button>
              ) : <span />}
            </div>
          </li>
        ))}
      </ul>
      {created.length > 0 && (
        <BigButton tone="primary" className="mt-3" disabled={busy} onClick={() => void print(created)} testId="return-print-new">
          Imprimir las {created.length} etiquetas nuevas
        </BigButton>
      )}
      <div className="mt-2 text-xs text-slate-400">Después de elegir ubicación, lleva cada tarima y confírmala en Ubicar escaneando la posición (o Cerrar acomodo desde la oficina).</div>
    </div>
  );
}
