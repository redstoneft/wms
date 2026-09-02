import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLES, type Role } from '@wms/shared';
import { adminApi } from '../../api/admin';
import type { UserRow } from '../../api/types';
import { useToast } from '../../components/Toast';
import { Alert, Button, Checkbox, Drawer, Field, Input, PageHeader, StatusChip, Table } from '../../components/ui';
import { fmtDateTime } from '../../lib/format';

export default function UsersPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const users = useQuery({ queryKey: ['users'], queryFn: adminApi.users });
  const roles = useQuery({ queryKey: ['roles'], queryFn: adminApi.roles });
  const [edit, setEdit] = useState<(Partial<UserRow> & { isNew?: boolean; password?: string }) | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['users'] });
  const save = useMutation({
    mutationFn: () =>
      edit!.isNew
        ? adminApi.createUser({ username: edit!.username, full_name: edit!.full_name, email: edit!.email || undefined, password: edit!.password, roles: edit!.roles })
        : adminApi.updateUser(edit!.id!, { full_name: edit!.full_name, email: edit!.email || null, is_active: edit!.is_active, roles: edit!.roles, reset_password: edit!.password || undefined }),
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
          { key: 'l', header: 'Bloqueo', render: (u) => (u.locked_until && new Date(u.locked_until) > new Date() ? <span className="text-rose-700">hasta {fmtDateTime(u.locked_until)}</span> : '—') },
          {
            key: 'ac',
            header: '',
            render: (u) => (
              <div className="flex gap-1">
                <Button size="sm" variant="secondary" onClick={() => setEdit({ ...u, password: '' })}>Editar</Button>
                <Button size="sm" variant="ghost" onClick={() => unlock.mutate(u.id)}>Desbloquear</Button>
                {u.mfa_enabled && <Button size="sm" variant="ghost" onClick={() => resetMfa.mutate(u.id)}>Reset MFA</Button>}
              </div>
            ),
          },
        ]}
      />
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
