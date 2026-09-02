// /layout — warehouses, zones, aisles, racks (generate locations), area locations, location edit.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { LOCATION_ADMIN_STATUSES, LOCATION_TYPES, ZONE_TYPES } from '@wms/shared';
import { layoutApi } from '../api/layout';
import type { LocationRow, Rack, Zone } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../components/Toast';
import { Alert, Button, Card, Drawer, Field, Input, PageHeader, Select, StatusChip, Table, Tabs, Textarea } from '../components/ui';
import { useDebounced, useQueryParam } from '../lib/hooks';
import { es, fmtNum, fmtQty } from '../lib/format';

type Tab = 'zones' | 'racks' | 'areas' | 'locations';

export default function LayoutPage() {
  const { can } = useAuth();
  const [tab, setTab] = useQueryParam('tab', 'zones');
  const [sp] = useSearchParams();
  const wh = useQuery({ queryKey: ['warehouses'], queryFn: layoutApi.warehouses });
  const warehouse = wh.data?.[0];
  useEffect(() => {
    if (sp.get('location') && tab !== 'locations') setTab('locations');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp]);
  if (!warehouse) return <Alert tone="info">Cargando almacén…</Alert>;
  return (
    <div>
      <PageHeader
        title={`Layout · ${warehouse.name}`}
        subtitle={`${fmtNum(warehouse.width_m, 1)} × ${fmtNum(warehouse.depth_m, 1)} × ${fmtNum(warehouse.height_m, 1)} m. Los cambios se reflejan en el mapa 3D al refrescar.`}
        actions={
          <Link to="/map" className="rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-white">
            Ver mapa 3D
          </Link>
        }
      />
      {!can('layout.manage') && <Alert tone="info" className="mb-3">Sólo lectura: tu rol no tiene layout.manage.</Alert>}
      <Tabs<Tab>
        value={tab as Tab}
        onChange={setTab}
        tabs={[
          { key: 'zones', label: 'Zonas y pasillos' },
          { key: 'racks', label: 'Racks' },
          { key: 'areas', label: 'Áreas (andenes, staging…)' },
          { key: 'locations', label: 'Ubicaciones' },
        ]}
      />
      {tab === 'zones' && <ZonesTab warehouseId={warehouse.id} />}
      {tab === 'racks' && <RacksTab />}
      {tab === 'areas' && <AreasTab warehouseId={warehouse.id} />}
      {tab === 'locations' && <LocationsTab initialCode={sp.get('location') ?? ''} />}
    </div>
  );
}

const num = (v: string) => (v === '' ? undefined : Number(v));

