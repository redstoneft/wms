import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { inboundApi } from '../../api/inbound';
import { incidentsApi } from '../../api/incidents';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../components/Toast';
import { Alert, Button, Card, ConfirmDialog, KV, PageHeader, Skeleton, StatusChip, Table } from '../../components/ui';
import { cls, es, fmtDateTime, fmtQty, toBigInt } from '../../lib/format';

export default function ReceiptDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['receipt', id], queryFn: () => inboundApi.receipt(id), refetchInterval: 10_000 });
  const incidents = useQuery({ queryKey: ['incidents', 'receipt', id], queryFn: () => incidentsApi.list({ entity_type: 'receipt', entity_id: id, limit: 50 }) });
  const [confirmComplete, setConfirmComplete] = useState(false);
  const [differences, setDifferences] = useState<{ sku: string; expected: string; received: string }[] | null>(null);
  const r = q.data;

  const complete = useMutation({
    mutationFn: (accept: boolean) => inboundApi.complete({ receipt_id: id, accept_differences: accept }),
    onSuccess: (res) => {
      toast.success(`Recepción ${es(res.receipt.status)}`, res.incidents.length ? `${res.incidents.length} incidencia(s) creadas` : `${res.putaway_tasks.length} tareas de put-away`);
      setConfirmComplete(false);
      setDifferences(null);
      void qc.invalidateQueries({ queryKey: ['receipt', id] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'RECEIPT_DIFFERENCES') {
        setDifferences((e.details as { differences: { sku: string; expected: string; received: string }[] }).differences);
        return;
      }
      toast.error('No se pudo completar', e);
    },
  });
  const close = useMutation({
    mutationFn: () => inboundApi.close(id),
    onSuccess: () => {
      toast.success('Recepción cerrada');
      void qc.invalidateQueries({ queryKey: ['receipt', id] });
    },
    onError: (e) => toast.error('No se pudo cerrar', e),
  });

  if (q.isLoading) return <Skeleton className="h-64" />;
  if (!r) return <Alert tone="error">Recepción no encontrada</Alert>;
  const lines = r.lines ?? [];
  const open = r.status === 'OPEN' || r.status === 'IN_PROGRESS';

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <span className="font-mono">{r.receipt_number}</span> <StatusChip status={r.status} />
          </span>
        }
        subtitle={
          <>
            {r.container && 'container_number' in r.container && (
              <>
                Contenedor{' '}
                <Link className="text-sky-700 underline" to={`/inbound/containers/${r.container_id}`}>
                  {r.container.container_number}
                </Link>{' '}
                ·{' '}
              </>
            )}
            Inicio {fmtDateTime(r.started_at)}
          </>
        }
        actions={
          <>
            <Link to="/inbound/receipts" className="text-sm text-sky-700 underline">
              ← Recepciones
            </Link>
            {open && can('receiving.scan') && (
              <>
                <Button variant="success" onClick={() => nav(`/wm/receive?receipt=${r.id}`)}>
                  Escanear (RF)
                </Button>
                <Button onClick={() => setConfirmComplete(true)}>Completar recepción</Button>
              </>
            )}
            {(r.status === 'COMPLETED' || r.status === 'WITH_INCIDENT') && can('receiving.close') && (
              <Button variant="secondary" onClick={() => close.mutate()} loading={close.isPending}>
                Cerrar recepción
              </Button>
            )}
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Esperado vs recibido" className="lg:col-span-2" padded={false}>
          <Table
            rows={lines}
            rowKey={(l) => l.id}
            empty="Sin líneas esperadas (recepción ciega)"
            columns={[
              { key: 'sku', header: 'SKU', render: (l) => <span className="font-mono font-semibold">{l.sku.code}</span> },
              { key: 'd', header: 'Descripción', render: (l) => l.sku.description },
              { key: 'e', header: 'Esperado', render: (l) => fmtQty(l.expected_qty), align: 'right' },
              {
                key: 'r',
                header: 'Recibido',
                render: (l) => {
                  const e = toBigInt(l.expected_qty);
                  const rc = toBigInt(l.received_qty);
                  return <span className={cls('font-bold tabular-nums', e === 0n ? 'text-amber-700' : rc === e ? 'text-emerald-700' : rc < e ? 'text-rose-700' : 'text-amber-700')}>{fmtQty(rc)}</span>;
                },
                align: 'right',
              },
              { key: 'dm', header: 'Dañado', render: (l) => (toBigInt(l.damaged_qty) > 0n ? <span className="text-rose-700">{fmtQty(l.damaged_qty)}</span> : '—'), align: 'right' },
              { key: 'dif', header: 'Diferencia', render: (l) => {
                  const d = toBigInt(l.received_qty) - toBigInt(l.expected_qty);
                  return <span className={cls('tabular-nums', d === 0n ? 'text-slate-400' : d < 0n ? 'text-rose-700' : 'text-amber-700')}>{d > 0n ? '+' : ''}{fmtQty(d)}</span>;
                }, align: 'right' },
              { key: 's', header: 'Estado', render: (l) => <StatusChip status={l.status} /> },
            ]}
          />
        </Card>
        <Card title="Resumen">
          <dl className="grid gap-3">
            <KV label="Estado">
              <StatusChip status={r.status} />
            </KV>
            <KV label="LPNs creados">{r.lpns?.length ?? 0}</KV>
            <KV label="Total esperado">{fmtQty(lines.reduce((a, l) => a + toBigInt(l.expected_qty), 0n))}</KV>
            <KV label="Total recibido">{fmtQty(lines.reduce((a, l) => a + toBigInt(l.received_qty), 0n))}</KV>
            <KV label="Completada">{fmtDateTime(r.completed_at)}</KV>
            <KV label="Cerrada">{fmtDateTime(r.closed_at)}</KV>
            <KV label="Notas">{r.notes ?? '—'}</KV>
          </dl>
        </Card>
      </div>

      <Card title={`Pallets creados (${r.lpns?.length ?? 0})`} className="mt-4" padded={false}>
        <Table
          rows={r.lpns ?? []}
          rowKey={(l) => l.id}
          onRowClick={(l) => nav(`/inventory/lpn/${l.code}`)}
          empty="Aún no se han escaneado pallets"
          columns={[
            { key: 'c', header: 'LPN', render: (l) => <span className="font-mono font-semibold">{l.code}</span> },
            { key: 's', header: 'Estado', render: (l) => <StatusChip status={l.status} /> },
            { key: 't', header: 'Tipo', render: (l) => l.lpn_type },
            { key: 'b', header: 'Contenido', render: (l) => (l.balances ?? []).filter((b) => toBigInt(b.qty) > 0n).map((b) => `${b.sku.code} × ${fmtQty(b.qty)} (${es(b.status)})`).join(', ') || '—' },
            { key: 'cs', header: 'Cajas', render: (l) => l.cases_count, align: 'right' },
            { key: 'cr', header: 'Creado', render: (l) => fmtDateTime(l.created_at) },
          ]}
        />
      </Card>

      <Card title={`Incidencias (${incidents.data?.total ?? 0})`} className="mt-4" padded={false}>
        <Table
          rows={incidents.data?.items}
          rowKey={(i) => i.id}
          onRowClick={(i) => nav(`/incidents/${i.id}`)}
          empty="Sin incidencias"
          columns={[
            { key: 'n', header: '#', render: (i) => i.incident_number },
            { key: 't', header: 'Tipo', render: (i) => es(i.incident_type) },
            { key: 'sv', header: 'Severidad', render: (i) => <StatusChip status={i.severity} /> },
            { key: 'ti', header: 'Título', render: (i) => i.title },
            { key: 's', header: 'Estado', render: (i) => <StatusChip status={i.status} /> },
          ]}
        />
      </Card>

      <ConfirmDialog
        open={confirmComplete}
        onClose={() => {
          setConfirmComplete(false);
          setDifferences(null);
        }}
        onConfirm={() => complete.mutate(!!differences)}
        title="Completar recepción"
        loading={complete.isPending}
        confirmLabel={differences ? 'Aceptar diferencias y completar' : 'Completar'}
        danger={!!differences}
      >
        {!differences && <p className="text-sm text-slate-700">Se compararán las cantidades esperadas contra las recibidas. Los LPN abiertos se cerrarán y se generarán tareas de put-away.</p>}
        {differences && (
          <div>
            <Alert tone="warn" title="Hay diferencias entre lo esperado y lo recibido">
              Se crearán incidencias de faltante/sobrante por cada SKU:
            </Alert>
            <ul className="mt-2 max-h-48 overflow-auto text-sm">
              {differences.map((d) => (
                <li key={d.sku} className="flex justify-between border-b border-slate-100 py-1">
                  <span className="font-mono">{d.sku}</span>
                  <span>
                    esperado {fmtQty(d.expected)} · recibido <b>{fmtQty(d.received)}</b>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}
