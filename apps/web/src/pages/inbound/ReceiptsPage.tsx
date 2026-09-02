import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { RECEIPT_STATUSES } from '@wms/shared';
import { inboundApi } from '../../api/inbound';
import { useAuth } from '../../auth/AuthContext';
import { Button, PageHeader, Select, StatusChip, Table } from '../../components/ui';
import { useQueryParam } from '../../lib/hooks';
import { es, fmtDateTime, fmtQty, toBigInt } from '../../lib/format';
import { NewReceiptModal } from './ContainerDetailPage';

export default function ReceiptsPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [status, setStatus] = useQueryParam('status');
  const q = useQuery({ queryKey: ['receipts', status], queryFn: () => inboundApi.receipts({ status: status || undefined, limit: 200 }), refetchInterval: 15_000 });
  const [open, setOpen] = useState(false);
  return (
    <div>
      <PageHeader
        title="Recepciones"
        subtitle="Esperado vs recibido por SKU; cada escaneo crea inventario en el libro mayor"
        actions={
          <>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44" aria-label="Estado">
              <option value="">Todos los estados</option>
              {RECEIPT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {es(s)}
                </option>
              ))}
            </Select>
            {can('receiving.scan') && (
              <>
                <Button variant="secondary" onClick={() => nav('/wm/receive')}>
                  Recibir (RF)
                </Button>
                <Button onClick={() => setOpen(true)}>Nueva recepción</Button>
              </>
            )}
          </>
        }
      />
      <Table
        rows={q.data}
        loading={q.isLoading}
        rowKey={(r) => r.id}
        onRowClick={(r) => nav(`/inbound/receipts/${r.id}`)}
        empty="Sin recepciones"
        columns={[
          { key: 'n', header: 'Recepción', render: (r) => <span className="font-mono font-semibold">{r.receipt_number}</span> },
          { key: 's', header: 'Estado', render: (r) => <StatusChip status={r.status} /> },
          { key: 'c', header: 'Contenedor', render: (r) => (r.container && 'container_number' in r.container ? r.container.container_number : '—') },
          { key: 'l', header: 'Líneas', render: (r) => r.lines?.length ?? 0, align: 'right' },
          {
            key: 'e',
            header: 'Esperado / Recibido',
            render: (r) => {
              const exp = (r.lines ?? []).reduce((a, l) => a + toBigInt(l.expected_qty), 0n);
              const rec = (r.lines ?? []).reduce((a, l) => a + toBigInt(l.received_qty), 0n);
              return (
                <span className="tabular-nums">
                  {fmtQty(exp)} / <b>{fmtQty(rec)}</b>
                </span>
              );
            },
            align: 'right',
          },
          { key: 'st', header: 'Inicio', render: (r) => fmtDateTime(r.started_at) },
          { key: 'co', header: 'Completada', render: (r) => fmtDateTime(r.completed_at) },
        ]}
      />
      <NewReceiptModal open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
