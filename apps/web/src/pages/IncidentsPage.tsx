import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { INCIDENT_SEVERITIES, INCIDENT_STATUSES, INCIDENT_TYPES } from '@wms/shared';
import { adminApi } from '../api/admin';
import { incidentsApi } from '../api/incidents';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../components/Toast';
import { Button, Drawer, Field, Input, KV, PageHeader, Pagination, Select, StatusChip, Table, Textarea } from '../components/ui';
import { useQueryParam } from '../lib/hooks';
import { es, fmtDateTime, fmtQty } from '../lib/format';

export default function IncidentsPage() {
  const nav = useNavigate();
  const { id } = useParams();
  const { can } = useAuth();
  const [status, setStatus] = useQueryParam('status');
  const [severity, setSeverity] = useQueryParam('severity');
  const [type, setType] = useQueryParam('type');
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const list = useQuery({ queryKey: ['incidents', status, severity, type, offset], queryFn: () => incidentsApi.list({ status: status || undefined, severity: severity || undefined, type: type || undefined, limit, offset }), refetchInterval: 15_000 });
  const [create, setCreate] = useState(false);
  return (
    <div>
      <PageHeader
        title="Incidencias"
        subtitle="Faltantes, sobrantes, daños, errores de surtido/carga. Nada se corrige en silencio."
        actions={
          <>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-36" aria-label="Estado">
              <option value="">Estado</option>
              {INCIDENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {es(s)}
                </option>
              ))}
            </Select>
            <Select value={severity} onChange={(e) => setSeverity(e.target.value)} className="w-36" aria-label="Severidad">
              <option value="">Severidad</option>
              {INCIDENT_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {es(s)}
                </option>
              ))}
            </Select>
            <Select value={type} onChange={(e) => setType(e.target.value)} className="w-44" aria-label="Tipo">
              <option value="">Tipo</option>
              {INCIDENT_TYPES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
            {can('incidents.create') && <Button onClick={() => setCreate(true)}>Reportar</Button>}
          </>
        }
      />
      <Table
        rows={list.data?.items}
        loading={list.isLoading}
        rowKey={(i) => i.id}
        onRowClick={(i) => nav(`/incidents/${i.id}`)}
        selectedKey={id ?? null}
        columns={[
          { key: 'n', header: '#', render: (i) => <b>{i.incident_number}</b> },
          { key: 'sv', header: 'Severidad', render: (i) => <StatusChip status={i.severity} /> },
          { key: 's', header: 'Estado', render: (i) => <StatusChip status={i.status} /> },
          { key: 't', header: 'Tipo', render: (i) => i.incident_type },
          { key: 'ti', header: 'Título', render: (i) => i.title },
          { key: 'e', header: 'Entidad', render: (i) => (i.entity_type ? `${i.entity_type}` : '—') },
          { key: 'q', header: 'Cant.', render: (i) => (i.qty ? fmtQty(i.qty) : ''), align: 'right' },
          { key: 'c', header: 'Creada', render: (i) => fmtDateTime(i.created_at) },
        ]}
      />
      {list.data && <Pagination total={list.data.total} limit={limit} offset={offset} onChange={setOffset} />}
      <IncidentDrawer id={id} onClose={() => nav('/incidents')} />
      <CreateIncidentDrawer open={create} onClose={() => setCreate(false)} />
    </div>
  );
}

