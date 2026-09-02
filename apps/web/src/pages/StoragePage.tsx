// /storage — office view of put-away tasks, transfers, replenishment (rules + tasks) and cycle counts (create / approve).
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { COUNT_TYPES } from '@wms/shared';
import { adminApi } from '../api/admin';
import { layoutApi } from '../api/layout';
import { countsApi, putawayApi, replenApi, transfersApi } from '../api/storage';
import type { CountTask } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../components/Toast';
import { Alert, Button, Card, Checkbox, Drawer, Field, Input, Modal, PageHeader, Select, StatusChip, Table, Tabs, Textarea } from '../components/ui';
import { useQueryParam } from '../lib/hooks';
import { es, fmtDateTime, fmtQty } from '../lib/format';

type Tab = 'putaway' | 'transfers' | 'replen' | 'counts';

export default function StoragePage() {
  const [tab, setTab] = useQueryParam('tab', 'putaway');
  return (
    <div>
      <PageHeader title="Almacenaje" subtitle="Put-away dirigido, traslados, reabasto y conteos cíclicos. La ejecución se hace en modo almacén; aquí se supervisa." />
      <Tabs<Tab>
        value={tab as Tab}
        onChange={setTab}
        tabs={[
          { key: 'putaway', label: 'Put-away' },
          { key: 'transfers', label: 'Traslados' },
          { key: 'replen', label: 'Reabasto' },
          { key: 'counts', label: 'Conteos cíclicos' },
        ]}
      />
      {tab === 'putaway' && <Putaway />}
      {tab === 'transfers' && <Transfers />}
      {tab === 'replen' && <Replen />}
      {tab === 'counts' && <Counts />}
    </div>
  );
}

function Putaway() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState('PENDING,ASSIGNED,IN_PROGRESS');
  const q = useQuery({ queryKey: ['putaway-tasks', status], queryFn: () => putawayApi.tasks(status), refetchInterval: 10_000 });
  const [cancel, setCancel] = useState<{ id: string; reason: string } | null>(null);
  const m = useMutation({
    mutationFn: () => putawayApi.cancel(cancel!.id, cancel!.reason),
    onSuccess: () => {
      toast.success('Tarea cancelada');
      setCancel(null);
      void qc.invalidateQueries({ queryKey: ['putaway-tasks'] });
    },
    onError: (e) => toast.error('No se pudo cancelar', e),
  });
  const re = useMutation({
    mutationFn: (id: string) => putawayApi.resuggest(id),
    onSuccess: () => {
      toast.success('Destino recalculado');
      void qc.invalidateQueries({ queryKey: ['putaway-tasks'] });
    },
    onError: (e) => toast.error('Error', e),
  });
  return (
    <div>
      <div className="mb-3 flex gap-2">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-56">
          <option value="PENDING,ASSIGNED,IN_PROGRESS">Activas</option>
          <option value="COMPLETED">Completadas</option>
          <option value="CANCELLED">Canceladas</option>
        </Select>
      </div>
      <Table
        rows={q.data}
        loading={q.isLoading}
        rowKey={(t) => t.id}
        columns={[
          { key: 'l', header: 'LPN', render: (t) => <span className="font-mono font-semibold">{t.lpn_code}</span> },
          { key: 's', header: 'Estado', render: (t) => <StatusChip status={t.status} /> },
          { key: 'c', header: 'Contenido', render: (t) => (t.contents ?? []).map((c) => `${c.sku} × ${fmtQty(c.qty)}`).join(', ') },
          { key: 'f', header: 'Desde', render: (t) => <span className="font-mono">{t.current_location ?? '—'}</span> },
          { key: 'to', header: 'Destino sugerido', render: (t) => <span className="font-mono font-semibold text-sky-700">{t.suggested_location ?? 'SIN DESTINO'}</span> },
          { key: 'u', header: 'Operador', render: (t) => t.assigned_username ?? '—' },
          { key: 'cr', header: 'Creada', render: (t) => fmtDateTime(t.created_at) },
          {
            key: 'a',
            header: '',
            render: (t) =>
              ['PENDING', 'ASSIGNED', 'IN_PROGRESS'].includes(t.status) && (
                <div className="flex gap-1">
                  <Button size="sm" variant="secondary" onClick={() => re.mutate(t.id)}>
                    Re-sugerir
                  </Button>
                  {can('putaway.override') && (
                    <Button size="sm" variant="danger" onClick={() => setCancel({ id: t.id, reason: '' })}>
                      Cancelar
                    </Button>
                  )}
                </div>
              ),
          },
        ]}
      />
      <Modal
        open={!!cancel}
        onClose={() => setCancel(null)}
        title="Cancelar tarea de put-away"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCancel(null)}>
              Cerrar
            </Button>
            <Button variant="danger" onClick={() => m.mutate()} loading={m.isPending} disabled={(cancel?.reason.trim().length ?? 0) < 3}>
              Cancelar tarea
            </Button>
          </>
        }
      >
        <Field label="Motivo" required>
          <Textarea value={cancel?.reason ?? ''} onChange={(e) => cancel && setCancel({ ...cancel, reason: e.target.value })} />
        </Field>
      </Modal>
    </div>
  );
}