function ZonesTab({ warehouseId }: { warehouseId: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const zones = useQuery({ queryKey: ['zones'], queryFn: () => layoutApi.zones(warehouseId) });
  const [edit, setEdit] = useState<Partial<Zone> & { isNew?: boolean } | null>(null);
  const [aisle, setAisle] = useState<{ zone_id: string; code: string; name: string } | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const b = { code: edit!.code, name: edit!.name, zone_type: edit!.zone_type, color: edit!.color || undefined, x_m: Number(edit!.x_m), y_m: Number(edit!.y_m), width_m: Number(edit!.width_m), depth_m: Number(edit!.depth_m) };
      return edit!.isNew ? layoutApi.createZone({ warehouse_id: warehouseId, ...b }) : layoutApi.updateZone(edit!.id!, b);
    },
    onSuccess: () => { toast.success('Zona guardada'); setEdit(null); void qc.invalidateQueries({ queryKey: ['zones'] }); void qc.invalidateQueries({ queryKey: ['map'] }); },
    onError: (e) => toast.error('No se pudo guardar', e),
  });
  const saveAisle = useMutation({
    mutationFn: () => layoutApi.createAisle({ zone_id: aisle!.zone_id, code: aisle!.code, name: aisle!.name || undefined }),
    onSuccess: () => { toast.success('Pasillo creado'); setAisle(null); void qc.invalidateQueries({ queryKey: ['zones'] }); },
    onError: (e) => toast.error('No se pudo crear', e),
  });
  return (
    <div>
      {can('layout.manage') && (
        <div className="mb-3">
          <Button onClick={() => setEdit({ isNew: true, code: '', name: '', zone_type: 'STORAGE', color: '#94a3b8', x_m: '0', y_m: '0', width_m: '10', depth_m: '10' })}>Nueva zona</Button>
        </div>
      )}
      <Table
        rows={zones.data}
        loading={zones.isLoading}
        rowKey={(z) => z.id}
        columns={[
          { key: 'c', header: 'Zona', render: (z) => <span className="flex items-center gap-2"><span className="inline-block h-3 w-3 rounded" style={{ background: z.color ?? '#94a3b8' }} /><b>{z.code}</b> {z.name}</span> },
          { key: 't', header: 'Tipo', render: (z) => es(z.zone_type) },
          { key: 'p', header: 'Posición (x, y)', render: (z) => `${fmtNum(z.x_m, 1)}, ${fmtNum(z.y_m, 1)} m` },
          { key: 's', header: 'Tamaño', render: (z) => `${fmtNum(z.width_m, 1)} × ${fmtNum(z.depth_m, 1)} m` },
          { key: 'a', header: 'Pasillos / racks', render: (z) => (z.aisles ?? []).map((a) => `${a.code} (${a.racks?.length ?? 0})`).join(', ') || '—' },
          { key: 'ac', header: '', render: (z) => can('layout.manage') && <div className="flex gap-1"><Button size="sm" variant="secondary" onClick={() => setEdit({ ...z })}>Editar</Button><Button size="sm" variant="ghost" onClick={() => setAisle({ zone_id: z.id, code: '', name: '' })}>+ Pasillo</Button></div> },
        ]}
      />
      <Drawer open={!!edit} onClose={() => setEdit(null)} title={edit?.isNew ? 'Nueva zona' : `Editar zona ${edit?.code}`} footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setEdit(null)}>Cancelar</Button><Button onClick={() => save.mutate()} loading={save.isPending}>Guardar</Button></div>}>
        {edit && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Código" required><Input value={edit.code ?? ''} onChange={(e) => setEdit({ ...edit, code: e.target.value })} disabled={!edit.isNew} /></Field>
            <Field label="Nombre" required><Input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Tipo" required>
              <Select value={edit.zone_type} onChange={(e) => setEdit({ ...edit, zone_type: e.target.value as Zone['zone_type'] })}>
                {ZONE_TYPES.map((t) => <option key={t} value={t}>{es(t)}</option>)}
              </Select>
            </Field>
            <Field label="Color"><Input type="color" value={edit.color ?? '#94a3b8'} onChange={(e) => setEdit({ ...edit, color: e.target.value })} /></Field>
            <Field label="X (m)"><Input type="number" step="0.1" value={String(edit.x_m ?? '')} onChange={(e) => setEdit({ ...edit, x_m: e.target.value })} /></Field>
            <Field label="Y (m)"><Input type="number" step="0.1" value={String(edit.y_m ?? '')} onChange={(e) => setEdit({ ...edit, y_m: e.target.value })} /></Field>
            <Field label="Ancho (m)"><Input type="number" step="0.1" value={String(edit.width_m ?? '')} onChange={(e) => setEdit({ ...edit, width_m: e.target.value })} /></Field>
            <Field label="Fondo (m)"><Input type="number" step="0.1" value={String(edit.depth_m ?? '')} onChange={(e) => setEdit({ ...edit, depth_m: e.target.value })} /></Field>
          </div>
        )}
      </Drawer>
      <Drawer open={!!aisle} onClose={() => setAisle(null)} title="Nuevo pasillo" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setAisle(null)}>Cancelar</Button><Button onClick={() => saveAisle.mutate()} loading={saveAisle.isPending} disabled={!aisle?.code}>Crear</Button></div>}>
        {aisle && (
          <div className="grid gap-3">
            <Field label="Código (p. ej. 04)" required><Input value={aisle.code} onChange={(e) => setAisle({ ...aisle, code: e.target.value })} /></Field>
            <Field label="Nombre"><Input value={aisle.name} onChange={(e) => setAisle({ ...aisle, name: e.target.value })} /></Field>
          </div>
        )}
      </Drawer>
    </div>
  );
}

