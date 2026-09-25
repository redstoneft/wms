// The order's outbound pallets as the picker sees them: the one being filled (closable when full or when the next
// pieces go elsewhere), the closed ones, each with its delivery destination and label.
import { useState } from 'react';
import { labelsApi } from '../api/labels';
import { pickingApi } from '../api/orders';
import type { OutboundPallet } from '../api/types';
import { fmtQty } from '../lib/format';
import { BigButton, useWm } from './WmShell';

const STATUS: Record<string, string> = { PICKING: 'surtida', STAGED: 'en staging', LOADED: 'cargada' };

export function OutboundPallets({ taskId, pallets, orderDestination, onChanged, busy, setBusy, compact }: { taskId: string; pallets: OutboundPallet[]; orderDestination: string | null; onChanged: (pallets: OutboundPallet[]) => void; busy: boolean; setBusy: (b: boolean) => void; compact?: boolean }) {
  const wm = useWm();
  const [closing, setClosing] = useState<{ destination: string } | null>(null);
  const [editing, setEditing] = useState<{ lpn: string; destination: string } | null>(null);
  const open = pallets.find((p) => p.open) ?? null;
  const shown = compact ? pallets.filter((p) => p.open) : pallets;

  const print = async (lpn: string) => {
    try {
      await labelsApi.print({ label_type: 'LPN', entity_id: lpn });
      wm.ok(`ETIQUETA ${lpn} ENVIADA`);
    } catch (e) {
      wm.fail(e);
    }
  };
  const close = async () => {
    if (!closing) return;
    setBusy(true);
    try {
      const r = await pickingApi.closePallet({ pick_task_id: taskId, destination: closing.destination.trim() || undefined });
      wm.ok(`TARIMA ${r.lpn_code} CERRADA · ${fmtQty(r.qty)} PZAS${r.destination ? ` · ${r.destination}` : ''} · LO SIGUIENTE VA EN UNA NUEVA`);
      setClosing(null);
      onChanged(r.pallets);
      await print(r.lpn_code);
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const saveDestination = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      const r = await pickingApi.palletDestination({ lpn_code: editing.lpn, destination: editing.destination });
      wm.ok(r.destination ? `${r.lpn_code} → ${r.destination}` : `${r.lpn_code} SIN DESTINO PROPIO`);
      setEditing(null);
      onChanged(r.pallets);
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (compact && !open) return null;
  return (
    <div className="mt-2 rounded-2xl bg-slate-900 p-2" data-testid="outbound-pallets">
      <div className="mb-1 flex items-center justify-between">
        <div className="text-xs font-bold uppercase tracking-wide text-slate-400">{compact ? 'Tarima de salida que estás llenando' : `Tarimas de salida · ${pallets.length}`}</div>
        {orderDestination && <div className="text-xs text-slate-400">Pedido → {orderDestination}</div>}
      </div>
      <div className="grid gap-1.5">
        {shown.map((p) => (
          <div key={p.lpn_code} className={`rounded-xl px-3 py-2 ${p.open ? 'border-2 border-amber-400 bg-amber-400/10' : 'bg-slate-800'}`} data-testid="outbound-pallet">
            <div className="flex items-center justify-between gap-2">
              <div className="font-mono text-lg font-black">{p.lpn_code}</div>
              <div className="text-sm text-slate-300">{fmtQty(p.qty)} pzas · {p.open ? 'ABIERTA' : STATUS[p.status] ?? p.status}</div>
            </div>
            <div className="text-xs text-slate-300">{p.skus.join(', ')}</div>
            <div className="text-sm">
              <span className="text-slate-400">Entrega: </span>
              <span className={`font-bold ${p.destination ? 'text-violet-300' : 'text-slate-300'}`}>{p.destination ?? orderDestination ?? 'sin destino'}</span>
            </div>
            {editing?.lpn === p.lpn_code ? (
              <div className="mt-1 grid gap-1">
                <input value={editing.destination} onChange={(e) => setEditing({ ...editing, destination: e.target.value })} placeholder="Ej. CEDIS 7494 · Tienda 1166" className="w-full rounded-lg border-2 border-slate-500 bg-slate-900 px-3 py-2 text-lg text-white" data-testid="pallet-destination-input" />
                <div className="grid grid-cols-2 gap-1">
                  <BigButton tone="neutral" onClick={() => setEditing(null)}>Cancelar</BigButton>
                  <BigButton tone="success" onClick={saveDestination} disabled={busy} testId="pallet-destination-save">Guardar</BigButton>
                </div>
              </div>
            ) : p.open && closing ? (
              <div className="mt-1 grid gap-1">
                <div className="text-xs text-slate-300">¿A dónde va esta tarima? (opcional; si no, el destino del pedido)</div>
                <input value={closing.destination} onChange={(e) => setClosing({ destination: e.target.value })} placeholder="Ej. CEDIS 7494 · Tienda 1166" className="w-full rounded-lg border-2 border-slate-500 bg-slate-900 px-3 py-2 text-lg text-white" data-testid="close-destination-input" />
                <div className="grid grid-cols-2 gap-1">
                  <BigButton tone="neutral" onClick={() => setClosing(null)}>Cancelar</BigButton>
                  <BigButton tone="success" onClick={close} disabled={busy} testId="close-pallet-confirm">Cerrar e imprimir</BigButton>
                </div>
              </div>
            ) : (
              <div className={`mt-1 grid gap-1 ${p.open ? 'grid-cols-1' : 'grid-cols-2'}`}>
                {p.open ? (
                  <button type="button" onClick={() => setClosing({ destination: '' })} disabled={busy} className="rounded-xl bg-amber-400 py-2 text-sm font-black uppercase text-amber-950 active:bg-amber-300" data-testid="close-pallet">
                    Tarima llena / va a otro lado → cerrar y abrir otra
                  </button>
                ) : (
                  <>
                    {p.status !== 'LOADED' && (
                      <button type="button" onClick={() => setEditing({ lpn: p.lpn_code, destination: p.destination ?? '' })} disabled={busy} className="rounded-xl border-2 border-violet-500 py-2 text-sm font-bold text-violet-300" data-testid="pallet-destination">
                        Destino
                      </button>
                    )}
                    <button type="button" onClick={() => void print(p.lpn_code)} disabled={busy} className="rounded-xl border-2 border-sky-500 py-2 text-sm font-bold text-sky-300" data-testid="pallet-print">
                      Etiqueta
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
        {!compact && pallets.length === 0 && <div className="text-sm text-slate-400">Aún no hay tarimas de salida.</div>}
      </div>
    </div>
  );
}
