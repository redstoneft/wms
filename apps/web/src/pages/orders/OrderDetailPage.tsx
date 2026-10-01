import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ALLOCATION_STRATEGIES } from '@wms/shared';
import { adminApi } from '../../api/admin';
import { ApiError } from '../../api/client';
import { masterdataApi } from '../../api/masterdata';
import { ordersApi, pickingApi, verificationApi } from '../../api/orders';
import type { Sku } from '../../api/types';
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
  const [adjust, setAdjust] = useState<{ open: boolean; reason: string; qty: Record<string, string>; add: { sku: string; qty: string }[] }>({ open: false, reason: '', qty: {}, add: [] });
  // swapping the model of a line: the old line goes to 0 (its picked pieces return to their pallets) and the new model is added (or increased) and gets picked
  const [swap, setSwap] = useState<{ open: boolean; lineId: string | null; q: string; hits: Sku[]; pick: Sku | null; qty: string; reason: string }>({ open: false, lineId: null, q: '', hits: [], pick: null, qty: '', reason: '' });
  useEffect(() => {
    const term = swap.q.trim();
    if (!swap.open || term.length < 1) return;
    const t = window.setTimeout(() => {
      masterdataApi.skus({ q: term, limit: 8, active: 'true' }).then((r) => setSwap((s) => (s.q === swap.q ? { ...s, hits: r.items } : s))).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(t);
  }, [swap.q, swap.open]);
  const doSwap = useMutation({
    mutationFn: () => {
      const line = o!.lines.find((l) => l.id === swap.lineId)!;
      const existing = o!.lines.find((l) => l.sku.code === swap.pick!.code);
      const qty = BigInt(swap.qty.trim());
      return ordersApi.adjust({
        order_id: o!.id,
        reason: swap.reason.trim(),
        lines: [{ sku_code: line.sku.code, qty: '0' }, { sku_code: swap.pick!.code, qty: (existing ? toBigInt(existing.required_qty) + qty : qty).toString() }],
      });
    },
    onSuccess: (r) => {
      toast.success(`Modelo cambiado · ${es(r.status)}`, r.changes.map((c) => `${c.sku}: ${c.before} → ${c.after}${c.returned_to_stock !== '0' ? ` · ${c.returned_to_stock} regresan a existencia` : ''}${c.to_pick !== '0' ? ` · ${c.to_pick} por surtir` : ''}`).join(' · '));
      setSwap({ open: false, lineId: null, q: '', hits: [], pick: null, qty: '', reason: '' });
      void qc.invalidateQueries({ queryKey: ['order', id] });
    },
    onError: (e) => toast.error('No se pudo cambiar el modelo', e),
  });
  const doAdjust = useMutation({
    mutationFn: () =>
      ordersApi.adjust({
        order_id: id,
        reason: adjust.reason,
        lines: [
          ...Object.entries(adjust.qty).filter(([, v]) => v.trim() !== '').map(([sku_code, qty]) => ({ sku_code, qty: qty.trim() })),
          ...adjust.add.filter((a) => a.sku.trim() && a.qty.trim()).map((a) => ({ sku_code: a.sku.trim().toUpperCase(), qty: a.qty.trim() })),
        ],
      }),
    onSuccess: (r) => {
      toast.success(
        r.changes.length ? `Pedido ajustado · ${es(r.status)}` : 'Sin cambios',
        r.changes.map((c) => `${c.sku} ${fmtQty(c.before)}→${fmtQty(c.after)}${c.returned_to_stock !== '0' ? ` · ${fmtQty(c.returned_to_stock)} a existencia (${c.new_lpns.join(', ')})` : ''}${c.to_pick !== '0' ? ` · ${fmtQty(c.to_pick)} por surtir` : ''}`).join(' | '),
      );
      setAdjust({ open: false, reason: '', qty: {}, add: [] });
      refresh();
    },
    onError: (e) => toast.error('No se pudo ajustar', e),
  });
  const [reopen, setReopen] = useState<{ open: boolean; reason: string }>({ open: false, reason: '' });
  const doReopen = useMutation({
    mutationFn: () => ordersApi.reopen({ order_id: id, reason: reopen.reason }),
    onSuccess: (r) => {
      toast.success(`Pedido reabierto · ${es(r.status)}`, r.restored.length ? `Regresa: ${r.restored.map((x) => `${x.lpn} ${x.sku} ${fmtQty(x.qty)}${x.location ? ` en ${x.location}` : ''}`).join(' · ')}` : 'Listo para asignar inventario');
      setReopen({ open: false, reason: '' });
      void qc.invalidateQueries({ queryKey: ['order', id] });
    },
    onError: (e) => toast.error('No se pudo reabrir', e),
  });
  const [force, setForce] = useState<{ open: boolean; reason: string }>({ open: false, reason: '' });
  const doForce = useMutation({
    mutationFn: () => ordersApi.forceDeliver({ order_id: id, reason: force.reason }),
    onSuccess: (r) => {
      toast.success('Pedido marcado como entregado', `${r.shipped.length} movimiento(s) de salida${r.missing.length ? ` · sin existencia: ${r.missing.map((m) => `${m.sku} ${fmtQty(m.qty)}`).join(', ')}` : ''}`);
      setForce({ open: false, reason: '' });
      refresh();
    },
    onError: (e) => toast.error('No se pudo marcar como entregado', e),
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
            {can('orders.adjust') && !['SHIPPED', 'CANCELLED', 'LOADING', 'LOADED'].includes(o.status) && !o.shipment && (
              <Button variant="secondary" onClick={() => setAdjust({ open: true, reason: '', qty: Object.fromEntries(o.lines.map((l) => [l.sku.code, ''])), add: [] })}>
                Ajustar cantidades
              </Button>
            )}
            {can('orders.reopen') && ['SHIPPED', 'CANCELLED'].includes(o.status) && (
              <Button variant="secondary" onClick={() => setReopen({ open: true, reason: '' })}>
                Reabrir pedido
              </Button>
            )}
            {can('orders.force_deliver') && !['SHIPPED', 'CANCELLED'].includes(o.status) && (
              <Button variant="secondary" onClick={() => setForce({ open: true, reason: '' })}>
                Marcar como entregado (fuera de flujo)
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
            ...(can('orders.adjust') && !['SHIPPED', 'CANCELLED', 'LOADING', 'LOADED'].includes(o.status) && !o.shipment
              ? [{ key: 'x', header: '', render: (l: (typeof o.lines)[number]) => <Button size="sm" variant="secondary" onClick={() => setSwap({ open: true, lineId: l.id, q: '', hits: [], pick: null, qty: toBigInt(l.required_qty).toString(), reason: '' })}>Cambiar modelo</Button> }]
              : []),
          ]}
        />
      </Card>
      <Modal open={swap.open} onClose={() => setSwap({ ...swap, open: false })} title={`Cambiar modelo de la línea ${o.lines.find((l) => l.id === swap.lineId)?.sku.code ?? ''}`} footer={<><Button variant="secondary" onClick={() => setSwap({ ...swap, open: false })}>Cancelar</Button><Button onClick={() => doSwap.mutate()} loading={doSwap.isPending} disabled={!swap.pick || !/^[0-9]+$/.test(swap.qty.trim()) || BigInt(swap.qty.trim() || '0') <= 0n || swap.reason.trim().length < 3 || swap.pick.code === o.lines.find((l) => l.id === swap.lineId)?.sku.code}>Cambiar</Button></>}>
        <div className="grid gap-3">
          <Alert tone="info">La línea actual queda en 0: lo que ya se surtió regresa a su tarima y posición. El modelo nuevo entra al pedido (si ya estaba, se le suma) y queda por asignar y surtir. Queda auditado y se abre una incidencia.</Alert>
          <Field label="Modelo nuevo (clave o nombre)" required>
            <Input value={swap.pick ? `${swap.pick.code} · ${swap.pick.description}` : swap.q} onChange={(e) => setSwap({ ...swap, q: e.target.value, pick: null })} placeholder="Escribe parte de la clave o del nombre" className="font-mono" autoFocus />
            {!swap.pick && swap.q.trim() && (
              <div className="mt-1 max-h-56 overflow-auto rounded-md border border-slate-200">
                {swap.hits.length === 0 && <div className="px-3 py-2 text-sm text-slate-500">Sin coincidencias</div>}
                {swap.hits.map((h) => (
                  <button key={h.id} type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-100" onClick={() => setSwap({ ...swap, pick: h, hits: [] })}>
                    <span className="font-mono font-semibold">{h.code}</span> <span className="text-slate-600">{h.description}</span>
                  </button>
                ))}
              </div>
            )}
          </Field>
          {swap.pick && o.lines.some((l) => l.sku.code === swap.pick!.code) && <Alert tone="warn">{swap.pick.code} ya está en el pedido: las piezas se sumarán a esa línea.</Alert>}
          <Field label="Piezas del modelo nuevo" required>
            <Input type="number" min={1} value={swap.qty} onChange={(e) => setSwap({ ...swap, qty: e.target.value })} className="w-40" />
          </Field>
          <Field label="Motivo (mín. 3)" required>
            <Textarea value={swap.reason} onChange={(e) => setSwap({ ...swap, reason: e.target.value })} placeholder="El cliente cambió el modelo" />
          </Field>
        </div>
      </Modal>
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
      <Modal open={adjust.open} onClose={() => setAdjust({ ...adjust, open: false })} title={`Ajustar cantidades de ${o.order_number}`} footer={<><Button variant="secondary" onClick={() => setAdjust({ ...adjust, open: false })}>Cancelar</Button><Button onClick={() => doAdjust.mutate()} loading={doAdjust.isPending} disabled={adjust.reason.trim().length < 3 || (Object.values(adjust.qty).every((v) => v.trim() === '') && !adjust.add.some((a) => a.sku.trim() && a.qty.trim()))}>Aplicar</Button></>}>
        <div className="grid gap-3">
          <Alert tone="info">Escribe la nueva cantidad requerida (en piezas) solo en las líneas que cambian. Puede ser menor a lo pedido o 0. Si es menor a lo surtido, el sobrante regresa a su tarima y posición. Si es mayor, la diferencia queda por asignar y surtir. Cero quita la línea del pedido (queda en el historial). Lo verificado se vuelve a verificar.</Alert>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setAdjust({ ...adjust, qty: Object.fromEntries(o.lines.map((l) => [l.sku.code, l.picked_qty === l.required_qty ? '' : String(l.picked_qty)])) })}>Dejar solo lo surtido</Button>
            <Button variant="secondary" onClick={() => setAdjust({ ...adjust, qty: Object.fromEntries(o.lines.map((l) => [l.sku.code, '0'])) })}>Todo en 0</Button>
            <Button variant="secondary" onClick={() => setAdjust({ ...adjust, qty: Object.fromEntries(o.lines.map((l) => [l.sku.code, ''])) })}>Limpiar</Button>
          </div>
          <Table
            rows={o.lines}
            rowKey={(l) => l.id}
            columns={[
              { key: 's', header: 'SKU', render: (l) => <span className="font-mono">{l.sku.code}</span> },
              { key: 'd', header: 'Descripción', render: (l) => l.sku.description },
              { key: 'r', header: 'Requerido', render: (l) => fmtQty(l.required_qty), align: 'right' },
              { key: 'p', header: 'Surtido', render: (l) => fmtQty(l.picked_qty), align: 'right' },
              {
                key: 'n',
                header: 'Nueva cantidad',
                render: (l) => (
                  <div className="flex items-center gap-1">
                    <Input type="number" min={0} value={adjust.qty[l.sku.code] ?? ''} placeholder={fmtQty(l.required_qty)} onChange={(e) => setAdjust({ ...adjust, qty: { ...adjust.qty, [l.sku.code]: e.target.value } })} className="w-28 text-right" />
                    <button type="button" className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100" title="Dejar la línea en 0 (se quita del pedido)" onClick={() => setAdjust({ ...adjust, qty: { ...adjust.qty, [l.sku.code]: '0' } })}>0</button>
                    {l.picked_qty !== l.required_qty && (
                      <button type="button" className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100" title="Dejar solo lo surtido" onClick={() => setAdjust({ ...adjust, qty: { ...adjust.qty, [l.sku.code]: String(l.picked_qty) } })}>= surtido</button>
                    )}
                  </div>
                ),
              },
            ]}
          />
          <div>
            <div className="mb-1 text-xs font-semibold uppercase text-slate-500">Agregar producto</div>
            {adjust.add.map((a, i) => (
              <div key={i} className="mb-1 flex gap-2">
                <Input value={a.sku} placeholder="SKU o código de barras" onChange={(e) => setAdjust({ ...adjust, add: adjust.add.map((x, j) => (j === i ? { ...x, sku: e.target.value.toUpperCase() } : x)) })} className="font-mono" />
                <Input type="number" min={1} value={a.qty} placeholder="piezas" onChange={(e) => setAdjust({ ...adjust, add: adjust.add.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)) })} className="w-28" />
              </div>
            ))}
            <Button variant="secondary" onClick={() => setAdjust({ ...adjust, add: [...adjust.add, { sku: '', qty: '' }] })}>+ Línea</Button>
          </div>
          <Field label="Motivo (mín. 3)" required>
            <Textarea value={adjust.reason} onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })} />
          </Field>
        </div>
      </Modal>
      <ConfirmDialog open={reopen.open} onClose={() => setReopen({ open: false, reason: '' })} onConfirm={() => doReopen.mutate()} title={`Reabrir ${o.order_number}`} danger loading={doReopen.isPending} confirmLabel="Reabrir">
        <div className="grid gap-3">
          <Alert tone="warn">
            {o.status === 'CANCELLED'
              ? 'El pedido vuelve a ACEPTADO con sus líneas, listo para asignar inventario y surtir de nuevo.'
              : 'Todo lo que salió de este pedido regresa a sus tarimas: lo surtido vuelve a sus tarimas de salida (en su carril si siguen ahí) y lo que se descontó de existencia vuelve como disponible. El pedido queda surtido, parcial o aceptado según lo que regrese. Si el camión ya salió con un embarque, no se puede reabrir.'}
          </Alert>
          <Field label="Motivo (mín. 3)" required>
            <Textarea value={reopen.reason} onChange={(e) => setReopen({ ...reopen, reason: e.target.value })} />
          </Field>
        </div>
      </ConfirmDialog>
      <ConfirmDialog open={force.open} onClose={() => setForce({ open: false, reason: '' })} onConfirm={() => doForce.mutate()} title={`Marcar ${o.order_number} como entregado`} danger loading={doForce.isPending} confirmLabel="Marcar como entregado">
        <div className="grid gap-3">
          <Alert tone="warn">
            Úsalo solo cuando el pedido ya salió sin seguir el flujo (sin staging, verificación o carga). El inventario se descuenta como embarcado desde donde esté: lo surtido, lo asignado y, si falta, de la existencia disponible. Lo que no haya en existencia queda registrado en una incidencia. El pedido pasa a SHIPPED y se libera su carril.
          </Alert>
          <Field label="Motivo (mín. 3)" required>
            <Textarea value={force.reason} onChange={(e) => setForce({ ...force, reason: e.target.value })} />
          </Field>
        </div>
      </ConfirmDialog>
      <ConfirmDialog open={cancel.open} onClose={() => setCancel({ open: false, reason: '', auth: '' })} onConfirm={() => doCancel.mutate()} title={`Cancelar pedido ${o.order_number}`} danger loading={doCancel.isPending} confirmLabel="Cancelar pedido">
        <div className="grid gap-3">
          {needsAuth && can('exceptions.authorize') && <Alert tone="info">El pedido está en surtido/staging. Como supervisor puedes cancelarlo con solo el motivo (queda auditado a tu nombre). Los pallets surtidos regresan a inventario disponible con tarea de put-away.</Alert>}
          {needsAuth && !can('exceptions.authorize') && <Alert tone="warn">El pedido está en surtido/staging: se requiere autorización de supervisor <b>ORDER_CANCEL_DURING_PICKING</b> (entidad order, id {o.id}). Los pallets surtidos regresan a inventario disponible con tarea de put-away.</Alert>}
          <Field label="Motivo (mín. 3)" required>
            <Textarea value={cancel.reason} onChange={(e) => setCancel({ ...cancel, reason: e.target.value })} />
          </Field>
          {needsAuth && (
            <Field label={can('exceptions.authorize') ? 'ID de autorización (opcional para supervisor)' : 'ID de autorización'} required={!can('exceptions.authorize')}>
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
