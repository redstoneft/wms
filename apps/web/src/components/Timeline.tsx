// Vertical timeline for LPN / SKU history (time, event, user, from → to).
import type { TimelineEvent } from '../api/types';
import { cls, es, fmtDateTime, fmtQty } from '../lib/format';

const kindDot: Record<string, string> = {
  MOVEMENT: 'bg-sky-500',
  LABEL: 'bg-violet-500',
  AUDIT: 'bg-slate-400',
  TASK: 'bg-amber-500',
};
const eventTone = (event: string) => {
  if (/CANCEL|BLOCK|DAMAGE|SCRAP|FAILED|OUT$/.test(event) && !/UNBLOCK|RELEASE/.test(event)) return 'text-rose-700';
  if (/RECEIPT|PUTAWAY|COMPLETE|PASSED|IN$/.test(event)) return 'text-emerald-700';
  return 'text-slate-800';
};

export function Timeline({ events, showLpn }: { events: TimelineEvent[]; showLpn?: boolean }) {
  if (events.length === 0) return <p className="py-6 text-center text-sm text-slate-500">Sin eventos registrados</p>;
  return (
    <ol className="relative ml-3 border-l-2 border-slate-200">
      {events.map((e, i) => {
        const kind = e.kind ?? 'MOVEMENT';
        return (
          <li key={`${e.ref}-${i}`} className="relative mb-4 ml-5">
            <span className={cls('absolute -left-[27px] top-1.5 h-3.5 w-3.5 rounded-full ring-4 ring-white', kindDot[kind] ?? 'bg-slate-400')} />
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <time className="font-mono text-xs text-slate-500">{fmtDateTime(e.at)}</time>
              <span className={cls('text-sm font-semibold', eventTone(e.event))}>{es(e.event)}</span>
              {e.username && <span className="text-xs text-slate-500">por {e.username}</span>}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-700">
              {e.sku && (
                <span>
                  SKU <b className="font-mono">{e.sku}</b>
                </span>
              )}
              {e.qty && <span>Cant. <b>{fmtQty(e.qty)}</b></span>}
              {showLpn && (e.from_lpn || e.to_lpn) && (
                <span className="font-mono">
                  {e.from_lpn ?? '—'} → {e.to_lpn ?? '—'}
                </span>
              )}
              {(e.from_location || e.to_location) && (
                <span>
                  <span className="font-mono">{e.from_location ?? '∅'}</span> → <span className="font-mono">{e.to_location ?? '∅'}</span>
                </span>
              )}
              {(e.from_status || e.to_status) && (
                <span>
                  {es(e.from_status)} → {es(e.to_status)}
                </span>
              )}
              {e.order_number && <span>Pedido {e.order_number}</span>}
              {e.receipt_number && <span>Recepción {e.receipt_number}</span>}
              {e.shipment_number && <span>Embarque {e.shipment_number}</span>}
            </div>
            {e.reason && <div className="mt-0.5 text-xs italic text-slate-500">“{e.reason}”</div>}
          </li>
        );
      })}
    </ol>
  );
}
