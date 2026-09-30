import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { inboundApi } from '../../api/inbound';
import { putawayApi } from '../../api/storage';
import type { PutawayOption, ReceiptPutawayPallet } from '../../api/types';
import { incidentsApi } from '../../api/incidents';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../components/Toast';
import { Alert, Button, Card, ConfirmDialog, Field, Input, KV, Modal, PageHeader, Skeleton, StatusChip, Table } from '../../components/ui';
import { cls, es, fmtDateTime, fmtQty, toBigInt } from '../../lib/format';

export default function ReceiptDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['receipt', id], queryFn: () => inboundApi.receipt(id), refetchInterval: 10_000 });
  const incidents = useQuery({ queryKey: ['incidents', 'receipt', id], queryFn: () => incidentsApi.list({ entity_type: 'receipt', entity_id: id, limit: 50 }) });
  const [confirmComplete, setConfirmComplete] = useState(false);
  const [differences, setDifferences] = useState<{ sku: string; expected: string; received: string }[] | null>(null);
  const r = q.data;

  const complete = useMutation({
    mutationFn: (accept: boolean) => inboundApi.complete({ receipt_id: id, accept_differences: accept }),
    onSuccess: (res) => {
      toast.success(`Recepción ${es(res.receipt.status)}`, res.incidents.length ? `${res.incidents.length} incidencia(s) creadas` : `${res.putaway_tasks.length} tareas de put-away`);
      setConfirmComplete(false);
      setDifferences(null);
      void qc.invalidateQueries({ queryKey: ['receipt', id] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'RECEIPT_DIFFERENCES') {
        setDifferences((e.details as { differences: { sku: string; expected: string; received: string }[] }).differences);
        return;
      }
      toast.error('No se pudo completar', e);
    },
  });
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const cancel = useMutation({
    mutationFn: () => inboundApi.cancel(id, cancelReason.trim()),
    onSuccess: (r) => {
      toast.success('Recepción cancelada', r.reverted?.length ? `${r.reverted.length} tarima(s) revertidas: ${r.reverted.map((x) => `${x.lpn} ${fmtQty(x.qty)} ${x.sku}`).join(', ')}` : 'No se recibió nada; el folio queda como cancelado.');
      setCancelOpen(false);
      void qc.invalidateQueries({ queryKey: ['receipt', id] });
      void qc.invalidateQueries({ queryKey: ['receipts'] });
    },
    onError: (e) => toast.error('No se pudo cancelar', e),
  });
  const close = useMutation({
    mutationFn: () => inboundApi.close(id),
    onSuccess: () => {
      toast.success('Recepción cerrada');
      void qc.invalidateQueries({ queryKey: ['receipt', id] });
    },
    onError: (e) => toast.error('No se pudo cerrar', e),
  });

  if (q.isLoading) return <Skeleton className="h-64" />;
  if (!r) return <Alert tone="error">Recepción no encontrada</Alert>;
  const lines = r.lines ?? [];
  const open = r.status === 'OPEN' || r.status === 'IN_PROGRESS';

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <span className="font-mono">{r.receipt_number}</span> <StatusChip status={r.status} />
          </span>
        }
        subtitle={
          <>
            {r.container && 'container_number' in r.container && (
              <>
                Contenedor{' '}
                <Link className="text-sky-700 underline" to={`/inbound/containers/${r.container_id}`}>
                  {r.container.container_number}
                </Link>{' '}
                ·{' '}
              </>
            )}
            Inicio {fmtDateTime(r.started_at)}
          </>
        }
        actions={
          <>
            <Link to="/inbound/receipts" className="text-sm text-sky-700 underline">
              ← Recepciones
            </Link>
            {open && can('receiving.scan') && (
              <>
                <Button variant="success" onClick={() => nav(`/wm/receive?receipt=${r.id}`)}>
                  Escanear (RF)
                </Button>
                <Button onClick={() => setConfirmComplete(true)}>Completar recepción</Button>
              </>
            )}
            {r.status !== 'CANCELLED' && ((open && can('receiving.close') && (r.lpns?.length ?? 0) === 0) || can('receiving.cancel_received')) && (
              <Button variant="danger" onClick={() => setCancelOpen(true)}>
                Cancelar recepción
              </Button>
            )}
            {(r.status === 'COMPLETED' || r.status === 'WITH_INCIDENT') && can('receiving.close') && (
              <Button variant="secondary" onClick={() => close.mutate()} loading={close.isPending}>
                Cerrar recepción
              </Button>
            )}
          </>
        }
      />
      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancelar recepción" footer={<Button variant="danger" onClick={() => cancel.mutate()} disabled={cancelReason.trim().length < 3} loading={cancel.isPending}>Cancelar recepción</Button>}>
        {(r.lpns?.length ?? 0) === 0 ? (
          <p className="text-sm text-slate-600">La recepción no tiene pallets recibidos. El folio no se reutiliza y la cancelación queda en auditoría con el motivo.</p>
        ) : (
          <Alert tone="warn">
            Esta recepción tiene {r.lpns?.length} tarima(s) recibidas. Al cancelarla, todo su inventario se revierte (sale del sistema como recepción deshecha), las tarimas quedan canceladas y se cancelan sus acomodos pendientes. Solo se permite si ninguna tarima está asignada a un pedido, surtida o en traslado. Queda auditado y se abre una incidencia.
            <div className="mt-1 font-mono text-xs">{r.lpns?.map((l) => l.code).join(' · ')}</div>
          </Alert>
        )}
        <Field label="Motivo" required>
          <Input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="abierta por error" />
        </Field>
      </Modal>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Esperado vs recibido" className="lg:col-span-2" padded={false}>
          <Table
            rows={lines}
            rowKey={(l) => l.id}
            empty="Sin líneas esperadas (recepción ciega)"
            columns={[
              { key: 'sku', header: 'SKU', render: (l) => <span className="font-mono font-semibold">{l.sku.code}</span> },
              { key: 'd', header: 'Descripción', render: (l) => l.sku.description },
              { key: 'e', header: 'Esperado', render: (l) => fmtQty(l.expected_qty), align: 'right' },
              {
                key: 'r',
                header: 'Recibido',
                render: (l) => {
                  const e = toBigInt(l.expected_qty);
                  const rc = toBigInt(l.received_qty);
                  return <span className={cls('font-bold tabular-nums', e === 0n ? 'text-amber-700' : rc === e ? 'text-emerald-700' : rc < e ? 'text-rose-700' : 'text-amber-700')}>{fmtQty(rc)}</span>;
                },
                align: 'right',
              },
              { key: 'dm', header: 'Dañado', render: (l) => (toBigInt(l.damaged_qty) > 0n ? <span className="text-rose-700">{fmtQty(l.damaged_qty)}</span> : '—'), align: 'right' },
              { key: 'dif', header: 'Diferencia', render: (l) => {
                  const d = toBigInt(l.received_qty) - toBigInt(l.expected_qty);
                  return <span className={cls('tabular-nums', d === 0n ? 'text-slate-400' : d < 0n ? 'text-rose-700' : 'text-amber-700')}>{d > 0n ? '+' : ''}{fmtQty(d)}</span>;
                }, align: 'right' },
              { key: 's', header: 'Estado', render: (l) => <StatusChip status={l.status} /> },
            ]}
          />
        </Card>
        <Card title="Resumen">
          <dl className="grid gap-3">
            <KV label="Estado">
              <StatusChip status={r.status} />
            </KV>
            <KV label="LPNs creados">{r.lpns?.length ?? 0}</KV>
            <KV label="Total esperado">{fmtQty(lines.reduce((a, l) => a + toBigInt(l.expected_qty), 0n))}</KV>
            <KV label="Total recibido">{fmtQty(lines.reduce((a, l) => a + toBigInt(l.received_qty), 0n))}</KV>
            <KV label="Completada">{fmtDateTime(r.completed_at)}</KV>
            <KV label="Cerrada">{fmtDateTime(r.closed_at)}</KV>
            <KV label="Notas">{r.notes ?? '—'}</KV>
          </dl>
        </Card>
      </div>

      <Card title={`Pallets creados (${r.lpns?.length ?? 0})`} className="mt-4" padded={false}>
        <Table
          rows={r.lpns ?? []}
          rowKey={(l) => l.id}
          onRowClick={(l) => nav(`/inventory/lpn/${l.code}`)}
          empty="Aún no se han escaneado pallets"
          columns={[
            { key: 'c', header: 'LPN', render: (l) => <span className="font-mono font-semibold">{l.code}</span> },
            { key: 's', header: 'Estado', render: (l) => <StatusChip status={l.status} /> },
            { key: 't', header: 'Tipo', render: (l) => l.lpn_type },
            { key: 'b', header: 'Contenido', render: (l) => (l.balances ?? []).filter((b) => toBigInt(b.qty) > 0n).map((b) => `${b.sku.code} × ${fmtQty(b.qty)} (${es(b.status)})`).join(', ') || '—' },
            { key: 'cs', header: 'Cajas', render: (l) => l.cases_count, align: 'right' },
            { key: 'cr', header: 'Creado', render: (l) => fmtDateTime(l.created_at) },
          ]}
        />
      </Card>

      {(r.lpns?.length ?? 0) > 0 && can('putaway.execute') && <PutawayPlanCard receiptId={r.id} />}

      <Card title={`Incidencias (${incidents.data?.total ?? 0})`} className="mt-4" padded={false}>
        <Table
          rows={incidents.data?.items}
          rowKey={(i) => i.id}
          onRowClick={(i) => nav(`/incidents/${i.id}`)}
          empty="Sin incidencias"
          columns={[
            { key: 'n', header: '#', render: (i) => i.incident_number },
            { key: 't', header: 'Tipo', render: (i) => es(i.incident_type) },
            { key: 'sv', header: 'Severidad', render: (i) => <StatusChip status={i.severity} /> },
            { key: 'ti', header: 'Título', render: (i) => i.title },
            { key: 's', header: 'Estado', render: (i) => <StatusChip status={i.status} /> },
          ]}
        />
      </Card>

      <ConfirmDialog
        open={confirmComplete}
        onClose={() => {
          setConfirmComplete(false);
          setDifferences(null);
        }}
        onConfirm={() => complete.mutate(!!differences)}
        title="Completar recepción"
        loading={complete.isPending}
        confirmLabel={differences ? 'Aceptar diferencias y completar' : 'Completar'}
        danger={!!differences}
      >
        {!differences && <p className="text-sm text-slate-700">Se compararán las cantidades esperadas contra las recibidas. Los LPN abiertos se cerrarán y se generarán tareas de put-away.</p>}
        {differences && (
          <div>
            <Alert tone="warn" title="Hay diferencias entre lo esperado y lo recibido">
              Se crearán incidencias de faltante/sobrante por cada SKU:
            </Alert>
            <ul className="mt-2 max-h-48 overflow-auto text-sm">
              {differences.map((d) => (
                <li key={d.sku} className="flex justify-between border-b border-slate-100 py-1">
                  <span className="font-mono">{d.sku}</span>
                  <span>
                    esperado {fmtQty(d.expected)} · recibido <b>{fmtQty(d.received)}</b>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}

/** Where each pallet of the receipt goes: the whole receipt on one table, destinations chosen here, confirmed by scanning in the handheld. */
function PutawayPlanCard({ receiptId }: { receiptId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const plan = useQuery({ queryKey: ['receipt-putaway', receiptId], queryFn: () => inboundApi.putawayPlan(receiptId), refetchInterval: 20_000 });
  const [edit, setEdit] = useState<{ pallet: ReceiptPutawayPallet; list: PutawayOption[]; selected: string; filter: string } | null>(null);
  const open = useMutation({
    mutationFn: async (p: ReceiptPutawayPallet) => ({ p, r: await putawayApi.options(p.task_id!) }),
    onSuccess: ({ p, r }) => (r.options.length ? setEdit({ pallet: p, list: r.options, selected: r.current ?? r.options[0]!.code, filter: '' }) : toast.error('Sin ubicación libre', `Ninguna ubicación acepta ${p.lpn_code}`)),
    onError: (e) => toast.error('No se pudieron cargar las ubicaciones', e),
  });
  const save = useMutation({
    mutationFn: (body: { location_code?: string; other?: boolean }) => putawayApi.choose(edit!.pallet.task_id!, body),
    onSuccess: (r) => { toast.success(`${edit!.pallet.lpn_code} → ${r.target.code}`); setEdit(null); void qc.invalidateQueries({ queryKey: ['receipt-putaway', receiptId] }); },
    onError: (e) => toast.error('No se pudo asignar', e),
  });
  const [confirmClose, setConfirmClose] = useState(false);
  const closePlan = useMutation({
    mutationFn: () => inboundApi.closePutawayPlan(receiptId),
    onSuccess: (r) => {
      setConfirmClose(false);
      if (r.failed.length) toast.error(`${r.placed.length} tarima(s) ubicadas, ${r.failed.length} no`, r.failed.map((f) => `${f.lpn} → ${f.target}: ${f.error}`).join(' · '));
      else toast.success(`Acomodo cerrado: ${r.placed.length} tarima(s) ubicadas en su destino`);
      void qc.invalidateQueries({ queryKey: ['receipt-putaway', receiptId] });
      void qc.invalidateQueries({ queryKey: ['receipt', receiptId] });
    },
    onError: (e) => toast.error('No se pudo cerrar el acomodo', e),
  });
  const printLabels = useMutation({
    mutationFn: () => inboundApi.printPutawayLabels(receiptId),
    onSuccess: (r) => (r.failed.length ? toast.error(`${r.printed.length} etiqueta(s) enviadas`, `Sin imprimir: ${r.failed.map((f) => `${f.lpn} (${f.error})`).join(', ')}`) : toast.success(`${r.printed.length} etiqueta(s) enviadas a imprimir`)),
    onError: (e) => toast.error('No se pudieron imprimir', e),
  });
  const pallets = plan.data?.pallets ?? [];
  const pending = pallets.filter((p) => p.pending).length;
  const noTarget = pallets.filter((p) => p.pending && !p.target).length;
  const q = edit?.filter.trim().toUpperCase() ?? '';
  const shown = edit ? (q ? edit.list.filter((o) => o.code.toUpperCase().includes(q) || o.code === edit.selected) : edit.list) : [];
  return (
    <Card title={`Acomodo: dónde va cada tarima (${pending} por ubicar de ${pallets.length})`} className="mt-4" padded={false} actions={pending > 0 ? <div className="flex gap-2"><Button variant="secondary" onClick={() => printLabels.mutate()} loading={printLabels.isPending}>Imprimir etiquetas ({pending})</Button><Button onClick={() => setConfirmClose(true)} disabled={noTarget > 0} title={noTarget > 0 ? `${noTarget} tarima(s) sin destino` : undefined}>Cerrar acomodo</Button></div> : undefined}>
      <div className="px-4 pt-3 text-xs text-slate-500">Elija aquí el destino de cada tarima. Los destinos <b>sugeridos</b> por el sistema no apartan el hueco: puede dárselo a otra tarima y la sugerida recibe otra propuesta. Un destino <b>elegido</b> sí queda apartado. Luego, o el montacarguista confirma cada tarima en el handheld (Ubicar) escaneando, o <b>Cerrar acomodo</b> las ubica todas en el sistema sin escanear.</div>
      <Table
        rows={pallets}
        rowKey={(p) => p.lpn_id}
        empty="Sin tarimas"
        columns={[
          { key: 'l', header: 'LPN', render: (p) => <span className="font-mono font-semibold">{p.lpn_code}</span> },
          { key: 'c', header: 'Contenido', render: (p) => p.contents.map((c) => `${c.sku} × ${fmtQty(c.qty)}`).join(', ') || '—' },
          { key: 'w', header: 'Está en', render: (p) => <span className="font-mono">{p.current_location ?? '—'}</span> },
          { key: 'd', header: 'Destino', render: (p) => (p.pending ? <span className={cls('font-mono font-semibold', p.planned ? 'text-emerald-700' : 'text-violet-700')}>{p.target ?? 'sin destino'}{p.planned ? ' · elegido' : ' · sugerido'}</span> : <span className="text-emerald-700">ubicada</span>) },
          { key: 'a', header: '', render: (p) => (p.pending ? <Button variant="secondary" onClick={() => open.mutate(p)} loading={open.isPending && open.variables?.lpn_id === p.lpn_id}>Elegir destino</Button> : null) },
        ]}
      />
      <ConfirmDialog open={confirmClose} onClose={() => setConfirmClose(false)} onConfirm={() => closePlan.mutate()} title="Cerrar el acomodo de esta recepción" loading={closePlan.isPending} confirmLabel="Cerrar e imprimir">
        Las {pending} tarima(s) pendientes quedan <b>ubicadas en su destino en el sistema</b>, igual que si se escaneara cada una en Ubicar. Hágalo cuando físicamente ya estén (o vayan) ahí. Las etiquetas no se imprimen solas: use <b>Imprimir etiquetas</b> antes si las necesita.
      </ConfirmDialog>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit ? `Destino de ${edit.pallet.lpn_code}` : ''} footer={<><Button variant="secondary" onClick={() => save.mutate({ other: true })} loading={save.isPending}>Otra automática</Button><Button variant="secondary" onClick={() => setEdit(null)}>Cancelar</Button><Button onClick={() => save.mutate({ location_code: edit!.selected })} loading={save.isPending}>Asignar</Button></>}>
        {edit && (
          <div className="grid gap-3">
            <div className="text-sm text-slate-600">{edit.pallet.contents.map((c) => `${c.sku} × ${fmtQty(c.qty)}`).join(' · ')} · destino actual <span className="font-mono">{edit.pallet.target ?? '—'}</span></div>
            <Input value={edit.filter} onChange={(e) => setEdit({ ...edit, filter: e.target.value })} placeholder={`Buscar entre ${edit.list.length} ubicaciones (ej. R03-N02 o PISO-B)`} className="font-mono" />
            <select value={edit.selected} onChange={(e) => setEdit({ ...edit, selected: e.target.value })} size={Math.min(12, Math.max(3, shown.length))} className="w-full rounded-md border border-slate-300 p-1 font-mono text-sm">
              {shown.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.code}{o.has_same_sku ? ' · ya tiene este producto' : ''}{o.pallet_capacity > 0 ? ` · ${o.lpn_count}/${o.pallet_capacity}` : ''}{o.is_current ? ' (actual)' : ''}
                </option>
              ))}
            </select>
            <div className="text-xs text-slate-500">{shown.length} de {edit.list.length} ubicaciones · primero las que ya tienen el producto</div>
          </div>
        )}
      </Modal>
    </Card>
  );
}
