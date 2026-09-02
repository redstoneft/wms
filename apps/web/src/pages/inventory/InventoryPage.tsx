// /inventory — by SKU, by LPN, by zone, movements ledger, adjust / status change, reconcile.
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { INVENTORY_STATUSES, LPN_STATUSES, MOVEMENT_TYPES, type UomCode } from '@wms/shared';
import { api } from '../../api/client';
import { inventoryApi } from '../../api/inventory';
import { layoutApi } from '../../api/layout';
import { masterdataApi } from '../../api/masterdata';
import type { ReconcileResult } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../components/Toast';
import { Alert, Button, Field, Input, Modal, PageHeader, Select, StatusChip, Table, Tabs, Textarea } from '../../components/ui';
import { useDebounced, useQueryParam } from '../../lib/hooks';
import { es, fmtDateTime, fmtNum, fmtQty } from '../../lib/format';

type Tab = 'sku' | 'lpn' | 'zone' | 'movements';

export default function InventoryPage() {
  const [tab, setTab] = useQueryParam('tab', 'sku');
  const { can } = useAuth();
  const [adjust, setAdjust] = useState(false);
  const [status, setStatus] = useState(false);
  const [recon, setRecon] = useState<ReconcileResult | null>(null);
  const toast = useToast();
  const reconcile = useMutation({
    mutationFn: inventoryApi.reconcile,
    onSuccess: (r) => {
      setRecon(r);
      if (r.ok) toast.success('Conciliación OK', 'El libro mayor y los saldos coinciden.');
      else toast.warn('Conciliación con diferencias');
    },
    onError: (e) => toast.error('Error al conciliar', e),
  });
  return (
    <div>
      <PageHeader
        title="Inventario"
        subtitle="Saldos derivados del libro mayor (nunca se editan directo). Cantidades en piezas (unidad base)."
        actions={
          <>
            {can('inventory.adjust') && <Button variant="secondary" onClick={() => setAdjust(true)}>Ajuste</Button>}
            {can('inventory.quarantine') && <Button variant="secondary" onClick={() => setStatus(true)}>Cuarentena / bloqueo</Button>}
            <Button variant="secondary" onClick={() => reconcile.mutate()} loading={reconcile.isPending}>
              Conciliar
            </Button>
          </>
        }
      />
      {recon && (
        <Alert tone={recon.ok ? 'success' : 'error'} title={recon.ok ? `Conciliación correcta (${fmtDateTime(recon.checked_at)})` : 'Se detectaron discrepancias'} className="mb-4">
          <div className="flex flex-wrap gap-4 text-xs">
            <span>Saldos ≠ libro: {recon.balance_discrepancies.length}</span>
            <span>Ubicación LPN ≠ libro: {recon.location_discrepancies.length}</span>
            <span>Negativos: {recon.negative_balances}</span>
            <span>LPN sin ubicación: {recon.stored_lpns_without_location}</span>
            <span>Líneas de pedido: {recon.order_line_discrepancies.length}</span>
            <span>Totales: {recon.totals_by_status.map((t) => `${es(t.status)} ${fmtQty(t.qty)}`).join(' · ')}</span>
          </div>
        </Alert>
      )}
      <Tabs<Tab>
        value={tab as Tab}
        onChange={setTab}
        tabs={[
          { key: 'sku', label: 'Por SKU' },
          { key: 'lpn', label: 'Por LPN' },
          { key: 'zone', label: 'Por zona' },
          { key: 'movements', label: 'Movimientos (libro mayor)' },
        ]}
      />
      {tab === 'sku' && <BySku />}
      {tab === 'lpn' && <ByLpn />}
      {tab === 'zone' && <ByZone />}
      {tab === 'movements' && <Movements />}
      <AdjustModal open={adjust} onClose={() => setAdjust(false)} />
      <StatusModal open={status} onClose={() => setStatus(false)} />
    </div>
  );
}