function RacksTab() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const racks = useQuery({ queryKey: ['racks'], queryFn: () => layoutApi.racks() });
  const zones = useQuery({ queryKey: ['zones'], queryFn: () => layoutApi.zones() });
  const aisles = (zones.data ?? []).flatMap((z) => (z.aisles ?? []).map((a) => ({ ...a, zone: z })));
  const empty = { aisle_id: '', code: '', bays: '8', levels: '4', positions_per_bay: '1', bay_width_m: '2.7', level_height_m: '1.8', depth_m: '1.2', x_m: '0', y_m: '0', rotation_deg: '0', location_type: 'RESERVE', pallet_capacity: '1', max_weight_kg: '1500' };
  const [form, setForm] = useState<typeof empty & { id?: string } | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const f = form!;
      const geo = { bays: Number(f.bays), levels: Number(f.levels), positions_per_bay: Number(f.positions_per_bay), bay_width_m: Number(f.bay_width_m), level_height_m: Number(f.level_height_m), depth_m: Number(f.depth_m), x_m: Number(f.x_m), y_m: Number(f.y_m), rotation_deg: Number(f.rotation_deg) };
      return f.id ? layoutApi.updateRack(f.id, { code: f.code, ...geo }) : layoutApi.createRack({ aisle_id: f.aisle_id, code: f.code, ...geo, location_type: f.location_type, pallet_capacity: Number(f.pallet_capacity), max_weight_kg: Number(f.max_weight_kg), generate_locations: true });
    },
    onSuccess: (r) => {
      toast.success('Rack guardado', `Ubicaciones: ${r.generated.created} nuevas · ${r.generated.updated} actualizadas · ${r.generated.deactivated} desactivadas`);
      setForm(null);
      void qc.invalidateQueries({ queryKey: ['racks'] });
      void qc.invalidateQueries({ queryKey: ['map'] });
      void qc.invalidateQueries({ queryKey: ['locations'] });
    },
    onError: (e) => toast.error('No se pudo guardar', e),
  });
  const edit = (r: Rack) => setForm({ id: r.id, aisle_id: r.aisle_id, code: r.code, bays: String(r.bays), levels: String(r.levels), positions_per_bay: String(r.positions_per_bay), bay_width_m: String(r.bay_width_m), level_height_m: String(r.level_height_m), depth_m: String(r.depth_m), x_m: String(r.x_m), y_m: String(r.y_m), rotation_deg: String(r.rotation_deg), location_type: 'RESERVE', pallet_capacity: '1', max_weight_kg: '1500' });
  return (
    <div>
      {can('layout.manage') && <div className="mb-3"><Button onClick={() => setForm({ ...empty, aisle_id: aisles[0]?.id ?? '' })}>Nuevo rack</Button></div>}
      <Table
        rows={racks.data}
        loading={racks.isLoading}
        rowKey={(r) => r.id}
        columns={[
          { key: 'c', header: 'Rack', render: (r) => <b>{r.aisle?.zone.code}-{r.aisle?.code} {r.code}</b> },
          { key: 'g', header: 'Bahías × niveles × pos.', render: (r) => `${r.bays} × ${r.levels} × ${r.positions_per_bay} = ${r.bays * r.levels * r.positions_per_bay} ubic.` },
          { key: 'd', header: 'Dimensiones', render: (r) => `${r.bay_width_m} m × ${r.level_height_m} m · fondo ${r.depth_m} m` },
          { key: 'p', header: 'Posición', render: (r) => `${r.x_m}, ${r.y_m} m · ${r.rotation_deg}°` },
          { key: 'a', header: '', render: (r) => can('layout.manage') && <Button size="sm" variant="secondary" onClick={() => edit(r)}>Editar geometría</Button> },
        ]}
      />
      <Drawer open={!!form} onClose={() => setForm(null)} title={form?.id ? `Editar rack ${form.code}` : 'Nuevo rack'} footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setForm(null)}>Cancelar</Button><Button onClick={() => save.mutate()} loading={save.isPending}>Guardar y generar ubicaciones</Button></div>}>
        {form && (
          <div className="grid gap-3 sm:grid-cols-2">
            {!form.id && (
              <Field label="Pasillo" required className="sm:col-span-2">
                <Select value={form.aisle_id} onChange={(e) => setForm({ ...form, aisle_id: e.target.value })}>
                  {aisles.map((a) => <option key={a.id} value={a.id}>{a.zone.code} · pasillo {a.code}</option>)}
                </Select>
              </Field>
            )}
            <Field label="Código (R01)" required><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
            <Field label="Bahías (1-200)"><Input type="number" value={form.bays} onChange={(e) => setForm({ ...form, bays: e.target.value })} /></Field>
            <Field label="Niveles (1-30)"><Input type="number" value={form.levels} onChange={(e) => setForm({ ...form, levels: e.target.value })} /></Field>
            <Field label="Posiciones por bahía"><Input type="number" value={form.positions_per_bay} onChange={(e) => setForm({ ...form, positions_per_bay: e.target.value })} /></Field>
            <Field label="Ancho de bahía (m)"><Input type="number" step="0.1" value={form.bay_width_m} onChange={(e) => setForm({ ...form, bay_width_m: e.target.value })} /></Field>
            <Field label="Altura de nivel (m)"><Input type="number" step="0.1" value={form.level_height_m} onChange={(e) => setForm({ ...form, level_height_m: e.target.value })} /></Field>
            <Field label="Fondo (m)"><Input type="number" step="0.1" value={form.depth_m} onChange={(e) => setForm({ ...form, depth_m: e.target.value })} /></Field>
            <Field label="X (m)"><Input type="number" step="0.1" value={form.x_m} onChange={(e) => setForm({ ...form, x_m: e.target.value })} /></Field>
            <Field label="Y (m)"><Input type="number" step="0.1" value={form.y_m} onChange={(e) => setForm({ ...form, y_m: e.target.value })} /></Field>
            <Field label="Rotación (°)"><Input type="number" value={form.rotation_deg} onChange={(e) => setForm({ ...form, rotation_deg: e.target.value })} /></Field>
            {!form.id && (
              <>
                <Field label="Tipo de ubicación"><Select value={form.location_type} onChange={(e) => setForm({ ...form, location_type: e.target.value })}><option>RESERVE</option><option>PICKING</option></Select></Field>
                <Field label="Capacidad pallets / posición"><Input type="number" value={form.pallet_capacity} onChange={(e) => setForm({ ...form, pallet_capacity: e.target.value })} /></Field>
                <Field label="Peso máx. (kg)"><Input type="number" value={form.max_weight_kg} onChange={(e) => setForm({ ...form, max_weight_kg: e.target.value })} /></Field>
              </>
            )}
            <Alert tone="info" className="sm:col-span-2">Se generan ubicaciones ZONA-PASILLO-R##-N##-P## con coordenadas mundo. Reducir un rack sólo desactiva posiciones vacías.</Alert>
          </div>
        )}
      </Drawer>
    </div>
  );
}

