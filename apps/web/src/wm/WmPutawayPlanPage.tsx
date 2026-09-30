// /wm/putaway-plan — put-away by receipt: every pallet of a receipt on one screen, choose where each one goes
// (no scanning here; the forklift still confirms each pallet in "Ubicar" by scanning LPN + location).
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { inboundApi } from '../api/inbound';
import { putawayApi } from '../api/storage';
import type { PutawayOption, ReceiptPutawayPallet } from '../api/types';
import { fmtQty } from '../lib/format';
import { LocationPicker } from './LocationPicker';
import { BigButton, StepBar, useWm, WmList, WmShell } from './WmShell';

export default function WmPutawayPlanPage() {
  return (
    <WmShell title="Acomodo por recepción">
      <Flow />
    </WmShell>
  );
}

function Flow() {
  const wm = useWm();
  const qc = useQueryClient();
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ pallet: ReceiptPutawayPallet; list: PutawayOption[]; selected: string } | null>(null);
  const receipts = useQuery({ queryKey: ['receipts-pending-putaway'], queryFn: inboundApi.pendingPutaway, refetchInterval: 15_000 });
  const plan = useQuery({ queryKey: ['receipt-putaway', receiptId], queryFn: () => inboundApi.putawayPlan(receiptId!), enabled: !!receiptId, refetchInterval: 15_000 });

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
    if (!receiptId) return;
    setBusy(true);
    try {
      const r = await inboundApi.closePutawayPlan(receiptId);
      wm.ok(`ACOMODO CERRADO · ${r.planned.length} tarimas · ${r.printed.length} etiquetas enviadas${r.failed.length ? ` · ${r.failed.length} sin imprimir` : ''}`);
      if (r.failed.length) wm.warn(`SIN IMPRIMIR: ${r.failed.map((f) => f.lpn).join(', ')} (${r.failed[0]!.error})`);
      void qc.invalidateQueries({ queryKey: ['receipt-putaway', receiptId] });
      void qc.invalidateQueries({ queryKey: ['receipts-pending-putaway'] });
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
      void qc.invalidateQueries({ queryKey: ['receipt-putaway', receiptId] });
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (!receiptId)
    return (
      <div>
        <StepBar text="RECEPCIONES CON TARIMAS POR ACOMODAR · ELIGE UNA" />
        <WmList
          items={receipts.data}
          keyOf={(r) => r.id}
          onSelect={(r) => setReceiptId(r.id)}
          empty="No hay tarimas pendientes de acomodo"
          testId="receipt-list"
          render={(r) => (
            <div className="flex items-center justify-between">
              <div>
                <div className="font-mono text-xl font-black">{r.receipt_number}</div>
                <div className="text-sm text-slate-300">{r.container_number ?? 'sin contenedor'}</div>
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
      <StepBar text={`${plan.data?.receipt.receipt_number ?? ''} · TOCA UNA TARIMA PARA ELEGIR SU DESTINO`} />
      <div className="mb-2 flex items-center justify-between rounded-2xl bg-slate-800 px-4 py-2">
        <span className="text-sm text-slate-300">{pallets.length} tarima(s)</span>
        <span className="text-sm font-bold text-amber-300">{pending} por ubicar</span>
      </div>
      <WmList
        items={plan.data ? pallets : undefined}
        keyOf={(p) => p.lpn_id}
        onSelect={(p) => (p.pending ? void open(p) : wm.warn(`${p.lpn_code} YA ESTÁ UBICADA EN ${p.current_location ?? '?'}`))}
        empty="Esta recepción no tiene tarimas"
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
        <BigButton tone="success" className="mt-3" onClick={() => void closePlan()} disabled={busy || pallets.some((p) => p.pending && !p.target)} testId="plan-close">
          Cerrar acomodo e imprimir etiquetas ({pending})
        </BigButton>
      )}
      {pallets.some((p) => p.pending && !p.target) && <div className="mt-1 text-center text-sm text-amber-300">Hay tarimas sin destino: asígnales uno para poder cerrar.</div>}
      <BigButton tone="neutral" className="mt-3" onClick={() => setReceiptId(null)} disabled={busy}>
        Volver a recepciones
      </BigButton>
    </div>
  );
}
