import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLES, type Role } from '@wms/shared';
import { adminApi } from '../../api/admin';
import { trainingApi, type TrainingUserRow } from '../../api/training';
import type { UserRow } from '../../api/types';
import { useToast } from '../../components/Toast';
import { Alert, Button, Checkbox, Drawer, Field, Input, Modal, PageHeader, StatusChip, Table } from '../../components/ui';
import { fmtDateTime } from '../../lib/format';

export default function UsersPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const users = useQuery({ queryKey: ['users'], queryFn: adminApi.users });
  const training = useQuery({ queryKey: ['training-users'], queryFn: trainingApi.users });
  const [waive, setWaive] = useState<string | null>(null);
  const [resetSchoolOpen, setResetSchoolOpen] = useState(false);
  const [resetSchoolReason, setResetSchoolReason] = useState('');
  const resetSchool = useMutation({
    mutationFn: () => trainingApi.resetSchool(resetSchoolReason.trim()),
    onSuccess: (r) => {
      toast.success('Almacén escuela vaciado', `${r.lpns} pallet(s) dados de baja, ${r.orders} pedido(s) cancelados`);
      setResetSchoolOpen(false);
      setResetSchoolReason('');
    },
    onError: (e) => toast.error('No se pudo vaciar', e),
  });
  const [waiveReason, setWaiveReason] = useState('');
  const resetTraining = useMutation({
    mutationFn: (id: string) => trainingApi.reset(id),
    onSuccess: () => {
      toast.success('Capacitación reiniciada', 'El usuario volverá a la guía al entrar al modo almacén');
      void qc.invalidateQueries({ queryKey: ['training-users'] });
    },
    onError: (e) => toast.error('No se pudo reiniciar', e),
  });
  const waiveTraining = useMutation({
    mutationFn: () => trainingApi.waive(waive!, waiveReason.trim()),
    onSuccess: () => {
      toast.success('Usuario marcado como capacitado');
      setWaive(null);
      setWaiveReason('');
      void qc.invalidateQueries({ queryKey: ['training-users'] });
    },
    onError: (e) => toast.error('No se pudo marcar', e),
  });
  const roles = useQuery({ queryKey: ['roles'], queryFn: adminApi.roles });
  const [edit, setEdit] = useState<(Partial<UserRow> & { isNew?: boolean; password?: string }) | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['users'] });
  const save = useMutation({
    mutationFn: async () => {
      if (edit!.isNew) await adminApi.createUser({ username: edit!.username, full_name: edit!.full_name, email: edit!.email || undefined, password: edit!.password, roles: edit!.roles });
      else await adminApi.updateUser(edit!.id!, { full_name: edit!.full_name, email: edit!.email || null, is_active: edit!.is_active, roles: edit!.roles, reset_password: edit!.password || undefined });
    },
    onSuccess: () => { toast.success('Usuario guardado'); setEdit(null); refresh(); },
    onError: (e) => toast.error('No se pudo guardar', e),
  });
  const unlock = useMutation({ mutationFn: (id: string) => adminApi.unlockUser(id), onSuccess: () => { toast.success('Cuenta desbloqueada'); refresh(); }, onError: (e) => toast.error('Error', e) });
  const resetMfa = useMutation({ mutationFn: (id: string) => adminApi.resetMfa(id), onSuccess: () => { toast.success('MFA restablecido; el usuario deberá enrolarse de nuevo'); refresh(); }, onError: (e) => toast.error('Error', e) });
  return (
    <div>
      <PageHeader title="Usuarios y roles" subtitle="Los permisos se derivan del rol; la API es quien los aplica." actions={<Button onClick={() => setEdit({ isNew: true, username: '', full_name: '', email: '', roles: [], password: '' })}>Nuevo usuario</Button>} />
      <Table
        rows={users.data}
        loading={users.isLoading}
        rowKey={(u) => u.id}
        columns={[
          { key: 'u', header: 'Usuario', render: (u) => <b>{u.username}</b> },
          { key: 'n', header: 'Nombre', render: (u) => u.full_name },
          { key: 'e', header: 'Email', render: (u) => u.email ?? '—' },
          { key: 'r', header: 'Roles', render: (u) => u.roles.join(', ') },
          { key: 'a', header: 'Activo', render: (u) => <StatusChip status={u.is_active ? 'ACTIVE' : 'BLOCKED'} /> },
          { key: 'm', header: 'MFA', render: (u) => (u.mfa_enabled ? 'Sí' : 'No') },
          { key: 'tr', header: 'Capacitación', render: (u) => <TrainingCell userId={u.id} rows={training.data} /> },
          { key: 'l', header: 'Bloqueo', render: (u) => (u.locked_until && new Date(u.locked_until) > new Date() ? <span className="text-rose-700">hasta {fmtDateTime(u.locked_until)}</span> : '—') },
          {
            key: 'ac',
            header: '',
            render: (u) => (
              <div className="flex gap-1">
                <Button size="sm" variant="secondary" onClick={() => setEdit({ ...u, password: '' })}>Editar</Button>
                <Button size="sm" variant="ghost" onClick={() => unlock.mutate(u.id)}>Desbloquear</Button>
                {u.mfa_enabled && <Button size="sm" variant="ghost" onClick={() => resetMfa.mutate(u.id)}>Reset MFA</Button>}
                <Button size="sm" variant="ghost" onClick={() => resetTraining.mutate(u.id)}>Reiniciar capacitación</Button>
                {!training.data?.find((t) => t.id === u.id)?.completed_at && <Button size="sm" variant="ghost" onClick={() => setWaive(u.id)}>Marcar capacitado</Button>}
              </div>
            ),
          },
        ]}
      />
      <Modal open={!!waive} onClose={() => setWaive(null)} title="Marcar como capacitado" footer={<Button onClick={() => waiveTraining.mutate()} disabled={waiveReason.trim().length < 3} loading={waiveTraining.isPending}>Marcar</Button>}>
        <p className="text-sm text-slate-600">El usuario podrá operar en el modo almacén sin hacer la capacitación guiada. Queda registrado en auditoría con el motivo.</p>
        <Field label="Motivo" required>
          <Input value={waiveReason} onChange={(e) => setWaiveReason(e.target.value)} placeholder="operador con experiencia previa" />
        </Field>
      </Modal>
      <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <div className="font-bold">Capacitación guiada</div>
        <p className="mt-1">Cada usuario nuevo practica todas sus operaciones en el almacén escuela antes de operar. Imprime las etiquetas de práctica una vez y pégalas en el área de capacitación.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <a className="rounded-md bg-white px-3 py-1.5 font-medium text-sky-700 ring-1 ring-slate-200" href={trainingApi.labelsUrl} target="_blank" rel="noreferrer">
            Etiquetas de práctica (imprimir)
          </a>
          <Button size="sm" variant="secondary" onClick={() => setResetSchoolOpen(true)}>
            Vaciar almacén escuela
          </Button>
        </div>
      </div>
      <Modal open={resetSchoolOpen} onClose={() => setResetSchoolOpen(false)} title="Vaciar almacén escuela" footer={<Button variant="danger" onClick={() => resetSchool.mutate()} disabled={resetSchoolReason.trim().length < 3} loading={resetSchool.isPending}>Vaciar</Button>}>
        <p className="text-sm text-slate-600">Da de baja los pallets de práctica y cancela recepciones, pedidos y tareas de práctica abiertos. Solo afecta al almacén escuela; queda en auditoría.</p>
        <Field label="Motivo" required>
          <Input value={resetSchoolReason} onChange={(e) => setResetSchoolReason(e.target.value)} placeholder="limpieza semanal" />
        </Field>
      </Modal>
      <div className="mt-6">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Roles y permisos</h2>
        <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-4">
          {roles.data?.map((r) => (
            <div key={r.code} className="rounded-lg border border-slate-200 bg-white p-3 text-xs">
              <div className="font-bold">{r.code}</div>
              <div className="text-slate-500">{r.name}</div>
              <div className="mt-1 text-slate-600">{r.permissions.length} permisos</div>
            </div>
          ))}
        </div>
      </div>
      <Drawer open={!!edit} onClose={() => setEdit(null)} title={edit?.isNew ? 'Nuevo usuario' : `Editar ${edit?.username}`} footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setEdit(null)}>Cancelar</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!edit?.username || !edit?.full_name || !(edit?.roles?.length) || (edit?.isNew && (edit.password?.length ?? 0) < 12)}>Guardar</Button></div>}>
        {edit && (
          <div className="grid gap-3">
            <Field label="Usuario" required><Input value={edit.username ?? ''} onChange={(e) => setEdit({ ...edit, username: e.target.value })} disabled={!edit.isNew} /></Field>
            <Field label="Nombre completo" required><Input value={edit.full_name ?? ''} onChange={(e) => setEdit({ ...edit, full_name: e.target.value })} /></Field>
            <Field label="Email"><Input type="email" value={edit.email ?? ''} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
            <Field label={edit.isNew ? 'Contraseña (mín. 12)' : 'Restablecer contraseña (opcional, mín. 12)'} required={edit.isNew}><Input type="password" value={edit.password ?? ''} onChange={(e) => setEdit({ ...edit, password: e.target.value })} autoComplete="new-password" /></Field>
            <div>
              <div className="mb-1 text-sm font-medium text-slate-700">Roles</div>
              <div className="grid grid-cols-2 gap-1">
                {ROLES.map((r) => (
                  <Checkbox key={r} label={r} checked={(edit.roles ?? []).includes(r)} onChange={(e) => setEdit({ ...edit, roles: e.target.checked ? [...(edit.roles ?? []), r] : (edit.roles ?? []).filter((x: Role) => x !== r) })} />
                ))}
              </div>
            </div>
            {!edit.isNew && <Checkbox label="Activo" checked={edit.is_active !== false} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} />}
            {(edit.roles ?? []).includes('ADMIN') && <Alert tone="info">Los administradores deben enrolar MFA (TOTP) en su primer inicio de sesión.</Alert>}
          </div>
        )}
      </Drawer>
    </div>
  );
}

function TrainingCell({ userId, rows }: { userId: string; rows: TrainingUserRow[] | undefined }) {
  const r = rows?.find((x) => x.id === userId);
  if (!r) return <span className="text-slate-400">—</span>;
  if (r.completed_at) return <span className="text-emerald-700">{r.waived ? 'Exento' : 'Completada'} · {fmtDateTime(r.completed_at)}</span>;
  const done = r.steps.filter((s) => s.status === 'COMPLETED').length;
  return <span className="text-amber-700">Pendiente · {done} paso(s)</span>;
}
