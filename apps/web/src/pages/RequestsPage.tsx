// /requests — what the floor staff asked the office to decide: pallet re-receipts and counts with differences.
// Each request shows what the system had, what the operator says is there and what the pallet holds today; the
// approver applies it or rejects it with a reason. A request whose pallet moved after the count cannot be applied.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { requestsApi, type StaffRequest } from '../api/requests';
import { useToast } from '../components/Toast';
import { Alert, Badge, Button, Card, EmptyState, Modal, PageHeader, Stat, Tabs, Textarea } from '../components/ui';
import { fmtDateTime, fmtQty } from '../lib/format';

type Filter = 'ALL' | 'OK' | 'STALE';

export default function RequestsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const view = useQuery({ queryKey: ['requests'], queryFn: requestsApi.list, refetchInterval: 30_000 });
  const [filter, setFilter] = useState<Filter>('ALL');
  const [dialog, setDialog] = useState<{ req: StaffRequest | null; bulk: StaffRequest[]; decision: 'APPROVE' | 'REJECT'; reason: string } | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['requests'] });
    void qc.invalidateQueries({ queryKey: ['requests-pending'] });
  };
  const decide = useMutation({
    mutationFn: async () => {
      const d = dialog!;
      const targets = d.req ? [d.req] : d.bulk;
      const results = [];
      for (const t of targets) results.push(await requestsApi.decide(t.id, { decision: d.decision, reason: d.reason.trim() }));
      return results;
    },
    onSuccess: (results) => {
      const d = dialog!;
      if (d.decision === 'REJECT') toast.success(results.length > 1 ? `${results.length} solicitudes rechazadas` : 'Solicitud rechazada', 'El inventario no cambió');
      else if (results[0]!.status === 'APPROVED') toast.success('Solicitud aprobada', `${results[0]!.adjusted} ajuste(s) aplicados al inventario`);
      else toast.error('No se pudo aplicar', 'La tarima tuvo movimientos después del conteo. Recházala o pide que la re-reciban de nuevo.');
      setDialog(null);
      refresh();
    },
    onError: (e) => {
      toast.error('No se pudo registrar la decisión', e);
      refresh();
    },
  });

  const all = view.data?.requests ?? [];
  const ok = all.filter((r) => r.applicable);
  const stale = all.filter((r) => !r.applicable);
  const shown = filter === 'OK' ? ok : filter === 'STALE' ? stale : all;
  const o = view.data?.other;

  return (
    <div>
      <PageHeader title="Solicitudes del personal" subtitle="Lo que los operadores piden desde el handheld y necesita tu decisión. Nada cambia en el inventario hasta que apruebas." />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Esperan tu decisión" value={all.length} tone={all.length ? 'warn' : 'ok'} sub={stale.length ? `${stale.length} ya no se pueden aplicar` : undefined} />
        <Link to="/incidents"><Stat label="Incidencias abiertas" value={o?.incidents_open ?? '—'} sub="Ver incidencias" /></Link>
        <Link to="/inbound/receipts"><Stat label="Recepciones por cerrar" value={o?.receipts_to_close ?? '—'} sub="Ver recepciones" /></Link>
        <Link to="/returns"><Stat label="Devoluciones en inspección" value={o?.returns_inspecting ?? '—'} sub="Ver devoluciones" /></Link>
        <Link to="/assembly"><Stat label="Armados en proceso" value={o?.assemblies_open ?? '—'} sub="Ver armados" /></Link>
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Tabs<Filter> value={filter} onChange={setFilter} tabs={[{ key: 'ALL', label: 'Todas', count: all.length }, { key: 'OK', label: 'Se pueden aplicar', count: ok.length }, { key: 'STALE', label: 'Vencidas', count: stale.length }]} />
        {stale.length > 0 && (
          <Button variant="secondary" onClick={() => setDialog({ req: null, bulk: stale, decision: 'REJECT', reason: 'Vencida: la tarima tuvo movimientos después del conteo' })}>
            Rechazar las {stale.length} vencidas
          </Button>
        )}
      </div>

      {view.isLoading && <Card>Cargando…</Card>}
      {!view.isLoading && shown.length === 0 && <EmptyState title="No hay solicitudes pendientes" hint="Cuando un operador re-reciba una tarima o termine un conteo con diferencias aparecerá aquí." />}

      <div className="grid gap-3">
        {shown.map((r) => (
          <Card key={r.id} padded>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={r.kind === 'RE_RECEIPT' ? 'violet' : 'sky'}>{r.kind === 'RE_RECEIPT' ? 'Re-recepción de tarima' : 'Conteo con diferencias'}</Badge>
                  {r.lpn && <Link to={`/timeline/${r.lpn}`} className="font-mono text-sm font-semibold text-sky-700 underline">{r.lpn}</Link>}
                  {!r.applicable && <Badge tone="amber">Vencida</Badge>}
                </div>
                <div className="mt-1 text-sm text-slate-600">
                  <b>{r.requested_by ?? '—'}</b> · {fmtDateTime(r.created_at)}
                </div>
                {r.purpose && <div className="mt-1 text-sm">Motivo del operador: <i>{r.purpose}</i></div>}
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setDialog({ req: r, bulk: [], decision: 'REJECT', reason: '' })}>Rechazar</Button>
                <Button disabled={!r.applicable} onClick={() => setDialog({ req: r, bulk: [], decision: 'APPROVE', reason: 'Revisado y aprobado' })}>Aprobar</Button>
              </div>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-500">
                    <th className="py-1 pr-3">Ubicación</th>
                    <th className="py-1 pr-3">Producto</th>
                    <th className="py-1 pr-3 text-right">Sistema tenía</th>
                    <th className="py-1 pr-3 text-right">Operador contó</th>
                    <th className="py-1 pr-3 text-right">Diferencia</th>
                    <th className="py-1 text-right">Hoy tiene</th>
                  </tr>
                </thead>
                <tbody>
                  {r.lines.map((l) => {
                    const d = Number(l.delta);
                    return (
                      <tr key={l.line_id} className="border-b border-slate-100 align-top">
                        <td className="py-1 pr-3 font-mono text-xs">{l.location}</td>
                        <td className="py-1 pr-3"><span className="font-mono font-semibold">{l.sku}</span> <span className="text-slate-500">{l.description}</span></td>
                        <td className="py-1 pr-3 text-right">{fmtQty(l.system_qty)}</td>
                        <td className="py-1 pr-3 text-right font-semibold">{fmtQty(l.proposed_qty)}</td>
                        <td className={`py-1 pr-3 text-right font-bold ${d < 0 ? 'text-rose-600' : d > 0 ? 'text-emerald-600' : ''}`}>{d > 0 ? '+' : ''}{fmtQty(l.delta)}</td>
                        <td className="py-1 text-right">{fmtQty(l.current_qty)}</td>
                      </tr>
                    );
                  })}
                  {r.lines.length === 0 && <tr><td colSpan={6} className="py-2 text-slate-500">Sin diferencias por aplicar.</td></tr>}
                </tbody>
              </table>
            </div>
            {!r.applicable && (
              <Alert tone="warn" className="mt-3" title="Ya no se puede aplicar">
                {[...new Set(r.lines.map((l) => l.why).filter(Boolean))].join(' · ') || 'No tiene diferencias vigentes.'} Recházala; si la diferencia sigue, pide que re-reciban la tarima otra vez.
              </Alert>
            )}
          </Card>
        ))}
      </div>

      <Modal
        open={!!dialog}
        onClose={() => setDialog(null)}
        title={dialog?.decision === 'APPROVE' ? 'Aprobar solicitud' : dialog?.req ? 'Rechazar solicitud' : `Rechazar ${dialog?.bulk.length ?? 0} solicitudes vencidas`}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDialog(null)}>Cancelar</Button>
            <Button onClick={() => decide.mutate()} loading={decide.isPending} disabled={(dialog?.reason.trim().length ?? 0) < 3}>
              {dialog?.decision === 'APPROVE' ? 'Aprobar y ajustar inventario' : 'Rechazar'}
            </Button>
          </div>
        }
      >
        {dialog && (
          <div className="grid gap-3 text-sm">
            {dialog.decision === 'APPROVE' && dialog.req && (
              <Alert tone="info">
                El inventario de {dialog.req.lpn ?? 'la ubicación'} quedará como lo contó {dialog.req.requested_by ?? 'el operador'}:{' '}
                {dialog.req.lines.map((l) => `${l.sku} ${fmtQty(l.system_qty)} → ${fmtQty(l.proposed_qty)}`).join(', ')}. Queda auditado con tu usuario.
              </Alert>
            )}
            {dialog.decision === 'REJECT' && <Alert tone="info">El inventario no cambia. El operador puede volver a re-recibir la tarima si la diferencia sigue.</Alert>}
            <label className="block">
              <div className="mb-1 font-semibold">Motivo (mínimo 3 letras)</div>
              <Textarea value={dialog.reason} onChange={(e) => setDialog({ ...dialog, reason: e.target.value })} rows={3} />
            </label>
          </div>
        )}
      </Modal>
    </div>
  );
}
