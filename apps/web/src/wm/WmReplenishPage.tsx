// /wm/replenish — replenishment tasks: start → transfer flow (scan LPN → scan picking location).
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { replenApi } from '../api/storage';
import type { ReplenTaskRow } from '../api/types';
import { fmtQty } from '../lib/format';
import { CompleteTransferFlow } from './WmTransferPage';
import { StepBar, useWm, WmList, WmShell } from './WmShell';

export default function WmReplenishPage() {
  return (
    <WmShell title="Reabasto">
      <Flow />
    </WmShell>
  );
}

function Flow() {
  const wm = useWm();
  const qc = useQueryClient();
  const tasks = useQuery({ queryKey: ['replen-tasks'], queryFn: () => replenApi.tasks('PENDING,IN_PROGRESS'), refetchInterval: 10_000 });
  const [active, setActive] = useState<{ id: string; lpn_code: string; to_code: string; to_barcode: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const select = async (t: ReplenTaskRow) => {
    if (t.status === 'IN_PROGRESS' && t.transfer_id && t.source_lpn_code) {
      setActive({ id: t.transfer_id, lpn_code: t.source_lpn_code, to_code: t.to_code, to_barcode: t.to_barcode });
      return;
    }
    setBusy(true);
    try {
      const r = await replenApi.start(t.id);
      wm.ok(`TOMA ${r.lpn_code} → ${r.to_location.code}`);
      setActive({ id: r.transfer.id, lpn_code: r.lpn_code, to_code: r.to_location.code, to_barcode: r.to_location.barcode });
      void qc.invalidateQueries({ queryKey: ['replen-tasks'] });
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (active)
    return (
      <CompleteTransferFlow
        transfer={active}
        onDone={() => {
          setActive(null);
          void qc.invalidateQueries({ queryKey: ['replen-tasks'] });
        }}
        onCancel={() => setActive(null)}
      />
    );

  return (
    <div>
      <StepBar text="ELIGE UNA TAREA DE REABASTO" />
      {busy && <div className="mb-2 text-center text-slate-300">Iniciando…</div>}
      <WmList
        items={tasks.data}
        keyOf={(t) => t.id}
        empty="No hay tareas de reabasto"
        onSelect={select}
        render={(t) => (
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="font-mono text-xl font-black">{t.sku_code}</div>
              <div className="text-sm text-slate-300">
                {t.source_lpn_code ?? 'origen por asignar'} · {t.from_code ?? '?'} → <b className="text-sky-300">{t.to_code}</b> · {fmtQty(t.qty)} pzas
              </div>
            </div>
            <span className={`rounded-full px-3 py-1 text-xs font-bold ${t.status === 'IN_PROGRESS' ? 'bg-sky-500' : 'bg-amber-400 text-amber-950'}`}>{t.status}</span>
          </div>
        )}
      />
    </div>
  );
}
