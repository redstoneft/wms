// Warehouse-mode label preview + print (used by receiving and other flows).
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { labelsApi } from '../api/labels';
import { masterdataApi } from '../api/masterdata';
import { ApiError } from '../api/client';
import type { LabelPreview as LabelPreviewT } from '../api/types';
import { LabelPreview } from '../components/LabelPreview';
import { BigButton, useWm } from './WmShell';

export function LabelPrintPanel({ labelType, entityId, onDone }: { labelType: string; entityId: string; onDone: () => void }) {
  const wm = useWm();
  const [preview, setPreview] = useState<LabelPreviewT | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [needsReason, setNeedsReason] = useState(false);
  const printers = useQuery({ queryKey: ['printers'], queryFn: masterdataApi.printers });
  const [printerId, setPrinterId] = useState('');

  useEffect(() => {
    labelsApi
      .preview({ label_type: labelType, entity_id: entityId, copies: 1 })
      .then(setPreview)
      .catch((e) => wm.fail(e));
  }, [labelType, entityId, wm]);

  const print = async () => {
    setBusy(true);
    try {
      const r = await labelsApi.print({ label_type: labelType, entity_id: entityId, copies: 1, printer_id: printerId || undefined, reprint_reason: reason.trim() || undefined });
      wm.ok(`ETIQUETA ${r.status === 'SENT' ? 'ENVIADA' : r.status} · ${r.model.title}`);
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'REPRINT_REASON_REQUIRED') {
        setNeedsReason(true);
        wm.warn('Es reimpresión: captura el motivo');
      } else wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="label-print-panel">
      {preview ? (
        <div className="rounded-2xl bg-slate-100 p-3 text-slate-900">
          <LabelPreview model={preview.model} barcodePng={preview.barcode_png} qrPng={preview.qr_png} zpl={preview.zpl} compact />
        </div>
      ) : (
        <div className="py-10 text-center text-slate-400">Generando vista previa…</div>
      )}
      {printers.data && printers.data.length > 0 && (
        <select value={printerId} onChange={(e) => setPrinterId(e.target.value)} className="h-14 rounded-xl bg-slate-800 px-3 text-lg text-white" aria-label="Impresora">
          <option value="">Impresora predeterminada</option>
          {printers.data.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.host})
            </option>
          ))}
        </select>
      )}
      {needsReason && <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motivo de reimpresión (mín. 3 caracteres)" className="h-14 rounded-xl bg-slate-800 px-3 text-lg text-white" />}
      <div className="grid grid-cols-2 gap-2">
        <BigButton tone="neutral" onClick={onDone}>
          Cerrar
        </BigButton>
        <BigButton tone="primary" onClick={print} disabled={busy || !preview || (needsReason && reason.trim().length < 3)} testId="label-print">
          {busy ? 'Enviando…' : 'Imprimir'}
        </BigButton>
      </div>
    </div>
  );
}
