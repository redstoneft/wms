// On-screen rendering of a label model (same model the API turns into ZPL).
import { useState } from 'react';
import type { LabelModel } from '../api/types';
import { cls } from '../lib/format';

export function LabelPreview({ model, barcodePng, qrPng, zpl, compact }: { model: LabelModel; barcodePng?: string | null; qrPng?: string | null; zpl?: string; compact?: boolean }) {
  const [showZpl, setShowZpl] = useState(false);
  return (
    <div className={cls('flex flex-col gap-3', compact ? '' : 'md:flex-row')}>
      <div className="mx-auto w-full max-w-[340px] shrink-0 rounded-md border-2 border-slate-800 bg-white p-3 font-mono text-slate-900 shadow" style={{ aspectRatio: '100 / 150' }}>
        <div className="mb-2 rounded bg-slate-900 px-2 py-1 text-xs font-bold text-white">{model.label_type}</div>
        <div className={cls('truncate font-black leading-tight', model.title.length > 14 ? 'text-2xl' : 'text-3xl')}>{model.title}</div>
        {barcodePng ? <img src={barcodePng} alt={`Código de barras ${model.barcode}`} className="mx-auto mt-2 max-h-24 w-full object-contain" /> : <div className="mt-2 h-16 rounded bg-slate-200 text-center text-xs leading-[4rem]">{model.barcode}</div>}
        <dl className="mt-2 space-y-0.5 text-[11px]">
          {model.lines.map((l, i) => (
            <div key={i} className="flex gap-2">
              <dt className="w-24 shrink-0 text-slate-500">{l.label}:</dt>
              <dd className="truncate font-semibold">{l.value}</dd>
            </div>
          ))}
        </dl>
        {model.sku_lines && model.sku_lines.length > 0 && (
          <table className="mt-2 w-full border-t border-slate-800 text-[10px]">
            <thead>
              <tr className="text-left">
                <th>SKU</th>
                <th>DESCRIPCION</th>
                <th className="text-right">CANT</th>
                <th className="text-right">CJS</th>
              </tr>
            </thead>
            <tbody>
              {model.sku_lines.slice(0, 6).map((s, i) => (
                <tr key={i}>
                  <td className="truncate">{s.sku}</td>
                  <td className="max-w-[90px] truncate">{s.description}</td>
                  <td className="text-right">{s.qty}</td>
                  <td className="text-right">{s.cases}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-2 flex items-end justify-between">
          <span className="text-[10px] text-slate-500">{model.footer ?? ''}</span>
          {qrPng && <img src={qrPng} alt="QR" className="h-14 w-14" />}
        </div>
      </div>
      {zpl && (
        <div className="min-w-0 flex-1">
          <button type="button" className="text-xs font-medium text-sky-700 underline" onClick={() => setShowZpl((v) => !v)}>
            {showZpl ? 'Ocultar ZPL' : 'Ver ZPL'}
          </button>
          {showZpl && <pre className="thin-scroll mt-1 max-h-72 overflow-auto rounded bg-slate-900 p-2 text-[10px] leading-snug text-emerald-300">{zpl}</pre>}
        </div>
      )}
    </div>
  );
}
