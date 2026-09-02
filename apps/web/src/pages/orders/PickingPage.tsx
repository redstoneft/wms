// /picking — supervision of pick tasks; short-line (supervisor only); staging lanes.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { pickingApi } from '../../api/orders';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../components/Toast';
import { Alert, Button, Card, Drawer, Field, PageHeader, Select, StatusChip, Table, Textarea } from '../../components/ui';
import { fmtDateTime, fmtQty } from '../../lib/format';

export default function PickingPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const [status, setStatus] = useState('PENDING,IN_PROGRESS');
  const tasks = useQuery({ queryKey: ['pick-tasks', status], queryFn: () => pickingApi.tasks({ status }), refetchInterval: 10_000 });
  const staging = useQuery({ queryKey: ['staging'], queryFn: pickingApi.staging, refetchInterval: 15_000 });
  const taskId = sp.get('task');
  const view = useQuery({ queryKey: ['pick-task', taskId], queryFn: () => pickingApi.task(taskId!), enabled: !!taskId, refetchInterval: 8_000 });
  const [short, setShort] = useState<{ lineId: string; reason: string } | null>(null);
  const doShort = useMutation({
    mutationFn: () => pickingApi.short({ pick_task_id: taskId!, line_id: short!.lineId, reason: short!.reason }),
    onSuccess: (r) => {
      toast.success('Línea cerrada como faltante', `Incidencia ${r.incident} · ${fmtQty(r.deallocated)} unidades liberadas`);
      setShort(null);
      void qc.invalidateQueries({ queryKey: ['pick-task', taskId] });
      void qc.invalidateQueries({ queryKey: ['pick-tasks'] });
    },
    onError: (e) => toast.error('No se pudo marcar faltante', e),
  });

  return (
    <div>
      <PageHeader
        title="Surtido"
        subtitle="Tareas dirigidas por ruta. La ejecución (escaneo) es en modo almacén; los faltantes sólo los cierra un supervisor aquí."
        actions={
          <>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-48">
              <option value="PENDING,IN_PROGRESS">Activas</option>
              <option value="COMPLETED">Completadas</option>
              <option value="CANCELLED">Canceladas</option>
            </Select>
            {can('picking.execute') && (
              <Link to="/wm/pick" className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white">
                Surtir (RF)
              </Link>
            )}
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Table
            rows={tasks.data}
            loading={tasks.isLoading}
            rowKey={(t) => t.id}
            onRowClick={(t) => setSp({ task: t.id })}
            selectedKey={taskId}
            columns={[
              { key: 'o', header: 'Pedido', render: (t) => <b>{t.order_number}</b> },
              { key: 'p', header: 'Prio', render: (t) => t.priority, align: 'center' },
              { key: 'c', header: 'Cliente', render: (t) => t.customer },
              { key: 's', header: 'Estado', render: (t) => <StatusChip status={t.status} /> },
              { key: 'u', header: 'Surtidor', render: (t) => t.assigned_username ?? 'sin asignar' },
              { key: 'l', header: 'Líneas', render: (t) => `${t.picked_lines}/${t.lines}`, align: 'right' },
              { key: 'st', header: 'Staging', render: (t) => <span className="font-mono">{t.staging_code ?? '—'}</span> },
              { key: 'cr', header: 'Creada', render: (t) => fmtDateTime(t.created_at) },
            ]}
          />
        </div>
        <Card title="Carriles de staging" padded={false}>
          <Table
            rows={staging.data}
            loading={staging.isLoading}
            rowKey={(s) => s.id}
            dense
            columns={[
              { key: 'c', header: 'Carril', render: (s) => <span className="font-mono font-semibold">{s.code}</span> },
              { key: 'o', header: 'Pedido', render: (s) => (s.order_number ? `${s.order_number} · ${s.customer}` : <span className="text-emerald-700">LIBRE</span>) },
              { key: 'n', header: 'LPN', render: (s) => fmtQty(s.lpn_count), align: 'right' },
            ]}
          />
        </Card>
      </div>

      <Drawer open={!!taskId} onClose={() => setSp({})} title={view.data ? `Tarea · ${view.data.order.order_number}` : 'Tarea'} width="max-w-4xl">
        {view.data && (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
              <StatusChip status={view.data.task.status} />
              <span>{view.data.order.customer}</span>
              <span>
                Staging <b className="font-mono">{view.data.staging?.code ?? '—'}</b>
              </span>
              {view.data.task.outbound_lpn && (
                <span>
                  LPN salida <b className="font-mono">{view.data.task.outbound_lpn}</b>
                </span>
              )}
              <Link to={`/orders/${view.data.order.id}`} className="ml-auto text-sky-700 underline">
                Ver pedido
              </Link>
            </div>
            <Table
              rows={view.data.lines}
              rowKey={(l) => l.id}
              dense
              columns={[
                { key: 'seq', header: '#', render: (l) => l.sequence },
                { key: 'loc', header: 'Ubicación', render: (l) => <span className="font-mono">{l.location_code}</span> },
                { key: 'lpn', header: 'LPN', render: (l) => <span className="font-mono">{l.lpn_code}</span> },
                { key: 'sku', header: 'SKU', render: (l) => <span className="font-mono">{l.sku_code}</span> },
                { key: 'q', header: 'Cant.', render: (l) => `${fmtQty(l.picked_qty)} / ${fmtQty(l.qty)}`, align: 'right' },
                { key: 'fp', header: 'Pallet completo', render: (l) => (l.full_pallet ? 'Sí' : '') },
                { key: 's', header: 'Estado', render: (l) => <StatusChip status={l.status} /> },
                { key: 'step', header: 'Paso', render: (l) => ['—', 'ubicación ok', 'pallet ok'][l.scan_step] ?? l.scan_step },
                {
                  key: 'a',
                  header: '',
                  render: (l) =>
                    can('picking.assign') && (l.status === 'PENDING' || l.status === 'IN_PROGRESS') && view.data?.task.status === 'IN_PROGRESS' && (
                      <Button size="sm" variant="danger" onClick={() => setShort({ lineId: l.id, reason: '' })}>
                        Faltante
                      </Button>
                    ),
                },
              ]}
            />
            {short && (
              <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3">
                <Alert tone="warn" className="mb-2">
                  Cerrar la línea como faltante libera el resto asignado y crea una incidencia PICKING_ERROR. El pedido quedará con surtido &lt; requerido y el embarque NO podrá liberarse hasta resolverlo.
                </Alert>
                <Field label="Motivo (mín. 3)" required>
                  <Textarea value={short.reason} onChange={(e) => setShort({ ...short, reason: e.target.value })} />
                </Field>
                <div className="mt-2 flex gap-2">
                  <Button variant="danger" onClick={() => doShort.mutate()} loading={doShort.isPending} disabled={short.reason.trim().length < 3}>
                    Confirmar faltante
                  </Button>
                  <Button variant="secondary" onClick={() => setShort(null)}>
                    Cancelar
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
