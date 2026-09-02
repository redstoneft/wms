// Quick lookup: LPN or SKU timeline.
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { inventoryApi } from '../api/inventory';
import { ApiError, errorMessage } from '../api/client';
import { Timeline } from '../components/Timeline';
import { Alert, Button, Card, Input, KV, PageHeader, Skeleton, StatusChip } from '../components/ui';
import { fmtDateTime } from '../lib/format';

export default function TimelinePage() {
  const { lpn } = useParams();
  const nav = useNavigate();
  const [q, setQ] = useState(lpn ?? '');
  const key = (lpn ?? '').trim();
  const isLpn = /^PLT-/i.test(key);

  const lpnQ = useQuery({ queryKey: ['lpn-timeline', key], queryFn: () => inventoryApi.lpnTimeline(key), enabled: !!key && isLpn, retry: false });
  const skuQ = useQuery({ queryKey: ['sku-timeline', key], queryFn: () => inventoryApi.skuTimeline(key), enabled: !!key && !isLpn, retry: false });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim()) nav(`/timeline/${encodeURIComponent(q.trim().toUpperCase())}`);
  };
  const err = (lpnQ.error ?? skuQ.error) as unknown;

  return (
    <div>
      <PageHeader title="Trazabilidad" subtitle="Historial completo de un pallet (LPN) o de un SKU: movimientos del libro mayor, etiquetas, tareas y auditoría." />
      <form onSubmit={submit} className="mb-4 flex gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="PLT-2026-00000001 o SKU-0001" className="max-w-md font-mono" autoFocus aria-label="LPN o SKU" data-testid="timeline-search" />
        <Button type="submit">Buscar</Button>
      </form>
      {!key && <Alert tone="info">Captura o escanea un LPN (PLT-…) o un código de SKU.</Alert>}
      {err ? <Alert tone="error">{err instanceof ApiError && err.status === 404 ? `No existe ${isLpn ? 'el LPN' : 'el SKU'} ${key}` : errorMessage(err)}</Alert> : null}
      {(lpnQ.isLoading || skuQ.isLoading) && <Skeleton className="h-40" />}

      {lpnQ.data && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title={`LPN ${lpnQ.data.lpn.code}`} className="lg:col-span-1">
            <dl className="grid gap-3">
              <KV label="Estado">
                <StatusChip status={lpnQ.data.lpn.status} />
              </KV>
              <KV label="Tipo">{lpnQ.data.lpn.lpn_type}</KV>
              <KV label="Creado">{fmtDateTime(lpnQ.data.lpn.created_at)}</KV>
              <KV label="Lote / Caducidad">
                {lpnQ.data.lpn.lot ?? '—'} / {lpnQ.data.lpn.expiry_date ? fmtDateTime(lpnQ.data.lpn.expiry_date) : '—'}
              </KV>
            </dl>
            <Link className="mt-3 inline-block text-sm text-sky-700 underline" to={`/inventory/lpn/${lpnQ.data.lpn.code}`}>
              Ver detalle del LPN →
            </Link>
            {lpnQ.data.orders.length > 0 && (
              <div className="mt-4">
                <div className="text-xs font-semibold uppercase text-slate-500">Pedidos relacionados</div>
                <ul className="mt-1 space-y-1 text-sm">
                  {lpnQ.data.orders.map((o) => (
                    <li key={o.order_number} className="rounded border border-slate-200 p-2">
                      <div className="flex justify-between">
                        <b>{o.order_number}</b> <StatusChip status={o.status} />
                      </div>
                      <div className="text-xs text-slate-500">
                        Surtió {o.picker ?? '—'} · Verificó {o.verifier ?? '—'} {o.shipment_number && `· Embarque ${o.shipment_number} ${o.plates ?? ''}`}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
          <Card title={`Línea de tiempo (${lpnQ.data.events.length})`} className="lg:col-span-2">
            <Timeline events={lpnQ.data.events} />
          </Card>
        </div>
      )}
      {skuQ.data && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title={`SKU ${skuQ.data.sku.code}`}>
            <dl className="grid gap-3">
              <KV label="Descripción">{skuQ.data.sku.description}</KV>
              <KV label="Familia">{skuQ.data.sku.family ?? '—'}</KV>
              <KV label="Clase ABC">{skuQ.data.sku.abc_class}</KV>
            </dl>
          </Card>
          <Card title={`Últimos ${skuQ.data.events.length} movimientos`} className="lg:col-span-2">
            <Timeline events={skuQ.data.events} showLpn />
          </Card>
        </div>
      )}
    </div>
  );
}