function Transfers() {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState('IN_TRANSIT');
  const q = useQuery({ queryKey: ['transfers', status], queryFn: () => transfersApi.list(status), refetchInterval: 10_000 });
  const [cancel, setCancel] = useState<{ id: string; reason: string } | null>(null);
  const m = useMutation({
    mutationFn: () => transfersApi.cancel(cancel!.id, cancel!.reason),
    onSuccess: () => {
      toast.success('Traslado cancelado');
      setCancel(null);
      void qc.invalidateQueries({ queryKey: ['transfers'] });
    },
    onError: (e) => toast.error('No se pudo cancelar', e),
  });
  return (
    <div>
      <div className="mb-3 flex gap-2">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-56">
          <option value="IN_TRANSIT">En tránsito</option>
          <option value="COMPLETED">Completados</option>
          <option value="CANCELLED">Cancelados</option>
        </Select>
      </div>
      <Table
        rows={q.data}
        loading={q.isLoading}
        rowKey={(t) => t.id}
        columns={[
          { key: 'l', header: 'LPN', render: (t) => <span className="font-mono font-semibold">{t.lpn_code}</span> },
          { key: 't', header: 'Tipo', render: (t) => t.transfer_type },
          { key: 's', header: 'Estado', render: (t) => <StatusChip status={t.status} /> },
          { key: 'f', header: 'Origen', render: (t) => <span className="font-mono">{t.from_code}</span> },
          { key: 'to', header: 'Destino', render: (t) => <span className="font-mono">{t.to_code}</span> },
          { key: 'u', header: 'Inició', render: (t) => `${t.started_by_username ?? ''} · ${fmtDateTime(t.started_at)}` },
          { key: 'r', header: 'Motivo', render: (t) => t.reason ?? '' },
          { key: 'a', header: '', render: (t) => t.status === 'IN_TRANSIT' && <Button size="sm" variant="danger" onClick={() => setCancel({ id: t.id, reason: '' })}>Cancelar</Button> },
        ]}
      />
      <Modal open={!!cancel} onClose={() => setCancel(null)} title="Cancelar traslado" footer={<><Button variant="secondary" onClick={() => setCancel(null)}>Cerrar</Button><Button variant="danger" onClick={() => m.mutate()} loading={m.isPending} disabled={(cancel?.reason.trim().length ?? 0) < 3}>Cancelar traslado</Button></>}>
        <Field label="Motivo" required>
          <Textarea value={cancel?.reason ?? ''} onChange={(e) => cancel && setCancel({ ...cancel, reason: e.target.value })} />
        </Field>
      </Modal>
    </div>
  );
}

