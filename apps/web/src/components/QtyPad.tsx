// Big numeric keypad + UoM buttons for warehouse mode. Quantities are integer strings.
import { useEffect, useState } from 'react';
import type { UomCode } from '@wms/shared';
import { cls, fmtQty, fmtUom, toBigInt, type UomDef } from '../lib/format';

export interface QtyPadProps {
  uoms?: UomDef[] | null;
  defaultUom?: UomCode;
  /** shown above the pad, e.g. "FALTAN 24 PIECE" */
  hint?: string;
  onConfirm: (qty: string, uom: UomCode) => void | Promise<void>;
  onCancel?: () => void;
  confirmLabel?: string;
  /** allow zero (cycle counts) */
  allowZero?: boolean;
  busy?: boolean;
  initial?: string;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'];
const ORDER: UomCode[] = ['PALLET', 'CASE', 'INNER', 'PIECE'];

export function QtyPad({ uoms, defaultUom = 'PIECE', hint, onConfirm, onCancel, confirmLabel = 'CONFIRMAR', allowZero, busy, initial = '' }: QtyPadProps) {
  const available = ORDER.filter((u) => u === 'PIECE' || uoms?.some((d) => d.uom_code === u));
  const [uom, setUom] = useState<UomCode>(available.includes(defaultUom) ? defaultUom : 'PIECE');
  const [val, setVal] = useState(initial);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key >= '0' && e.key <= '9') setVal((v) => (v.length < 9 ? (v === '0' ? e.key : v + e.key) : v));
      else if (e.key === 'Backspace') setVal((v) => v.slice(0, -1));
      else if (e.key === 'Enter') void confirm();
      else if (e.key === 'Escape') onCancel?.();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [val, uom]);

  const press = (k: string) => {
    if (k === 'C') setVal('');
    else if (k === '⌫') setVal((v) => v.slice(0, -1));
    else setVal((v) => (v.length < 9 ? (v === '0' ? k : v + k) : v));
  };
  const n = toBigInt(val || '0');
  const valid = val !== '' && (allowZero ? n >= 0n : n > 0n);
  const confirm = async () => {
    if (!valid || busy) return;
    await onConfirm(n.toString(), uom);
  };
  const baseQty = (() => {
    const def = uoms?.find((d) => d.uom_code === uom);
    return def ? n * toBigInt(def.base_qty) : n;
  })();

  return (
    <div className="mx-auto w-full max-w-md select-none" data-testid="qty-pad">
      {hint && <div className="mb-2 text-center text-lg font-bold text-amber-300">{hint}</div>}
      <div className="mb-3 flex h-20 items-center justify-between rounded-xl border-2 border-slate-600 bg-slate-800 px-5">
        <span className="font-mono text-5xl font-black text-white" data-testid="qty-value">
          {val === '' ? <span className="text-slate-500">0</span> : fmtQty(n)}
        </span>
        <span className="text-right text-sm text-slate-300">
          <div className="text-xl font-bold text-sky-300">{uom}</div>
          {uoms && uom !== 'PIECE' && <div>= {fmtUom(baseQty, uoms)}</div>}
        </span>
      </div>
      {available.length > 1 && (
        <div className="mb-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${available.length}, minmax(0, 1fr))` }}>
          {available.map((u) => (
            <button key={u} type="button" onClick={() => setUom(u)} className={cls('h-14 rounded-xl text-lg font-bold', uom === u ? 'bg-sky-500 text-white ring-4 ring-sky-300/40' : 'bg-slate-700 text-slate-200')}>
              {u}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-3 gap-2">
        {KEYS.map((k) => (
          <button key={k} type="button" onClick={() => press(k)} className={cls('h-16 rounded-xl text-3xl font-bold active:scale-95', k === 'C' ? 'bg-rose-700 text-white' : k === '⌫' ? 'bg-slate-600 text-white' : 'bg-slate-200 text-slate-900')}>
            {k}
          </button>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" onClick={onCancel} className="h-16 rounded-xl bg-slate-700 text-xl font-bold text-white disabled:opacity-40" disabled={!onCancel}>
          CANCELAR
        </button>
        <button type="button" onClick={confirm} disabled={!valid || busy} data-testid="qty-confirm" className="h-16 rounded-xl bg-emerald-500 text-xl font-black text-white disabled:opacity-40">
          {busy ? '…' : confirmLabel}
        </button>
      </div>
    </div>
  );
}
