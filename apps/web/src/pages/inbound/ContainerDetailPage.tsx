import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CONTAINER_TRANSITIONS, type ContainerStatus } from '@wms/shared';
import { inboundApi } from '../../api/inbound';
import { layoutApi } from '../../api/layout';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../components/Toast';
import { Alert, Button, Card, Field, Input, KV, Modal, PageHeader, Select, Skeleton, StatusChip, Table, Textarea } from '../../components/ui';
import { cls, es, fmtDateTime, fmtQty } from '../../lib/format';

const STEPS: { status: ContainerStatus; field: 'created_at' | 'arrived_at' | 'unload_started_at' | 'unload_finished_at' | 'opened_at' | 'closed_at' | null }[] = [
  { status: 'SCHEDULED', field: 'created_at' },
  { status: 'ARRIVED', field: 'arrived_at' },
  { status: 'UNLOADING', field: 'unload_started_at' },
  { status: 'UNLOADED', field: 'unload_finished_at' },
  { status: 'RECEIVING', field: null },
  { status: 'RECEIVED', field: null },
  { status: 'CLOSED', field: 'closed_at' },
];

export default function ContainerDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['container', id], queryFn: () => inboundApi.container(id) });
  const [transition, setTransition] = useState<ContainerStatus | null>(null);
  const [tf, setTf] = useState({ notes: '', seal_number: '', plates: '', driver_name: '' });
  const [newReceipt, setNewReceipt] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const c = q.data;

  const doTransition = useMutation({
    mutationFn: () => inboundApi.transition(id, { status: transition!, version: c!.version, notes: tf.notes || undefined, seal_number: tf.seal_number || undefined, plates: tf.plates || undefined, driver_name: tf.driver_name || undefined }),
    onSuccess: () => {
      toast.success(`Contenedor → ${es(transition!)}`);
      setTransition(null);
      void qc.invalidateQueries({ queryKey: ['container', id] });
      void qc.invalidateQueries({ queryKey: ['containers'] });
    },
    onError: (e) => toast.error('Transición rechazada', e),
  });
  const upload = useMutation({
    mutationFn: (file: File) => inboundApi.uploadPhoto(id, file),
    onSuccess: () => {
      toast.success('Foto adjuntada');
      void qc.invalidateQueries({ queryKey: ['container', id] });
    },
    onError: (e) => toast.error('No se pudo subir la foto', e),
  });

  if (q.isLoading) return <Skeleton className="h-64" />;
  if (!c) return <Alert tone="error">Contenedor no encontrado</Alert>;
  const allowed = CONTAINER_TRANSITIONS[c.status] ?? [];
  const currentIdx = STEPS.findIndex((s) => s.status === c.status);

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <span className="font-mono">{c.container_number}</span> <StatusChip status={c.status} />
          </span>
        }
        subtitle={`${c.supplier?.name ?? 'Sin proveedor'} · OC ${c.po?.po_number ?? '—'} · versión ${c.version}`}
        actions={
          <>
            <Link to="/inbound/containers" className="text-sm text-sky-700 underline">
              ← Contenedores
            </Link>
            {can('containers.manage') &&
              allowed.map((s) => (
                <Button key={s} variant={s === 'WITH_INCIDENT' ? 'danger' : s === 'CLOSED' ? 'secondary' : 'primary'} onClick={() => setTransition(s)}>
                  → {es(s)}
                </Button>
              ))}
            {can('receiving.scan') && ['ARRIVED', 'UNLOADING', 'UNLOADED', 'RECEIVING'].includes(c.status) && (
              <Button variant="success" onClick={() => setNewReceipt(true)}>
                Nueva recepción
              </Button>
            )}
          </>
        }
      />

      {/* status timeline */}
      <Card title="Línea de estado" className="mb-4">
        <ol className="flex flex-wrap gap-2">
          {STEPS.map((s, i) => {
            const done = c.status === 'WITH_INCIDENT' ? false : i <= currentIdx;
            const ts = s.field ? c[s.field] : null;
            return (
              <li key={s.status} className={cls('flex-1 min-w-32 rounded-lg border px-3 py-2 text-xs', done ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-slate-50 text-slate-500')}>
                <div className="font-semibold">{es(s.status)}</div>
                <div>{ts ? fmtDateTime(ts) : '—'}</div>
              </li>
            );
          })}
          {c.status === 'WITH_INCIDENT' && <li className="flex-1 min-w-32 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800">Con incidencia</li>}
        </ol>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Datos">
          <dl className="grid grid-cols-2 gap-3">
            <KV label="Transportista">{c.carrier?.name ?? '—'}</KV>
            <KV label="BL">{c.bl_number ?? '—'}</KV>
            <KV label="Sello">{c.seal_number ?? '—'}</KV>
            <KV label="Placas">{c.plates ?? '—'}</KV>
            <KV label="Chofer">{c.driver_name ?? '—'}</KV>
            <KV label="Cita">{fmtDateTime(c.scheduled_at)}</KV>
            <KV label="Notas">{c.notes ?? '—'}</KV>
            <KV label="Pallets (LPN)">{c.lpns?.length ?? 0}</KV>
          </dl>
        </Card>
        <Card
          title={`Fotos (${c.photos?.length ?? 0})`}
          actions={
            can('containers.manage') && (
              <>
                <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="hidden" onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
                <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()} loading={upload.isPending}>
                  Subir foto
                </Button>
              </>
            )
          }
        >
          {c.photos?.length ? (
            <ul className="space-y-1 text-sm">
              {c.photos.map((p) => (
                <li key={p.id} className="flex justify-between gap-2 rounded border border-slate-100 px-2 py-1">
                  <span className="truncate">{p.file_name}</span>
                  <span className="whitespace-nowrap text-xs text-slate-500">
                    {Math.round(p.size_bytes / 1024)} KB · {fmtDateTime(p.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">Sin fotos. Sube evidencia del sello, la carga y daños.</p>
          )}
        </Card>
        <Card title={`Incidencias (${c.incidents?.length ?? 0})`}>
          {c.incidents?.length ? (
            <ul className="space-y-1 text-sm">
              {c.incidents.map((i) => (
                <li key={i.id}>
                  <Link to={`/incidents/${i.id}`} className="flex items-center justify-between gap-2 rounded border border-slate-100 px-2 py-1 hover:bg-slate-50">
                    <span className="truncate">
                      <b>{i.incident_number}</b> {i.title}
                    </span>
                    <StatusChip status={i.severity} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">Sin incidencias.</p>
          )}
        </Card>
      </div>

      {c.po?.lines && (
        <Card title={`Orden de compra ${c.po.po_number}`} className="mt-4" padded={false}>
          <Table
            rows={c.po.lines}
            rowKey={(l) => l.id}
            dense
            columns={[
              { key: 'sku', header: 'SKU', render: (l) => <span className="font-mono">{l.sku?.code}</span> },
              { key: 'd', header: 'Descripción', render: (l) => l.sku?.description },
              { key: 'o', header: 'Ordenado', render: (l) => `${fmtQty(l.uom_qty)} ${l.uom_code} (${fmtQty(l.ordered_qty)} pzas)`, align: 'right' },
              { key: 'r', header: 'Recibido (pzas)', render: (l) => fmtQty(l.received_qty), align: 'right' },
            ]}
          />
        </Card>
      )}

      <Card title={`Recepciones (${c.receipts?.length ?? 0})`} className="mt-4" padded={false}>
        <Table
          rows={c.receipts}
          rowKey={(r) => r.id}
          onRowClick={(r) => nav(`/inbound/receipts/${r.id}`)}
          empty="Sin recepciones. Crea una para empezar a escanear."
          columns={[
            { key: 'n', header: 'Recepción', render: (r) => <span className="font-mono">{r.receipt_number}</span> },
            { key: 's', header: 'Estado', render: (r) => <StatusChip status={r.status} /> },
            { key: 'l', header: 'Líneas', render: (r) => r.lines?.length ?? '—', align: 'right' },
            { key: 'c', header: 'Inicio', render: (r) => fmtDateTime(r.started_at) },
            { key: 'f', header: 'Completada', render: (r) => fmtDateTime(r.completed_at) },
          ]}
        />
      </Card>

      <Modal
        open={!!transition}
        onClose={() => setTransition(null)}
        title={`Cambiar estado a ${es(transition ?? '')}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setTransition(null)}>
              Cancelar
            </Button>
            <Button onClick={() => doTransition.mutate()} loading={doTransition.isPending} variant={transition === 'WITH_INCIDENT' ? 'danger' : 'primary'}>
              Confirmar
            </Button>
          </>
        }
      >
        <div className="grid gap-3">
          {transition === 'ARRIVED' && (
            <>
              <Field label="Sello (verificado físicamente)">
                <Input value={tf.seal_number} onChange={(e) => setTf({ ...tf, seal_number: e.target.value })} placeholder={c.seal_number ?? ''} />
              </Field>
              <Field label="Placas">
                <Input value={tf.plates} onChange={(e) => setTf({ ...tf, plates: e.target.value })} placeholder={c.plates ?? ''} />
              </Field>
              <Field label="Chofer">
                <Input value={tf.driver_name} onChange={(e) => setTf({ ...tf, driver_name: e.target.value })} placeholder={c.driver_name ?? ''} />
              </Field>
            </>
          )}
          <Field label="Notas" required={transition === 'WITH_INCIDENT'}>
            <Textarea value={tf.notes} onChange={(e) => setTf({ ...tf, notes: e.target.value })} />
          </Field>
          <p className="text-xs text-slate-500">La transición envía la versión {c.version}; si otro usuario modificó el contenedor se rechazará (409) y deberás recargar.</p>
        </div>
      </Modal>
      <NewReceiptModal open={newReceipt} onClose={() => setNewReceipt(false)} containerId={c.id} defaultDock={c.dock_location_id} />
    </div>
  );
}

export function NewReceiptModal({ open, onClose, containerId, defaultDock }: { open: boolean; onClose: () => void; containerId?: string; defaultDock?: string | null }) {
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const docks = useQuery({ queryKey: ['locations', 'RECEIVING'], queryFn: () => layoutApi.locations({ type: 'RECEIVING', limit: 100 }), enabled: open });
  const [dock, setDock] = useState(defaultDock ?? '');
  const [notes, setNotes] = useState('');
  const [expected, setExpected] = useState('');
  const m = useMutation({
    mutationFn: () => {
      const lines = expected
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [sku, qty, uom] = l.split(/[,;\s]+/);
          return { sku_code: sku, qty, uom_code: uom ?? 'CASE' };
        });
      return inboundApi.createReceipt({ container_id: containerId, receiving_location_id: dock || docks.data?.items[0]?.id, notes: notes || undefined, expected: lines.length ? lines : undefined });
    },
    onSuccess: (r) => {
      toast.success(`Recepción ${r.receipt_number} creada`);
      void qc.invalidateQueries({ queryKey: ['container'] });
      void qc.invalidateQueries({ queryKey: ['receipts'] });
      onClose();
      nav(`/inbound/receipts/${r.id}`);
    },
    onError: (e) => toast.error('No se pudo crear la recepción', e),
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Nueva recepción"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => m.mutate()} loading={m.isPending}>
            Crear
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Ubicación de recepción (andén)" required>
          <Select value={dock} onChange={(e) => setDock(e.target.value)}>
            {docks.data?.items.map((d) => (
              <option key={d.id} value={d.id}>
                {d.code}
              </option>
            ))}
          </Select>
        </Field>
        {!containerId && (
          <Field label="Líneas esperadas (opcional)" hint="Una por renglón: SKU, cantidad, UoM (CASE por defecto). Ej. SKU-0001, 40, CASE">
            <Textarea value={expected} onChange={(e) => setExpected(e.target.value)} className="font-mono" />
          </Field>
        )}
        {containerId && <p className="text-xs text-slate-500">Las líneas esperadas se toman de la orden de compra del contenedor (cantidades pendientes).</p>}
        <Field label="Notas">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
