// /wm/putaway-plan — put-away by batch (receipt or assembly order): every pallet of the batch on one screen, choose where each one goes
// (no scanning here; the forklift still confirms each pallet in "Ubicar" by scanning LPN + location).
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { putawayApi, type PutawayBatch } from '../api/storage';
import type { PutawayOption, ReceiptPutawayPallet } from '../api/types';
import { fmtQty } from '../lib/format';
import { LocationPicker } from './LocationPicker';
import { BigButton, StepBar, useWm, WmList, WmShell } from './WmShell';

export default function WmPutawayPlanPage() {
  return (
    <WmShell title="Acomodo por lote">
      <Flow />
    </WmShell>
  );
}

function Flow() {
  const wm = useWm();
  const qc = useQueryClient();
  const [batch, setBatch] = useState<PutawayBatch | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ pallet: ReceiptPutawayPallet; list: PutawayOption[]; selected: string } | null>(null);
  const batches = useQuery({ queryKey: ['putaway-batches'], queryFn: putawayApi.batches, refetchInterval: 15_000 });
  const plan = useQuery({ queryKey: ['putaway-batch', batch?.kind, batch?.id], queryFn: () => putawayApi.batch(batch!.kind, batch!.id), enabled: !!batch, refetchInterval: 15_000 });

  const open = async (p: ReceiptPutawayPallet) => {
    if (!p.task_id) return;
    setBusy(true);
    try {
      const r = await putawayApi.options(p.task_id);
      if (!r.options.length) { wm.warn('NO HAY UBICACIÓN LIBRE PARA ESTA TARIMA'); return; }
      setEditing({ pallet: p, list: r.options, selected: r.current ?? r.options[0]!.code });
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const closePlan = async () => {
    if (!batch) return;
    setBusy(true);
    try {
      const r = await putawayApi.closeBatch(batch.kind, batch.id);
      if (r.failed.length) wm.warn(`${r.placed.length} TARIMAS UBICADAS · NO SE PUDO: ${r.failed.map((f) => `${f.lpn} (${f.error})`).join(' · ')}`);
      else wm.ok(`ACOMODO CERRADO · ${r.placed.length} TARIMAS UBICADAS EN SU DESTINO`);
      void qc.invalidateQueries({ queryKey: ['putaway-batch'] });
      void qc.invalidateQueries({ queryKey: ['putaway-batches'] });
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const printLabels = async () => {
    if (!batch) return;
    setBusy(true);
    try {
      const r = await putawayApi.printBatchLabels(batch.kind, batch.id);
      if (r.failed.length) wm.warn(`${r.printed.length} ETIQUETAS ENVIADAS · SIN IMPRIMIR: ${r.failed.map((f) => f.lpn).join(', ')} (${r.failed[0]!.error})`);
      else wm.ok(`${r.printed.length} ETIQUETAS ENVIADAS A IMPRIMIR`);
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const save = async (body: { location_code?: string; other?: boolean }) => {
    if (!editing?.pallet.task_id) return;
    setBusy(true);
    try {
      const r = await putawayApi.choose(editing.pallet.task_id, body);
      wm.ok(`${editing.pallet.lpn_code} → ${r.target.code}`);
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['putaway-batch'] });
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (!batch)
    return (
      <div>
        <StepBar text="RECEPCIONES Y ARMADOS CON TARIMAS POR ACOMODAR · ELIGE UNO" />
        <WmList
          items={batches.data}
          keyOf={(r) => `${r.kind}:${r.id}`}
          onSelect={(r) => setBatch(r)}
          empty="No hay tarimas pendientes de acomodo"
          testId="receipt-list"
          render={(r) => (
            <div className="flex items-center justify-between">
              <div>
                <div className="font-mono text-xl font-black">{r.number}</div>
                <div className="text-sm text-slate-300">{r.kind === 'RECEIPT' ? 'Recepción' : 'Armado'}{r.label ? ` · ${r.label}` : ''}</div>
              </div>
              <div className="text-right">
                <div className="text-2xl font-black text-amber-300">{r.pending}</div>
                <div className="text-xs text-slate-400">de {r.total} por ubicar</div>
              </div>
            </div>
          )}
        />
      </div>
    );

  if (editing) {
    const p = editing.pallet;
    return (
      <div>
        <StepBar text={`¿DÓNDE VA ${p.lpn_code}?`} />
        <div className="mb-2 rounded-2xl bg-slate-800 px-4 py-2 text-sm text-slate-300">
          {p.contents.map((c) => `${c.sku} × ${fmtQty(c.qty)}`).join(' · ')} · destino actual <span className="font-mono text-violet-300">{p.target ?? '—'}</span>
        </div>
        <LocationPicker list={editing.list} selected={editing.selected} onSelect={(code) => setEditing({ ...editing, selected: code })} testId="plan-location" />
        <div className="mt-3 grid grid-cols-2 gap-2">
          <BigButton tone="neutral" onClick={() => setEditing(null)} disabled={busy}>
            Cancelar
          </BigButton>
          <BigButton tone="success" onClick={() => void save({ location_code: editing.selected })} disabled={busy} testId="plan-location-use">
            Usar esta ubicación
          </BigButton>
        </div>
        <BigButton tone="neutral" className="mt-2" onClick={() => void save({ other: true })} disabled={busy}>
          Otra ubicación (automática)
        </BigButton>
      </div>
    );
  }

  const pallets = plan.data?.pallets ?? [];
  const pending = pallets.filter((p) => p.pending).length;
  return (
    <div>
      <StepBar text={`${batch.kind === 'RECEIPT' ? 'RECEPCIÓN' : 'ARMADO'} ${batch.number} · TOCA UNA TARIMA PARA ELEGIR SU DESTINO`} />
      <div className="mb-2 rounded-2xl bg-slate-900 px-3 py-2 text-xs text-slate-400">Cerrar acomodo ubica en el sistema todas las tarimas pendientes en su destino, sin escanearlas. Hazlo cuando ya estén (o vayan) físicamente ahí.</div>
      <div className="mb-2 flex items-center justify-between rounded-2xl bg-slate-800 px-4 py-2">
        <span className="text-sm text-slate-300">{pallets.length} tarima(s)</span>
        <span className="text-sm font-bold text-amber-300">{pending} por ubicar</span>
      </div>
      <WmList
        items={plan.data ? pallets : undefined}
        keyOf={(p) => p.lpn_id}
        onSelect={(p) => (p.pending ? void open(p) : wm.warn(`${p.lpn_code} YA ESTÁ UBICADA EN ${p.current_location ?? '?'}`))}
        empty="Este lote no tiene tarimas"
        testId="plan-list"
        render={(p) => (
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="font-mono text-lg font-black">{p.lpn_code}</div>
              <div className="truncate text-sm text-slate-300">{p.contents.map((c) => `${c.sku} × ${fmtQty(c.qty)}`).join(' · ') || 'vacía'}</div>
            </div>
            <div className="shrink-0 text-right">
              {p.pending ? (
                <>
                  <div className={`font-mono text-lg font-black ${p.planned ? 'text-emerald-300' : 'text-violet-300'}`}>{p.target ?? 'sin destino'}</div>
                  <div className="text-xs text-slate-400">{p.planned ? 'elegido · toca para cambiar' : 'sugerido · toca para elegir'}</div>
                </>
              ) : (
                <>
                  <div className="font-mono text-lg font-black text-emerald-300">{p.current_location ?? '—'}</div>
                  <div className="text-xs text-slate-400">ubicada</div>
                </>
              )}
            </div>
          </div>
        )}
      />
      {pending > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <BigButton tone="success" onClick={() => void closePlan()} disabled={busy || pallets.some((p) => p.pending && !p.target)} testId="plan-close">
            Cerrar acomodo ({pending})
          </BigButton>
          <BigButton tone="primary" onClick={() => void printLabels()} disabled={busy} testId="plan-print">
            Imprimir etiquetas ({pending})
          </BigButton>
        </div>
      )}
      {pallets.some((p) => p.pending && !p.target) && <div className="mt-1 text-center text-sm text-amber-300">Hay tarimas sin destino: asígnales uno para poder cerrar.</div>}
      <BigButton tone="neutral" className="mt-3" onClick={() => setBatch(null)} disabled={busy}>
        Volver a la lista
      </BigButton>
    </div>
  );
}
