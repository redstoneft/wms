// Free picking screen: the order is built by scanning pallets (whole, or a quantity from a single-SKU pallet),
// at any moment or day; the picker closes it when the order is complete.
import { useState } from 'react';
import type { UomCode } from '@wms/shared';
import { api } from '../api/client';
import { inventoryApi } from '../api/inventory';
import { pickingApi } from '../api/orders';
import type { PickTaskView } from '../api/types';
import { QtyPad } from '../components/QtyPad';
import { ScanInput } from '../components/ScanInput';
import { fmtQty } from '../lib/format';
import { BigButton, BigValue, StepBar, useWm } from './WmShell';

interface Pallet {
  code: string;
  location: string;
  contents: { sku_code: string; description: string; qty: string }[];
}

export function WmFreePick({ view, onRefresh, onPause, onClosed }: { view: PickTaskView; onRefresh: (v: PickTaskView) => void; onPause: () => void; onClosed: (v: PickTaskView) => void }) {
  const wm = useWm();
  const [busy, setBusy] = useState(false);
  const [pallet, setPallet] = useState<Pallet | null>(null);
  const [qtyMode, setQtyMode] = useState(false);
  const picked = view.lines.filter((l) => l.status === 'PICKED');
  const totalPieces = picked.reduce((a, l) => a + Number(l.picked_qty), 0);

  const onScan = async (code: string) => {
    setBusy(true);
    try {
      const d = await inventoryApi.lpn(code);
      const contents = d.balances.filter((b) => b.status === 'AVAILABLE' && BigInt(b.qty) > 0n).map((b) => ({ sku_code: b.sku.code, description: b.sku.description, qty: String(b.qty) }));
      if (!contents.length) throw new Error('La tarima no tiene inventario disponible');
      setPallet({ code: d.code, location: d.current_location?.code ?? '', contents });
      setQtyMode(false);
      wm.ok(`${d.code} · ${contents.length === 1 ? `${fmtQty(contents[0]!.qty)} pzas de ${contents[0]!.sku_code}` : `${contents.length} productos`}`);
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const add = async (qty?: string, uom?: UomCode) => {
    if (!pallet) return;
    setBusy(true);
    try {
      const r = await pickingApi.freeScan({ pick_task_id: view.task.id, lpn_code: pallet.code, qty, uom_code: uom }, api.newKey());
      wm.ok(r.replayed ? 'YA REGISTRADA' : `${r.data.whole_pallet ? 'TARIMA COMPLETA' : 'CANTIDAD'} AGREGADA · ${r.data.added.map((a) => `${fmtQty(a.qty)} ${a.sku}`).join(', ')}`);
      onRefresh(r.data.view);
      setPallet(null);
      setQtyMode(false);
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const close = async () => {
    setBusy(true);
    try {
      const v = await pickingApi.close(view.task.id);
      wm.ok(`SURTIDO CERRADO · ${v.order.order_number} · llévalo a staging ${v.staging?.code ?? ''}`);
      onClosed(v);
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <StepBar text={pallet ? (qtyMode ? '¿CUÁNTO DE ESTA TARIMA?' : '¿TARIMA COMPLETA O UNA CANTIDAD?') : 'SURTIDO LIBRE · ESCANEA LA TARIMA QUE VAS A SURTIR'} />
      <div className="mb-3 flex items-center justify-between rounded-2xl bg-slate-800 px-4 py-2">
        <div>
          <div className="text-xs uppercase text-slate-400">Pedido</div>
          <div className="text-xl font-black">
            {view.order.order_number} <span className="text-sm font-normal text-slate-300">{view.order.customer}</span>
          </div>
          {view.task.purpose && <div className="text-xs text-slate-400">Para qué: {view.task.purpose}</div>}
        </div>
        <div className="text-right">
          <div className="text-xs uppercase text-slate-400">Surtido</div>
          <div className="text-xl font-black">
            {picked.length} tarimas/líneas · {fmtQty(totalPieces)} pzas
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase text-slate-400">Staging</div>
          <div className="font-mono text-xl font-black text-violet-300">{view.staging?.code ?? '—'}</div>
        </div>
      </div>

      {!pallet && (
        <>
          <ScanInput label="LPN de la tarima" autoUpper onScan={onScan} disabled={busy} testId="free-scan-lpn" />
          {picked.length > 0 && (
            <ul className="mt-3 grid gap-1 font-mono text-base" data-testid="free-picked-list">
              {picked.map((l) => (
                <li key={l.id} className="flex justify-between rounded bg-slate-900 px-3 py-2">
                  <span>
                    {l.lpn_code} · {l.sku_code}
                  </span>
                  <span>{fmtQty(l.picked_qty)} pzas</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 grid grid-cols-2 gap-2">
            <BigButton tone="neutral" onClick={onPause} testId="free-pause">
              Guardar y seguir después
            </BigButton>
            <BigButton tone="success" onClick={close} disabled={busy || picked.length === 0} testId="free-close">
              Cerrar surtido
            </BigButton>
          </div>
          <div className="mt-2 text-center text-xs text-slate-400">Puedes salir y volver otro día: la tarea queda en "Mis tareas" hasta que la cierres.</div>
        </>
      )}

      {pallet && !qtyMode && (
        <div>
          <div className="grid gap-2 sm:grid-cols-2">
            <BigValue label="Tarima" value={pallet.code} tone="accent" />
            <BigValue label="Ubicación" value={pallet.location || '—'} />
          </div>
          <ul className="mt-2 grid gap-1 rounded-2xl bg-slate-900 px-4 py-2 text-lg">
            {pallet.contents.map((c) => (
              <li key={c.sku_code}>
                <span className="font-mono font-bold">{c.sku_code}</span> {c.description} · <b>{fmtQty(c.qty)}</b> pzas
              </li>
            ))}
          </ul>
          <div className="mt-3 grid gap-2">
            <BigButton tone="success" onClick={() => add()} disabled={busy} testId="free-whole">
              Tarima completa
            </BigButton>
            {pallet.contents.length === 1 && (
              <BigButton tone="primary" onClick={() => setQtyMode(true)} disabled={busy} testId="free-partial">
                Solo una cantidad…
              </BigButton>
            )}
            <BigButton tone="neutral" onClick={() => setPallet(null)}>
              Otra tarima
            </BigButton>
          </div>
        </div>
      )}

      {pallet && qtyMode && (
        <div>
          <BigValue label={`${pallet.code} · ${pallet.contents[0]!.sku_code}`} value={`${fmtQty(pallet.contents[0]!.qty)} pzas disponibles`} />
          <div className="mt-3">
            <QtyPad hint={`MÁXIMO ${fmtQty(pallet.contents[0]!.qty)} pzas`} onConfirm={(q, u) => add(q, u)} onCancel={() => setQtyMode(false)} busy={busy} confirmLabel="AGREGAR" />
          </div>
        </div>
      )}
    </div>
  );
}
