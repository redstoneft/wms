import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { ordersApi } from '../../api/orders';
import { shipmentsApi } from '../../api/shipments';
import type { ReleaseLine } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../components/Toast';
import { Alert, Badge, Button, Card, ConfirmDialog, Field, KV, Modal, PageHeader, Select, Skeleton, StatusChip, Table, Textarea } from '../../components/ui';
import { cls, es, fmtDateTime, fmtQty } from '../../lib/format';

const PROBLEM_ES: Record<string, string> = { SHORT_LOADED: 'Carga incompleta', OVER_LOADED: 'Sobrecarga', NOT_PICKED: 'No surtido', NOT_VERIFIED: 'No verificado', SKU_OMITTED: 'SKU omitido' };

export default function ShipmentDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['shipment', id], queryFn: () => shipmentsApi.get(id), refetchInterval: 10_000 });
  const check = useQuery({ queryKey: ['release-check', id], queryFn: () => shipmentsApi.releaseCheck(id), refetchInterval: 10_000 });
  const s = q.data;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['shipment', id] });
    void qc.invalidateQueries({ queryKey: ['release-check', id] });
    void qc.invalidateQueries({ queryKey: ['shipments'] });
  };
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [confirmDepart, setConfirmDepart] = useState(false);
  const [blocked, setBlocked] = useState<string[] | null>(null);
  const release = useMutation({
    mutationFn: () => shipmentsApi.release(id, s!.version),
    onSuccess: () => {
      toast.success('Embarque LIBERADO');
      setConfirmRelease(false);
      refresh();
    },
    onError: (e) => {
      setConfirmRelease(false);
      if (e instanceof ApiError && e.code === 'RELEASE_BLOCKED') setBlocked((e.details as { blocking_reasons: string[] }).blocking_reasons);
      else if (e instanceof ApiError && e.code === 'STALE_VERSION') toast.error('Versión desactualizada', 'El embarque cambió; se recargó, revisa y vuelve a intentar.');
      else toast.error('Liberación rechazada', e);
      refresh();
    },
  });
  const depart = useMutation({
    mutationFn: () => shipmentsApi.depart(id),
    onSuccess: (r) => {
      toast.success('Embarque salió', `${r.lpns} pallets · ${r.movements} movimientos SHIP`);
      setConfirmDepart(false);
      refresh();
    },
    onError: (e) => toast.error('No pudo salir', e),
  });
  const [addOrder, setAddOrder] = useState(false);
  const [orderSel, setOrderSel] = useState('');
  const eligible = useQuery({ queryKey: ['orders', 'eligible'], queryFn: () => ordersApi.list({ status: 'VERIFIED,STAGED,PICKED,ALLOCATED,PARTIALLY_ALLOCATED,PICKING', limit: 200 }), enabled: addOrder });
  const doAdd = useMutation({
    mutationFn: () => shipmentsApi.addOrder(id, orderSel),
    onSuccess: () => {
      toast.success('Pedido agregado');
      setAddOrder(false);
      refresh();
    },
    onError: (e) => toast.error('No se pudo agregar', e),
  });
  const remove = useMutation({
    mutationFn: (oid: string) => shipmentsApi.removeOrder(id, oid),
    onSuccess: () => {
      toast.success('Pedido retirado');
      refresh();
    },
    onError: (e) => toast.error('No se pudo retirar', e),
  });
  const [unload, setUnload] = useState<{ lpn: string; reason: string } | null>(null);
  const doUnload = useMutation({
    mutationFn: () => shipmentsApi.unload({ shipment_id: id, lpn_code: unload!.lpn, reason: unload!.reason }, api.newKey()),
    onSuccess: () => {
      toast.success('Pallet descargado');
      setUnload(null);
      refresh();
    },
    onError: (e) => toast.error('No se pudo descargar', e),
  });

  if (q.isLoading) return <Skeleton className="h-64" />;
  if (!s) return <Alert tone="error">Embarque no encontrado</Alert>;
  const rc = check.data ?? s.release;
  const canReleaseNow = rc.can_release && ['LOADING', 'LOADED', 'BLOCKED'].includes(s.status);

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {s.shipment_number} <StatusChip status={s.status} />
          </span>
        }
        subtitle={`${s.carrier?.name ?? 'Sin transportista'} · ${s.vehicle ?? ''} ${s.plates ?? ''} · ${s.driver_name ?? ''} · andén ${s.dock?.code ?? '—'} · v${s.version}`}
        actions={
          <>
            <Link to="/shipments" className="text-sm text-sky-700 underline">
              ← Embarques
            </Link>
            {can('shipments.manage') && ['OPEN', 'LOADING'].includes(s.status) && (
              <Button variant="secondary" onClick={() => setAddOrder(true)}>
                Agregar pedido
              </Button>
            )}
            {can('loading.execute') && ['OPEN', 'LOADING'].includes(s.status) && (
              <Link to="/wm/load" className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white">
                Cargar (RF)
              </Link>
            )}
            {can('shipments.release') && ['LOADING', 'LOADED', 'BLOCKED'].includes(s.status) && (
              <Button variant={canReleaseNow ? 'success' : 'secondary'} onClick={() => setConfirmRelease(true)} title={canReleaseNow ? '' : 'La validación del servidor decide; aquí se muestra el resultado actual'}>
                Liberar embarque
              </Button>
            )}
            {can('shipments.release') && s.status === 'RELEASED' && (
              <Button variant="primary" onClick={() => setConfirmDepart(true)}>
                Registrar salida
              </Button>
            )}
            <Link to={`/labels?type=SHIPMENT&id=${s.shipment_number}`} className="text-sm text-sky-700 underline">
              Etiqueta
            </Link>
          </>
        }
      />

      {blocked && (
        <Alert tone="error" title="EMBARQUE INCORRECTO — liberación bloqueada" className="mb-4">
          <ul className="list-disc pl-5 text-xs">
            {blocked.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </Alert>
      )}

      <Card
        title={
          <span className="flex items-center gap-2">
            Validación de liberación
            {rc.can_release ? <Badge tone="emerald">PUEDE LIBERARSE</Badge> : <Badge tone="rose">{rc.blocking_reasons.length} bloqueo(s)</Badge>}
            <span className="text-xs font-normal text-slate-500">
              requerido {fmtQty(rc.totals.required)} · cargado {fmtQty(rc.totals.loaded)} (los totales NO liberan; se valida por pedido y SKU)
            </span>
          </span>
        }
        padded={false}
      >
        <Table<ReleaseLine>
          rows={rc.lines}
          rowKey={(l) => `${l.order_number}/${l.sku_code}`}
          dense
          empty="El embarque no tiene líneas de pedido"
          columns={[
            { key: 'o', header: 'Pedido', render: (l) => <b>{l.order_number}</b> },
            { key: 's', header: 'SKU', render: (l) => <span className="font-mono">{l.sku_code}</span> },
            { key: 'r', header: 'REQUERIDO', render: (l) => <b>{fmtQty(l.required_qty)}</b>, align: 'right' },
            { key: 'p', header: 'SURTIDO', render: (l) => <Q v={l.picked_qty} req={l.required_qty} />, align: 'right' },
            { key: 'v', header: 'VERIFICADO', render: (l) => <Q v={l.verified_qty} req={l.required_qty} />, align: 'right' },
            { key: 'l', header: 'CARGADO', render: (l) => <Q v={l.loaded_qty} req={l.required_qty} />, align: 'right' },
            {
              key: 'ok',
              header: 'Resultado',
              render: (l) =>
                l.ok ? (
                  <Badge tone="emerald">OK</Badge>
                ) : (
                  <span className="flex flex-wrap gap-1">
                    {l.problems.map((p) => (
                      <Badge key={p} tone="rose">
                        {PROBLEM_ES[p] ?? p}
                      </Badge>
                    ))}
                  </span>
                ),
            },
          ]}
        />
        {rc.blocking_reasons.length > 0 && (
          <div className="border-t border-slate-100 p-3">
            <div className="mb-1 text-xs font-semibold uppercase text-rose-700">Razones de bloqueo</div>
            <ul className="list-disc pl-5 text-xs text-slate-700">
              {rc.blocking_reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title={`Pedidos (${s.orders.length})`} className="lg:col-span-2" padded={false}>
          <Table
            rows={s.orders}
            rowKey={(o) => o.id}
            columns={[
              { key: 'n', header: 'Pedido', render: (o) => <Link to={`/orders/${o.id}`} className="font-semibold text-sky-700 underline">{o.order_number}</Link> },
              { key: 'c', header: 'Cliente', render: (o) => o.customer.name },
              { key: 's', header: 'Estado', render: (o) => <StatusChip status={o.status} /> },
              { key: 'l', header: 'Líneas', render: (o) => o.lines.length, align: 'right' },
              { key: 'p', header: 'Pallets cargados', render: (o) => s.lpns.filter((l) => l.order_id === o.id && l.status === 'LOADED').length, align: 'right' },
              { key: 'a', header: '', render: (o) => can('shipments.manage') && ['OPEN', 'LOADING'].includes(s.status) && <Button size="sm" variant="ghost" onClick={() => remove.mutate(o.id)}>Retirar</Button> },
            ]}
          />
        </Card>
        <Card title={`Pallets (${s.lpns.length})`}>
          <ul className="max-h-72 space-y-1 overflow-y-auto text-sm">
            {s.lpns.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-2 rounded border border-slate-100 px-2 py-1">
                <Link to={`/inventory/lpn/${l.code}`} className="font-mono text-sky-700 underline">
                  {l.code}
                </Link>
                <span className="flex items-center gap-2">
                  <StatusChip status={l.status} />
                  {can('loading.execute') && l.status === 'LOADED' && ['LOADING', 'LOADED', 'BLOCKED'].includes(s.status) && (
                    <Button size="sm" variant="ghost" onClick={() => setUnload({ lpn: l.code, reason: '' })}>
                      Descargar
                    </Button>
                  )}
                </span>
              </li>
            ))}
            {s.lpns.length === 0 && <li className="text-slate-500">Aún no se ha cargado ningún pallet</li>}
          </ul>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <KV label="Inicio carga">{fmtDateTime(s.loading_started_at)}</KV>
            <KV label="Fin carga">{fmtDateTime(s.loading_finished_at)}</KV>
            <KV label="Liberado">{fmtDateTime(s.released_at)}</KV>
            <KV label="Salida">{fmtDateTime(s.departed_at)}</KV>
          </dl>
        </Card>
      </div>

      <ConfirmDialog open={confirmRelease} onClose={() => setConfirmRelease(false)} onConfirm={() => release.mutate()} title={`Liberar embarque ${s.shipment_number}`} loading={release.isPending} confirmLabel="Liberar" danger={!rc.can_release}>
        <p className="text-sm text-slate-700">Se enviará la versión {s.version}. El servidor re-evalúa la regla absoluta (cargado = requerido por pedido y SKU, verificación de segunda persona, sin incidencias críticas). {rc.can_release ? 'La validación actual pasa.' : 'La validación actual NO pasa: el servidor marcará el embarque como BLOQUEADO.'}</p>
      </ConfirmDialog>
      <ConfirmDialog open={confirmDepart} onClose={() => setConfirmDepart(false)} onConfirm={() => depart.mutate()} title="Registrar salida del camión" loading={depart.isPending} confirmLabel="Registrar salida" danger>
        <p className="text-sm text-slate-700">Los pallets cargados salen del inventario (movimientos SHIP). Esta acción no se puede deshacer.</p>
      </ConfirmDialog>
      <Modal open={addOrder} onClose={() => setAddOrder(false)} title="Agregar pedido al embarque" footer={<><Button variant="secondary" onClick={() => setAddOrder(false)}>Cancelar</Button><Button onClick={() => doAdd.mutate()} loading={doAdd.isPending} disabled={!orderSel}>Agregar</Button></>}>
        <Field label="Pedido">
          <Select value={orderSel} onChange={(e) => setOrderSel(e.target.value)}>
            <option value="">—</option>
            {eligible.data?.items.filter((o) => !o.shipment_id).map((o) => (
              <option key={o.id} value={o.id}>
                {o.order_number} · {o.customer.name} · {es(o.status)}
              </option>
            ))}
          </Select>
        </Field>
      </Modal>
      <Modal open={!!unload} onClose={() => setUnload(null)} title={`Descargar ${unload?.lpn ?? ''}`} footer={<><Button variant="secondary" onClick={() => setUnload(null)}>Cancelar</Button><Button variant="danger" onClick={() => doUnload.mutate()} loading={doUnload.isPending} disabled={(unload?.reason.trim().length ?? 0) < 3}>Descargar</Button></>}>
        <Field label="Motivo (mín. 3)" required>
          <Textarea value={unload?.reason ?? ''} onChange={(e) => unload && setUnload({ ...unload, reason: e.target.value })} />
        </Field>
      </Modal>
    </div>
  );
}

function Q({ v, req }: { v: string; req: string }) {
  const ok = BigInt(v) === BigInt(req);
  const over = BigInt(v) > BigInt(req);
  return <span className={cls('tabular-nums', ok ? 'font-bold text-emerald-700' : over ? 'font-bold text-rose-700' : BigInt(v) === 0n ? 'text-slate-400' : 'text-amber-700')}>{fmtQty(v)}</span>;
}
