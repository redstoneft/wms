// /returns — create, receive lines into a RETURNS location, classify, close.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { RETURN_DISPOSITIONS, type UomCode } from '@wms/shared';
import { api } from '../api/client';
import { layoutApi } from '../api/layout';
import { masterdataApi } from '../api/masterdata';
import { returnsApi } from '../api/returns';
import type { ReturnLine } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../components/Toast';
import { Alert, Button, Drawer, Field, Input, KV, Modal, PageHeader, Select, StatusChip, Table, Textarea } from '../components/ui';
import { es, fmtDateTime, fmtQty, toBigInt } from '../lib/format';

export default function ReturnsPage() {
  const nav = useNavigate();
  const { id } = useParams();
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const list = useQuery({ queryKey: ['returns', status], queryFn: () => returnsApi.list({ status: status || undefined, limit: 200 }) });
  const [create, setCreate] = useState(false);
  return (
    <div>
      <PageHeader
        title="Devoluciones"
        subtitle="Las unidades devueltas entran en CUARENTENA sobre un LPN de retorno; la clasificación decide su destino."
        actions={
          <>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44">
              <option value="">Todos</option>
              {['OPEN', 'RECEIVED', 'INSPECTING', 'CLASSIFIED', 'CLOSED'].map((s) => (
                <option key={s} value={s}>
                  {es(s)}
                </option>
              ))}
            </Select>
            {can('returns.manage') && <Button onClick={() => setCreate(true)}>Nueva devolución</Button>}
          </>
        }
      />
      <Table
        rows={list.data}
        loading={list.isLoading}
        rowKey={(r) => r.id}
        onRowClick={(r) => nav(`/returns/${r.id}`)}
        selectedKey={id ?? null}
        columns={[
          { key: 'n', header: 'Devolución', render: (r) => <b>{r.return_number}</b> },
          { key: 's', header: 'Estado', render: (r) => <StatusChip status={r.status} /> },
          { key: 'c', header: 'Cliente', render: (r) => r.customer.name },
          { key: 'o', header: 'Pedido original', render: (r) => r.original_order?.order_number ?? '—' },
          { key: 'l', header: 'Líneas', render: (r) => r.lines.length, align: 'right' },
          { key: 'e', header: 'Esperado / Recibido', render: (r) => `${fmtQty(r.lines.reduce((a, l) => a + toBigInt(l.expected_qty), 0n))} / ${fmtQty(r.lines.reduce((a, l) => a + toBigInt(l.received_qty), 0n))}`, align: 'right' },
          { key: 'cr', header: 'Creada', render: (r) => fmtDateTime(r.created_at) },
        ]}
      />
      <ReturnDrawer id={id} onClose={() => nav('/returns')} />
      <CreateReturnDrawer open={create} onClose={() => setCreate(false)} />
    </div>
  );
}

