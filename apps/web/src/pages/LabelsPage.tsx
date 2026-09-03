// /labels — print / reprint any label type with preview; print history.
import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { LABEL_TYPES } from '@wms/shared';
import { ApiError } from '../api/client';
import { labelsApi } from '../api/labels';
import { masterdataApi } from '../api/masterdata';
import { layoutApi } from '../api/layout';
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
  // batch labelling of a whole rack (or zone) — the first thing to do after building the layout
  const zones = useQuery({ queryKey: ['zones', 'all'], queryFn: () => layoutApi.zones() });
  const [batch, setBatch] = useState({ zone_id: '', rack_id: '', printer_id: '' });
  const batchZone = zones.data?.find((z) => z.id === batch.zone_id);
  const batchRacks = (batchZone?.aisles ?? []).flatMap((a) => (a.racks ?? []).map((r) => ({ id: r.id, label: `Pasillo ${a.code} · Rack ${r.code}` })));
  const batchFilter = batch.rack_id ? { rack_id: batch.rack_id } : batch.zone_id ? { zone_id: batch.zone_id } : null;
  const doBatch = useMutation({
    mutationFn: () => labelsApi.printBatch({ ...batchFilter!, printer_id: batch.printer_id || undefined }),
    onSuccess: (r) => (r.failed.length ? toast.warn(`${r.sent}/${r.total} etiquetas enviadas`, r.failed[0]?.error) : toast.success(`${r.sent} etiquetas enviadas a la Zebra`)),
    onError: (e) => toast.error('No se pudo imprimir el lote', e),
  });
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
  }, []);

  return (
    <div>
      <PageHeader title="Etiquetas" subtitle="ZPL para Zebra (203 dpi, 101.6 × 84 mm, el mismo tamaño que las etiquetas de caja de las cadenas). Las reimpresiones requieren motivo y quedan auditadas." />
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
      <Card title="Etiquetar un rack completo" className="mt-4">
        <div className="grid gap-3 lg:grid-cols-4">
          <Field label="Zona" required>
            <Select value={batch.zone_id} onChange={(e) => setBatch({ ...batch, zone_id: e.target.value, rack_id: '' })}>
              <option value="">Elegir zona…</option>
              {zones.data?.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.code} · {z.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Rack" hint="Vacío = todas las ubicaciones de la zona">
            <Select value={batch.rack_id} onChange={(e) => setBatch({ ...batch, rack_id: e.target.value })} disabled={!batch.zone_id}>
              <option value="">Toda la zona</option>
              {batchRacks.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Impresora Zebra">
            <Select value={batch.printer_id} onChange={(e) => setBatch({ ...batch, printer_id: e.target.value })}>
              <option value="">Predeterminada</option>
              {printers.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-wrap items-end gap-2">
            <Button variant="secondary" disabled={!batchFilter} onClick={() => window.open(labelsApi.sheetUrl(batchFilter!), '_blank')} data-testid="labels-sheet">
              Hoja para imprimir
            </Button>
            <Button variant="secondary" disabled={!batchFilter} onClick={() => window.open(labelsApi.zplUrl(batchFilter!), '_blank')}>
              Descargar ZPL
            </Button>
            <Button variant="secondary" disabled={!batchFilter} onClick={() => window.open(labelsApi.embarqueUrl(batchFilter!), '_blank')} data-testid="labels-embarque">
              Exportar a app de etiquetas
            </Button>
            <Button disabled={!batchFilter || !printers.data?.length} loading={doBatch.isPending} onClick={() => doBatch.mutate()}>
              Imprimir en Zebra
            </Button>
          </div>
        </div>
        <Alert tone="info" className="mt-3">
          <b>Hoja para imprimir</b>: etiquetas de 101.6 × 84 mm (3 por hoja A4) para cualquier impresora o para guardar como PDF; imprimir al 100 %. Orden de pegado: por pasillo, módulo y nivel, igual que la ruta de surtido.
          <b> Descargar ZPL</b>: archivo listo para una Zebra (203 dpi). <b>Exportar a app de etiquetas</b>: archivo <code>.json</code> que tu app Embarque importa como un pedido más y manda a su estación Zebra. <b>Imprimir en Zebra</b>: envía una etiqueta por posición y queda auditado.
        </Alert>
      </Card>
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
