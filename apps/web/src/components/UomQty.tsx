// Office-mode quantity input with UoM selector and live breakdown.
import type { UomCode } from '@wms/shared';
import { Input, Select } from './ui';
import { fmtUom, toBigInt, type UomDef } from '../lib/format';

export function UomQty({ qty, uom, uoms, onChange, allowZero }: { qty: string; uom: UomCode; uoms?: UomDef[] | null; onChange: (qty: string, uom: UomCode) => void; allowZero?: boolean }) {
  const codes: UomCode[] = (['PALLET', 'CASE', 'INNER', 'PIECE'] as UomCode[]).filter((c) => c === 'PIECE' || uoms?.some((u) => u.uom_code === c));
  const def = uoms?.find((u) => u.uom_code === uom);
  const base = def ? toBigInt(qty || '0') * toBigInt(def.base_qty) : toBigInt(qty || '0');
  const invalid = qty !== '' && (!/^\d+$/.test(qty) || (!allowZero && toBigInt(qty) === 0n));
  return (
    <div>
      <div className="flex gap-2">
        <Input inputMode="numeric" pattern="\d*" value={qty} onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ''), uom)} placeholder="Cantidad" className={invalid ? 'border-rose-400' : ''} aria-label="Cantidad" />
        <Select value={uom} onChange={(e) => onChange(qty, e.target.value as UomCode)} className="w-32" aria-label="Unidad">
          {codes.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </div>
      {uoms && qty && !invalid && <div className="mt-1 text-xs text-slate-500">= {fmtUom(base, uoms)}</div>}
    </div>
  );
}
