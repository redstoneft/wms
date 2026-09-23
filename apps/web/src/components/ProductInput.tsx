// Product field for the handheld: scan a barcode (Enter) OR type part of the code/name and pick from the matches.
import { useEffect, useRef, useState } from 'react';
import { masterdataApi } from '../api/masterdata';
import type { Sku } from '../api/types';
import { ScanInput } from './ScanInput';

interface Props {
  label: string;
  onPick: (code: string) => void | Promise<void>;
  disabled?: boolean;
  testId?: string;
}

export function ProductInput({ label, onPick, disabled, testId = 'product-input' }: Props) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Sku[]>([]);
  const [searching, setSearching] = useState(false);
  const timer = useRef<number | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    const term = q.trim();
    if (term.length < 1) {
      setHits([]);
      setSearching(false);
      return;
    }
    const mine = ++seq.current;
    setSearching(true);
    timer.current = window.setTimeout(async () => {
      try {
        const r = await masterdataApi.skus({ q: term, limit: 8, active: 'true' });
        const items = r.items ?? [];
        if (mine === seq.current) setHits(items);
      } catch {
        if (mine === seq.current) setHits([]);
      } finally {
        if (mine === seq.current) setSearching(false);
      }
    }, 250);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [q]);

  const pick = async (code: string) => {
    setHits([]);
    setQ('');
    await onPick(code);
  };

  return (
    <div>
      <ScanInput label={label} placeholder="Escanea o escribe…" onScan={pick} onType={setQ} disabled={disabled} testId={testId} />
      {q.trim().length === 0 && <div className="mt-1 px-2 text-xs text-slate-400">Al escribir aparece la lista de productos; toca uno para elegirlo.</div>}
      {q.trim().length >= 1 && (
        <div className="mt-1 grid gap-1" data-testid={`${testId}-hits`}>
          {searching && hits.length === 0 && <div className="px-2 text-sm text-slate-400">Buscando…</div>}
          {!searching && hits.length === 0 && <div className="px-2 text-sm text-slate-400">Sin coincidencias · escribe otra letra o escanea la caja</div>}
          {hits.map((s) => (
            <button key={s.id} type="button" className="rounded-xl bg-slate-800 px-3 py-3 text-left active:bg-slate-700" onClick={() => void pick(s.code)} disabled={disabled} data-testid={`${testId}-hit-${s.code}`}>
              <span className="font-mono text-lg font-bold text-white">{s.code}</span>
              <span className="block text-sm text-slate-300">{s.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