function Replen() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const rules = useQuery({ queryKey: ['replen-rules'], queryFn: replenApi.rules });
  const tasks = useQuery({ queryKey: ['replen-tasks', 'all'], queryFn: () => replenApi.tasks('PENDING,IN_PROGRESS,COMPLETED'), refetchInterval: 15_000 });
  const [f, setF] = useState({ sku_code: '', pick_location_barcode: '', min_qty: '', max_qty: '' });
  const upsert = useMutation({
    mutationFn: () => replenApi.upsertRule(f),
    onSuccess: () => {
      toast.success('Regla guardada');
      void qc.invalidateQueries({ queryKey: ['replen-rules'] });
    },
    onError: (e) => toast.error('No se pudo guardar', e),
  });
  const del = useMutation({
    mutationFn: (id: string) => replenApi.deleteRule(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['replen-rules'] }),
    onError: (e) => toast.error('Error', e),
  });
  const evaluate = useMutation({
    mutationFn: replenApi.evaluate,
    onSuccess: (r) => {
      toast.success(`Evaluación: ${r.created} tarea(s) creadas`);
      void qc.invalidateQueries({ queryKey: ['replen-tasks'] });
    },
    onError: (e) => toast.error('Error', e),
  });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Reglas mín/máx por ubicación de picking" actions={can('counts.manage') && <Button size="sm" variant="secondary" onClick={() => evaluate.mutate()} loading={evaluate.isPending}>Evaluar ahora</Button>}>
        {can('counts.manage') && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              upsert.mutate();
            }}
            className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5"
          >
            <Input placeholder="SKU" value={f.sku_code} onChange={(e) => setF({ ...f, sku_code: e.target.value })} className="font-mono" required />
            <Input placeholder="Ubicación picking" value={f.pick_location_barcode} onChange={(e) => setF({ ...f, pick_location_barcode: e.target.value })} className="font-mono" required />
            <Input placeholder="Mín" inputMode="numeric" value={f.min_qty} onChange={(e) => setF({ ...f, min_qty: e.target.value.replace(/\D/g, '') })} required />
            <Input placeholder="Máx" inputMode="numeric" value={f.max_qty} onChange={(e) => setF({ ...f, max_qty: e.target.value.replace(/\D/g, '') })} required />
            <Button type="submit" loading={upsert.isPending}>
              Guardar
            </Button>
          </form>
        )}
        <Table
          rows={rules.data}
          loading={rules.isLoading}
          rowKey={(r) => r.id}
          dense
          columns={[
            { key: 's', header: 'SKU', render: (r) => <span className="font-mono">{r.sku_code}</span> },
            { key: 'l', header: 'Ubicación', render: (r) => <span className="font-mono">{r.location_code}</span> },
            { key: 'mn', header: 'Mín', render: (r) => fmtQty(r.min_qty), align: 'right' },
            { key: 'mx', header: 'Máx', render: (r) => fmtQty(r.max_qty), align: 'right' },
            { key: 'c', header: 'Actual', render: (r) => <b className={BigInt(r.current_qty) <= BigInt(r.min_qty) ? 'text-rose-700' : ''}>{fmtQty(r.current_qty)}</b>, align: 'right' },
            { key: 'a', header: '', render: (r) => r.is_active && can('counts.manage') && <Button size="sm" variant="ghost" onClick={() => del.mutate(r.id)}>Desactivar</Button> },
          ]}
        />
      </Card>
      <Card title="Tareas de reabasto" padded={false}>
        <Table
          rows={tasks.data}
          loading={tasks.isLoading}
          rowKey={(t) => t.id}
          dense
          columns={[
            { key: 's', header: 'SKU', render: (t) => <span className="font-mono">{t.sku_code}</span> },
            { key: 'st', header: 'Estado', render: (t) => <StatusChip status={t.status} /> },
            { key: 'l', header: 'LPN origen', render: (t) => <span className="font-mono">{t.source_lpn_code ?? '—'}</span> },
            { key: 'f', header: 'De → A', render: (t) => <span className="font-mono">{t.from_code ?? '?'} → {t.to_code}</span> },
            { key: 'q', header: 'Cant.', render: (t) => fmtQty(t.qty), align: 'right' },
            { key: 'c', header: 'Creada', render: (t) => fmtDateTime(t.created_at) },
          ]}
        />
      </Card>
    </div>
  );
}

