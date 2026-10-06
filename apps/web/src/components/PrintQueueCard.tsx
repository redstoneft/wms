// The print queue, from any device: how many labels wait per printer and a button to empty it (one printer or all).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { labelsApi } from '../api/labels';
import { fmtDateTime } from '../lib/format';

export function PrintQueueCard({ big = false, onDone }: { big?: boolean; onDone?: (msg: string) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['print-queue'], queryFn: labelsApi.queue, refetchInterval: 5_000 });
  const clear = useMutation({
    mutationFn: (printer_id?: string) => labelsApi.clearQueue(printer_id),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['print-queue'] });
      void qc.invalidateQueries({ queryKey: ['label-history'] });
      onDone?.(`${r.cancelled} etiqueta(s) canceladas`);
    },
  });
  const rows = q.data?.printers ?? [];
  const total = q.data?.total ?? 0;
  const btn = big ? 'rounded-2xl px-4 py-4 text-lg font-black' : 'rounded-lg px-3 py-1.5 text-sm font-semibold';
  return (
    <div data-testid="print-queue">
      <div className={`${big ? 'text-lg' : 'text-sm'} ${total ? 'font-bold text-amber-500' : 'opacity-60'}`}>{total ? `${total} etiqueta(s) en cola` : 'Cola de impresión vacía'}</div>
      {rows.length > 0 && (
        <ul className="mt-2 grid gap-2">
          {rows.map((r) => (
            <li key={r.printer_id ?? 'none'} className={`flex items-center justify-between gap-3 rounded-xl ${big ? 'bg-slate-800 px-3 py-3' : 'bg-slate-100 px-3 py-2 dark:bg-slate-800'}`}>
              <div>
                <div className="font-bold">{r.printer ?? 'Sin impresora'}</div>
                <div className="text-xs opacity-70">
                  {r.queued} en cola{r.printing ? ` · ${r.printing} imprimiendo` : ''}{r.oldest ? ` · desde ${fmtDateTime(r.oldest)}` : ''}
                </div>
              </div>
              <button type="button" className={`${btn} bg-rose-600 text-white disabled:opacity-50`} disabled={clear.isPending} onClick={() => { if (confirm(`¿Vaciar la cola de ${r.printer ?? 'sin impresora'}? Se cancelan ${r.queued + r.printing} etiqueta(s).`)) clear.mutate(r.printer_id ?? undefined); }}>
                Vaciar
              </button>
            </li>
          ))}
        </ul>
      )}
      {total > 0 && rows.length > 1 && (
        <button type="button" className={`${btn} mt-2 w-full border-2 border-rose-500 text-rose-500 disabled:opacity-50`} disabled={clear.isPending} onClick={() => { if (confirm(`¿Vaciar TODA la cola? Se cancelan ${total} etiqueta(s).`)) clear.mutate(undefined); }} data-testid="print-queue-clear-all">
          Vaciar toda la cola
        </button>
      )}
    </div>
  );
}
