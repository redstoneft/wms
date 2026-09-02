import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ALLOCATION_STRATEGIES } from '@wms/shared';
import { adminApi } from '../../api/admin';
import { ApiError } from '../../api/client';
import { ordersApi, pickingApi, verificationApi } from '../../api/orders';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../components/Toast';
import { Alert, Button, Card, Checkbox, ConfirmDialog, Field, Input, KV, Modal, PageHeader, Select, Skeleton, StatusChip, Table, Textarea } from '../../components/ui';
import { cls, es, fmtDate, fmtDateTime, fmtQty, fmtUom, toBigInt } from '../../lib/format';

export default function OrderDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['order', id], queryFn: () => ordersApi.get(id), refetchInterval: 10_000 });
  const verifs = useQuery({ queryKey: ['verifications', id], queryFn: () => verificationApi.list({ order_id: id }), enabled: can('verification.execute') });
  const users = useQuery({ queryKey: ['directory'], queryFn: adminApi.directory, enabled: can('picking.assign') });
  const o = q.data;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['order', id] });
    void qc.invalidateQueries({ queryKey: ['orders'] });
  };

  const accept = useMutation({ mutationFn: () => ordersApi.accept(id), onSuccess: () => { toast.success('Pedido aceptado'); refresh(); }, onError: (e) => toast.error('No se pudo aceptar', e) });
  const [alloc, setAlloc] = useState<{ open: boolean; strategy: string; partial: boolean }>({ open: false, strategy: '', partial: false });
  const allocate = useMutation({
    mutationFn: () => ordersApi.allocate({ order_id: id, strategy: alloc.strategy || undefined, allow_partial: alloc.partial }),
    onSuccess: (r) => {
      toast.success(`Asignación ${es(r.status)} (${r.strategy})`, r.lines.map((l) => `${l.sku}: +${fmtQty(l.allocated_now)}${l.short !== '0' ? ` faltan ${fmtQty(l.short)}` : ''}`).join(' · '));
      setAlloc({ ...alloc, open: false });
      refresh();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'INSUFFICIENT_INVENTORY') {
        const d = e.details as { lines: { sku: string; short: string }[] } | undefined;
        toast.error('Inventario insuficiente', `${e.message}. ${d?.lines.filter((l) => l.short !== '0').map((l) => `${l.sku} faltan ${l.short}`).join(', ') ?? ''} Puedes permitir asignación parcial.`);
      } else toast.error('No se pudo asignar', e);
    },
  });
  const [pick, setPick] = useState<{ open: boolean; user: string }>({ open: false, user: '' });
  const createPick = useMutation({
    mutationFn: () => pickingApi.createTask(id, pick.user || undefined),
    onSuccess: (r) => {
      toast.success('Tarea de surtido creada', `${r.lines} líneas · staging ${r.staging.code}`);
      setPick({ open: false, user: '' });
      refresh();
    },
    onError: (e) => toast.error('No se pudo crear la tarea', e),
  });
  const [cancel, setCancel] = useState<{ open: boolean; reason: string; auth: string }>({ open: false, reason: '', auth: '' });
  const doCancel = useMutation({
    mutationFn: () => ordersApi.cancel({ order_id: id, reason: cancel.reason, authorization_id: cancel.auth || undefined }),
    onSuccess: (r) => {
      toast.success('Pedido cancelado', `${fmtQty(r.deallocated)} unidades liberadas`);
      setCancel({ open: false, reason: '', auth: '' });
      refresh();
    },
    onError: (e) => toast.error('No se pudo cancelar', e),
  });

  if (q.isLoading) return <Skeleton className="h-64" />;
  if (!o) return <Alert tone="error">Pedido no encontrado</Alert>;
  const needsAuth = ['PICKING', 'PICKED', 'STAGED', 'VERIFIED'].includes(o.status);
  const activePick = o.pick_tasks.find((t) => t.status === 'PENDING' || t.status === 'IN_PROGRESS');

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {o.order_number} <StatusChip status={o.status} /> <span className={cls('rounded px-2 py-0.5 text-xs', o.priority <= 2 ? 'bg-rose-100 text-rose-800' : 'bg-slate-100')}>Prioridad {o.priority}</span>
          </span>
        }
        subtitle={`${o.customer.name} · ${o.destination ?? 'sin destino'} · ${fmtDate(o.order_date)} · v${o.version}`}
        actions={
          <>
            <Link to="/orders" className="text-sm text-sky-700 underline">
              ← Pedidos
            </Link>
            {can('orders.manage') && o.status === 'IMPORTED' && (
              <Button onClick={() => accept.mutate()} loading={accept.isPending}>
                Aceptar
              </Button>
            )}
            {can('orders.allocate') && ['IMPORTED', 'ACCEPTED', 'PARTIALLY_ALLOCATED'].includes(o.status) && <Button onClick={() => setAlloc({ ...alloc, open: true })}>Asignar inventario</Button>}
            {can('picking.assign') && ['ALLOCATED', 'PARTIALLY_ALLOCATED'].includes(o.status) && !activePick && <Button variant="success" onClick={() => setPick({ open: true, user: '' })}>Crear tarea de surtido</Button>}
            {can('orders.manage') && !['SHIPPED', 'LOADED', 'LOADING', 'CANCELLED'].includes(o.status) && (
              <Button variant="danger" onClick={() => setCancel({ open: true, reason: '', auth: '' })}>
                Cancelar pedido
              </Button>
            )}
            <Link to={`/labels?type=ORDER&id=${o.order_number}`} className="text-sm text-sky-700 underline">
              Etiqueta
            </Link>
          </>
        }
      />
      <Card title="Líneas" padded={false}>
        <Table
          rows={o.lines}
          rowKey={(l) => l.id}
          columns={[
            { key: 'n', header: '#', render: (l) => l.line_no },
            { key: 's', header: 'SKU', render: (l) => <span className="font-mono font-semibold">{l.sku.code}</span> },
            { key: 'd', header: 'Descripción', render: (l) => l.sku.description },
            { key: 'u', header: 'Pedido en', render: (l) => `${fmtQty(l.uom_qty)} ${l.uom_code}` },
            { key: 'req', header: 'REQUERIDO', render: (l) => <b>{fmtQty(l.required_qty)}</b>, align: 'right' },
            { key: 'al', header: 'ASIGNADO', render: (l) => <Cell v={l.allocated_qty} req={l.required_qty} tone="violet" />, align: 'right' },
            { key: 'pk', header: 'SURTIDO', render: (l) => <Cell v={l.picked_qty} req={l.required_qty} tone="sky" />, align: 'right' },
            { key: 'vf', header: 'VERIFICADO', render: (l) => <Cell v={l.verified_qty} req={l.required_qty} tone="teal" />, align: 'right' },
            { key: 'ld', header: 'CARGADO', render: (l) => <Cell v={l.loaded_qty} req={l.required_qty} tone="emerald" />, align: 'right' },
            { key: 'b', header: 'Desglose', render: (l) => fmtUom(l.required_qty, l.sku.uoms) },
            { key: 'a', header: 'Asignaciones', render: (l) => (l.allocations ?? []).filter((a) => a.status !== 'RELEASED').map((a) => `${a.lpn.code}@${a.lpn.current_location?.code ?? '?'} (${fmtQty(a.qty)})`).join(', ') || '—' },
          ]}
        />
      </Card>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Surtido">
          <dl className="grid gap-2">
            <KV label="Surtidor">{o.picker ? `${o.picker.full_name} (${o.picker.username})` : '—'}</KV>
            <KV label="Carril de staging" mono>
              {o.staging_assignments[0]?.location.code ?? '—'}
            </KV>
            <KV label="Tareas">
              {o.pick_tasks.length === 0 ? '—' : o.pick_tasks.map((t) => (
                <div key={t.id} className="flex items-center gap-2 text-xs">
                  <StatusChip status={t.status} /> {fmtDateTime(t.created_at)}
                  {(t.status === 'PENDING' || t.status === 'IN_PROGRESS') && can('picking.assign') && (
                    <Link to={`/picking?task=${t.id}`} className="text-sky-700 underline">
                      supervisar
                    </Link>
                  )}
                </div>
              ))}
            </KV>
            <KV label="LPNs de salida">
              {o.lpns.length === 0 ? '—' : o.lpns.map((l) => (
                <div key={l.id} className="text-xs">
                  <Link to={`/inventory/lpn/${l.code}`} className="font-mono text-sky-700 underline">{l.code}</Link> <StatusChip status={l.status} /> {l.current_location?.code ?? ''}
                </div>
              ))}
            </KV>
          </dl>
        </Card>
        <Card title="Verificación">
          <dl className="grid gap-2">
            <KV label="Verificador">{o.verifier ? `${o.verifier.full_name} (${o.verifier.username})` : '—'}</KV>
            <KV label="Verificado el">{fmtDateTime(o.verified_at)}</KV>
            <KV label="Verificaciones">
              {(verifs.data ?? o.verifications).length === 0 ? '—' : (verifs.data ?? o.verifications).map((v) => (
                <div key={v.id} className="flex items-center gap-2 text-xs">
                  <StatusChip status={v.status} /> {fmtDateTime(v.started_at)} {'notes' in v && v.notes ? `· ${v.notes}` : ''}
                </div>
              ))}
            </KV>
          </dl>
        </Card>
        <Card title="Embarque">
          <dl className="grid gap-2">
            <KV label="Embarque">{o.shipment ? <Link to={`/shipments/${o.shipment.id}`} className="text-sky-700 underline">{o.shipment.shipment_number}</Link> : '—'}</KV>
            <KV label="Estado embarque">{o.shipment ? <StatusChip status={o.shipment.status} /> : '—'}</KV>
            <KV label="Fuente / ref.">{o.source} {o.external_ref ? `· ${o.external_ref}` : ''}</KV>
            <KV label="Notas">{o.notes ?? '—'}</KV>
          </dl>
          {!o.shipment && ['VERIFIED', 'STAGED', 'PICKED', 'ALLOCATED', 'PARTIALLY_ALLOCATED', 'PICKING'].includes(o.status) && can('shipments.manage') && (
            <Button size="sm" variant="secondary" className="mt-3" onClick={() => nav(`/shipments?add_order=${o.id}`)}>
              Agregar a un embarque
            </Button>
          )}
        </Card>
      </div>

      <Modal open={alloc.open} onClose={() => setAlloc({ ...alloc, open: false })} title="Asignar inventario" footer={<><Button variant="secondary" onClick={() => setAlloc({ ...alloc, open: false })}>Cancelar</Button><Button onClick={() => allocate.mutate()} loading={allocate.isPending}>Asignar</Button></>}>
        <div className="grid gap-3">
          <Field label="Estrategia (vacío = configuración global)">
            <Select value={alloc.strategy} onChange={(e) => setAlloc({ ...alloc, strategy: e.target.value })}>
              <option value="">Predeterminada</option>
              {ALLOCATION_STRATEGIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Checkbox label="Permitir asignación parcial (si falta inventario)" checked={alloc.partial} onChange={(e) => setAlloc({ ...alloc, partial: e.target.checked })} />
          <Alert tone="info">Sólo se asigna inventario DISPONIBLE en pallets almacenados en ubicaciones activas; cuarentena/bloqueado/dañado nunca se asignan.</Alert>
        </div>
      </Modal>
      <Modal open={pick.open} onClose={() => setPick({ open: false, user: '' })} title="Crear tarea de surtido" footer={<><Button variant="secondary" onClick={() => setPick({ open: false, user: '' })}>Cancelar</Button><Button onClick={() => createPick.mutate()} loading={createPick.isPending}>Crear</Button></>}>
        <Field label="Asignar surtidor (opcional)">
          <Select value={pick.user} onChange={(e) => setPick({ ...pick, user: e.target.value })}>
            <option value="">Cualquier surtidor la puede tomar</option>
            {users.data?.filter((u) => u.roles.includes('PICKER') || u.roles.includes('SUPERVISOR')).map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name} ({u.username})
              </option>
            ))}
          </Select>
        </Field>
        <p className="mt-2 text-xs text-slate-500">Se generará la ruta por secuencia de picking y se reservará un carril de staging.</p>
      </Modal>
      <ConfirmDialog open={cancel.open} onClose={() => setCancel({ open: false, reason: '', auth: '' })} onConfirm={() => doCancel.mutate()} title={`Cancelar pedido ${o.order_number}`} danger loading={doCancel.isPending} confirmLabel="Cancelar pedido">
        <div className="grid gap-3">
          {needsAuth && <Alert tone="warn">El pedido está en surtido/staging: se requiere autorización de supervisor <b>ORDER_CANCEL_DURING_PICKING</b> (entidad order, id {o.id}). Los pallets surtidos regresan a inventario disponible con tarea de put-away.</Alert>}
          <Field label="Motivo (mín. 3)" required>
            <Textarea value={cancel.reason} onChange={(e) => setCancel({ ...cancel, reason: e.target.value })} />
          </Field>
          {needsAuth && (
            <Field label="ID de autorización" required>
              <Input value={cancel.auth} onChange={(e) => setCancel({ ...cancel, auth: e.target.value })} className="font-mono" />
            </Field>
          )}
        </div>
      </ConfirmDialog>
    </div>
  );
}

function Cell({ v, req, tone }: { v: string; req: string; tone: 'violet' | 'sky' | 'teal' | 'emerald' }) {
  const n = toBigInt(v);
  const r = toBigInt(req);
  const full = n >= r && r > 0n;
  const colors = { violet: 'text-violet-700', sky: 'text-sky-700', teal: 'text-teal-700', emerald: 'text-emerald-700' };
  return <span className={cls('tabular-nums', n === 0n ? 'text-slate-400' : full ? `font-bold ${colors[tone]}` : 'text-amber-700')}>{fmtQty(v)}</span>;
}
