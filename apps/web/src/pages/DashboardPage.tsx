import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { dashboardApi } from '../api/dashboard';
import { Alert, Card, PageHeader, Select, Skeleton, Stat, StatusChip } from '../components/ui';
import { es, fmtDateTime, fmtNum, fmtPct, fmtQty, relTime } from '../lib/format';

function sum(m: Record<string, number> | undefined) {
  return Object.values(m ?? {}).reduce((a, b) => a + b, 0);
}
function Breakdown({ m, to }: { m: Record<string, number> | undefined; to?: string }) {
  const entries = Object.entries(m ?? {});
  if (!entries.length) return <span className="text-xs text-slate-400">sin pendientes</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([k, v]) => (
        <Link key={k} to={to ? `${to}?status=${k}` : '#'} className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-xs hover:bg-slate-50">
          <StatusChip status={k} /> <b>{v}</b>
        </Link>
      ))}
    </div>
  );
}

const PERIODS = [
  { key: '7', label: 'Últimos 7 días' },
  { key: '30', label: 'Últimos 30 días' },
  { key: '90', label: 'Últimos 90 días' },
  { key: '365', label: 'Último año' },
];

export default function DashboardPage() {
  const dash = useQuery({ queryKey: ['dashboard'], queryFn: dashboardApi.get, refetchInterval: 15_000 });
  const [period, setPeriod] = useState('30');
  const from = new Date(Date.now() - Number(period) * 86400_000).toISOString();
  const kpis = useQuery({ queryKey: ['kpis', period], queryFn: () => dashboardApi.kpis({ from }) });
  const d = dash.data;

  return (
    <div>
      <PageHeader title="Tablero operativo" subtitle={d ? `Actualizado ${relTime(d.generated_at)} · se refresca cada 15 s` : 'Cargando…'} />
      {dash.error && <Alert tone="error">No se pudo cargar el tablero.</Alert>}
      {d?.alerts.length ? (
        <div className="mb-4 space-y-2">
          {d.alerts.map((a, i) => (
            <Alert key={i} tone={a.level === 'error' ? 'error' : 'warn'}>
              {a.text}
            </Alert>
          ))}
        </div>
      ) : null}

      {!d ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Contenedores esperando" value={d.containers.SCHEDULED ?? 0} sub={<Breakdown m={d.containers} to="/inbound/containers" />} />
            <Stat label="Recepciones abiertas" value={sum(d.receipts)} sub={<Breakdown m={d.receipts} to="/inbound/receipts" />} />
            <Stat label="Pallets sin ubicación" value={d.pallets_without_location} tone={d.pallets_without_location > 0 ? 'warn' : 'default'} sub="en recepción sin put-away confirmado" />
            <Stat label="Tareas put-away" value={sum(d.putaway_tasks)} sub={<Breakdown m={d.putaway_tasks} to="/storage" />} />
            <Stat label="Pedidos activos" value={sum(d.orders)} sub={<Breakdown m={d.orders} to="/orders" />} />
            <Stat label="Tareas de surtido" value={sum(d.pick_tasks)} sub={<Breakdown m={d.pick_tasks} to="/picking" />} />
            <Stat label="Staging usado" value={`${d.staging.used} / ${d.staging.total}`} sub={<progress className="w-full" value={d.staging.used} max={d.staging.total || 1} />} tone={d.staging.total && d.staging.used >= d.staging.total ? 'warn' : 'default'} />
            <Stat label="Embarques" value={sum(d.shipments)} sub={<Breakdown m={d.shipments} to="/shipments" />} tone={d.shipments.BLOCKED ? 'error' : 'default'} />
            <Stat label="Incidencias abiertas" value={sum(d.incidents)} sub={<Breakdown m={d.incidents} to="/incidents" />} tone={d.incidents.CRITICAL ? 'error' : d.incidents.HIGH ? 'warn' : 'default'} />
            <Stat label="Conteos cíclicos" value={sum(d.cycle_counts)} sub={<Breakdown m={d.cycle_counts} to="/storage" />} />
            <Stat label="Traslados en tránsito" value={d.transfers_in_transit} sub={`${d.replenishment_tasks} tareas de reabasto`} />
            <Stat
              label="Ocupación de almacén"
              value={fmtPct(d.occupancy.utilization_pct)}
              tone={d.occupancy.utilization_pct > 90 ? 'warn' : 'ok'}
              sub={`${d.occupancy.occupied} ocupadas · ${d.occupancy.partial} parciales · ${d.occupancy.blocked} bloqueadas de ${d.occupancy.total}`}
            />
          </div>
        </>
      )}

      <div className="mt-6">
        <Card
          title="Indicadores (KPIs)"
          actions={
            <Select value={period} onChange={(e) => setPeriod(e.target.value)} className="w-44" aria-label="Periodo">
              {PERIODS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </Select>
          }
        >
          {kpis.isLoading && <Skeleton className="h-32" />}
          {kpis.data && (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Stat label="Exactitud de inventario" value={fmtPct(kpis.data.inventory_accuracy_pct)} sub="líneas de conteo sin diferencia" />
                <Stat label="Exactitud de recepción" value={fmtPct(kpis.data.receiving_accuracy_pct)} sub="líneas recibidas = esperadas" />
                <Stat label="Exactitud de surtido" value={fmtPct(kpis.data.picking_accuracy_pct)} sub="verificaciones aprobadas" />
                <Stat label="Exactitud de carga" value={fmtPct(kpis.data.loading_accuracy_pct)} sub="embarques liberados al primer intento" />
                <Stat label="Dock-to-stock" value={kpis.data.dock_to_stock_hours.avg === null ? '—' : `${fmtNum(kpis.data.dock_to_stock_hours.avg, 1)} h`} sub={`p90 ${kpis.data.dock_to_stock_hours.p90 === null ? '—' : fmtNum(kpis.data.dock_to_stock_hours.p90, 1) + ' h'}`} />
                <Stat label="Productividad surtido" value={kpis.data.picking_productivity_lines_per_hour === null ? '—' : fmtNum(kpis.data.picking_productivity_lines_per_hour, 1)} sub="líneas / operador-hora" />
                <Stat label="Productividad recepción" value={kpis.data.receiving_productivity_lines_per_hour === null ? '—' : fmtNum(kpis.data.receiving_productivity_lines_per_hour, 1)} sub="líneas / operador-hora" />
                <Stat label="Ciclo de pedido" value={kpis.data.order_cycle_time_hours === null ? '—' : `${fmtNum(kpis.data.order_cycle_time_hours, 1)} h`} sub={`${kpis.data.orders_shipped} pedidos embarcados`} />
                <Stat label="Incidencias / 1000 mov." value={kpis.data.incidence_rate_per_1000_movements === null ? '—' : fmtNum(kpis.data.incidence_rate_per_1000_movements, 2)} />
                <Stat label="Discrepancias de stock" value={kpis.data.stock_discrepancies.lines} sub={`${fmtQty(kpis.data.stock_discrepancies.abs_units)} unidades absolutas`} />
                <Stat label="Utilización" value={fmtPct(kpis.data.warehouse_utilization_pct)} />
              </div>
              <div className="mt-4 grid gap-4 md:grid-cols-3">
                {(
                  [
                    ['Errores por usuario', kpis.data.errors_by_user.map((e) => [e.username, e.errors] as const)],
                    ['Incidencias por SKU', kpis.data.errors_by_sku.map((e) => [e.sku, e.errors] as const)],
                    ['Incidencias por cliente', kpis.data.errors_by_customer.map((e) => [e.customer, e.errors] as const)],
                  ] as const
                ).map(([title, rows]) => (
                  <div key={title} className="rounded-lg border border-slate-200">
                    <div className="border-b border-slate-100 px-3 py-2 text-xs font-semibold uppercase text-slate-500">{title}</div>
                    {rows.length === 0 ? (
                      <div className="px-3 py-4 text-xs text-slate-400">Sin datos en el periodo</div>
                    ) : (
                      <ul className="divide-y divide-slate-100 text-sm">
                        {rows.map(([k, v]) => (
                          <li key={k} className="flex justify-between px-3 py-1.5">
                            <span className="truncate">{k}</span>
                            <b className="tabular-nums">{v}</b>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-slate-400">
                Periodo {fmtDateTime(kpis.data.period.from)} → {fmtDateTime(kpis.data.period.to)} · {es('COMPLETED')}
              </p>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
