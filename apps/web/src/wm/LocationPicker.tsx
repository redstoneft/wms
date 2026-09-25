// Location chooser for put-away: a filter box (type or scan part of the code) over the full list of valid destinations.
import { useMemo, useState } from 'react';
import type { PutawayOption } from '../api/types';

export function LocationPicker({ list, selected, onSelect, testId }: { list: PutawayOption[]; selected: string; onSelect: (code: string) => void; testId: string }) {
  const [filter, setFilter] = useState('');
  const q = filter.trim().toUpperCase();
  const shown = useMemo(() => {
    const f = q ? list.filter((o) => o.code.toUpperCase().includes(q)) : list;
    // keep the selected one visible even when the filter hides it
    return f.some((o) => o.code === selected) ? f : [...list.filter((o) => o.code === selected), ...f];
  }, [list, q, selected]);
  return (
    <div>
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={`Buscar entre ${list.length} ubicaciones (ej. R03-N02)`}
        inputMode="text"
        autoCapitalize="characters"
        className="mb-2 w-full rounded-lg border-2 border-slate-500 bg-slate-800 px-3 py-2 font-mono text-base text-white placeholder:text-slate-500"
        data-testid={`${testId}-filter`}
      />
      <select value={selected} onChange={(e) => onSelect(e.target.value)} size={Math.min(8, Math.max(2, shown.length))} className="w-full rounded-lg border-2 border-slate-500 bg-slate-800 px-2 py-1 text-lg text-white" data-testid={testId}>
        {shown.map((o) => (
          <option key={o.code} value={o.code} className="py-1">
            {o.code}{o.has_same_sku ? ' · ya tiene este producto' : ''}{o.pallet_capacity > 0 ? ` · ${o.lpn_count}/${o.pallet_capacity}` : ''}{o.is_current ? ' (actual)' : ''}
          </option>
        ))}
      </select>
      <div className="mt-1 text-xs text-slate-400">{shown.length === list.length ? `${list.length} ubicaciones disponibles` : `${shown.length} de ${list.length} ubicaciones`}</div>
    </div>
  );
}