function IncidentDrawer({ id, onClose }: { id?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['incident', id], queryFn: () => incidentsApi.get(id!), enabled: !!id });
  const users = useQuery({ queryKey: ['directory'], queryFn: adminApi.directory, enabled: !!id && can('incidents.resolve') });
  const [comment, setComment] = useState('');
  const [resolution, setResolution] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['incident', id] });
    void qc.invalidateQueries({ queryKey: ['incidents'] });
  };
  const addComment = useMutation({ mutationFn: () => incidentsApi.comment(id!, comment), onSuccess: () => { setComment(''); refresh(); }, onError: (e) => toast.error('Error', e) });
  const setStatus = useMutation({
    mutationFn: (status: 'IN_REVIEW' | 'RESOLVED' | 'CLOSED' | 'REJECTED') => incidentsApi.status(id!, { status, resolution: resolution || undefined, comment: comment || undefined }),
    onSuccess: () => { toast.success('Estado actualizado'); setComment(''); refresh(); },
    onError: (e) => toast.error('No se pudo cambiar el estado', e),
  });
  const assign = useMutation({ mutationFn: (uid: string | null) => incidentsApi.assign(id!, uid), onSuccess: () => { toast.success('Asignada'); refresh(); }, onError: (e) => toast.error('Error', e) });
  const photo = useMutation({ mutationFn: (f: File) => incidentsApi.photo(id!, f), onSuccess: () => { toast.success('Foto adjuntada'); refresh(); }, onError: (e) => toast.error('No se pudo subir', e) });
  const i = q.data;
  return (
    <Drawer open={!!id} onClose={onClose} title={i ? `${i.incident_number} · ${i.title}` : 'Incidencia'} width="max-w-2xl">
      {i && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status={i.severity} />
            <StatusChip status={i.status} />
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">{i.incident_type}</span>
          </div>
          {i.description && <p className="whitespace-pre-line text-sm text-slate-700">{i.description}</p>}
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <KV label="SKU" mono>{i.sku ? `${i.sku.code}` : '—'}</KV>
            <KV label="LPN" mono>{i.lpn?.code ?? '—'}</KV>
            <KV label="Ubicación" mono>{i.location?.code ?? '—'}</KV>
            <KV label="Entidad">{i.entity_type ? `${i.entity_type} ${i.entity_id?.slice(0, 8) ?? ''}` : '—'}</KV>
            <KV label="Cantidad">{i.qty ? fmtQty(i.qty) : '—'}</KV>
            <KV label="Creada">{fmtDateTime(i.created_at)}</KV>
            <KV label="Resuelta">{fmtDateTime(i.resolved_at)}</KV>
            <KV label="Resolución">{i.resolution ?? '—'}</KV>
          </dl>
          {can('incidents.resolve') && (
            <Field label="Asignar a">
              <Select value={i.assigned_to ?? ''} onChange={(e) => assign.mutate(e.target.value || null)}>
                <option value="">Sin asignar</option>
                {users.data?.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.full_name} ({u.username})
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <div>
            <div className="mb-1 flex items-center justify-between text-xs font-semibold uppercase text-slate-500">
              Fotos ({i.attachments.length})
              {can('incidents.create') && (
                <>
                  <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => e.target.files?.[0] && photo.mutate(e.target.files[0])} />
                  <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()} loading={photo.isPending}>
                    Subir
                  </Button>
                </>
              )}
            </div>
            <ul className="text-sm">
              {i.attachments.map((a) => (
                <li key={a.id} className="flex justify-between border-b border-slate-100 py-1">
                  <span>{a.file_name}</span>
                  <span className="text-xs text-slate-500">{fmtDateTime(a.created_at)}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase text-slate-500">Comentarios ({i.comments.length})</div>
            <ul className="space-y-2">
              {i.comments.map((c) => (
                <li key={c.id} className="rounded-lg bg-slate-50 p-2 text-sm">
                  <div className="text-xs text-slate-500">{fmtDateTime(c.created_at)}</div>
                  <div className="whitespace-pre-line">{c.body}</div>
                </li>
              ))}
            </ul>
            <Textarea className="mt-2" placeholder="Agregar comentario" value={comment} onChange={(e) => setComment(e.target.value)} />
            <Button size="sm" className="mt-2" variant="secondary" onClick={() => addComment.mutate()} disabled={!comment.trim()} loading={addComment.isPending}>
              Comentar
            </Button>
          </div>
          {can('incidents.resolve') && i.status !== 'CLOSED' && (
            <div className="rounded-lg border border-slate-200 p-3">
              <Field label="Resolución (requerida para resolver/cerrar)">
                <Textarea value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder={i.resolution ?? ''} />
              </Field>
              <div className="mt-2 flex flex-wrap gap-2">
                {i.status === 'OPEN' && <Button size="sm" variant="secondary" onClick={() => setStatus.mutate('IN_REVIEW')}>En revisión</Button>}
                <Button size="sm" variant="success" onClick={() => setStatus.mutate('RESOLVED')} disabled={!resolution && !i.resolution}>Resolver</Button>
                <Button size="sm" onClick={() => setStatus.mutate('CLOSED')} disabled={!resolution && !i.resolution}>Cerrar</Button>
                <Button size="sm" variant="danger" onClick={() => setStatus.mutate('REJECTED')}>Rechazar</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

function CreateIncidentDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ incident_type: 'OTHER', severity: 'MEDIUM', title: '', description: '', sku_code: '', lpn_code: '', location_barcode: '', qty: '' });
  const m = useMutation({
    mutationFn: () => incidentsApi.create({ ...f, description: f.description || undefined, sku_code: f.sku_code || undefined, lpn_code: f.lpn_code || undefined, location_barcode: f.location_barcode || undefined, qty: f.qty || undefined }),
    onSuccess: (i) => {
      toast.success(`Incidencia ${i.incident_number} creada`);
      void qc.invalidateQueries({ queryKey: ['incidents'] });
      onClose();
    },
    onError: (e) => toast.error('No se pudo crear', e),
  });
  return (
    <Drawer open={open} onClose={onClose} title="Reportar incidencia" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button onClick={() => m.mutate()} loading={m.isPending} disabled={f.title.trim().length < 3}>Reportar</Button></div>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Tipo" required>
          <Select value={f.incident_type} onChange={(e) => setF({ ...f, incident_type: e.target.value })}>
            {INCIDENT_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
        </Field>
        <Field label="Severidad" required>
          <Select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>
            {INCIDENT_SEVERITIES.map((t) => (
              <option key={t} value={t}>
                {es(t)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Título (mín. 3)" required className="sm:col-span-2">
          <Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </Field>
        <Field label="Descripción" className="sm:col-span-2">
          <Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label="SKU">
          <Input value={f.sku_code} onChange={(e) => setF({ ...f, sku_code: e.target.value })} className="font-mono" />
        </Field>
        <Field label="LPN">
          <Input value={f.lpn_code} onChange={(e) => setF({ ...f, lpn_code: e.target.value.toUpperCase() })} className="font-mono" />
        </Field>
        <Field label="Ubicación (código o barcode)">
          <Input value={f.location_barcode} onChange={(e) => setF({ ...f, location_barcode: e.target.value })} className="font-mono" />
        </Field>
        <Field label="Cantidad">
          <Input inputMode="numeric" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value.replace(/\D/g, '') })} />
        </Field>
      </div>
    </Drawer>
  );
}
