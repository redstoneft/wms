// /labels — print / reprint any label type with preview; print history.
import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { LABEL_TYPES } from '@wms/shared';
import { ApiError } from '../api/client';
import { labelsApi } from '../api/labels';
import { masterdataApi } from '../api/masterdata';
import type { LabelPreview as LabelPreviewT } from '../api/types';
import { LabelPreview } from '../components/LabelPreview';
import { useToast } from '../components/Toast';
import { Alert, Button, Card, Field, Input, PageHeader, Select, StatusChip, Table } from '../components/ui';
import { fmtDateTime } from '../lib/format';

export default function LabelsPage() {
  const toast = useToast();
  const [sp] = useSearchParams();
  const [f, setF] = useState({ label_type: sp.get('type') ?? 'LPN', entity_id: sp.get('id') ?? '', printer_id: '', copies: '1', reprint_reason: '' });
  const [preview, setPreview] = useState<LabelPreviewT | null>(null);
  const [needsReason, setNeedsReason] = useState(false);
  const printers = useQuery({ queryKey: ['printers'], queryFn: masterdataApi.printers });
  const history = useQuery({ queryKey: ['label-history', f.label_type], queryFn: () => labelsApi.history({ label_type: f.label_type, limit: 100 }) });
  const doPreview = useMutation({
    mutationFn: () => labelsApi.preview({ label_type: f.label_type, entity_id: f.entity_id.trim(), copies: Number(f.copies) }),
    onSuccess: setPreview,
    onError: (e) => toast.error('No se pudo generar la vista previa', e),
  });
  const doPrint = useMutation({
    mutationFn: () => labelsApi.print({ label_type: f.label_type, entity_id: f.entity_id.trim(), copies: Number(f.copies), printer_id: f.printer_id || undefined, reprint_reason: f.reprint_reason || undefined }),
    onSuccess: (r) => {
      toast.success(`Etiqueta ${r.status === 'SENT' ? 'enviada' : r.status}`, `${r.model.title}${r.is_reprint ? ' (reimpresión)' : ''}`);
      setNeedsReason(false);
      void history.refetch();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'REPRINT_REASON_REQUIRED') {
        setNeedsReason(true);
        toast.warn('Es una reimpresión', 'Captura el motivo (queda auditado).');
      } else toast.error('No se pudo imprimir', e);
    },
  });
  useEffect(() => {
    if (sp.get('id')) doPreview.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <PageHeader title="Etiquetas" subtitle="ZPL para Zebra (203 dpi, 100×150 mm). Las reimpresiones requieren motivo y quedan auditadas." />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Imprimir">
          <div className="grid gap-3">
            <Field label="Tipo" required>
              <Select value={f.label_type} onChange={(e) => setF({ ...f, label_type: e.target.value })}>
                {LABEL_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </Select>
            </Field>
            <Field label="Identificador" required hint={{ LPN: 'Código LPN', LOCATION: 'Código de ubicación', CASE: 'SKU (o SKU|cantidad)', ORDER: 'Número de pedido', STAGING: 'Código del carril', SHIPMENT: 'Número de embarque' }[f.label_type]}>
              <Input value={f.entity_id} onChange={(e) => setF({ ...f, entity_id: e.target.value })} className="font-mono" />
            </Field>
            <Field label="Impresora">
              <Select value={f.printer_id} onChange={(e) => setF({ ...f, printer_id: e.target.value })}>
                <option value="">Predeterminada</option>
                {printers.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.host}:{p.port}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Copias">
              <Input type="number" min={1} max={10} value={f.copies} onChange={(e) => setF({ ...f, copies: e.target.value })} />
            </Field>
            {needsReason && (
              <Field label="Motivo de reimpresión (mín. 3)" required>
                <Input value={f.reprint_reason} onChange={(e) => setF({ ...f, reprint_reason: e.target.value })} />
              </Field>
            )}
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => doPreview.mutate()} loading={doPreview.isPending} disabled={!f.entity_id.trim()}>
                Vista previa
              </Button>
              <Button onClick={() => doPrint.mutate()} loading={doPrint.isPending} disabled={!f.entity_id.trim() || (needsReason && f.reprint_reason.trim().length < 3)}>
                Imprimir
              </Button>
            </div>
            <Alert tone="info">La impresión envía ZPL por TCP 9100. Si la impresora no responde, el intento queda registrado como FAILED.</Alert>
          </div>
        </Card>
        <Card title="Vista previa" className="lg:col-span-2">
          {preview ? <LabelPreview model={preview.model} barcodePng={preview.barcode_png} qrPng={preview.qr_png} zpl={preview.zpl} /> : <p className="text-sm text-slate-500">Genera una vista previa para ver la etiqueta y su ZPL.</p>}
        </Card>
      </div>
      <Card title="Historial" className="mt-4" padded={false}>
        <Table
          rows={history.data}
          loading={history.isLoading}
          rowKey={(h) => h.id}
          dense
          columns={[
            { key: 'd', header: 'Fecha', render: (h) => fmtDateTime(h.created_at) },
            { key: 't', header: 'Tipo', render: (h) => h.label_type },
            { key: 'e', header: 'Entidad', render: (h) => <span className="font-mono">{h.entity_id}</span> },
            { key: 's', header: 'Estado', render: (h) => <StatusChip status={h.status} /> },
            { key: 'r', header: 'Reimpresión', render: (h) => (h.is_reprint ? `Sí · ${h.reprint_reason ?? ''}` : 'No') },
            { key: 'er', header: 'Error', render: (h) => <span className="text-xs text-rose-700">{h.error ?? ''}</span> },
            { key: 'z', header: '', render: (h) => <a className="text-xs text-sky-700 underline" href={`/api/labels/${h.id}/zpl`} target="_blank" rel="noreferrer">ZPL</a> },
          ]}
        />
      </Card>
    </div>
  );
}