function AreasTab({ warehouseId }: { warehouseId: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const zones = useQuery({ queryKey: ['zones'], queryFn: () => layoutApi.zones() });
  const areas = useQuery({ queryKey: ['locations', 'areas'], queryFn: async () => (await Promise.all(['RECEIVING', 'STAGING', 'SHIPPING', 'QUARANTINE', 'RETURNS', 'DAMAGED'].map((t) => layoutApi.locations({ type: t, limit: 500 })))).flatMap((r) => r.items) });
  const empty = { zone_id: '', code: '', location_type: 'STAGING', x_m: '0', y_m: '0', width_m: '3', depth_m: '8', height_m: '3', pallet_capacity: '10', max_weight_kg: '50000' };
  const [form, setForm] = useState<typeof empty | null>(null);
  const save = useMutation({
    mutationFn: () => layoutApi.createLocation({ warehouse_id: warehouseId, zone_id: form!.zone_id || undefined, code: form!.code, location_type: form!.location_type, x_m: Number(form!.x_m), y_m: Number(form!.y_m), width_m: Number(form!.width_m), depth_m: Number(form!.depth_m), height_m: Number(form!.height_m), pallet_capacity: Number(form!.pallet_capacity), max_weight_kg: Number(form!.max_weight_kg) }),
    onSuccess: () => { toast.success('Área creada'); setForm(null); void qc.invalidateQueries({ queryKey: ['locations'] }); void qc.invalidateQueries({ queryKey: ['map'] }); },
    onError: (e) => toast.error('No se pudo crear', e),
  });
  return (
    <div>
      {can('layout.manage') && <div className="mb-3"><Button onClick={() => setForm(empty)}>Nueva área</Button></div>}
      <Table
        rows={areas.data}
        loading={areas.isLoading}
        rowKey={(l) => l.id}
        columns={[
          { key: 'c', header: 'Código', render: (l) => <span className="font-mono font-semibold">{l.code}</span> },
          { key: 't', header: 'Tipo', render: (l) => es(l.location_type) },
          { key: 's', header: 'Estado', render: (l) => <StatusChip status={l.status} /> },
          { key: 'o', header: 'Ocupación', render: (l) => `${l.lpn_count} / ${l.pallet_capacity}`, align: 'right' },
          { key: 'p', header: 'Posición', render: (l) => `${fmtNum(l.x_m, 1)}, ${fmtNum(l.y_m, 1)} m` },
          { key: 'd', header: 'Tamaño', render: (l) => `${fmtNum(l.width_m, 1)} × ${fmtNum(l.depth_m, 1)} × ${fmtNum(l.height_m, 1)} m` },
          { key: 'a', header: 'Admin', render: (l) => <StatusChip status={l.admin_status} /> },
        ]}
      />
      <Drawer open={!!form} onClose={() => setForm(null)} title="Nueva área" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setForm(null)}>Cancelar</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!form?.code}>Crear</Button></div>}>
        {form && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Código" required><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} /></Field>
            <Field label="Tipo" required><Select value={form.location_type} onChange={(e) => setForm({ ...form, location_type: e.target.value })}>{LOCATION_TYPES.filter((t) => t !== 'RESERVE' && t !== 'PICKING').map((t) => <option key={t} value={t}>{es(t)}</option>)}</Select></Field>
            <Field label="Zona"><Select value={form.zone_id} onChange={(e) => setForm({ ...form, zone_id: e.target.value })}><option value="">—</option>{zones.data?.map((z) => <option key={z.id} value={z.id}>{z.code}</option>)}</Select></Field>
            <Field label="Capacidad (pallets)"><Input type="number" value={form.pallet_capacity} onChange={(e) => setForm({ ...form, pallet_capacity: e.target.value })} /></Field>
            <Field label="X (m)"><Input type="number" step="0.1" value={form.x_m} onChange={(e) => setForm({ ...form, x_m: e.target.value })} /></Field>
            <Field label="Y (m)"><Input type="number" step="0.1" value={form.y_m} onChange={(e) => setForm({ ...form, y_m: e.target.value })} /></Field>
            <Field label="Ancho (m)"><Input type="number" step="0.1" value={form.width_m} onChange={(e) => setForm({ ...form, width_m: e.target.value })} /></Field>
            <Field label="Fondo (m)"><Input type="number" step="0.1" value={form.depth_m} onChange={(e) => setForm({ ...form, depth_m: e.target.value })} /></Field>
            <Field label="Alto (m)"><Input type="number" step="0.1" value={form.height_m} onChange={(e) => setForm({ ...form, height_m: e.target.value })} /></Field>
            <Field label="Peso máx. (kg)"><Input type="number" value={form.max_weight_kg} onChange={(e) => setForm({ ...form, max_weight_kg: e.target.value })} /></Field>
          </div>
        )}
      </Drawer>
    </div>
  );
}