function BySku() {
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [status, setStatus] = useState('');
  const nav = useNavigate();
  const rows = useQuery({ queryKey: ['inv-skus', dq, status], queryFn: () => inventoryApi.skus({ q: dq || undefined, status: status || undefined, limit: 500 }) });
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        <Input placeholder="Buscar SKU o descripción" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44">
          <option value="">Cualquier estado</option>
          {INVENTORY_STATUSES.map((s) => (
            <option key={s} value={s}>
              {es(s)}
            </option>
          ))}
        </Select>
      </div>
      <Table
        rows={rows.data}
        loading={rows.isLoading}
        rowKey={(r) => r.sku_id}
        onRowClick={(r) => nav(`/timeline/${r.code}`)}
        columns={[
          { key: 'c', header: 'SKU', render: (r) => <span className="font-mono font-semibold">{r.code}</span> },
          { key: 'd', header: 'Descripción', render: (r) => r.description },
          { key: 'f', header: 'Familia', render: (r) => r.family ?? '—' },
          { key: 'a', header: 'ABC', render: (r) => r.abc_class, align: 'center' },
          { key: 'av', header: 'Disponible', render: (r) => <b className="text-emerald-700">{fmtQty(r.available)}</b>, align: 'right' },
          { key: 'al', header: 'Asignado', render: (r) => fmtQty(r.allocated), align: 'right' },
          { key: 'ou', header: 'En salida', render: (r) => fmtQty(r.outbound), align: 'right' },
          { key: 'lk', header: 'Bloqueado', render: (r) => <span className={r.locked !== '0' ? 'text-rose-700' : ''}>{fmtQty(r.locked)}</span>, align: 'right' },
          { key: 'tr', header: 'En traslado', render: (r) => fmtQty(r.in_transfer), align: 'right' },
          { key: 't', header: 'Total', render: (r) => <b>{fmtQty(r.total)}</b>, align: 'right' },
          { key: 'l', header: 'LPNs', render: (r) => r.lpn_count, align: 'right' },
        ]}
      />
    </div>
  );
}

function ByLpn() {
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [status, setStatus] = useState('');
  const [sku, setSku] = useState('');
  const dsku = useDebounced(sku);
  const nav = useNavigate();
  const rows = useQuery({ queryKey: ['inv-lpns', dq, status, dsku], queryFn: () => inventoryApi.lpns({ q: dq || undefined, status: status || undefined, sku: dsku || undefined, limit: 500 }) });
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        <Input placeholder="Buscar LPN" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs font-mono" />
        <Input placeholder="SKU exacto" value={sku} onChange={(e) => setSku(e.target.value)} className="max-w-xs font-mono" />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44">
          <option value="">Cualquier estado</option>
          {LPN_STATUSES.map((s) => (
            <option key={s} value={s}>
              {es(s)}
            </option>
          ))}
        </Select>
      </div>
      <Table
        rows={rows.data}
        loading={rows.isLoading}
        rowKey={(r) => r.id}
        onRowClick={(r) => nav(`/inventory/lpn/${r.code}`)}
        columns={[
          { key: 'c', header: 'LPN', render: (r) => <span className="font-mono font-semibold">{r.code}</span> },
          { key: 's', header: 'Estado', render: (r) => <StatusChip status={r.status} /> },
          { key: 't', header: 'Tipo', render: (r) => r.lpn_type },
          { key: 'l', header: 'Ubicación', render: (r) => <span className="font-mono">{r.location_code ?? '—'}</span> },
          { key: 'z', header: 'Zona', render: (r) => r.zone_code ?? '—' },
          { key: 'ct', header: 'Contenido', render: (r) => (r.contents ?? []).map((c) => `${c.sku_code} × ${fmtQty(c.qty)}`).join(', ') || '—' },
          { key: 'q', header: 'Total', render: (r) => <b>{fmtQty(r.total_qty)}</b>, align: 'right' },
          { key: 'o', header: 'Pedido / Embarque', render: (r) => [r.order_number, r.shipment_number].filter(Boolean).join(' / ') || '—' },
          { key: 'cr', header: 'Creado', render: (r) => fmtDateTime(r.created_at) },
        ]}
      />
    </div>
  );
}

function ByZone() {
  const rows = useQuery({ queryKey: ['inv-zones'], queryFn: inventoryApi.byZone });
  return (
    <Table
      rows={rows.data}
      loading={rows.isLoading}
      rowKey={(r) => r.zone_id}
      columns={[
        { key: 'z', header: 'Zona', render: (r) => <b>{r.zone_code}</b> },
        { key: 't', header: 'Tipo', render: (r) => es(r.zone_type) },
        { key: 'l', header: 'Ubicaciones', render: (r) => r.locations, align: 'right' },
        { key: 'p', header: 'LPNs', render: (r) => r.lpns, align: 'right' },
        { key: 'q', header: 'Piezas', render: (r) => fmtQty(r.qty), align: 'right' },
        { key: 'w', header: 'Peso (kg)', render: (r) => fmtNum(r.weight_kg, 1), align: 'right' },
      ]}
    />
  );
}