function ReturnDrawer({ id, onClose }: { id?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['return', id], queryFn: () => returnsApi.get(id!), enabled: !!id });
  const locs = useQuery({ queryKey: ['locations', 'RETURNS'], queryFn: () => layoutApi.locations({ type: 'RETURNS', limit: 50 }), enabled: !!id });
  const [recv, setRecv] = useState<{ line: ReturnLine; qty: string; loc: string } | null>(null);
  const [cls, setCls] = useState<{ line: ReturnLine; qty: string; disposition: string; reason: string } | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['return', id] });
    void qc.invalidateQueries({ queryKey: ['returns'] });
  };
  const receive = useMutation({
    mutationFn: () => returnsApi.receive({ return_id: id!, line_id: recv!.line.id, qty: recv!.qty, uom_code: 'PIECE', returns_location_barcode: recv!.loc }, api.newKey()),
    onSuccess: (r) => { toast.success(`Recibido en ${r.data.lpn_code}`); setRecv(null); refresh(); },
    onError: (e) => toast.error('No se pudo recibir', e),
  });
  const classify = useMutation({
    mutationFn: () => returnsApi.classify({ return_id: id!, line_id: cls!.line.id, disposition: cls!.disposition, qty: cls!.qty, reason: cls!.reason }, api.newKey()),
    onSuccess: (r) => { toast.success(`Clasificado ${es(r.data.disposition)}`, r.data.putaway_task ? 'Se creó tarea de put-away' : undefined); setCls(null); refresh(); },
    onError: (e) => toast.error('No se pudo clasificar', e),
  });
  const close = useMutation({ mutationFn: () => returnsApi.close(id!), onSuccess: () => { toast.success('Devolución cerrada'); refresh(); }, onError: (e) => toast.error('No se pudo cerrar', e) });
  const r = q.data;
  return (
    <Drawer open={!!id} onClose={onClose} title={r ? `${r.return_number} · ${r.customer.name}` : 'Devolución'} width="max-w-3xl" footer={r && can('returns.manage') && r.status === 'CLASSIFIED' ? <Button onClick={() => close.mutate()} loading={close.isPending}>Cerrar devolución</Button> : undefined}>
      {r && (
        <>
          <dl className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KV label="Estado"><StatusChip status={r.status} /></KV>
            <KV label="Pedido original">{r.original_order?.order_number ?? '—'}</KV>
            <KV label="Motivo">{r.reason ?? '—'}</KV>
            <KV label="LPNs" mono>{r.lpns?.map((l) => l.code).join(', ') || '—'}</KV>
          </dl>
          <Table
            rows={r.lines}
            rowKey={(l) => l.id}
            dense
            columns={[
              { key: 's', header: 'SKU', render: (l) => <span className="font-mono">{l.sku.code}</span> },
              { key: 'e', header: 'Esperado', render: (l) => fmtQty(l.expected_qty), align: 'right' },
              { key: 'r', header: 'Recibido', render: (l) => fmtQty(l.received_qty), align: 'right' },
              { key: 'd', header: 'Clasificado', render: (l) => `${fmtQty(l.disposition_qty)} ${l.disposition ? es(l.disposition) : ''}`, align: 'right' },
              {
                key: 'a',
                header: '',
                render: (l) =>
                  can('returns.manage') && r.status !== 'CLOSED' && (
                    <div className="flex gap-1">
                      <Button size="sm" variant="secondary" onClick={() => setRecv({ line: l, qty: (toBigInt(l.expected_qty) - toBigInt(l.received_qty)).toString(), loc: locs.data?.items[0]?.barcode ?? '' })}>Recibir</Button>
                      {toBigInt(l.received_qty) > toBigInt(l.disposition_qty) && <Button size="sm" onClick={() => setCls({ line: l, qty: (toBigInt(l.received_qty) - toBigInt(l.disposition_qty)).toString(), disposition: 'RESTOCK', reason: '' })}>Clasificar</Button>}
                    </div>
                  ),
              },
            ]}
          />
          <Modal open={!!recv} onClose={() => setRecv(null)} title={`Recibir ${recv?.line.sku.code}`} footer={<><Button variant="secondary" onClick={() => setRecv(null)}>Cancelar</Button><Button onClick={() => receive.mutate()} loading={receive.isPending} disabled={!recv?.qty || !recv?.loc}>Recibir</Button></>}>
            <div className="grid gap-3">
              <Field label="Cantidad (piezas)" required><Input inputMode="numeric" value={recv?.qty ?? ''} onChange={(e) => recv && setRecv({ ...recv, qty: e.target.value.replace(/\D/g, '') })} /></Field>
              <Field label="Ubicación de devoluciones" required>
                <Select value={recv?.loc ?? ''} onChange={(e) => recv && setRecv({ ...recv, loc: e.target.value })}>
                  {locs.data?.items.map((l) => <option key={l.id} value={l.barcode}>{l.code}</option>)}
                </Select>
              </Field>
              <Alert tone="info">Entra al libro mayor en estado CUARENTENA.</Alert>
            </div>
          </Modal>
          <Modal open={!!cls} onClose={() => setCls(null)} title={`Clasificar ${cls?.line.sku.code}`} footer={<><Button variant="secondary" onClick={() => setCls(null)}>Cancelar</Button><Button onClick={() => classify.mutate()} loading={classify.isPending} disabled={!cls?.qty || (cls?.reason.trim().length ?? 0) < 3}>Aplicar</Button></>}>
            <div className="grid gap-3">
              <Field label="Disposición" required>
                <Select value={cls?.disposition ?? ''} onChange={(e) => cls && setCls({ ...cls, disposition: e.target.value })}>
                  {RETURN_DISPOSITIONS.map((d) => <option key={d} value={d}>{es(d)}</option>)}
                </Select>
              </Field>
              <Field label="Cantidad" required><Input inputMode="numeric" value={cls?.qty ?? ''} onChange={(e) => cls && setCls({ ...cls, qty: e.target.value.replace(/\D/g, '') })} /></Field>
              <Field label="Motivo (mín. 3)" required><Textarea value={cls?.reason ?? ''} onChange={(e) => cls && setCls({ ...cls, reason: e.target.value })} /></Field>
            </div>
          </Modal>
        </>
      )}
    </Drawer>
  );
}

function CreateReturnDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const customers = useQuery({ queryKey: ['customers'], queryFn: () => masterdataApi.parties('customers', { limit: 500 }), enabled: open });
  const [f, setF] = useState({ customer_code: '', original_order_number: '', reason: '' });
  const [lines, setLines] = useState<{ sku_code: string; qty: string; uom_code: UomCode }[]>([{ sku_code: '', qty: '', uom_code: 'PIECE' }]);
  const m = useMutation({
    mutationFn: () => returnsApi.create({ ...f, original_order_number: f.original_order_number || undefined, reason: f.reason || undefined, lines: lines.filter((l) => l.sku_code && l.qty) }),
    onSuccess: (r) => { toast.success(`Devolución ${r.return_number} creada`); void qc.invalidateQueries({ queryKey: ['returns'] }); onClose(); nav(`/returns/${r.id}`); },
    onError: (e) => toast.error('No se pudo crear', e),
  });
  return (
    <Drawer open={open} onClose={onClose} title="Nueva devolución" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button onClick={() => m.mutate()} loading={m.isPending}>Crear</Button></div>}>
      <div className="grid gap-3">
        <Field label="Cliente" required>
          <Select value={f.customer_code} onChange={(e) => setF({ ...f, customer_code: e.target.value })}>
            <option value="">—</option>
            {customers.data?.items.map((c) => <option key={c.id} value={c.code}>{c.code} · {c.name}</option>)}
          </Select>
        </Field>
        <Field label="Pedido original"><Input value={f.original_order_number} onChange={(e) => setF({ ...f, original_order_number: e.target.value })} /></Field>
        <Field label="Motivo"><Textarea value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        <div className="text-sm font-semibold text-slate-700">Líneas</div>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[1fr_100px_100px_40px] gap-2">
            <Input placeholder="SKU" value={l.sku_code} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, sku_code: e.target.value } : x)))} className="font-mono" />
            <Input placeholder="Cant." inputMode="numeric" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value.replace(/\D/g, '') } : x)))} />
            <Select value={l.uom_code} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, uom_code: e.target.value as UomCode } : x)))}>
              {['PIECE', 'INNER', 'CASE', 'PALLET'].map((u) => <option key={u}>{u}</option>)}
            </Select>
            <Button variant="ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</Button>
          </div>
        ))}
        <Button variant="secondary" size="sm" onClick={() => setLines([...lines, { sku_code: '', qty: '', uom_code: 'PIECE' }])}>+ Línea</Button>
      </div>
    </Drawer>
  );
}
