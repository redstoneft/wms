import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { SHIPMENT_STATUSES } from '@wms/shared';
import { layoutApi } from '../../api/layout';
import { masterdataApi } from '../../api/masterdata';
import { ordersApi } from '../../api/orders';
import { shipmentsApi } from '../../api/shipments';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../components/Toast';
import { Button, Checkbox, Drawer, Field, Input, PageHeader, Select, StatusChip, Table, Textarea } from '../../components/ui';
import { useQueryParam } from '../../lib/hooks';
import { es, fmtDateTime } from '../../lib/format';

export default function ShipmentsPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [status, setStatus] = useQueryParam('status');
  const [sp] = useSearchParams();
  const list = useQuery({ queryKey: ['shipments', status], queryFn: () => shipmentsApi.list({ status: status || undefined, limit: 200 }), refetchInterval: 15_000 });
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (sp.get('add_order')) setOpen(true);
  }, [sp]);
  return (
    <div>
      <PageHeader
        title="Embarques"
        subtitle="Regla absoluta: un embarque sólo se libera cuando por CADA pedido y CADA SKU, cargado = requerido."
        actions={
          <>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44" aria-label="Estado">
              <option value="">Todos los estados</option>
              {SHIPMENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {es(s)}
                </option>
              ))}
            </Select>
            {can('shipments.manage') && <Button onClick={() => setOpen(true)}>Nuevo embarque</Button>}
          </>
        }
      />
      <Table
        rows={list.data}
        loading={list.isLoading}
        rowKey={(s) => s.id}
        onRowClick={(s) => nav(`/shipments/${s.id}`)}
        columns={[
          { key: 'n', header: 'Embarque', render: (s) => <b>{s.shipment_number}</b> },
          { key: 'st', header: 'Estado', render: (s) => <StatusChip status={s.status} /> },
          { key: 'c', header: 'Transportista', render: (s) => s.carrier?.name ?? '—' },
          { key: 'v', header: 'Unidad / placas', render: (s) => `${s.vehicle ?? '—'} ${s.plates ?? ''}` },
          { key: 'd', header: 'Chofer', render: (s) => s.driver_name ?? '—' },
          { key: 'o', header: 'Pedidos', render: (s) => s.orders.map((o) => o.order_number).join(', ') || '—' },
          { key: 'l', header: 'Pallets cargados', render: (s) => s._count.lpns, align: 'right' },
          { key: 'r', header: 'Liberado', render: (s) => fmtDateTime(s.released_at) },
          { key: 'dp', header: 'Salida', render: (s) => fmtDateTime(s.departed_at) },
        ]}
      />
      <NewShipmentDrawer open={open} onClose={() => setOpen(false)} preselectOrder={sp.get('add_order') ?? undefined} />
    </div>
  );
}

function NewShipmentDrawer({ open, onClose, preselectOrder }: { open: boolean; onClose: () => void; preselectOrder?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const carriers = useQuery({ queryKey: ['carriers'], queryFn: () => masterdataApi.parties('carriers', { limit: 500 }), enabled: open });
  const docks = useQuery({ queryKey: ['locations', 'SHIPPING'], queryFn: () => layoutApi.locations({ type: 'SHIPPING', limit: 100 }), enabled: open });
  const orders = useQuery({ queryKey: ['orders', 'for-shipment'], queryFn: () => ordersApi.list({ status: 'VERIFIED,STAGED,PICKED,ALLOCATED,PARTIALLY_ALLOCATED,PICKING', limit: 200 }), enabled: open });
  const [f, setF] = useState({ carrier_id: '', vehicle: '', plates: '', driver_name: '', destination: '', dock_location_id: '', notes: '' });
  const [sel, setSel] = useState<string[]>(preselectOrder ? [preselectOrder] : []);
  useEffect(() => {
    if (preselectOrder) setSel((s) => (s.includes(preselectOrder) ? s : [...s, preselectOrder]));
  }, [preselectOrder]);
  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { order_ids: sel };
      for (const [k, v] of Object.entries(f)) if (v) body[k] = v;
      return shipmentsApi.create(body);
    },
    onSuccess: (s) => {
      toast.success(`Embarque ${s.shipment_number} creado`);
      void qc.invalidateQueries({ queryKey: ['shipments'] });
      onClose();
      nav(`/shipments/${s.id}`);
    },
    onError: (e) => toast.error('No se pudo crear el embarque', e),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Drawer open={open} onClose={onClose} title="Nuevo embarque" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button onClick={() => m.mutate()} loading={m.isPending}>Crear</Button></div>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Transportista">
          <Select value={f.carrier_id} onChange={set('carrier_id')}>
            <option value="">—</option>
            {carriers.data?.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Andén de embarque">
          <Select value={f.dock_location_id} onChange={set('dock_location_id')}>
            <option value="">—</option>
            {docks.data?.items.map((d) => (
              <option key={d.id} value={d.id}>
                {d.code}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Unidad / vehículo">
          <Input value={f.vehicle} onChange={set('vehicle')} />
        </Field>
        <Field label="Placas">
          <Input value={f.plates} onChange={set('plates')} />
        </Field>
        <Field label="Chofer">
          <Input value={f.driver_name} onChange={set('driver_name')} />
        </Field>
        <Field label="Destino">
          <Input value={f.destination} onChange={set('destination')} />
        </Field>
        <Field label="Notas" className="sm:col-span-2">
          <Textarea value={f.notes} onChange={set('notes')} />
        </Field>
      </div>
      <div className="mt-4">
        <div className="mb-1 text-sm font-semibold text-slate-700">Pedidos a incluir</div>
        <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-200">
          {orders.data?.items.filter((o) => !o.shipment_id || sel.includes(o.id)).map((o) => (
            <label key={o.id} className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 text-sm">
              <Checkbox label="" checked={sel.includes(o.id)} onChange={(e) => setSel(e.target.checked ? [...sel, o.id] : sel.filter((x) => x !== o.id))} />
              <b>{o.order_number}</b> <span className="text-slate-500">{o.customer.name}</span> <StatusChip status={o.status} />
            </label>
          ))}
          {orders.data && orders.data.items.length === 0 && <div className="p-3 text-sm text-slate-500">No hay pedidos elegibles</div>}
        </div>
      </div>
    </Drawer>
  );
}
