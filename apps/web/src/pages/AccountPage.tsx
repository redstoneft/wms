import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authApi } from '../api/auth';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../components/Toast';
import { Button, Card, Field, Input, KV, PageHeader, Table } from '../components/ui';
import { getDeviceId } from '../lib/device';
import { fmtDateTime } from '../lib/format';

export default function AccountPage() {
  const { user } = useAuth();
  const toast = useToast();
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: authApi.sessions });
  const qc = useQueryClient();
  const devices = useQuery({ queryKey: ['trusted-devices'], queryFn: authApi.trustedDevices });
  const revokeDevice = useMutation({
    mutationFn: (id: string | null) => (id ? authApi.revokeTrustedDevice(id) : authApi.revokeAllTrustedDevices()),
    onSuccess: (r) => {
      toast.success(r.revoked === 1 ? 'Dispositivo olvidado' : `${r.revoked} dispositivos olvidados`, 'La próxima vez pedirá el código de verificación');
      void qc.invalidateQueries({ queryKey: ['trusted-devices'] });
    },
    onError: (e) => toast.error('No se pudo revocar', e),
  });
  const [cur, setCur] = useState('');
  const [nw, setNw] = useState('');
  const [busy, setBusy] = useState(false);
  const change = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await authApi.changePassword(cur, nw);
      toast.success('Contraseña actualizada', 'Las demás sesiones fueron cerradas.');
      setCur('');
      setNw('');
    } catch (err) {
      toast.error('No se pudo cambiar la contraseña', err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="max-w-3xl">
      <PageHeader title="Mi cuenta" />
      <Card title="Perfil">
        <dl className="grid gap-3 sm:grid-cols-2">
          <KV label="Usuario">{user?.username}</KV>
          <KV label="Nombre">{user?.full_name}</KV>
          <KV label="Roles">{user?.roles.join(', ')}</KV>
          <KV label="MFA">{user?.mfa_enabled ? 'Activo' : 'No activo'}</KV>
          <KV label="Dispositivo" mono>
            {getDeviceId()}
          </KV>
          <KV label="Permisos">{user?.permissions.length}</KV>
        </dl>
      </Card>
      <Card title="Cambiar contraseña" className="mt-4">
        <form onSubmit={change} className="grid gap-3 sm:grid-cols-2">
          <Field label="Contraseña actual" required>
            <Input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required />
          </Field>
          <Field label="Nueva contraseña (mín. 12)" required>
            <Input type="password" value={nw} onChange={(e) => setNw(e.target.value)} autoComplete="new-password" minLength={12} required />
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit" loading={busy}>
              Guardar
            </Button>
          </div>
        </form>
      </Card>
      <Card
        title="Dispositivos de confianza (segundo factor recordado)"
        className="mt-4"
        padded={false}
        actions={devices.data?.length ? <Button size="sm" variant="secondary" onClick={() => revokeDevice.mutate(null)} loading={revokeDevice.isPending}>Olvidar todos</Button> : undefined}
      >
        <Table
          rows={devices.data}
          loading={devices.isLoading}
          rowKey={(d) => d.id}
          dense
          empty="Ningún navegador recordado. Al verificar el código puedes marcar “Recordar este dispositivo”."
          columns={[
            { key: 'ua', header: 'Navegador', render: (d) => <span className="text-xs">{d.user_agent ?? '—'}</span> },
            { key: 'dev', header: 'Dispositivo', render: (d) => <span className="font-mono text-xs">{d.device_id ?? '—'}</span> },
            { key: 'ip', header: 'IP', render: (d) => d.ip ?? '—' },
            { key: 'u', header: 'Último uso', render: (d) => fmtDateTime(d.last_used_at) },
            { key: 'e', header: 'Vence', render: (d) => fmtDateTime(d.expires_at) },
            { key: 'x', header: '', render: (d) => <Button size="sm" variant="ghost" onClick={() => revokeDevice.mutate(d.id)}>Olvidar</Button> },
          ]}
        />
      </Card>
      <Card title="Sesiones activas" className="mt-4" padded={false}>
        <Table
          rows={sessions.data}
          loading={sessions.isLoading}
          rowKey={(s) => s.id}
          columns={[
            { key: 'ip', header: 'IP', render: (s) => s.ip ?? '—' },
            { key: 'dev', header: 'Dispositivo', render: (s) => <span className="font-mono text-xs">{s.device_id ?? '—'}</span> },
            { key: 'ua', header: 'Navegador', render: (s) => <span className="text-xs">{(s.user_agent ?? '').slice(0, 60)}</span> },
            { key: 'seen', header: 'Última actividad', render: (s) => fmtDateTime(s.last_seen_at) },
            { key: 'mfa', header: 'MFA', render: (s) => (s.mfa_verified ? 'Sí' : 'No') },
          ]}
        />
      </Card>
    </div>
  );
}
