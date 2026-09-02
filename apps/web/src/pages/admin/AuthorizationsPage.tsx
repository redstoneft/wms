// /admin/authorizations — supervisor authorizations for exceptions (create, list, revoke).
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EXCEPTION_TYPES } from '@wms/shared';
import { adminApi } from '../../api/admin';
import { useToast } from '../../components/Toast';
import { Alert, Button, Card, Field, Input, PageHeader, Select, StatusChip, Table, Textarea } from '../../components/ui';
import { fmtDateTime } from '../../lib/format';

const ENTITY_HINT: Record<string, string> = {
  PUTAWAY_LOCATION_OVERRIDE: 'entity_type = putaway_task · entity_id = id de la tarea (lo muestra el handheld)',
  SAME_USER_VERIFICATION: 'entity_type = order · entity_id = id del pedido',
  ORDER_CANCEL_DURING_PICKING: 'entity_type = order · entity_id = id del pedido',
  COUNT_ADJUSTMENT: 'entity_type = lpn · entity_id = id del LPN',
  NEGATIVE_INVENTORY: 'no soportado por el libro mayor (siempre rechazado)',
  FORCE_RELEASE_NOT_ALLOWED: 'existe sólo para ser rechazado: la liberación nunca se fuerza',
  REPRINT_LABEL: 'entity_type = label · entity_id = entidad de la etiqueta',
};
const DEFAULT_ENTITY: Record<string, string> = { PUTAWAY_LOCATION_OVERRIDE: 'putaway_task', SAME_USER_VERIFICATION: 'order', ORDER_CANCEL_DURING_PICKING: 'order', COUNT_ADJUSTMENT: 'lpn', REPRINT_LABEL: 'label' };

export default function AuthorizationsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const list = useQuery({ queryKey: ['authorizations', status], queryFn: () => adminApi.authorizations({ status: status || undefined }), refetchInterval: 15_000 });
  const [f, setF] = useState({ exception_type: 'PUTAWAY_LOCATION_OVERRIDE', entity_type: 'putaway_task', entity_id: '', reason: '' });
  const [created, setCreated] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => adminApi.authorize(f),
    onSuccess: (a) => {
      setCreated(a.id);
      toast.success('Autorización creada', 'Comparte el ID con el operador');
      setF({ ...f, entity_id: '', reason: '' });
      void qc.invalidateQueries({ queryKey: ['authorizations'] });
    },
    onError: (e) => toast.error('No se pudo autorizar', e),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => adminApi.revokeAuthorization(id),
    onSuccess: () => { toast.success('Autorización revocada'); void qc.invalidateQueries({ queryKey: ['authorizations'] }); },
    onError: (e) => toast.error('No se pudo revocar', e),
  });
  return (
    <div>
      <PageHeader title="Autorizaciones de supervisor" subtitle="Una autorización aprueba UNA excepción sobre UNA entidad y se consume al usarse. Todo queda auditado." />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Nueva autorización">
          <div className="grid gap-3">
            <Field label="Tipo de excepción" required>
              <Select value={f.exception_type} onChange={(e) => setF({ ...f, exception_type: e.target.value, entity_type: DEFAULT_ENTITY[e.target.value] ?? f.entity_type })}>
                {EXCEPTION_TYPES.filter((t) => t !== 'FORCE_RELEASE_NOT_ALLOWED' && t !== 'NEGATIVE_INVENTORY').map((t) => <option key={t}>{t}</option>)}
              </Select>
            </Field>
            <p className="text-xs text-slate-500">{ENTITY_HINT[f.exception_type]}</p>
            <Field label="Tipo de entidad" required><Input value={f.entity_type} onChange={(e) => setF({ ...f, entity_type: e.target.value })} className="font-mono" /></Field>
            <Field label="ID de entidad" required><Input value={f.entity_id} onChange={(e) => setF({ ...f, entity_id: e.target.value.trim() })} className="font-mono" placeholder="UUID" /></Field>
            <Field label="Motivo (mín. 3)" required><Textarea value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
            <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!f.entity_id || f.reason.trim().length < 3}>Autorizar</Button>
            {created && (
              <Alert tone="success" title="ID de autorización (dáselo al operador)">
                <code className="block select-all break-all font-mono text-xs" data-testid="auth-id">{created}</code>
              </Alert>
            )}
          </div>
        </Card>
        <div className="lg:col-span-2">
          <div className="mb-3">
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44">
              <option value="">Todas</option>
              <option value="APPROVED">Aprobadas (vigentes)</option>
              <option value="CONSUMED">Consumidas</option>
              <option value="REVOKED">Revocadas</option>
            </Select>
          </div>
          <Table
            rows={list.data}
            loading={list.isLoading}
            rowKey={(a) => a.id}
            dense
            columns={[
              { key: 'id', header: 'ID', render: (a) => <code className="select-all font-mono text-xs">{a.id}</code> },
              { key: 't', header: 'Excepción', render: (a) => <b>{a.exception_type}</b> },
              { key: 'e', header: 'Entidad', render: (a) => <span className="font-mono text-xs">{a.entity_type} {a.entity_id.slice(0, 8)}…</span> },
              { key: 's', header: 'Estado', render: (a) => <StatusChip status={a.status} /> },
              { key: 'r', header: 'Motivo', render: (a) => a.reason },
              { key: 'c', header: 'Creada', render: (a) => fmtDateTime(a.created_at) },
              { key: 'u', header: 'Consumida', render: (a) => fmtDateTime(a.consumed_at) },
              { key: 'a', header: '', render: (a) => a.status === 'APPROVED' && <Button size="sm" variant="danger" onClick={() => revoke.mutate(a.id)}>Revocar</Button> },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