function Movements() {
  const [f, setF] = useState({ lpn: '', sku: '', type: '', from: '', to: '' });
  const df = useDebounced(f, 400);
  const rows = useQuery({
    queryKey: ['movements', df],
    queryFn: () => inventoryApi.movements({ lpn: df.lpn || undefined, sku: df.sku || undefined, type: df.type || undefined, from: df.from ? new Date(df.from).toISOString() : undefined, to: df.to ? new Date(df.to).toISOString() : undefined, limit: 300 }),
  });
  return (
    <div>
      <div className="mb-3 grid gap-2 sm:grid-cols-5">
        <Input placeholder="LPN" value={f.lpn} onChange={(e) => setF({ ...f, lpn: e.target.value })} className="font-mono" />
        <Input placeholder="SKU" value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} className="font-mono" />
        <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
          <option value="">Todos los tipos</option>
          {MOVEMENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        <Input type="datetime-local" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} aria-label="Desde" />
        <Input type="datetime-local" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} aria-label="Hasta" />
      </div>
      <Table
        rows={rows.data}
        loading={rows.isLoading}
        rowKey={(r) => r.id}
        dense
        columns={[
          { key: 'id', header: '#', render: (r) => <span className="font-mono text-xs">{r.id}</span> },
          { key: 'at', header: 'Fecha', render: (r) => fmtDateTime(r.occurred_at) },
          { key: 't', header: 'Tipo', render: (r) => <span className="font-semibold">{r.movement_type}</span> },
          { key: 's', header: 'SKU', render: (r) => <span className="font-mono">{r.sku_code}</span> },
          { key: 'q', header: 'Cant.', render: (r) => <b>{fmtQty(r.qty)}</b>, align: 'right' },
          { key: 'u', header: 'UoM', render: (r) => `${fmtQty(r.uom_qty)} ${r.uom_code}` },
          { key: 'lp', header: 'LPN', render: (r) => <span className="font-mono text-xs">{r.from_lpn === r.to_lpn ? r.from_lpn : `${r.from_lpn ?? '∅'} → ${r.to_lpn ?? '∅'}`}</span> },
          { key: 'lo', header: 'Ubicación', render: (r) => <span className="font-mono text-xs">{r.from_location === r.to_location ? r.from_location : `${r.from_location ?? '∅'} → ${r.to_location ?? '∅'}`}</span> },
          { key: 'st', header: 'Estado', render: (r) => `${es(r.from_status)} → ${es(r.to_status)}` },
          { key: 'us', header: 'Usuario', render: (r) => r.username ?? 'sistema' },
          { key: 'rf', header: 'Referencia', render: (r) => [r.order_number, r.receipt_number, r.shipment_number].filter(Boolean).join(' ') || r.reference_type || '—' },
          { key: 'rs', header: 'Motivo', render: (r) => r.reason ?? '' },
        ]}
      />
    </div>
  );
}

