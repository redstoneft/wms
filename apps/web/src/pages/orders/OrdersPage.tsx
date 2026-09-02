import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ORDER_STATUSES, type UomCode } from '@wms/shared';
import { masterdataApi } from '../../api/masterdata';
import { ordersApi } from '../../api/orders';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../components/Toast';
import { Button, Drawer, Field, Input, PageHeader, Pagination, Select, StatusChip, Table, Textarea } from '../../components/ui';
import { useDebounced, useQueryParam } from '../../lib/hooks';
import { es, fmtDate, fmtQty } from '../../lib/format';

export default function OrdersPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [status, setStatus] = useQueryParam('status');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const list = useQuery({ queryKey: ['orders', status, dq, offset], queryFn: () => ordersApi.list({ status: status || undefined, q: dq || undefined, limit, offset }), refetchInterval: 15_000 });
  const [open, setOpen] = useState(false);
  return (
    <div>
      <PageHeader
        title="Pedidos"
        subtitle="REQUERIDO / ASIGNADO / SURTIDO / VERIFICADO / CARGADO se llevan por separado y nunca se infieren"
        actions={
          <>
            <Input placeholder="Buscar pedido o cliente" value={q} onChange={(e) => setQ(e.target.value)} className="w-56" />
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-48" aria-label="Estado">
              <option value="">Todos los estados</option>
              {ORDER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {es(s)}
                </option>
              ))}
            </Select>
            {can('orders.manage') && <Button onClick={() => setOpen(true)}>Nuevo pedido</Button>}
          </>
        }
      />
      <Table
        rows={list.data?.items}
        loading={list.isLoading}
        rowKey={(o) => o.id}
        onRowClick={(o) => nav(`/orders/${o.id}`)}
        columns={[
          { key: 'n', header: 'Pedido', render: (o) => <span className="font-semibold">{o.order_number}</span> },
          { key: 's', header: 'Estado', render: (o) => <StatusChip status={o.status} /> },
          { key: 'p', header: 'Prio', render: (o) => <span className={o.priority <= 2 ? 'font-bold text-rose-700' : ''}>{o.priority}</span>, align: 'center' },
          { key: 'c', header: 'Cliente', render: (o) => o.customer.name },
          { key: 'd', header: 'Destino', render: (o) => o.destination ?? '—' },
          { key: 'l', header: 'Líneas', render: (o) => o.line_count, align: 'right' },
          { key: 'req', header: 'Requerido', render: (o) => fmtQty(o.totals.required), align: 'right' },
          { key: 'al', header: 'Asignado', render: (o) => fmtQty(o.totals.allocated), align: 'right' },
          { key: 'pk', header: 'Surtido', render: (o) => fmtQty(o.totals.picked), align: 'right' },
          { key: 'vf', header: 'Verificado', render: (o) => fmtQty(o.totals.verified), align: 'right' },
          { key: 'ld', header: 'Cargado', render: (o) => fmtQty(o.totals.loaded), align: 'right' },
          { key: 'sh', header: 'Embarque', render: (o) => o.shipment?.shipment_number ?? '—' },
          { key: 'dt', header: 'Fecha', render: (o) => fmtDate(o.order_date) },
        ]}
      />
      {list.data && <Pagination total={list.data.total} limit={limit} offset={offset} onChange={setOffset} />}
      <NewOrderDrawer open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

function NewOrderDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const customers = useQuery({ queryKey: ['customers'], queryFn: () => masterdataApi.parties('customers', { limit: 500 }), enabled: open });
  const [f, setF] = useState({ order_number: '', customer_code: '', destination: '', order_date: '', priority: '5', external_ref: '', notes: '' });
  const [lines, setLines] = useState<{ sku_code: string; qty: string; uom_code: UomCode }[]>([{ sku_code: '', qty: '', uom_code: 'CASE' }]);
  const m = useMutation({
    mutationFn: () =>
      ordersApi.create({
        ...f,
        priority: Number(f.priority),
        order_date: f.order_date || undefined,
        destination: f.destination || undefined,
        external_ref: f.external_ref || undefined,
        notes: f.notes || undefined,
        lines: lines.filter((l) => l.sku_code && l.qty),
      }),
    onSuccess: (o) => {
      toast.success(`Pedido ${o.order_number} creado`);
      void qc.invalidateQueries({ queryKey: ['orders'] });
      onClose();
      nav(`/orders/${o.id}`);
    },
    onError: (e) => toast.error('No se pudo crear el pedido', e),
  });
  return (
    <Drawer open={open} onClose={onClose} title="Nuevo pedido manual" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button onClick={() => m.mutate()} loading={m.isPending}>Crear pedido</Button></div>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Número de pedido" required>
          <Input value={f.order_number} onChange={(e) => setF({ ...f, order_number: e.target.value })} className="font-mono" />
        </Field>
        <Field label="Cliente" required>
          <Select value={f.customer_code} onChange={(e) => setF({ ...f, customer_code: e.target.value })}>
            <option value="">—</option>
            {customers.data?.items.map((c) => (
              <option key={c.id} value={c.code}>
                {c.code} · {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Destino">
          <Input value={f.destination} onChange={(e) => setF({ ...f, destination: e.target.value })} />
        </Field>
        <Field label="Fecha">
          <Input type="date" value={f.order_date} onChange={(e) => setF({ ...f, order_date: e.target.value })} />
        </Field>
        <Field label="Prioridad (1 = máxima)">
          <Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Referencia externa">
          <Input value={f.external_ref} onChange={(e) => setF({ ...f, external_ref: e.target.value })} />
        </Field>
        <Field label="Notas" className="sm:col-span-2">
          <Textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
      </div>
      <div className="mt-4">
        <div className="mb-1 text-sm font-semibold text-slate-700">Líneas</div>
        {lines.map((l, i) => (
          <div key={i} className="mb-2 grid grid-cols-[1fr_100px_100px_40px] gap-2">
            <Input placeholder="SKU" value={l.sku_code} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, sku_code: e.target.value } : x)))} className="font-mono" />
            <Input placeholder="Cant." inputMode="numeric" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value.replace(/\D/g, '') } : x)))} />
            <Select value={l.uom_code} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, uom_code: e.target.value as UomCode } : x)))}>
              {['PIECE', 'INNER', 'CASE', 'PALLET'].map((u) => (
                <option key={u}>{u}</option>
              ))}
            </Select>
            <Button variant="ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Quitar línea">
              ✕
            </Button>
          </div>
        ))}
        <Button variant="secondary" size="sm" onClick={() => setLines([...lines, { sku_code: '', qty: '', uom_code: 'CASE' }])}>
          + Línea
        </Button>
      </div>
    </Drawer>
  );
}
