// /wm/stage — scan outbound LPN → scan staging lane.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { pickingApi } from '../api/orders';
import { ScanInput } from '../components/ScanInput';
import { BigButton, BigValue, StepBar, useWm, WmShell } from './WmShell';

export default function WmStagePage() {
  return (
    <WmShell title="Staging">
      <Flow />
    </WmShell>
  );
}

function Flow() {
  const wm = useWm();
  const [lpn, setLpn] = useState('');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ lpn: string; location: string; order_status: string | null } | null>(null);
  const lanes = useQuery({ queryKey: ['staging'], queryFn: pickingApi.staging, refetchInterval: 10_000 });

  const stage = async (lane: string) => {
    setBusy(true);
    try {
      const r = await pickingApi.stage({ lpn_code: lpn, staging_location_barcode: lane }, api.newKey());
      wm.ok(r.replayed ? 'YA EN STAGING' : `${r.data.lpn_code} EN ${r.data.location}${r.data.order_status === 'STAGED' ? ' · PEDIDO COMPLETO EN STAGING' : ''}`);
      setLast({ lpn: r.data.lpn_code, location: r.data.location, order_status: r.data.order_status });
      setLpn('');
      void lanes.refetch();
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <StepBar text={lpn ? '2 · ESCANEA EL CARRIL DE STAGING' : '1 · ESCANEA EL LPN DE SALIDA'} />
      {lpn ? (
        <>
          <BigValue label="LPN" value={lpn} tone="ok" />
          <div className="mt-3">
            <ScanInput label="Carril de staging" onScan={stage} disabled={busy} testId="scan-location" placeholder="LOC-STG-…" />
          </div>
          <BigButton tone="neutral" className="mt-3" onClick={() => setLpn('')}>
            Cancelar
          </BigButton>
        </>
      ) : (
        <ScanInput
          label="LPN"
          autoUpper
          onScan={(v) => {
            setLpn(v);
            wm.ok();
          }}
          testId="scan-lpn"
        />
      )}
      {last && (
        <div className="mt-3 rounded-2xl bg-emerald-600 p-4">
          <div className="text-xs font-bold uppercase tracking-widest">Último</div>
          <div className="font-mono text-2xl font-black">
            {last.lpn} → {last.location}
          </div>
          {last.order_status === 'STAGED' && <div className="font-bold">Pedido completo en staging: listo para verificación.</div>}
        </div>
      )}
      <div className="mt-4">
        <div className="mb-1 text-xs font-bold uppercase text-slate-400">Carriles</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {lanes.data?.map((l) => (
            <div key={l.id} className={`rounded-xl p-3 ${l.order_number ? 'bg-violet-700' : 'bg-slate-800'}`}>
              <div className="font-mono text-lg font-black">{l.code}</div>
              <div className="text-xs text-slate-200">{l.order_number ? `${l.order_number} · ${l.customer} · ${l.lpn_count} LPN` : 'LIBRE'}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
