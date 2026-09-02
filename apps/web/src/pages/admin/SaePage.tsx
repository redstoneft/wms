import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { saeApi, type SaeEntity, type SaeRun, type SaeStockCompare, type SaeSyncResult } from '../../api/sae';
import { Alert, Badge, Button, Card, PageHeader, Stat, Table, Tabs } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { fmtDateTime, fmtQty, relTime } from '../../lib/format';

const ENTITY_LABEL: Record<SaeEntity, string> = {
  suppliers: 'Proveedores',
  customers: 'Clientes',
  skus: 'Artículos (SKUs)',
  purchase_orders: 'Órdenes de compra',
  customer_orders: 'Pedidos de clientes',
};

function runTone(status: string): 'emerald' | 'rose' | 'amber' {
  return status === 'OK' ? 'emerald' : status === 'FAILED' ? 'rose' : 'amber';
}

type Tab = 'status' | 'runs' | 'stock';

export default function SaePage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('status');
  const [lastResults, setLastResults] = useState<SaeSyncResult[] | null>(null);
  const [openRun, setOpenRun] = useState<SaeRun | null>(null);

  const status = useQuery({ queryKey: ['sae', 'status'], queryFn: saeApi.status, refetchInterval: 60_000 });
  const runs = useQuery({ queryKey: ['sae', 'runs'], queryFn: () => saeApi.runs({ limit: 100 }), enabled: tab === 'runs' });
  const stock = useQuery({ queryKey: ['sae', 'stock'], queryFn: saeApi.stockCompare, enabled: tab === 'stock', staleTime: 5 * 60_000 });

  const sync = useMutation({
    mutationFn: (entities?: SaeEntity[]) => saeApi.sync(entities),
    onSuccess: (r) => {
      setLastResults(r.results);
      const failed = r.results.filter((x) => x.status === 'FAILED');
      const errors = r.results.reduce((a, x) => a + x.errors.length, 0);
      if (failed.length) toast.error('Sincronización con fallas', failed.map((x) => `${ENTITY_LABEL[x.entity]}: ${x.notes ?? 'error'}`).join('; '));
      else if (errors) toast.warn('Sincronización terminada con observaciones', `${errors} referencia(s) no pudieron aplicarse; revise el detalle`);
      else toast.success('Sincronización completa');
      qc.invalidateQueries({ queryKey: ['sae'] });
    },
    onError: (e) => toast.error('No se pudo sincronizar', e),
  });

  const s = status.data;
  const configured = !!s && s.configured.erp && s.configured.raw;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Integración Aspel SAE"
        subtitle="Lectura de los espejos de SAE (artículos, clientes, proveedores, órdenes de compra, pedidos). El WMS nunca escribe en SAE ni crea inventario desde SAE."
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => status.refetch()} loading={status.isFetching}>Actualizar</Button>
            <Button onClick={() => sync.mutate(undefined)} loading={sync.isPending} disabled={!configured}>Sincronizar todo ahora</Button>
          </div>
        }
      />

      {status.isError && <Alert tone="error" title="No se pudo consultar el estado de la integración" />}
      {s && !configured && (
        <Alert tone="warn" title="Integración no configurada">
          Faltan las variables <code>SAE_SUPABASE_URL/KEY</code> {s.configured.raw ? '' : 'y '}
          {s.configured.raw ? '' : <code>SAE_RAW_SUPABASE_URL/KEY</code>} en el servidor. Ver docs/INTEGRATION_SAE.md.
        </Alert>
      )}

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'status', label: 'Estado' },
          { key: 'runs', label: 'Historial de corridas' },
          { key: 'stock', label: 'Existencias SAE vs WMS' },
        ]}
      />

      {tab === 'status' && s && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label="Artículos SAE en WMS" value={fmtQty(s.wms_counts.skus)} />
            <Stat label="Clientes" value={fmtQty(s.wms_counts.customers)} />
            <Stat label="Proveedores" value={fmtQty(s.wms_counts.suppliers)} />
            <Stat label="Órdenes de compra" value={fmtQty(s.wms_counts.pos)} sub={`abiertas, últimos ${s.po_since_days} días`} />
            <Stat label="Pedidos de clientes" value={fmtQty(s.wms_counts.orders)} />
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <Card title="Fuentes">
              <dl className="space-y-1 text-sm">
                <div className="flex justify-between gap-2"><dt className="text-slate-500">ERP (PEDIDOS / existencias / OC)</dt><dd className="font-mono">{s.configured.erp_host ?? '—'}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-slate-500">Última actualización ERP</dt><dd title={fmtDateTime(s.source_freshness.erp_updated_at)}>{s.source_freshness.erp_updated_at ? relTime(s.source_freshness.erp_updated_at) : 'sin datos'}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-slate-500">Espejo crudo SAE (artículos/clientes/proveedores)</dt><dd className="font-mono">{s.configured.raw_host ?? '—'}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-slate-500">Última replicación SAE</dt><dd title={fmtDateTime(s.source_freshness.raw_synced_at)}>{s.source_freshness.raw_synced_at ? relTime(s.source_freshness.raw_synced_at) : 'sin datos'}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-slate-500">Sincronización automática</dt><dd>cada {s.interval_minutes} min</dd></div>
              </dl>
            </Card>
            <Card title="Última corrida por entidad">
              <Table<SaeRun>
                dense
                rows={s.entities.map((e) => s.last_runs.find((r) => r.entity === e)).filter((r): r is SaeRun => !!r)}
                rowKey={(r) => r.id}
                empty="Aún no se ha sincronizado"
                columns={[
                  { key: 'entity', header: 'Entidad', render: (r) => <div className="flex items-center gap-2">{ENTITY_LABEL[r.entity]}<Badge tone={runTone(r.status)}>{r.status}</Badge></div> },
                  { key: 'when', header: 'Cuándo', render: (r) => <span title={fmtDateTime(r.started_at)}>{relTime(r.started_at)} · {r.trigger === 'MANUAL' ? 'manual' : 'automática'}</span> },
                  { key: 'rows', header: 'Origen', align: 'right', render: (r) => fmtQty(r.source_rows) },
                  { key: 'created', header: 'Creados', align: 'right', render: (r) => fmtQty(r.created) },
                  { key: 'updated', header: 'Actualizados', align: 'right', render: (r) => fmtQty(r.updated) },
                  { key: 'errors', header: 'Errores', align: 'right', render: (r) => (r.error_count ? <span className="font-semibold text-amber-700">{r.error_count}</span> : '0') },
                  { key: 'act', header: '', render: (r) => <Button size="sm" variant="secondary" onClick={() => sync.mutate([r.entity])} loading={sync.isPending} disabled={!configured}>Sincronizar</Button> },
                ]}
              />
              <div className="mt-3 flex flex-wrap gap-2">
                {s.entities.filter((e) => !s.last_runs.some((r) => r.entity === e)).map((e) => (
                  <Button key={e} size="sm" variant="secondary" onClick={() => sync.mutate([e])} loading={sync.isPending} disabled={!configured}>Sincronizar {ENTITY_LABEL[e].toLowerCase()}</Button>
                ))}
              </div>
            </Card>
          </div>

          {lastResults && (
            <Card title="Resultado de la última sincronización manual">
              <div className="space-y-3">
                {lastResults.map((r) => (
                  <div key={r.run_id} className="rounded border border-slate-200 p-3">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-semibold">{ENTITY_LABEL[r.entity]}</span>
                      <Badge tone={runTone(r.status)}>{r.status}</Badge>
                      <span className="text-slate-600">origen {fmtQty(r.source_rows)} · creados {fmtQty(r.created)} · actualizados {fmtQty(r.updated)} · omitidos {fmtQty(r.skipped)}</span>
                      {r.notes && <span className="text-slate-500">— {r.notes}</span>}
                    </div>
                    {r.errors.length > 0 && (
                      <ul className="mt-2 max-h-48 list-disc space-y-0.5 overflow-auto pl-5 text-xs text-amber-800">
                        {r.errors.map((e, i) => <li key={i}><span className="font-mono">{e.ref}</span>: {e.message}</li>)}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}

      {tab === 'runs' && (
        <Card title="Corridas registradas" padded={false}>
          <Table<SaeRun>
            dense
            loading={runs.isLoading}
            rows={runs.data}
            rowKey={(r) => r.id}
            onRowClick={(r) => setOpenRun(openRun?.id === r.id ? null : r)}
            selectedKey={openRun?.id ?? null}
            empty="Sin corridas"
            columns={[
              { key: 'started', header: 'Inicio', render: (r) => fmtDateTime(r.started_at) },
              { key: 'entity', header: 'Entidad', render: (r) => ENTITY_LABEL[r.entity] },
              { key: 'trigger', header: 'Disparo', render: (r) => (r.trigger === 'MANUAL' ? 'Manual' : 'Automática') },
              { key: 'status', header: 'Estado', render: (r) => <Badge tone={runTone(r.status)}>{r.status}</Badge> },
              { key: 'rows', header: 'Origen', align: 'right', render: (r) => fmtQty(r.source_rows) },
              { key: 'created', header: 'Creados', align: 'right', render: (r) => fmtQty(r.created) },
              { key: 'updated', header: 'Actualizados', align: 'right', render: (r) => fmtQty(r.updated) },
              { key: 'skipped', header: 'Omitidos', align: 'right', render: (r) => fmtQty(r.skipped) },
              { key: 'errors', header: 'Errores', align: 'right', render: (r) => fmtQty(r.errors?.length ?? r.error_count ?? 0) },
              { key: 'notes', header: 'Notas', render: (r) => r.notes ?? '' },
            ]}
          />
          {openRun && (
            <div className="border-t border-slate-200 p-3 text-sm">
              <div className="mb-1 font-semibold">Detalle · {ENTITY_LABEL[openRun.entity]} · {fmtDateTime(openRun.started_at)}</div>
              {openRun.errors && openRun.errors.length > 0 ? (
                <ul className="max-h-64 list-disc space-y-0.5 overflow-auto pl-5 text-xs text-amber-800">
                  {openRun.errors.map((e, i) => <li key={i}><span className="font-mono">{e.ref}</span>: {e.message}</li>)}
                </ul>
              ) : (
                <div className="text-slate-500">Sin errores en esta corrida.</div>
              )}
            </div>
          )}
        </Card>
      )}

      {tab === 'stock' && <StockCompare data={stock.data} loading={stock.isLoading} error={stock.isError} onRefresh={() => stock.refetch()} />}
    </div>
  );
}

function StockCompare({ data, loading, error, onRefresh }: { data: SaeStockCompare | undefined; loading: boolean; error: boolean; onRefresh: () => void }) {
  const [onlyInWms, setOnlyInWms] = useState(false);
  if (error) return <Alert tone="error" title="No se pudo leer las existencias de SAE" />;
  const rows = data ? (onlyInWms ? data.differences.filter((d) => d.in_wms) : data.differences) : undefined;
  return (
    <div className="space-y-3">
      <Alert tone="info" title="Solo comparación">
        Las existencias de SAE no modifican el inventario del WMS. Las diferencias se resuelven con conteos y ajustes autorizados.
      </Alert>
      {data && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="Productos" value={fmtQty(data.products)} sub={`${fmtQty(data.skus_sae)} claves SAE${data.sae_updated_at ? ` · SAE al ${fmtDateTime(data.sae_updated_at)}` : ''}`} />
          <Stat label="Coinciden" value={fmtQty(data.skus_matching)} tone="ok" />
          <Stat label="Difieren" value={fmtQty(data.skus_differing)} tone={data.skus_differing ? 'warn' : 'ok'} />
          <Stat label="Unidades SAE" value={fmtQty(data.sae_units)} />
          <Stat label="Unidades WMS" value={fmtQty(data.wms_units)} />
        </div>
      )}
      <Card
        title="Diferencias por clave"
        padded={false}
        actions={
          <div className="flex items-center gap-3 text-sm">
            <label className="flex items-center gap-1"><input type="checkbox" checked={onlyInWms} onChange={(e) => setOnlyInWms(e.target.checked)} /> solo claves que existen en el WMS</label>
            <Button size="sm" variant="secondary" onClick={onRefresh} loading={loading}>Recalcular</Button>
          </div>
        }
      >
        <Table<SaeStockCompare['differences'][number]>
          dense
          loading={loading}
          rows={rows}
          rowKey={(r) => r.sku}
          empty="Sin diferencias"
          columns={[
            { key: 'sku', header: 'Producto', render: (r) => <div><span className="font-mono">{r.sku}</span>{r.gtin && <div className="font-mono text-[11px] text-slate-500">{r.gtin}</div>}</div> },
            { key: 'desc', header: 'Descripción', render: (r) => r.description ?? '' },
            { key: 'keys', header: 'Claves SAE (existencia)', render: (r) => <span className="font-mono text-xs">{r.sae_keys.map((k) => `${k.key} ${fmtQty(k.existencia)}${Number(k.factor) > 1 ? `×${k.factor}` : ''}`).join(' · ')}</span> },
            { key: 'in', header: 'En WMS', render: (r) => (r.in_wms ? <Badge tone="emerald">sí</Badge> : <Badge tone="slate">no</Badge>) },
            { key: 'sae', header: 'SAE', align: 'right', render: (r) => fmtQty(r.sae_existencia) },
            { key: 'wms', header: 'WMS total', align: 'right', render: (r) => fmtQty(r.wms_total) },
            { key: 'avail', header: 'WMS disponible', align: 'right', render: (r) => fmtQty(r.wms_available) },
            { key: 'diff', header: 'Diferencia (WMS − SAE)', align: 'right', render: (r) => <span className={Number(r.diff) < 0 ? 'text-rose-700' : 'text-emerald-700'}>{fmtQty(r.diff)}</span> },
          ]}
        />
      </Card>
    </div>
  );
}