function Counts() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const q = useQuery({ queryKey: ['counts', status], queryFn: () => countsApi.list(status || undefined), refetchInterval: 15_000 });
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<CountTask | null>(null);
  const view = useQuery({ queryKey: ['count', sel?.id], queryFn: () => countsApi.get(sel!.id), enabled: !!sel });
  const [reason, setReason] = useState('');
  const approve = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REJECT') => countsApi.approve({ count_task_id: sel!.id, decision, reason }),
    onSuccess: (r) => {
      toast.success(`Conteo ${es(r.status)}`, `${r.adjusted} ajuste(s) aplicados · ${r.skipped.length} omitidos`);
      void qc.invalidateQueries({ queryKey: ['counts'] });
      void qc.invalidateQueries({ queryKey: ['count', sel?.id] });
    },
    onError: (e) => toast.error('No se pudo aprobar', e),
  });
  return (
    <div>
      <div className="mb-3 flex gap-2">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-56">
          <option value="">Todos</option>
          {['PENDING', 'IN_PROGRESS', 'RECOUNT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CLOSED'].map((s) => (
            <option key={s} value={s}>
              {es(s)}
            </option>
          ))}
        </Select>
        {can('counts.manage') && (
          <Button onClick={() => setOpen(true)} className="ml-auto">
            Nuevo conteo
          </Button>
        )}
      </div>
      <Table
        rows={q.data}
        loading={q.isLoading}
        rowKey={(t) => t.id}
        onRowClick={(t) => {
          setSel(t);
          setReason('');
        }}
        columns={[
          { key: 't', header: 'Tipo', render: (t) => t.count_type },
          { key: 's', header: 'Estado', render: (t) => <StatusChip status={t.status} /> },
          { key: 'l', header: 'Ubicaciones', render: (t) => t.scope.location_ids.length, align: 'right' },
          { key: 'n', header: 'Líneas', render: (t) => t.lines ?? '—', align: 'right' },
          { key: 'b', header: 'Ciego', render: (t) => (t.is_blind ? 'Sí' : 'No') },
          { key: 'c', header: 'Creado', render: (t) => fmtDateTime(t.created_at) },
          { key: 'no', header: 'Notas', render: (t) => t.notes ?? '' },
        ]}
      />
      <CreateCountDrawer open={open} onClose={() => setOpen(false)} />
      <Drawer open={!!sel} onClose={() => setSel(null)} title={`Conteo ${sel?.count_type ?? ''}`} width="max-w-3xl">
        {view.data && (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <StatusChip status={view.data.task.status} /> <span className="text-sm text-slate-600">{view.data.locations.length} ubicaciones · {view.data.lines.length} líneas</span>
            </div>
            <Table
              rows={view.data.lines}
              rowKey={(l) => l.id}
              dense
              columns={[
                { key: 'l', header: 'Ubicación', render: (l) => <span className="font-mono">{l.location_code}</span> },
                { key: 'p', header: 'LPN', render: (l) => <span className="font-mono">{l.lpn_code ?? '—'}</span> },
                { key: 's', header: 'SKU', render: (l) => <span className="font-mono">{l.sku_code}</span> },
                { key: 'sys', header: 'Sistema', render: (l) => (l.system_qty === null ? '••' : fmtQty(l.system_qty)), align: 'right' },
                { key: 'c', header: 'Contado', render: (l) => (l.counted_qty === null ? '—' : fmtQty(l.counted_qty)), align: 'right' },
                { key: 'r', header: 'Reconteo', render: (l) => (l.recount_qty === null ? '—' : fmtQty(l.recount_qty)), align: 'right' },
                { key: 'v', header: 'Diferencia', render: (l) => (l.variance === null ? '—' : <b className={l.variance !== '0' ? 'text-rose-700' : 'text-emerald-700'}>{fmtQty(l.variance)}</b>), align: 'right' },
                { key: 'st', header: 'Estado', render: (l) => <StatusChip status={l.status} /> },
              ]}
            />
            {view.data.task.status === 'PENDING_APPROVAL' && can('counts.approve') && (
              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <div className="mb-2 text-sm font-semibold text-amber-900">Aprobar ajustes por diferencias</div>
                <Textarea placeholder="Motivo / comentario (mín. 3)" value={reason} onChange={(e) => setReason(e.target.value)} />
                <div className="mt-2 flex gap-2">
                  <Button variant="success" onClick={() => approve.mutate('APPROVE')} loading={approve.isPending} disabled={reason.trim().length < 3}>
                    Aprobar y ajustar
                  </Button>
                  <Button variant="danger" onClick={() => approve.mutate('REJECT')} loading={approve.isPending} disabled={reason.trim().length < 3}>
                    Rechazar
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </Drawer>
    </div>
  );
}

function CreateCountDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const zones = useQuery({ queryKey: ['zones'], queryFn: () => layoutApi.zones(), enabled: open });
  const users = useQuery({ queryKey: ['directory'], queryFn: adminApi.directory, enabled: open });
  const [f, setF] = useState({ count_type: 'LOCATION', location_barcodes: '', sku_codes: '', zone_id: '', abc_class: 'A', random_sample: '10', assigned_to: '', is_blind: true, notes: '' });
  const m = useMutation({
    mutationFn: () =>
      countsApi.create({
        count_type: f.count_type,
        location_barcodes: f.location_barcodes ? f.location_barcodes.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean) : undefined,
        sku_codes: f.sku_codes ? f.sku_codes.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean) : undefined,
        zone_id: f.zone_id || undefined,
        abc_class: f.count_type === 'ABC' ? f.abc_class : undefined,
        random_sample: f.count_type === 'RANDOM' ? Number(f.random_sample) : undefined,
        assigned_to: f.assigned_to || undefined,
        is_blind: f.is_blind,
        notes: f.notes || undefined,
      }),
    onSuccess: (r) => {
      toast.success('Conteo creado', `${r.locations} ubicaciones · ${r.lines} líneas`);
      void qc.invalidateQueries({ queryKey: ['counts'] });
      onClose();
    },
    onError: (e) => toast.error('No se pudo crear', e),
  });
  return (
    <Drawer open={open} onClose={onClose} title="Nuevo conteo cíclico" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button onClick={() => m.mutate()} loading={m.isPending}>Crear</Button></div>}>
      <div className="grid gap-3">
        <Field label="Tipo" required>
          <Select value={f.count_type} onChange={(e) => setF({ ...f, count_type: e.target.value })}>
            {COUNT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
        {['LOCATION', 'SCHEDULED', 'INCIDENT'].includes(f.count_type) && (
          <Field label="Ubicaciones (códigos, uno por línea)" required>
            <Textarea value={f.location_barcodes} onChange={(e) => setF({ ...f, location_barcodes: e.target.value })} className="font-mono" />
          </Field>
        )}
        {f.count_type === 'SKU' && (
          <Field label="SKUs (uno por línea)" required>
            <Textarea value={f.sku_codes} onChange={(e) => setF({ ...f, sku_codes: e.target.value })} className="font-mono" />
          </Field>
        )}
        {f.count_type === 'ZONE' && (
          <Field label="Zona" required>
            <Select value={f.zone_id} onChange={(e) => setF({ ...f, zone_id: e.target.value })}>
              <option value="">—</option>
              {zones.data?.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.code} · {z.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {f.count_type === 'ABC' && (
          <Field label="Clase ABC" required>
            <Select value={f.abc_class} onChange={(e) => setF({ ...f, abc_class: e.target.value })}>
              <option>A</option>
              <option>B</option>
              <option>C</option>
            </Select>
          </Field>
        )}
        {f.count_type === 'RANDOM' && (
          <Field label="Muestra (ubicaciones)" required>
            <Input inputMode="numeric" value={f.random_sample} onChange={(e) => setF({ ...f, random_sample: e.target.value.replace(/\D/g, '') })} />
          </Field>
        )}
        <Field label="Asignar a">
          <Select value={f.assigned_to} onChange={(e) => setF({ ...f, assigned_to: e.target.value })}>
            <option value="">Sin asignar</option>
            {users.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name} ({u.username})
              </option>
            ))}
          </Select>
        </Field>
        <Checkbox label="Conteo ciego (el operador no ve cantidades del sistema)" checked={f.is_blind} onChange={(e) => setF({ ...f, is_blind: e.target.checked })} />
        <Field label="Notas">
          <Textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
        <Alert tone="info">Máximo 500 ubicaciones por tarea. Las diferencias generan reconteo por otra persona y luego aprobación de supervisor.</Alert>
      </div>
    </Drawer>
  );
}
