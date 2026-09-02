// /masterdata — SKUs (UoMs + barcodes), customers, suppliers, carriers, printers, quarantine reasons.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UomCode } from '@wms/shared';
import { masterdataApi } from '../api/masterdata';
import type { Party, Printer, Sku } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../components/Toast';
import { Alert, Button, Checkbox, Drawer, Field, Input, PageHeader, Pagination, Select, StatusChip, Table, Tabs } from '../components/ui';
import { useDebounced, useQueryParam } from '../lib/hooks';
import { es, fmtQty, fmtUom } from '../lib/format';

type Tab = 'skus' | 'customers' | 'suppliers' | 'carriers' | 'printers' | 'reasons';

export default function MasterDataPage() {
  const [tab, setTab] = useQueryParam('tab', 'skus');
  return (
    <div>
      <PageHeader title="Datos maestros" subtitle="SKUs con conversiones exactas de UoM (PALLET/CASE/INNER/PIECE) y códigos de barras por nivel de empaque." />
      <Tabs<Tab>
        value={tab as Tab}
        onChange={setTab}
        tabs={[
          { key: 'skus', label: 'SKUs' },
          { key: 'customers', label: 'Clientes' },
          { key: 'suppliers', label: 'Proveedores' },
          { key: 'carriers', label: 'Transportistas' },
          { key: 'printers', label: 'Impresoras' },
          { key: 'reasons', label: 'Motivos de cuarentena' },
        ]}
      />
      {tab === 'skus' && <Skus />}
      {(tab === 'customers' || tab === 'suppliers' || tab === 'carriers') && <Parties kind={tab} />}
      {tab === 'printers' && <Printers />}
      {tab === 'reasons' && <Reasons />}
    </div>
  );
}

function Skus() {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const list = useQuery({ queryKey: ['skus', dq, offset], queryFn: () => masterdataApi.skus({ q: dq || undefined, limit, offset }) });
  const [edit, setEdit] = useState<Partial<Sku> & { isNew?: boolean } | null>(null);
  return (
    <div>
      <div className="mb-3 flex gap-2">
        <Input placeholder="Buscar código o descripción" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
        {can('masterdata.manage') && (
          <Button className="ml-auto" onClick={() => setEdit({ isNew: true, code: '', description: '', abc_class: 'C', unit_weight_kg: '0', uoms: [{ uom_code: 'PIECE', base_qty: '1' }, { uom_code: 'CASE', base_qty: '6' }, { uom_code: 'PALLET', base_qty: '240' }], barcodes: [], requires_lot: false, requires_expiry: false })}>
            Nuevo SKU
          </Button>
        )}
      </div>
      <Table
        rows={list.data?.items}
        loading={list.isLoading}
        rowKey={(s) => s.id}
        onRowClick={can('masterdata.manage') ? (s) => setEdit({ ...s }) : undefined}
        columns={[
          { key: 'c', header: 'SKU', render: (s) => <span className="font-mono font-semibold">{s.code}</span> },
          { key: 'd', header: 'Descripción', render: (s) => s.description },
          { key: 'f', header: 'Familia', render: (s) => s.family ?? '—' },
          { key: 'a', header: 'ABC', render: (s) => s.abc_class, align: 'center' },
          { key: 'u', header: 'UoMs', render: (s) => s.uoms.map((u) => `${u.uom_code}=${fmtQty(u.base_qty)}`).join(' · ') },
          { key: 'b', header: 'Códigos de barras', render: (s) => s.barcodes.map((b) => `${b.barcode} (${b.uom_code})`).join(', ') || '—' },
          { key: 'w', header: 'Peso u. (kg)', render: (s) => s.unit_weight_kg, align: 'right' },
          { key: 'fl', header: 'Reglas', render: (s) => [s.requires_lot && 'Lote', s.requires_expiry && 'Caducidad'].filter(Boolean).join(', ') },
          { key: 's', header: 'Activo', render: (s) => (s.is_active ? 'Sí' : 'No') },
        ]}
      />
      {list.data && <Pagination total={list.data.total} limit={limit} offset={offset} onChange={setOffset} />}
      <SkuDrawer sku={edit} onClose={() => setEdit(null)} />
    </div>
  );
}

