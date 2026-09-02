import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { CONTAINER_STATUSES } from '@wms/shared';
import { inboundApi } from '../../api/inbound';
import { layoutApi } from '../../api/layout';
import { masterdataApi } from '../../api/masterdata';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../components/Toast';
import { Button, Drawer, Field, Input, PageHeader, Pagination, Select, StatusChip, Table, Textarea } from '../../components/ui';
import { useQueryParam } from '../../lib/hooks';
import { es, fmtDateTime } from '../../lib/format';

export default function ContainersPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [status, setStatus] = useQueryParam('status');
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const q = useQuery({ queryKey: ['containers', status, offset], queryFn: () => inboundApi.containers({ status: status || undefined, limit, offset }) });
  const [open, setOpen] = useState(false);

  return (
    <div>
      <PageHeader
        title="Contenedores"
        subtitle="Programación de arribos, descarga y recepción"
        actions={
          <>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44" aria-label="Estado">
              <option value="">Todos los estados</option>
              {CONTAINER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {es(s)}
                </option>
              ))}
            </Select>
            {can('containers.manage') && <Button onClick={() => setOpen(true)}>Nuevo contenedor</Button>}
          </>
        }
      />
      <Table
        rows={q.data?.items}
        loading={q.isLoading}
        rowKey={(c) => c.id}
        onRowClick={(c) => nav(`/inbound/containers/${c.id}`)}
        empty="No hay contenedores con ese filtro"
        columns={[
          { key: 'n', header: 'Contenedor', render: (c) => <span className="font-mono font-semibold">{c.container_number}</span> },
          { key: 's', header: 'Estado', render: (c) => <StatusChip status={c.status} /> },
          { key: 'sup', header: 'Proveedor', render: (c) => c.supplier?.name ?? '—' },
          { key: 'po', header: 'OC', render: (c) => c.po?.po_number ?? '—' },
          { key: 'car', header: 'Transportista', render: (c) => c.carrier?.name ?? '—' },
          { key: 'bl', header: 'BL / Sello', render: (c) => `${c.bl_number ?? '—'} / ${c.seal_number ?? '—'}` },
          { key: 'sch', header: 'Programado', render: (c) => fmtDateTime(c.scheduled_at) },
          { key: 'arr', header: 'Arribo', render: (c) => fmtDateTime(c.arrived_at) },
          { key: 'rc', header: 'Recepciones', render: (c) => c.receipts?.length ?? 0, align: 'right' },
        ]}
      />
      {q.data && <Pagination total={q.data.total} limit={limit} offset={offset} onChange={setOffset} />}
      <CreateContainerDrawer open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

function CreateContainerDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: () => masterdataApi.parties('suppliers', { limit: 500 }), enabled: open });
  const carriers = useQuery({ queryKey: ['carriers'], queryFn: () => masterdataApi.parties('carriers', { limit: 500 }), enabled: open });
  const pos = useQuery({ queryKey: ['purchase-orders'], queryFn: () => inboundApi.purchaseOrders({ limit: 200 }), enabled: open });
  const docks = useQuery({ queryKey: ['locations', 'RECEIVING'], queryFn: () => layoutApi.locations({ type: 'RECEIVING', limit: 100 }), enabled: open });
  const [f, setF] = useState({ container_number: '', supplier_id: '', po_id: '', carrier_id: '', bl_number: '', seal_number: '', plates: '', driver_name: '', scheduled_at: '', dock_location_id: '', notes: '' });
  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(f)) if (v) body[k] = k === 'scheduled_at' ? new Date(v).toISOString() : v;
      return inboundApi.createContainer(body);
    },
    onSuccess: () => {
      toast.success('Contenedor registrado');
      void qc.invalidateQueries({ queryKey: ['containers'] });
      onClose();
    },
    onError: (e) => toast.error('No se pudo registrar', e),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Drawer open={open} onClose={onClose} title="Nuevo contenedor">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" id="new-container">
        <Field label="Número de contenedor" required>
          <Input value={f.container_number} onChange={set('container_number')} required className="font-mono uppercase" />
        </Field>
        <Field label="Proveedor">
          <Select value={f.supplier_id} onChange={set('supplier_id')}>
            <option value="">—</option>
            {suppliers.data?.items.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} · {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Orden de compra">
          <Select value={f.po_id} onChange={set('po_id')}>
            <option value="">—</option>
            {pos.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.po_number} ({es(p.status)})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Transportista">
          <Select value={f.carrier_id} onChange={set('carrier_id')}>
            <option value="">—</option>
            {carriers.data?.items.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="BL">
          <Input value={f.bl_number} onChange={set('bl_number')} />
        </Field>
        <Field label="Sello">
          <Input value={f.seal_number} onChange={set('seal_number')} />
        </Field>
        <Field label="Placas">
          <Input value={f.plates} onChange={set('plates')} />
        </Field>
        <Field label="Chofer">
          <Input value={f.driver_name} onChange={set('driver_name')} />
        </Field>
        <Field label="Cita programada">
          <Input type="datetime-local" value={f.scheduled_at} onChange={set('scheduled_at')} />
        </Field>
        <Field label="Andén de recepción">
          <Select value={f.dock_location_id} onChange={set('dock_location_id')}>
            <option value="">—</option>
            {docks.data?.items.map((d) => (
              <option key={d.id} value={d.id}>
                {d.code}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Notas" className="sm:col-span-2">
          <Textarea value={f.notes} onChange={set('notes')} />
        </Field>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={m.isPending}>
            Registrar
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
