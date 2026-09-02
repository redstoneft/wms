// /map — interactive 3D digital twin: filters, search, occupancy, side panel, edit mode.
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { layoutApi } from '../api/layout';
import type { MapLocation, MapSearchType } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../components/Toast';
import { Alert, Button, Input, Select, Skeleton, StatusChip } from '../components/ui';
import { cls, es, fmtDateTime, fmtNum, fmtQty, relTime } from '../lib/format';
import { AREA_TYPES, buildSceneModel, locationCenter, locationVisible, STATUS_COLORS, STATUS_LABELS, type MapFilters } from './mapModel';
import { MapScene, type FlyTarget, type HoverInfo } from './MapScene';

const SEARCH_TYPES: { key: MapSearchType; label: string }[] = [
  { key: 'SKU', label: 'SKU' },
  { key: 'LPN', label: 'LPN' },
  { key: 'LOCATION', label: 'Ubicación' },
  { key: 'ORDER', label: 'Pedido' },
];

export default function MapPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const mapQ = useQuery({ queryKey: ['map'], queryFn: () => layoutApi.map(), refetchInterval: 10_000 });
  const model = useMemo(() => (mapQ.data ? buildSceneModel(mapQ.data) : null), [mapQ.data]);

  const [filters, setFilters] = useState<MapFilters>({ zoneId: '', type: '', status: '', availability: '' });
  const [skuFilterIds, setSkuFilterIds] = useState<Set<string> | null>(null);
  const [highlight, setHighlight] = useState<Set<string>>(new Set());
  const [hits, setHits] = useState<{ title: string; rows: { location_id: string | null; code: string | null; lpn_code?: string | null; qty?: string; status?: string; kind?: string }[] } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [fly, setFly] = useState<FlyTarget | null>(null);
  const [far, setFar] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [selectedRackId, setSelectedRackId] = useState<string | null>(null);
  const [searchType, setSearchType] = useState<MapSearchType>('SKU');
  const [searchQ, setSearchQ] = useState('');
  const [panelOpen, setPanelOpen] = useState(true);

  const visible = useMemo(() => {
    if (!mapQ.data) return null;
    const anyFilter = filters.zoneId || filters.type || filters.status || filters.availability || skuFilterIds;
    if (!anyFilter) return null;
    const s = new Set<string>();
    for (const l of mapQ.data.locations) if (locationVisible(l, filters, skuFilterIds)) s.add(l.id);
    return s;
  }, [mapQ.data, filters, skuFilterIds]);

  // Esc clears selection/highlight
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedId(null);
        setSelectedRackId(null);
        setHighlight(new Set());
        setHits(null);
        setSkuFilterIds(null);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const flyToLocation = useCallback(
    (loc: MapLocation) => {
      const c = locationCenter(loc);
      const isArea = !loc.rack_id;
      const dist = isArea ? Math.max(loc.w, loc.d) * 1.4 + 6 : 9;
      setFly({ seq: Date.now(), position: [c[0] + dist * 0.6, c[1] + dist * 0.7, c[2] + dist * 0.9], lookAt: c });
    },
    [],
  );

  const doSearch = async (e?: FormEvent) => {
    e?.preventDefault();
    const q = searchQ.trim();
    if (!q || !mapQ.data) return;
    try {
      const r = await layoutApi.mapSearch(searchType, q);
      const ids = new Set(r.hits.map((h) => h.location_id).filter((x): x is string => !!x));
      setHighlight(ids);
      setHits({ title: `${SEARCH_TYPES.find((t) => t.key === searchType)?.label} ${q} · ${r.hits.length} resultado(s)`, rows: r.hits });
      if (r.hits.length === 0) toast.warn('Sin resultados', `No se encontró ${q}`);
      if (searchType === 'SKU') setSkuFilterIds(null);
      if ((searchType === 'LPN' || searchType === 'LOCATION') && r.hits[0]?.location_id) {
        const loc = mapQ.data.locations.find((l) => l.id === r.hits[0]!.location_id);
        if (loc) {
          setSelectedId(loc.id);
          flyToLocation(loc);
        }
      }
      if (searchType === 'ORDER' && ids.size) {
        const first = mapQ.data.locations.find((l) => ids.has(l.id) && l.location_type === 'STAGING') ?? mapQ.data.locations.find((l) => ids.has(l.id));
        if (first) flyToLocation(first);
      }
    } catch (err) {
      toast.error('Error en la búsqueda', err);
    }
  };
  const applySkuFilter = () => {
    if (highlight.size && searchType === 'SKU') setSkuFilterIds(new Set(highlight));
  };

  const selected = useQuery({ queryKey: ['location', selectedId], queryFn: () => layoutApi.location(selectedId!), enabled: !!selectedId });
  const hoverLoc = hover && model ? model.locById.get(hover.id) : null;

  // ---- edit mode (rack geometry) ----
  const rack = selectedRackId && mapQ.data ? mapQ.data.racks.find((r) => r.id === selectedRackId) : null;
  const [rackForm, setRackForm] = useState({ x_m: '', y_m: '', rotation_deg: '' });
  useEffect(() => {
    if (rack) setRackForm({ x_m: String(rack.x_m), y_m: String(rack.y_m), rotation_deg: String(rack.rotation_deg) });
  }, [rack]);
  const saveRack = useMutation({
    mutationFn: () => layoutApi.updateRack(selectedRackId!, { x_m: Number(rackForm.x_m), y_m: Number(rackForm.y_m), rotation_deg: Number(rackForm.rotation_deg) }),
    onSuccess: (r) => {
      toast.success('Rack actualizado', `${r.generated.updated} ubicaciones reposicionadas`);
      void qc.invalidateQueries({ queryKey: ['map'] });
    },
    onError: (e) => toast.error('No se pudo guardar', e),
  });

  const occ = useMemo(() => {
    if (!mapQ.data) return null;
    const zoneName = new Map(mapQ.data.zones.map((z) => [z.id, z.code]));
    const rackName = new Map(mapQ.data.racks.map((r) => [r.id, `${r.zone_code}-${r.aisle_code} ${r.code}`]));
    return {
      warehouse: mapQ.data.occupancy.find((o) => o.scope === 'warehouse'),
      zones: mapQ.data.occupancy.filter((o) => o.scope === 'zone').map((o) => ({ ...o, name: zoneName.get(o.id) ?? o.id })),
      racks: mapQ.data.occupancy.filter((o) => o.scope === 'rack').map((o) => ({ ...o, name: rackName.get(o.id) ?? o.id })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }, [mapQ.data]);

  if (mapQ.isLoading) return <Skeleton className="h-[70vh]" />;
  if (mapQ.error || !mapQ.data || !model) return <Alert tone="error">No se pudo cargar el mapa del almacén.</Alert>;

  return (
    <div className="relative -m-4 flex h-[calc(100vh-3.5rem)] flex-col lg:-m-6" data-testid="map-page">
      {/* toolbar */}
      <div className="z-10 flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 text-sm">
        <form onSubmit={doSearch} className="flex items-center gap-1">
          <Select value={searchType} onChange={(e) => setSearchType(e.target.value as MapSearchType)} className="w-32" aria-label="Tipo de búsqueda">
            {SEARCH_TYPES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </Select>
          <Input value={searchQ} onChange={(e) => setSearchQ(e.target.value)} placeholder={searchType === 'SKU' ? 'SKU-0001 o código de barras' : searchType === 'LPN' ? 'PLT-2026-…' : searchType === 'ORDER' ? 'PED-48571' : 'A-01-R01-N01-P01'} className="w-56 font-mono" data-testid="map-search-input" />
          <Button type="submit" size="md" data-testid="map-search-submit">
            Buscar
          </Button>
          {highlight.size > 0 && (
            <>
              {searchType === 'SKU' && (
                <Button type="button" variant="secondary" onClick={applySkuFilter} title="Mostrar sólo ubicaciones con este SKU">
                  Filtrar
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setHighlight(new Set());
                  setHits(null);
                  setSkuFilterIds(null);
                }}
              >
                Limpiar
              </Button>
            </>
          )}
        </form>
        <span className="mx-1 hidden h-6 w-px bg-slate-200 md:inline-block" />
        <Select value={filters.zoneId} onChange={(e) => setFilters({ ...filters, zoneId: e.target.value })} className="w-40" aria-label="Zona">
          <option value="">Todas las zonas</option>
          {mapQ.data.zones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.code} · {z.name}
            </option>
          ))}
        </Select>
        <Select value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })} className="w-36" aria-label="Tipo">
          <option value="">Todos los tipos</option>
          {['RESERVE', 'PICKING', ...AREA_TYPES].map((t) => (
            <option key={t} value={t}>
              {es(t)}
            </option>
          ))}
        </Select>
        <Select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} className="w-36" aria-label="Estado">
          <option value="">Todos los estados</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <Select value={filters.availability} onChange={(e) => setFilters({ ...filters, availability: e.target.value as MapFilters['availability'] })} className="w-40" aria-label="Disponibilidad">
          <option value="">Disponibilidad: todas</option>
          <option value="AVAILABLE">Con espacio</option>
          <option value="FULL">Llenas</option>
        </Select>
        <div className="ml-auto flex items-center gap-2 text-xs text-slate-500">
          <span title={fmtDateTime(mapQ.data.generated_at)}>Actualizado {relTime(mapQ.dataUpdatedAt)}</span>
          <Button size="sm" variant="secondary" onClick={() => void mapQ.refetch()} loading={mapQ.isFetching}>
            Actualizar
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setFly({ seq: Date.now(), position: [model.width * 0.55, Math.max(model.width, model.depth) * 0.75, model.depth * 1.45], lookAt: [model.width / 2, 0, model.depth / 2] })}>
            Vista general
          </Button>
          {can('layout.manage') && (
            <label className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1">
              <input type="checkbox" checked={editMode} onChange={(e) => setEditMode(e.target.checked)} /> Modo edición
            </label>
          )}
          <Button size="sm" variant="ghost" onClick={() => setPanelOpen((v) => !v)} aria-label="Mostrar/ocultar panel">
            {panelOpen ? 'Ocultar panel' : 'Panel'}
          </Button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1" onMouseLeave={() => setHover(null)}>
          <MapScene
            model={model}
            zones={mapQ.data.zones}
            visible={visible}
            highlight={highlight}
            selectedId={selectedId}
            selectedRackId={selectedRackId}
            editMode={editMode}
            fly={fly}
            far={far}
            onFar={setFar}
            onHover={setHover}
            onSelect={(id) => {
              setSelectedId(id);
              if (id) setPanelOpen(true);
            }}
            onSelectRack={(id) => {
              setSelectedRackId(id);
              setPanelOpen(true);
            }}
          />
          {/* legend */}
          <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg bg-white/90 p-2 text-[11px] shadow" data-testid="map-legend">
            {Object.entries(STATUS_COLORS).map(([k, c]) => (
              <div key={k} className="flex items-center gap-1.5">
                <span className="inline-block h-3 w-3 rounded-sm border border-slate-300" style={{ background: c }} />
                {STATUS_LABELS[k as keyof typeof STATUS_LABELS]}
              </div>
            ))}
            <div className="mt-1 border-t border-slate-200 pt-1 text-slate-500">
              {model.slots.length} posiciones · {model.pallets.length} pallets · {far ? 'LOD lejano' : 'detalle'}
            </div>
          </div>
          {editMode && <div className="pointer-events-none absolute left-3 top-3 rounded bg-amber-400 px-2 py-1 text-xs font-bold text-amber-950">MODO EDICIÓN: haz clic en la estructura de un rack</div>}
          {/* hover tooltip */}
          {hover && hoverLoc && (
            <div className="pointer-events-none fixed z-50 rounded-md bg-slate-900 px-2 py-1 text-xs text-white shadow-lg" style={{ left: hover.x + 12, top: hover.y + 12 }}>
              <div className="font-mono font-bold">{hoverLoc.code}</div>
              <div>
                {STATUS_LABELS[hoverLoc.status]} · {hoverLoc.lpn_count} LPN · {fmtQty(hoverLoc.total_qty)} pzas
              </div>
            </div>
          )}
        </div>

        {/* side panel */}
        {panelOpen && (
          <aside className="thin-scroll flex w-80 shrink-0 flex-col overflow-y-auto border-l border-slate-200 bg-white text-sm lg:w-96" data-testid="map-panel">
            {rack && editMode && (
              <section className="border-b border-slate-200 p-3">
                <h3 className="font-semibold">
                  Editar rack {rack.zone_code}-{rack.aisle_code} {rack.code}
                </h3>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <label className="text-xs">
                    X (m)
                    <Input type="number" step="0.1" value={rackForm.x_m} onChange={(e) => setRackForm({ ...rackForm, x_m: e.target.value })} />
                  </label>
                  <label className="text-xs">
                    Y (m)
                    <Input type="number" step="0.1" value={rackForm.y_m} onChange={(e) => setRackForm({ ...rackForm, y_m: e.target.value })} />
                  </label>
                  <label className="text-xs">
                    Rotación °
                    <Input type="number" step="1" min={0} max={359} value={rackForm.rotation_deg} onChange={(e) => setRackForm({ ...rackForm, rotation_deg: e.target.value })} />
                  </label>
                </div>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={() => saveRack.mutate()} loading={saveRack.isPending}>
                    Guardar
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSelectedRackId(null)}>
                    Cerrar
                  </Button>
                  <Link to="/layout" className="ml-auto self-center text-xs text-sky-700 underline">
                    Layout completo →
                  </Link>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {rack.bays} bahías × {rack.levels} niveles · {rack.bay_width_m} m × {rack.level_height_m} m · fondo {rack.depth_m} m
                </p>
              </section>
            )}

            {selectedId ? (
              <section className="border-b border-slate-200 p-3" data-testid="map-selected">
                {selected.isLoading && <Skeleton className="h-24" />}
                {selected.data && (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-mono text-base font-bold">{selected.data.code}</div>
                        <div className="text-xs text-slate-500">
                          {es(selected.data.location_type)} · {selected.data.zone_code ?? '—'} {selected.data.rack_code ? `· ${selected.data.rack_code}` : ''} · <span className="font-mono">{selected.data.barcode}</span>
                        </div>
                      </div>
                      <button type="button" className="text-slate-400 hover:text-slate-700" onClick={() => setSelectedId(null)} aria-label="Cerrar">
                        ✕
                      </button>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <StatusChip status={selected.data.status} />
                      {selected.data.admin_status !== 'ACTIVE' && <StatusChip status={selected.data.admin_status} />}
                      <span className="text-xs text-slate-600">
                        Capacidad {selected.data.lpn_count}/{selected.data.pallet_capacity} pallets · {fmtNum(selected.data.weight_kg, 0)} kg / {fmtNum(selected.data.max_weight_kg, 0)} kg
                      </span>
                    </div>
                    {selected.data.block_reason && <Alert tone="warn" className="mt-2">{selected.data.block_reason}</Alert>}
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" variant="secondary" onClick={() => flyToLocation(model.locById.get(selectedId)!)} disabled={!model.locById.get(selectedId)}>
                        Volar aquí
                      </Button>
                      <Link to={`/layout?location=${selected.data.code}`} className="self-center text-xs text-sky-700 underline">
                        Editar ubicación
                      </Link>
                    </div>
                    <h4 className="mt-3 text-xs font-semibold uppercase text-slate-500">LPNs ({selected.data.lpns.length})</h4>
                    {selected.data.lpns.length === 0 && <div className="text-xs text-slate-400">Vacía</div>}
                    <ul className="mt-1 space-y-2">
                      {selected.data.lpns.map((l) => (
                        <li key={l.id} className="rounded-md border border-slate-200 p-2">
                          <div className="flex items-center justify-between">
                            <Link to={`/inventory/lpn/${l.code}`} className="font-mono text-xs font-bold text-sky-700 underline">
                              {l.code}
                            </Link>
                            <StatusChip status={l.status} />
                          </div>
                          <ul className="mt-1 text-xs">
                            {l.contents.map((c, i) => (
                              <li key={i} className="flex justify-between gap-2">
                                <span className="truncate">
                                  <b className="font-mono">{c.sku_code}</b> {c.description}
                                </span>
                                <span className="whitespace-nowrap">
                                  {fmtQty(c.qty)} · {es(c.status)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </li>
                      ))}
                    </ul>
                    <h4 className="mt-3 text-xs font-semibold uppercase text-slate-500">Último movimiento</h4>
                    {selected.data.last_movement ? (
                      <div className="text-xs text-slate-700">
                        {es(selected.data.last_movement.movement_type)} · {fmtQty(selected.data.last_movement.qty)} × {selected.data.last_movement.sku_code} · {selected.data.last_movement.username ?? 'sistema'} · {fmtDateTime(selected.data.last_movement.occurred_at)}
                      </div>
                    ) : (
                      <div className="text-xs text-slate-400">Sin movimientos</div>
                    )}
                  </>
                )}
              </section>
            ) : (
              !rack && <div className="border-b border-slate-200 p-3 text-xs text-slate-500">Haz clic en una posición o pallet para ver su detalle. Esc limpia la selección.</div>
            )}

            {hits && (
              <section className="border-b border-slate-200 p-3" data-testid="map-hits">
                <h3 className="text-xs font-semibold uppercase text-slate-500">{hits.title}</h3>
                <ul className="mt-1 max-h-64 space-y-1 overflow-y-auto">
                  {hits.rows.map((h, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between rounded px-2 py-1 text-left hover:bg-sky-50"
                        onClick={() => {
                          if (!h.location_id) return;
                          setSelectedId(h.location_id);
                          const loc = model.locById.get(h.location_id);
                          if (loc) flyToLocation(loc);
                        }}
                      >
                        <span className="font-mono text-xs">{h.code ?? 'sin ubicación'}</span>
                        <span className="text-xs text-slate-500">
                          {h.lpn_code ?? ''} {h.qty ? `· ${fmtQty(h.qty)}` : ''} {h.status ? `· ${es(h.status)}` : ''} {h.kind ? `· ${h.kind}` : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {occ && (
              <section className="p-3" data-testid="map-occupancy">
                <h3 className="text-xs font-semibold uppercase text-slate-500">Ocupación</h3>
                {occ.warehouse && <OccRow name="Almacén" pct={occ.warehouse.pct} detail={`${occ.warehouse.occupied}/${occ.warehouse.total}`} strong />}
                <div className="mt-2 text-[11px] font-semibold text-slate-400">Zonas</div>
                {occ.zones.map((o) => (
                  <OccRow key={o.id} name={o.name} pct={o.pct} detail={`${o.occupied}/${o.total}`} onClick={() => setFilters({ ...filters, zoneId: filters.zoneId === o.id ? '' : o.id })} active={filters.zoneId === o.id} />
                ))}
                <div className="mt-2 text-[11px] font-semibold text-slate-400">Racks</div>
                {occ.racks.map((o) => (
                  <OccRow key={o.id} name={o.name} pct={o.pct} detail={`${o.occupied}/${o.total}`} />
                ))}
              </section>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

function OccRow({ name, pct, detail, strong, onClick, active }: { name: string; pct: number; detail: string; strong?: boolean; onClick?: () => void; active?: boolean }) {
  const tone = pct > 90 ? 'bg-rose-500' : pct > 70 ? 'bg-amber-500' : 'bg-emerald-500';
  const inner = (
    <>
      <div className="flex justify-between text-xs">
        <span className={cls(strong && 'font-semibold')}>{name}</span>
        <span className="tabular-nums text-slate-600">
          {detail} · {fmtNum(pct, 1)}%
        </span>
      </div>
      <div className="mt-0.5 h-1.5 w-full rounded-full bg-slate-200">
        <div className={cls('h-full rounded-full', tone)} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </>
  );
  if (onClick)
    return (
      <button type="button" onClick={onClick} className={cls('mt-1 block w-full rounded px-1 py-0.5 text-left hover:bg-slate-50', active && 'bg-sky-50 ring-1 ring-sky-300')}>
        {inner}
      </button>
    );
  return <div className="mt-1 px-1 py-0.5">{inner}</div>;
}
