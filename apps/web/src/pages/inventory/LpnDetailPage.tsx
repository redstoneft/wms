import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { inventoryApi } from '../../api/inventory';
import { useAuth } from '../../auth/AuthContext';
import { Timeline } from '../../components/Timeline';
import { Alert, Button, Card, KV, PageHeader, Skeleton, StatusChip, Table } from '../../components/ui';
import { es, fmtDate, fmtDateTime, fmtNum, fmtQty, fmtUom, toBigInt } from '../../lib/format';
import { AdjustModal, StatusModal } from './InventoryPage';

export default function LpnDetailPage() {
  const { code = '' } = useParams();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['lpn', code], queryFn: () => inventoryApi.lpn(code) });
  const tl = useQuery({ queryKey: ['lpn-timeline', code], queryFn: () => inventoryApi.lpnTimeline(code) });
  const [adjust, setAdjust] = useState(false);
  const [status, setStatus] = useState(false);
  const l = q.data;
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (!l) return <Alert tone="error">LPN {code} no encontrado</Alert>;
  const balances = l.balances.filter((b) => toBigInt(b.qty) > 0n);
  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <span className="font-mono">{l.code}</span> <StatusChip status={l.status} />
          </span>
        }
        subtitle={`${l.lpn_type} · creado ${fmtDateTime(l.created_at)} · versión ${l.version}`}
        actions={
          <>
            <Link to="/inventory?tab=lpn" className="text-sm text-sky-700 underline">
              ← Inventario
            </Link>
            <Link to={`/labels?type=LPN&id=${l.code}`} className="text-sm text-sky-700 underline">
              Etiqueta
            </Link>
            {can('inventory.adjust') && (
              <Button variant="secondary" onClick={() => setAdjust(true)}>
                Ajustar
              </Button>
            )}
            {can('inventory.quarantine') && (
              <Button variant="secondary" onClick={() => setStatus(true)}>
                Cuarentena / bloqueo
              </Button>
            )}
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Ubicación y referencias">
          <dl className="grid grid-cols-2 gap-3">
            <KV label="Ubicación" mono>
              {l.current_location ? (
                <Link to={`/map`} className="text-sky-700 underline">
                  {l.current_location.code}
                </Link>
              ) : (
                '—'
              )}
            </KV>
            <KV label="Zona">{l.current_location?.zone?.code ?? '—'}</KV>
            <KV label="Recepción">{l.receipt ? <Link className="text-sky-700 underline" to={`/inbound/receipts/${l.receipt.id}`}>{l.receipt.receipt_number}</Link> : '—'}</KV>
            <KV label="Contenedor">{l.container ? <Link className="text-sky-700 underline" to={`/inbound/containers/${l.container.id}`}>{l.container.container_number}</Link> : '—'}</KV>
            <KV label="Proveedor">{l.supplier?.name ?? '—'}</KV>
            <KV label="Pedido">{l.order ? <Link className="text-sky-700 underline" to={`/orders/${l.order.id}`}>{l.order.order_number}</Link> : '—'}</KV>
            <KV label="Embarque">{l.shipment ? <Link className="text-sky-700 underline" to={`/shipments/${l.shipment.id}`}>{l.shipment.shipment_number}</Link> : '—'}</KV>
            <KV label="Cajas / Peso">
              {l.cases_count} / {l.weight_kg ? `${fmtNum(l.weight_kg, 1)} kg` : '—'}
            </KV>
            <KV label="Lote">{l.lot ?? '—'}</KV>
            <KV label="Caducidad">{fmtDate(l.expiry_date)}</KV>
          </dl>
        </Card>
        <Card title={`Contenido (${balances.length})`} className="lg:col-span-2" padded={false}>
          <Table
            rows={balances}
            rowKey={(b) => b.id}
            columns={[
              { key: 's', header: 'SKU', render: (b) => <span className="font-mono font-semibold">{b.sku.code}</span> },
              { key: 'd', header: 'Descripción', render: (b) => b.sku.description },
              { key: 'st', header: 'Estado', render: (b) => <StatusChip status={b.status} /> },
              { key: 'q', header: 'Piezas', render: (b) => <b>{fmtQty(b.qty)}</b>, align: 'right' },
              { key: 'u', header: 'Desglose', render: (b) => fmtUom(b.qty, b.sku.uoms) },
              { key: 'w', header: 'Peso', render: (b) => `${fmtNum(Number(b.sku.unit_weight_kg) * Number(b.qty), 1)} kg`, align: 'right' },
            ]}
          />
        </Card>
      </div>
      <Card title="Línea de tiempo" className="mt-4">
        {tl.isLoading && <Skeleton className="h-32" />}
        {tl.data && <Timeline events={tl.data.events} />}
        {tl.data && tl.data.orders.length > 0 && (
          <div className="mt-3 text-xs text-slate-500">
            Pedidos: {tl.data.orders.map((o) => `${o.order_number} (${es(o.status)})`).join(', ')}
          </div>
        )}
      </Card>
      {adjust && <AdjustModal open onClose={() => setAdjust(false)} lpn={l.code} sku={balances[0]?.sku.code} />}
      {status && <StatusModal open onClose={() => setStatus(false)} lpn={l.code} />}
    </div>
  );
}
