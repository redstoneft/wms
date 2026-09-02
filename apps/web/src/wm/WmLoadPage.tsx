// /wm/load — loading: choose shipment → scan LPN → loaded/remaining → release status. Unload with reason.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { shipmentsApi } from '../api/shipments';
import type { ShipmentListItem } from '../api/types';
import { ScanInput } from '../components/ScanInput';
import { BigButton, BigValue, StepBar, useWm, WmList, WmShell } from './WmShell';

export default function WmLoadPage() {
  return (
    <WmShell title="Carga de embarque">
      <Flow />
    </WmShell>
  );
}

function Flow() {
  const wm = useWm();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['shipments', 'loading'], queryFn: () => shipmentsApi.list({ status: 'OPEN,LOADING,BLOCKED' }), refetchInterval: 10_000 });
  const [sh, setSh] = useState<ShipmentListItem | null>(null);
  const detail = useQuery({ queryKey: ['shipment', sh?.id], queryFn: () => shipmentsApi.get(sh!.id), enabled: !!sh, refetchInterval: 8_000 });
  const [busy, setBusy] = useState(false);
  const [unload, setUnload] = useState<{ lpn: string; reason: string } | null>(null);

  const load = async (lpn: string) => {
    if (!sh) return;
    setBusy(true);
    try {
      const r = await shipmentsApi.loadScan({ shipment_id: sh.id, lpn_code: lpn }, api.newKey());
      wm.ok(r.replayed ? 'YA CARGADO' : `${r.data.lpn_code} CARGADO · ${r.data.order_number}${r.data.order_loaded ? ' COMPLETO' : ''}`);
      void qc.invalidateQueries({ queryKey: ['shipment', sh.id] });
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const doUnload = async () => {
    if (!sh || !unload) return;
    setBusy(true);
    try {
      await shipmentsApi.unload({ shipment_id: sh.id, lpn_code: unload.lpn, reason: unload.reason.trim() }, api.newKey());
      wm.ok(`${unload.lpn} DESCARGADO`);
      setUnload(null);
      void qc.invalidateQueries({ queryKey: ['shipment', sh.id] });
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (!sh)
    return (
      <div>
        <StepBar text="ELIGE EL EMBARQUE" />
        <WmList
          items={list.data}
          keyOf={(s) => s.id}
          empty="No hay embarques abiertos"
          onSelect={(s) => {
            setSh(s);
            wm.ok();
          }}
          render={(s) => (
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-xl font-black">{s.shipment_number}</div>
                <div className="text-sm text-slate-300">
                  {s.carrier?.name ?? '—'} · {s.plates ?? ''} · {s.orders.length} pedidos · {s._count.lpns} cargados
                </div>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-bold ${s.status === 'BLOCKED' ? 'bg-rose-600' : s.status === 'LOADING' ? 'bg-sky-500' : 'bg-amber-400 text-amber-950'}`}>{s.status}</span>
            </div>
          )}
        />
      </div>
    );

  const d = detail.data;
  const loaded = d?.lpns.filter((l) => l.status === 'LOADED').length ?? 0;
  const expected = d ? d.orders.reduce((a, o) => a + (d.lpns.filter((l) => l.order_id === o.id).length || 0), 0) : 0;
  const release = d?.release;

  return (
    <div>
      <StepBar text="ESCANEA CADA PALLET AL SUBIRLO AL CAMIÓN" />
      <div className="mb-3 flex items-center justify-between rounded-2xl bg-slate-800 px-4 py-2">
        <div>
          <div className="text-xs uppercase text-slate-400">Embarque</div>
          <div className="text-xl font-black">{sh.shipment_number}</div>
          <div className="text-xs text-slate-300">
            {d?.dock?.code ?? 'sin andén'} · {sh.plates ?? ''}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase text-slate-400">Cargados</div>
          <div className="text-3xl font-black text-emerald-300" data-testid="loaded-count">
            {loaded}
          </div>
          <div className="text-xs text-slate-300">{expected ? `${expected} asociados` : ''}</div>
        </div>
      </div>
      <ScanInput label="LPN" autoUpper onScan={load} disabled={busy} testId="scan-lpn" />
      {release && (
        <div className={`mt-3 rounded-2xl p-3 ${release.can_release ? 'bg-emerald-600' : 'bg-slate-800'}`}>
          <div className="text-xs font-bold uppercase tracking-widest">Estado de liberación</div>
          <div className="text-2xl font-black">{release.can_release ? 'LISTO PARA LIBERAR' : `${release.blocking_reasons.length} BLOQUEO(S)`}</div>
          {!release.can_release && (
            <ul className="mt-1 max-h-32 overflow-y-auto text-xs text-slate-300">
              {release.blocking_reasons.slice(0, 8).map((r, i) => (
                <li key={i}>• {r}</li>
              ))}
            </ul>
          )}
          <div className="mt-1 text-xs text-slate-200">La liberación se hace en modo oficina (Embarques) con todas las validaciones.</div>
        </div>
      )}
      <div className="mt-3">
        <div className="mb-1 text-xs font-bold uppercase text-slate-400">Pedidos</div>
        <div className="grid gap-1">
          {d?.orders.map((o) => (
            <div key={o.id} className="flex items-center justify-between rounded-xl bg-slate-900 px-3 py-2 text-sm">
              <span className="font-bold">
                {o.order_number} <span className="font-normal text-slate-400">{o.customer.name}</span>
              </span>
              <span className="rounded bg-slate-700 px-2 py-0.5 text-xs">{o.status}</span>
            </div>
          ))}
        </div>
      </div>
      {loaded > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-xs font-bold uppercase text-slate-400">Pallets cargados (toca para descargar)</div>
          <div className="flex flex-wrap gap-1">
            {d?.lpns.filter((l) => l.status === 'LOADED').map((l) => (
              <button key={l.id} type="button" onClick={() => setUnload({ lpn: l.code, reason: '' })} className="rounded bg-slate-700 px-2 py-1 font-mono text-sm">
                {l.code}
              </button>
            ))}
          </div>
        </div>
      )}
      {unload && (
        <div className="mt-3 rounded-2xl border-2 border-rose-500 bg-slate-900 p-3">
          <BigValue label="Descargar pallet" value={unload.lpn} tone="warn" />
          <input value={unload.reason} onChange={(e) => setUnload({ ...unload, reason: e.target.value })} placeholder="Motivo (mín. 3 caracteres)" className="mt-2 h-14 w-full rounded-xl bg-slate-800 px-3 text-white" />
          <div className="mt-2 grid grid-cols-2 gap-2">
            <BigButton tone="neutral" onClick={() => setUnload(null)}>
              Cancelar
            </BigButton>
            <BigButton tone="danger" onClick={doUnload} disabled={busy || unload.reason.trim().length < 3}>
              Descargar
            </BigButton>
          </div>
        </div>
      )}
      <BigButton tone="neutral" className="mt-3" onClick={() => setSh(null)}>
        Otro embarque
      </BigButton>
    </div>
  );
}
