import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ALLOCATION_STRATEGIES } from '@wms/shared';
import { adminApi } from '../../api/admin';
import type { Settings } from '../../api/types';
import { useToast } from '../../components/Toast';
import { Alert, Button, Card, Checkbox, Field, Input, PageHeader, Select, Skeleton } from '../../components/ui';

export default function SettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['settings'], queryFn: adminApi.settings });
  const [f, setF] = useState<Settings | null>(null);
  useEffect(() => {
    if (q.data) setF(q.data);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => adminApi.updateSettings({ allocation_strategy: f!.allocation_strategy, count_variance_recount_threshold: Number(f!.count_variance_recount_threshold), session_ttl_hours: Number(f!.session_ttl_hours), require_mfa_for_admin: f!.require_mfa_for_admin }),
    onSuccess: () => { toast.success('Configuración guardada (auditada)'); void qc.invalidateQueries({ queryKey: ['settings'] }); },
    onError: (e) => toast.error('No se pudo guardar', e),
  });
  if (!f) return <Skeleton className="h-40" />;
  return (
    <div className="max-w-2xl">
      <PageHeader title="Configuración del sistema" />
      <Card>
        <div className="grid gap-4">
          <Field label="Estrategia de asignación predeterminada" hint="FIFO por defecto. FEFO usa caducidad; FULL_PALLET prefiere pallets completos; CASE_PIECE prefiere ubicaciones de picking.">
            <Select value={f.allocation_strategy} onChange={(e) => setF({ ...f, allocation_strategy: e.target.value })}>
              {ALLOCATION_STRATEGIES.map((s) => <option key={s}>{s}</option>)}
            </Select>
          </Field>
          <Field label="Umbral de diferencia para reconteo (piezas)" hint="0 = cualquier diferencia obliga a reconteo por otra persona.">
            <Input type="number" min={0} value={f.count_variance_recount_threshold} onChange={(e) => setF({ ...f, count_variance_recount_threshold: Number(e.target.value) })} />
          </Field>
          <Field label="Duración de sesión (horas, 1-72)">
            <Input type="number" min={1} max={72} value={f.session_ttl_hours} onChange={(e) => setF({ ...f, session_ttl_hours: Number(e.target.value) })} />
          </Field>
          <Checkbox label="Requerir MFA a administradores" checked={f.require_mfa_for_admin} onChange={(e) => setF({ ...f, require_mfa_for_admin: e.target.checked })} />
          <Alert tone="info">La regla de liberación de embarques (cargado = requerido por pedido y SKU) no es configurable por diseño.</Alert>
          <div>
            <Button onClick={() => save.mutate()} loading={save.isPending}>Guardar</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