function SkuDrawer({ sku, onClose }: { sku: (Partial<Sku> & { isNew?: boolean }) | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState<Partial<Sku> & { isNew?: boolean }>({});
  useEffect(() => {
    if (sku) setF(sku);
  }, [sku]);
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        code: f.code,
        description: f.description,
        family: f.family || undefined,
        compatibility_group: f.compatibility_group || undefined,
        abc_class: f.abc_class,
        unit_weight_kg: Number(f.unit_weight_kg ?? 0),
        case_length_cm: f.case_length_cm ? Number(f.case_length_cm) : undefined,
        case_width_cm: f.case_width_cm ? Number(f.case_width_cm) : undefined,
        case_height_cm: f.case_height_cm ? Number(f.case_height_cm) : undefined,
        pallet_height_cm: f.pallet_height_cm ? Number(f.pallet_height_cm) : undefined,
        requires_lot: !!f.requires_lot,
        requires_expiry: !!f.requires_expiry,
        uoms: (f.uoms ?? []).filter((u) => u.base_qty).map((u) => ({ uom_code: u.uom_code, base_qty: String(u.base_qty) })),
        barcodes: (f.barcodes ?? []).filter((b) => b.barcode).map((b) => ({ barcode: b.barcode, uom_code: b.uom_code })),
      };
      if (!f.isNew) body.is_active = f.is_active;
      return f.isNew ? masterdataApi.createSku(body) : masterdataApi.updateSku(f.id!, body);
    },
    onSuccess: () => {
      toast.success('SKU guardado');
      void qc.invalidateQueries({ queryKey: ['skus'] });
      onClose();
    },
    onError: (e) => toast.error('No se pudo guardar', e),
  });
  const uoms = f.uoms ?? [];
  const barcodes = f.barcodes ?? [];
  const setUom = (code: UomCode, v: string) => {
    const others = uoms.filter((u) => u.uom_code !== code);
    setF({ ...f, uoms: v === '' ? others : [...others, { uom_code: code, base_qty: v }] });
  };
  return (
    <Drawer open={!!sku} onClose={onClose} title={f.isNew ? 'Nuevo SKU' : `SKU ${f.code}`} width="max-w-2xl" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!f.code || !f.description}>Guardar</Button></div>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Código" required><Input value={f.code ?? ''} onChange={(e) => setF({ ...f, code: e.target.value })} disabled={!f.isNew} className="font-mono" /></Field>
        <Field label="Descripción" required><Input value={f.description ?? ''} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Familia"><Input value={f.family ?? ''} onChange={(e) => setF({ ...f, family: e.target.value })} /></Field>
        <Field label="Grupo de compatibilidad"><Input value={f.compatibility_group ?? ''} onChange={(e) => setF({ ...f, compatibility_group: e.target.value })} /></Field>
        <Field label="Clase ABC"><Select value={f.abc_class ?? 'C'} onChange={(e) => setF({ ...f, abc_class: e.target.value })}><option>A</option><option>B</option><option>C</option></Select></Field>
        <Field label="Peso unitario (kg)"><Input type="number" step="0.001" value={String(f.unit_weight_kg ?? '')} onChange={(e) => setF({ ...f, unit_weight_kg: e.target.value })} /></Field>
        <Field label="Caja L×An×Al (cm)">
          <div className="flex gap-1">
            <Input placeholder="L" value={f.case_length_cm ?? ''} onChange={(e) => setF({ ...f, case_length_cm: e.target.value })} />
            <Input placeholder="An" value={f.case_width_cm ?? ''} onChange={(e) => setF({ ...f, case_width_cm: e.target.value })} />
            <Input placeholder="Al" value={f.case_height_cm ?? ''} onChange={(e) => setF({ ...f, case_height_cm: e.target.value })} />
          </div>
        </Field>
        <Field label="Altura pallet (cm)"><Input value={f.pallet_height_cm ?? ''} onChange={(e) => setF({ ...f, pallet_height_cm: e.target.value })} /></Field>
        <div className="flex flex-wrap gap-4 sm:col-span-2">
          <Checkbox label="Requiere lote" checked={!!f.requires_lot} onChange={(e) => setF({ ...f, requires_lot: e.target.checked })} />
          <Checkbox label="Requiere caducidad" checked={!!f.requires_expiry} onChange={(e) => setF({ ...f, requires_expiry: e.target.checked })} />
          {!f.isNew && <Checkbox label="Activo" checked={f.is_active !== false} onChange={(e) => setF({ ...f, is_active: e.target.checked })} />}
        </div>
      </div>
      <div className="mt-4">
        <div className="mb-1 text-sm font-semibold text-slate-700">Unidades de medida (piezas por unidad)</div>
        <div className="grid grid-cols-4 gap-2">
          {(['PIECE', 'INNER', 'CASE', 'PALLET'] as UomCode[]).map((c) => (
            <Field key={c} label={c}>
              <Input inputMode="numeric" value={String(uoms.find((u) => u.uom_code === c)?.base_qty ?? (c === 'PIECE' ? '1' : ''))} onChange={(e) => setUom(c, e.target.value.replace(/\D/g, ''))} disabled={c === 'PIECE'} />
            </Field>
          ))}
        </div>
        {uoms.length > 0 && <div className="mt-1 text-xs text-slate-500">Ejemplo: 250 piezas = {fmtUom(250, uoms)}</div>}
      </div>
      <div className="mt-4">
        <div className="mb-1 text-sm font-semibold text-slate-700">Códigos de barras</div>
        {barcodes.map((b, i) => (
          <div key={i} className="mb-2 grid grid-cols-[1fr_120px_40px] gap-2">
            <Input value={b.barcode} onChange={(e) => setF({ ...f, barcodes: barcodes.map((x, j) => (j === i ? { ...x, barcode: e.target.value } : x)) })} className="font-mono" />
            <Select value={b.uom_code} onChange={(e) => setF({ ...f, barcodes: barcodes.map((x, j) => (j === i ? { ...x, uom_code: e.target.value as UomCode } : x)) })}>
              {['PIECE', 'INNER', 'CASE', 'PALLET'].map((u) => <option key={u}>{u}</option>)}
            </Select>
            <Button variant="ghost" onClick={() => setF({ ...f, barcodes: barcodes.filter((_, j) => j !== i) })}>✕</Button>
          </div>
        ))}
        <Button size="sm" variant="secondary" onClick={() => setF({ ...f, barcodes: [...barcodes, { barcode: '', uom_code: 'PIECE' }] })}>+ Código</Button>
      </div>
      {!f.isNew && f.inventory && f.inventory.length > 0 && <Alert tone="info" className="mt-4">Inventario: {f.inventory.map((i) => `${es(i.status)} ${fmtQty(i.qty)} (${i.lpn_count} LPN)`).join(' · ')}</Alert>}
    </Drawer>
  );
}