function LocationsTab({ initialCode }: { initialCode: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState(initialCode);
  const dq = useDebounced(q);
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const rows = useQuery({ queryKey: ['locations', 'list', dq, type, status], queryFn: () => layoutApi.locations({ q: dq || undefined, type: type || undefined, status: status || undefined, limit: 500 }) });
  const [edit, setEdit] = useState<LocationRow | null>(null);
  const [f, setF] = useState({ admin_status: 'ACTIVE', reason: '', pallet_capacity: '', max_weight_kg: '', height_m: '', allowed_families: '', allowed_compatibility_groups: '', max_height_cm: '', pick_sequence: '' });
  useEffect(() => {
    if (edit) {
      const r = (edit.restrictions ?? {}) as { allowed_families?: string[]; allowed_compatibility_groups?: string[]; max_height_cm?: number };
      setF({ admin_status: edit.admin_status, reason: '', pallet_capacity: String(edit.pallet_capacity), max_weight_kg: String(edit.max_weight_kg), height_m: String(edit.height_m), allowed_families: (r.allowed_families ?? []).join(', '), allowed_compatibility_groups: (r.allowed_compatibility_groups ?? []).join(', '), max_height_cm: r.max_height_cm ? String(r.max_height_cm) : '', pick_sequence: edit.pick_sequence === null ? '' : String(edit.pick_sequence) });
    }
  }, [edit]);
  const save = useMutation({
    mutationFn: () =>
      layoutApi.updateLocation(edit!.id, {
        admin_status: f.admin_status,
        reason: f.reason || undefined,
        block_reason: f.admin_status !== 'ACTIVE' ? f.reason || undefined : undefined,
        pallet_capacity: num(f.pallet_capacity),
        max_weight_kg: num(f.max_weight_kg),
        height_m: num(f.height_m),
        pick_sequence: num(f.pick_sequence),
        restrictions: { allowed_families: f.allowed_families ? f.allowed_families.split(',').map((s) => s.trim()).filter(Boolean) : undefined, allowed_compatibility_groups: f.allowed_compatibility_groups ? f.allowed_compatibility_groups.split(',').map((s) => s.trim()).filter(Boolean) : undefined, max_height_cm: num(f.max_height_cm) },
      }),
    onSuccess: () => { toast.success('Ubicación actualizada'); setEdit(null); void qc.invalidateQueries({ queryKey: ['locations'] }); void qc.invalidateQueries({ queryKey: ['map'] }); },
    onError: (e) => toast.error('No se pudo guardar', e),
  });
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        <Input placeholder="Buscar código" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs font-mono" />
        <Select value={type} onChange={(e) => setType(e.target.value)} className="w-40"><option value="">Todos los tipos</option>{LOCATION_TYPES.map((t) => <option key={t} value={t}>{es(t)}</option>)}</Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40"><option value="">Todos los estados</option>{['FREE', 'PARTIAL', 'OCCUPIED', 'RESERVED', 'BLOCKED', 'QUARANTINE'].map((t) => <option key={t} value={t}>{es(t)}</option>)}</Select>
      </div>
      <Table
        rows={rows.data?.items}
        loading={rows.isLoading}
        rowKey={(l) => l.id}
        onRowClick={can('layout.manage') ? (l) => setEdit(l) : undefined}
        dense
        columns={[
          { key: 'c', header: 'Código', render: (l) => <span className="font-mono font-semibold">{l.code}</span> },
          { key: 'b', header: 'Barcode', render: (l) => <span className="font-mono text-xs">{l.barcode}</span> },
          { key: 't', header: 'Tipo', render: (l) => es(l.location_type) },
          { key: 's', header: 'Ocupación', render: (l) => <StatusChip status={l.status} /> },
          { key: 'a', header: 'Admin', render: (l) => <StatusChip status={l.admin_status} /> },
          { key: 'n', header: 'LPN / cap.', render: (l) => `${l.lpn_count}/${l.pallet_capacity}`, align: 'right' },
          { key: 'q', header: 'Piezas', render: (l) => fmtQty(l.total_qty), align: 'right' },
          { key: 'w', header: 'Peso', render: (l) => `${fmtNum(l.weight_kg, 0)} / ${fmtNum(l.max_weight_kg, 0)} kg`, align: 'right' },
          { key: 'ps', header: 'Secuencia', render: (l) => l.pick_sequence ?? '—', align: 'right' },
          { key: 'r', header: 'Motivo bloqueo', render: (l) => l.block_reason ?? '' },
        ]}
      />
      <Drawer open={!!edit} onClose={() => setEdit(null)} title={`Editar ubicación ${edit?.code ?? ''}`} footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setEdit(null)}>Cancelar</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={f.admin_status !== 'ACTIVE' && f.reason.trim().length < 3}>Guardar</Button></div>}>
        {edit && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Estado administrativo" required>
              <Select value={f.admin_status} onChange={(e) => setF({ ...f, admin_status: e.target.value })}>{LOCATION_ADMIN_STATUSES.map((s) => <option key={s} value={s}>{es(s)}</option>)}</Select>
            </Field>
            <Field label="Motivo (requerido para bloquear/cuarentena)" required={f.admin_status !== 'ACTIVE'}><Textarea value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
            <Field label="Capacidad (pallets)"><Input type="number" value={f.pallet_capacity} onChange={(e) => setF({ ...f, pallet_capacity: e.target.value })} /></Field>
            <Field label="Peso máx. (kg)"><Input type="number" value={f.max_weight_kg} onChange={(e) => setF({ ...f, max_weight_kg: e.target.value })} /></Field>
            <Field label="Altura (m)"><Input type="number" step="0.1" value={f.height_m} onChange={(e) => setF({ ...f, height_m: e.target.value })} /></Field>
            <Field label="Secuencia de picking"><Input type="number" value={f.pick_sequence} onChange={(e) => setF({ ...f, pick_sequence: e.target.value })} /></Field>
            <Field label="Familias permitidas (coma)"><Input value={f.allowed_families} onChange={(e) => setF({ ...f, allowed_families: e.target.value })} /></Field>
            <Field label="Grupos de compatibilidad (coma)"><Input value={f.allowed_compatibility_groups} onChange={(e) => setF({ ...f, allowed_compatibility_groups: e.target.value })} /></Field>
            <Field label="Altura máx. de pallet (cm)"><Input type="number" value={f.max_height_cm} onChange={(e) => setF({ ...f, max_height_cm: e.target.value })} /></Field>
          </div>
        )}
      </Drawer>
    </div>
  );
}
