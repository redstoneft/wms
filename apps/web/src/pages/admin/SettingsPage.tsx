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
    mutationFn: () => adminApi.updateSettings({ allocation_strategy: f!.allocation_strategy, session_ttl_hours: Number(f!.session_ttl_hours), require_mfa_for_admin: f!.require_mfa_for_admin, orders_import_since: f!.orders_import_since ?? '', free_pick_enabled: f!.free_pick_enabled ?? true, auto_pick_customer_codes: f!.auto_pick_customer_codes ?? '', auto_pick_imported_orders: f!.auto_pick_imported_orders ?? false }),
    onSuccess: () => { toast.success('Configuración guardada (auditada)'); void qc.invalidateQueries({ queryKey: ['settings'] }); },
    onError: (e) => toast.error('No se pudo guardar', e),
  });
  if (!f) return <Skeleton className="h-40" />;
  return (
    <div className="max-w-2xl">
      <PageHeader title="Configuración del sistema" />
      <Card>
        <div className="grid gap-4">
          <Field label="Estrategia de asignación predeterminada" hint="FINISH_PALLET (regla de piso): 1) acabar tarimas, las que se vacían completas van primero, de menor a mayor; 2) cajas completas, solo se abre una tarima y de preferencia la que queda en cajas cerradas. FULL_PALLET prefiere pallets completos; FEFO usa caducidad; CASE_PIECE prefiere ubicaciones de picking.">
            <Select value={f.allocation_strategy} onChange={(e) => setF({ ...f, allocation_strategy: e.target.value })}>
              {ALLOCATION_STRATEGIES.map((s) => <option key={s}>{s}</option>)}
            </Select>
          </Field>
          <Field label="Duración de sesión (horas, 1-72)">
            <Input type="number" min={1} max={72} value={f.session_ttl_hours} onChange={(e) => setF({ ...f, session_ttl_hours: Number(e.target.value) })} />
          </Field>
          <Checkbox label="Requerir MFA a administradores" checked={f.require_mfa_for_admin} onChange={(e) => setF({ ...f, require_mfa_for_admin: e.target.checked })} />
          <Field label="Importar pedidos de la plataforma (Walmart/HEB) desde" hint="Fecha de arranque: los pedidos con fecha anterior nunca se importan al WMS aunque sigan abiertos en la plataforma de etiquetas. Solo se importan pedidos en estatus validado.">
            <Input type="date" value={f.orders_import_since ?? ''} onChange={(e) => setF({ ...f, orders_import_since: e.target.value })} />
          </Field>
          <Checkbox label="Surtido libre en la handheld (armar un pedido escaneando tarimas, sin capturar sus modelos). Desmarcado: todo pedido debe tener sus modelos antes de surtirse." checked={f.free_pick_enabled ?? true} onChange={(e) => setF({ ...f, free_pick_enabled: e.target.checked })} />
          <Checkbox label="Pedidos importados de la plataforma (SAE) directo a surtir: al importarse se aceptan, se planean y aparecen en Surtir, sin importar el cliente." checked={f.auto_pick_imported_orders ?? false} onChange={(e) => setF({ ...f, auto_pick_imported_orders: e.target.checked })} />
          <Field label="Clientes con surtido automático" hint="Códigos de cliente separados por coma. Sus pedidos, al importarse de SAE o capturarse, se aceptan, se planean y aparecen de inmediato en Surtir (estado SURTIENDO).">
            <Input value={f.auto_pick_customer_codes ?? ''} onChange={(e) => setF({ ...f, auto_pick_customer_codes: e.target.value })} placeholder="Ej. 3, 206, 207, 208, 209, WMT" className="font-mono" />
          </Field>
          <Alert tone="info">La regla de liberación de embarques (cargado = requerido por pedido y SKU) no es configurable por diseño.</Alert>
          <div>
            <Button onClick={() => save.mutate()} loading={save.isPending}>Guardar</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