function Parties({ kind }: { kind: 'customers' | 'suppliers' | 'carriers' }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const list = useQuery({ queryKey: [kind, dq], queryFn: () => masterdataApi.parties(kind, { q: dq || undefined, limit: 500 }) });
  const [edit, setEdit] = useState<Partial<Party> & { isNew?: boolean } | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { name: edit!.name, tax_id: edit!.tax_id || undefined, contact: edit!.contact || undefined, address: edit!.address || undefined };
      return edit!.isNew ? masterdataApi.createParty(kind, { code: edit!.code, ...body }) : masterdataApi.updateParty(kind, edit!.id!, { ...body, is_active: edit!.is_active });
    },
    onSuccess: () => { toast.success('Guardado'); setEdit(null); void qc.invalidateQueries({ queryKey: [kind] }); },
    onError: (e) => toast.error('No se pudo guardar', e),
  });
  const label = { customers: 'cliente', suppliers: 'proveedor', carriers: 'transportista' }[kind];
  return (
    <div>
      <div className="mb-3 flex gap-2">
        <Input placeholder="Buscar" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
        {can('masterdata.manage') && <Button className="ml-auto" onClick={() => setEdit({ isNew: true, code: '', name: '' })}>Nuevo {label}</Button>}
      </div>
      <Table
        rows={list.data?.items}
        loading={list.isLoading}
        rowKey={(p) => p.id}
        onRowClick={can('masterdata.manage') ? (p) => setEdit({ ...p }) : undefined}
        columns={[
          { key: 'c', header: 'Código', render: (p) => <span className="font-mono font-semibold">{p.code}</span> },
          { key: 'n', header: 'Nombre', render: (p) => p.name },
          ...(kind !== 'carriers' ? [{ key: 't', header: 'RFC', render: (p: Party) => p.tax_id ?? '—' }] : []),
          ...(kind === 'suppliers' ? [{ key: 'ct', header: 'Contacto', render: (p: Party) => p.contact ?? '—' }] : []),
          ...(kind === 'customers' ? [{ key: 'a', header: 'Dirección', render: (p: Party) => p.address ?? '—' }] : []),
          { key: 's', header: 'Activo', render: (p) => (p.is_active ? 'Sí' : 'No') },
        ]}
      />
      <Drawer open={!!edit} onClose={() => setEdit(null)} title={edit?.isNew ? `Nuevo ${label}` : edit?.name ?? ''} footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setEdit(null)}>Cancelar</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!edit?.code || !edit?.name}>Guardar</Button></div>}>
        {edit && (
          <div className="grid gap-3">
            <Field label="Código" required><Input value={edit.code ?? ''} onChange={(e) => setEdit({ ...edit, code: e.target.value })} disabled={!edit.isNew} className="font-mono" /></Field>
            <Field label="Nombre" required><Input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            {kind !== 'carriers' && <Field label="RFC"><Input value={edit.tax_id ?? ''} onChange={(e) => setEdit({ ...edit, tax_id: e.target.value })} /></Field>}
            {kind === 'suppliers' && <Field label="Contacto"><Input value={edit.contact ?? ''} onChange={(e) => setEdit({ ...edit, contact: e.target.value })} /></Field>}
            {kind === 'customers' && <Field label="Dirección"><Input value={edit.address ?? ''} onChange={(e) => setEdit({ ...edit, address: e.target.value })} /></Field>}
            {!edit.isNew && <Checkbox label="Activo" checked={edit.is_active !== false} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} />}
          </div>
        )}
      </Drawer>
    </div>
  );
}