export function AdjustModal({ open, onClose, lpn: initialLpn, sku: initialSku }: { open: boolean; onClose: () => void; lpn?: string; sku?: string }) {
  const toast = useToast();
  const [f, setF] = useState({ lpn_code: initialLpn ?? '', sku_code: initialSku ?? '', direction: 'OUT' as 'IN' | 'OUT', qty: '', uom_code: 'PIECE' as UomCode, reason: '', authorization_id: '' });
  const m = useMutation({
    mutationFn: () => inventoryApi.adjust({ ...f, authorization_id: f.authorization_id || undefined }, api.newKey()),
    onSuccess: (r) => {
      toast.success('Ajuste aplicado', `Movimiento ${r.data.movement_id} · incidencia ${r.data.incident_id}`);
      onClose();
    },
    onError: (e) => toast.error('Ajuste rechazado', e),
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Ajuste de inventario"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="danger" onClick={() => m.mutate()} loading={m.isPending} disabled={!f.lpn_code || !f.sku_code || !/^\d+$/.test(f.qty) || f.reason.trim().length < 3}>
            Aplicar ajuste
          </Button>
        </>
      }
    >
      <Alert tone="warn" className="mb-3">
        Todo ajuste queda en el libro mayor, crea una incidencia y requiere motivo. Requiere permiso de aprobación (counts.approve) o una autorización COUNT_ADJUSTMENT del supervisor.
      </Alert>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="LPN" required>
          <Input value={f.lpn_code} onChange={(e) => setF({ ...f, lpn_code: e.target.value.toUpperCase() })} className="font-mono" />
        </Field>
        <Field label="SKU" required>
          <Input value={f.sku_code} onChange={(e) => setF({ ...f, sku_code: e.target.value })} className="font-mono" />
        </Field>
        <Field label="Dirección" required>
          <Select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value as 'IN' | 'OUT' })}>
            <option value="OUT">Salida (−)</option>
            <option value="IN">Entrada (+)</option>
          </Select>
        </Field>
        <Field label="Cantidad" required>
          <div className="flex gap-2">
            <Input inputMode="numeric" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value.replace(/\D/g, '') })} />
            <Select value={f.uom_code} onChange={(e) => setF({ ...f, uom_code: e.target.value as UomCode })} className="w-28">
              {['PIECE', 'INNER', 'CASE', 'PALLET'].map((u) => (
                <option key={u}>{u}</option>
              ))}
            </Select>
          </div>
        </Field>
        <Field label="Motivo (mín. 3)" required className="sm:col-span-2">
          <Textarea value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        </Field>
        <Field label="ID de autorización (si no eres supervisor)" className="sm:col-span-2">
          <Input value={f.authorization_id} onChange={(e) => setF({ ...f, authorization_id: e.target.value })} className="font-mono" />
        </Field>
      </div>
    </Modal>
  );
}

export function StatusModal({ open, onClose, lpn: initialLpn }: { open: boolean; onClose: () => void; lpn?: string }) {
  const toast = useToast();
  const reasons = useQuery({ queryKey: ['quarantine-reasons'], queryFn: masterdataApi.quarantineReasons, enabled: open });
  const [f, setF] = useState({ lpn_code: initialLpn ?? '', sku_code: '', action: 'QUARANTINE', qty: '', reason_code: '', reason: '' });
  const m = useMutation({
    mutationFn: () => inventoryApi.status({ lpn_code: f.lpn_code, sku_code: f.sku_code || undefined, action: f.action, qty: f.qty || undefined, reason_code: f.reason_code || undefined, reason: f.reason }, api.newKey()),
    onSuccess: (r) => {
      toast.success('Estado actualizado', `${r.data.movements.length} movimiento(s) en ${r.data.lpn_code}`);
      onClose();
    },
    onError: (e) => toast.error('Cambio rechazado', e),
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Cuarentena / bloqueo / daño"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => m.mutate()} loading={m.isPending} disabled={!f.lpn_code || f.reason.trim().length < 3}>
            Aplicar
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="LPN" required>
          <Input value={f.lpn_code} onChange={(e) => setF({ ...f, lpn_code: e.target.value.toUpperCase() })} className="font-mono" />
        </Field>
        <Field label="SKU (vacío = todo el LPN)">
          <Input value={f.sku_code} onChange={(e) => setF({ ...f, sku_code: e.target.value })} className="font-mono" />
        </Field>
        <Field label="Acción" required>
          <Select value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })}>
            {['QUARANTINE', 'RELEASE_QUARANTINE', 'BLOCK', 'UNBLOCK', 'DAMAGE', 'RELEASE_DAMAGE'].map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Cantidad (vacío = toda; requiere SKU)">
          <Input inputMode="numeric" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value.replace(/\D/g, '') })} />
        </Field>
        <Field label="Código de motivo">
          <Select value={f.reason_code} onChange={(e) => setF({ ...f, reason_code: e.target.value })}>
            <option value="">—</option>
            {reasons.data?.map((r) => (
              <option key={r.code} value={r.code}>
                {r.code} · {r.description}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Motivo (mín. 3)" required className="sm:col-span-2">
          <Textarea value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

export function useLocationsForSelect(type?: string) {
  return useQuery({ queryKey: ['locations', type ?? 'all'], queryFn: () => layoutApi.locations({ type, limit: 5000 }) });
}