function Printers() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['printers'], queryFn: masterdataApi.printers });
  const [edit, setEdit] = useState<Partial<Printer> & { isNew?: boolean } | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = { code: edit!.code, name: edit!.name, host: edit!.host, port: Number(edit!.port ?? 9100), dpi: Number(edit!.dpi ?? 203), label_width_mm: Number(edit!.label_width_mm ?? 100), label_height_mm: Number(edit!.label_height_mm ?? 150), is_default: !!edit!.is_default };
      return edit!.isNew ? masterdataApi.createPrinter(body) : masterdataApi.updatePrinter(edit!.id!, { ...body, is_active: edit!.is_active });
    },
    onSuccess: () => { toast.success('Impresora guardada'); setEdit(null); void qc.invalidateQueries({ queryKey: ['printers'] }); },
    onError: (e) => toast.error('No se pudo guardar', e),
  });
  return (
    <div>
      {can('printers.manage') && <div className="mb-3"><Button onClick={() => setEdit({ isNew: true, code: '', name: '', host: '', port: 9100, dpi: 203, label_width_mm: 100, label_height_mm: 150, is_default: false })}>Nueva impresora</Button></div>}
      <Table
        rows={list.data}
        loading={list.isLoading}
        rowKey={(p) => p.id}
        onRowClick={can('printers.manage') ? (p) => setEdit({ ...p }) : undefined}
        columns={[
          { key: 'c', header: 'Código', render: (p) => <b>{p.code}</b> },
          { key: 'n', header: 'Nombre', render: (p) => p.name },
          { key: 'h', header: 'Host:puerto', render: (p) => <span className="font-mono">{p.host}:{p.port}</span> },
          { key: 'd', header: 'DPI', render: (p) => p.dpi },
          { key: 'l', header: 'Etiqueta', render: (p) => `${p.label_width_mm} × ${p.label_height_mm} mm` },
          { key: 'df', header: 'Predeterminada', render: (p) => (p.is_default ? <StatusChip status="ACTIVE" /> : '') },
          { key: 'a', header: 'Activa', render: (p) => (p.is_active ? 'Sí' : 'No') },
        ]}
      />
      <Drawer open={!!edit} onClose={() => setEdit(null)} title={edit?.isNew ? 'Nueva impresora' : edit?.name ?? ''} footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setEdit(null)}>Cancelar</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!edit?.code || !edit?.host}>Guardar</Button></div>}>
        {edit && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Código" required><Input value={edit.code ?? ''} onChange={(e) => setEdit({ ...edit, code: e.target.value })} /></Field>
            <Field label="Nombre" required><Input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Host / IP" required><Input value={edit.host ?? ''} onChange={(e) => setEdit({ ...edit, host: e.target.value })} className="font-mono" /></Field>
            <Field label="Puerto"><Input type="number" value={edit.port ?? 9100} onChange={(e) => setEdit({ ...edit, port: Number(e.target.value) })} /></Field>
            <Field label="DPI"><Select value={String(edit.dpi ?? 203)} onChange={(e) => setEdit({ ...edit, dpi: Number(e.target.value) })}><option value="203">203</option><option value="300">300</option></Select></Field>
            <Field label="Etiqueta (mm)"><div className="flex gap-1"><Input type="number" value={edit.label_width_mm ?? 100} onChange={(e) => setEdit({ ...edit, label_width_mm: Number(e.target.value) })} /><Input type="number" value={edit.label_height_mm ?? 150} onChange={(e) => setEdit({ ...edit, label_height_mm: Number(e.target.value) })} /></div></Field>
            <Checkbox label="Predeterminada" checked={!!edit.is_default} onChange={(e) => setEdit({ ...edit, is_default: e.target.checked })} />
            {!edit.isNew && <Checkbox label="Activa" checked={edit.is_active !== false} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} />}
          </div>
        )}
      </Drawer>
    </div>
  );
}

function Reasons() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['quarantine-reasons'], queryFn: masterdataApi.quarantineReasons });
  const [f, setF] = useState({ code: '', description: '' });
  const m = useMutation({
    mutationFn: () => masterdataApi.createQuarantineReason(f),
    onSuccess: () => { toast.success('Motivo guardado'); setF({ code: '', description: '' }); void qc.invalidateQueries({ queryKey: ['quarantine-reasons'] }); },
    onError: (e) => toast.error('No se pudo guardar', e),
  });
  return (
    <div className="max-w-2xl">
      {can('settings.manage') && (
        <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="mb-3 grid grid-cols-[140px_1fr_auto] gap-2">
          <Input placeholder="Código" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} required className="font-mono" />
          <Input placeholder="Descripción" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} required />
          <Button type="submit" loading={m.isPending}>Guardar</Button>
        </form>
      )}
      <Table rows={list.data} loading={list.isLoading} rowKey={(r) => r.code} columns={[{ key: 'c', header: 'Código', render: (r) => <span className="font-mono font-semibold">{r.code}</span> }, { key: 'd', header: 'Descripción', render: (r) => r.description }]} />
    </div>
  );
}
