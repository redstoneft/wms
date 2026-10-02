// /wm/damage — merma: a piece got broken or dropped while picking, staging or loading (or sits broken on a stored pallet).
// Scan the pallet it is on, the product, how many, why. Stored pallet: the pieces stay there as DAÑADO. Outbound pallet of
// an order: the pieces leave the order onto a DAÑADO pallet and the order gets them planned again.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { UomCode } from '@wms/shared';
import { inventoryApi } from '../api/inventory';
import { masterdataApi } from '../api/masterdata';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { wmTasksApi, type DamageReportResult, type DamageReportRow } from '../api/wmTasks';
import { ProductInput } from '../components/ProductInput';
import { QtyPad } from '../components/QtyPad';
import { ScanInput } from '../components/ScanInput';
import { fmtQty } from '../lib/format';
import { BigButton, BigValue, StepBar, useWm, WmShell } from './WmShell';

const REASONS = ['Se cayó al cargar', 'Se cayó al surtir', 'Golpeada / rota en la tarima', 'Venía dañada de fábrica', 'Otro'];

export default function WmDamagePage() {
  return (
    <WmShell title="Merma / daño">
      <Flow />
    </WmShell>
  );
}

function Flow() {
  const wm = useWm();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState<'LPN' | 'PRODUCT' | 'QTY' | 'REASON' | 'DONE'>('LPN');
  const [lpn, setLpn] = useState<{ code: string; location: string; outbound: string | null; contents: { sku_code: string; description: string; qty: string }[] } | null>(null);
  const [sku, setSku] = useState<{ sku_code: string; description: string; uoms: { uom_code: UomCode; base_qty: string }[] } | null>(null);
  const [qty, setQty] = useState<{ qty: string; uom: UomCode } | null>(null);
  const [reason, setReason] = useState('');
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DamageReportResult | null>(null);
  // orders that already have this product picked on an outbound pallet: the merma may belong to one of them
  const [orders, setOrders] = useState<{ order_number: string; customer: string; status: string; picked: string }[]>([]);
  const [orderNo, setOrderNo] = useState('');
  useEffect(() => {
    if (!sku || lpn?.outbound) { setOrders([]); return; }
    let alive = true;
    wmTasksApi.damageOrders(sku.sku_code).then((r) => { if (alive) setOrders(r.orders); }).catch(() => { if (alive) setOrders([]); });
    return () => { alive = false; };
  }, [sku, lpn?.outbound]);

  const onLpn = async (code: string) => {
    setBusy(true);
    try {
      const d = await inventoryApi.lpn(code);
      const contents = d.balances.filter((b) => Number(b.qty) > 0).map((b) => ({ sku_code: b.sku.code, description: b.sku.description, qty: String(b.qty) }));
      const outbound = (d.status === 'PICKING' || d.status === 'STAGED') && d.order ? d.order.order_number : null;
      setLpn({ code: d.code, location: d.current_location?.code ?? '', outbound, contents });
      setStep('PRODUCT');
      wm.ok(outbound ? `${d.code} · tarima de salida del pedido ${outbound}` : `${d.code} · ${contents.length} producto(s)`);
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const pickSku = async (code: string) => {
    setBusy(true);
    try {
      const r = await masterdataApi.skuByBarcode(code);
      setSku({ sku_code: r.sku.code, description: r.sku.description, uoms: r.uoms.map((u) => ({ uom_code: u.uom_code, base_qty: String(u.base_qty) })) });
      setStep('QTY');
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    if (!lpn || !sku || !qty) return;
    const why = reason === 'Otro' ? other.trim() : reason;
    if (why.length < 3) { wm.warn('ESCRIBE EL MOTIVO'); return; }
    setBusy(true);
    try {
      const r = await wmTasksApi.reportDamage({ lpn_code: lpn.code, sku_code: sku.sku_code, qty: qty.qty, uom_code: qty.uom, reason: why, order_number: orderNo || undefined });
      setResult(r);
      setStep('DONE');
      void qc.invalidateQueries({ queryKey: ['my-damage'] });
      wm.warn(r.order_number ? `MERMA REGISTRADA · PEDIDO ${r.order_number} ABIERTO · ${r.replanned?.added ?? 0} LÍNEA(S) POR SURTIR DE NUEVO` : 'MERMA REGISTRADA · PIEZAS BLOQUEADAS COMO DAÑADAS');
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const link = async () => {
    if (!result || !orderNo) return;
    setBusy(true);
    try {
      const r = await wmTasksApi.linkDamageToOrder({ order_number: orderNo, sku_code: result.sku, qty: result.qty, uom_code: 'PIECE', lpn_code: result.lpn, reason: reason === 'Otro' ? other.trim() : reason || 'Merma', report_id: result.report_id ?? undefined });
      setResult(r);
      void qc.invalidateQueries({ queryKey: ['my-damage'] });
      wm.warn(`PEDIDO ${r.order_number} ABIERTO · ${r.replanned?.added ?? 0} LÍNEA(S) POR SURTIR DE NUEVO`);
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const orderSelect = (
    <select className="mt-2 w-full rounded-xl bg-slate-800 px-3 py-3 text-lg text-white" value={orderNo} onChange={(e) => setOrderNo(e.target.value)} data-testid="damage-order">
      <option value="">— Ningún pedido (estaba en almacén) —</option>
      {orders.map((o) => (
        <option key={o.order_number} value={o.order_number}>{o.order_number} · {o.customer} · {fmtQty(o.picked)} surtidas</option>
      ))}
    </select>
  );
  const reset = () => { setLpn(null); setSku(null); setQty(null); setReason(''); setOther(''); setResult(null); setOrders([]); setOrderNo(''); setStep('LPN'); };

  if (step === 'LPN')
    return (
      <div>
        <StepBar text="1 · ESCANEA LA TARIMA DONDE ESTÁ LA PIEZA DAÑADA" />
        <ScanInput label="LPN (de almacén o de salida del pedido)" autoUpper onScan={onLpn} disabled={busy} testId="damage-lpn" />
        <div className="mt-2 text-xs text-slate-400">Si la pieza ya está cargada en el camión, primero descárgala (Cargar → Descargar) y después regístrala aquí.</div>
        <MyDamageHistory busy={busy} setBusy={setBusy} />
      </div>
    );
  if (step === 'PRODUCT' && lpn)
    return (
      <div>
        <StepBar text="2 · ¿QUÉ PRODUCTO SE DAÑÓ?" />
        {lpn.outbound && <div className="mb-2 rounded-2xl border-2 border-amber-400 bg-amber-900/40 px-3 py-2 text-sm text-amber-100">Tarima de salida del pedido <b>{lpn.outbound}</b>: las piezas dañadas salen del pedido y se vuelven a planear para que vayan por otras.</div>}
        <ul className="mb-2 grid gap-1">
          {lpn.contents.map((c) => (
            <li key={c.sku_code}>
              <button type="button" className="w-full rounded-xl bg-slate-800 px-3 py-3 text-left" onClick={() => void pickSku(c.sku_code)} disabled={busy}>
                <span className="font-mono text-lg font-black">{c.sku_code}</span> <span className="text-sm text-slate-300">· {c.description} · {fmtQty(c.qty)} pzas</span>
              </button>
            </li>
          ))}
        </ul>
        <ProductInput label="O escanea la pieza o la caja" onPick={pickSku} disabled={busy} testId="damage-product" />
        <BigButton tone="neutral" className="mt-3" onClick={reset}>Regresar</BigButton>
      </div>
    );
  if (step === 'QTY' && sku)
    return (
      <div>
        <StepBar text={`3 · ¿CUÁNTAS PIEZAS DE ${sku.sku_code} SE DAÑARON?`} />
        <QtyPad uoms={sku.uoms} hint={sku.description} onConfirm={(q, u) => { setQty({ qty: q, uom: u }); setStep('REASON'); }} busy={busy} confirmLabel="SIGUIENTE" />
        <BigButton tone="neutral" className="mt-3" onClick={() => setStep('PRODUCT')}>Regresar</BigButton>
      </div>
    );
  if (step === 'REASON' && lpn && sku && qty)
    return (
      <div>
        <StepBar text="4 · ¿QUÉ PASÓ?" />
        <BigValue label="Merma" value={`${fmtQty(qty.qty)} ${qty.uom} de ${sku.sku_code}`} tone="warn" />
        <div className="mt-3 grid grid-cols-2 gap-2">
          {REASONS.map((r) => (
            <button key={r} type="button" className={`rounded-2xl py-3 text-base font-bold ${reason === r ? 'bg-amber-400 text-amber-950' : 'bg-slate-700 text-white'}`} onClick={() => setReason(r)}>{r}</button>
          ))}
        </div>
        {reason === 'Otro' && <input className="mt-2 w-full rounded-xl bg-slate-800 px-3 py-3 text-lg text-white" placeholder="Escribe qué pasó" value={other} onChange={(e) => setOther(e.target.value)} />}
        {!lpn.outbound && orders.length > 0 && (
          <div className="mt-3 rounded-2xl border-2 border-amber-400 bg-amber-900/30 p-3">
            <div className="text-sm font-bold text-amber-200">¿Ya estaba surtida para un pedido?</div>
            {orderSelect}
            <div className="mt-1 text-xs text-amber-100">Si eliges un pedido, se abre y pide volver a surtir las {fmtQty(qty.qty)} piezas.</div>
          </div>
        )}
        <BigButton tone="warning" className="mt-3" onClick={() => void submit()} disabled={busy || !reason} testId="damage-submit">Registrar merma</BigButton>
        <BigButton tone="neutral" className="mt-2" onClick={() => setStep('QTY')}>Regresar</BigButton>
      </div>
    );
  if (step === 'DONE' && result)
    return (
      <div>
        <StepBar text="MERMA REGISTRADA" />
        <BigValue label="Piezas dañadas" value={`${fmtQty(result.qty)} de ${result.sku}`} tone="warn" />
        <div className="mt-3 rounded-2xl bg-slate-900 p-3 text-base text-slate-200">
          {!result.order_number
            ? `Quedan en la tarima ${result.lpn} marcadas como DAÑADAS: nadie las puede surtir. El supervisor decide si se desechan o se recuperan. Queda incidencia.`
            : `Salieron del pedido ${result.order_number}${result.mode === 'OUTBOUND' && result.damaged_lpn && result.damaged_lpn !== result.lpn ? ` a la tarima ${result.damaged_lpn} (DAÑADO)` : ''}. ${result.replanned?.added ? `${result.replanned.added} línea(s) nuevas en la tarea de surtido: ve por las piezas de reemplazo.` : 'No hay existencia para reponerlas; el pedido queda corto.'}${result.replanned?.short.length ? ` Sin existencia: ${result.replanned.short.join(', ')}.` : ''} Queda incidencia.`}
        </div>
        {!result.order_number && orders.length > 0 && (
          <div className="mt-3 rounded-2xl border-2 border-amber-400 bg-amber-900/30 p-3">
            <div className="text-sm font-bold text-amber-200">¿A qué pedido afectó esta merma?</div>
            {orderSelect}
            <BigButton tone="warning" className="mt-2" onClick={() => void link()} disabled={busy || !orderNo} testId="damage-link">Abrir pedido y volver a surtir</BigButton>
          </div>
        )}
        <div className="mt-4 grid gap-2">
          {result.replanned?.task_id && <BigButton tone="primary" onClick={() => nav(`/wm/pick?task=${result.replanned!.task_id}`)} testId="damage-go-pick">Ir a surtir el pedido {result.order_number}</BigButton>}
          <BigButton tone={result.replanned?.task_id ? 'neutral' : 'primary'} onClick={reset}>Otra merma</BigButton>
          <BigButton tone="neutral" onClick={() => nav('/wm')}>Volver al menú</BigButton>
        </div>
      </div>
    );
  return null;
}

/** The user's own mermas: the ones not charged to an order yet can be charged here, then the picker goes to re-pick. */
function MyDamageHistory({ busy, setBusy }: { busy: boolean; setBusy: (b: boolean) => void }) {
  const wm = useWm();
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['my-damage'], queryFn: () => wmTasksApi.myDamageReports(), refetchInterval: 30_000 });
  const [open, setOpen] = useState<string | null>(null);
  const [orders, setOrders] = useState<{ order_number: string; customer: string; status: string; picked: string }[]>([]);
  const [orderNo, setOrderNo] = useState('');
  const rows = q.data?.reports ?? [];
  if (rows.length === 0) return null;
  const expand = async (r: DamageReportRow) => {
    if (open === r.id) { setOpen(null); return; }
    setOpen(r.id);
    setOrderNo('');
    setOrders([]);
    try {
      const o = await wmTasksApi.damageOrders(r.sku);
      setOrders(o.orders);
      if (o.orders.length === 0) wm.warn('NINGÚN PEDIDO ABIERTO TIENE ESE PRODUCTO SURTIDO');
    } catch (e) {
      wm.fail(e);
    }
  };
  const link = async (r: DamageReportRow) => {
    if (!orderNo) return;
    setBusy(true);
    try {
      const res = await wmTasksApi.linkDamageToOrder({ order_number: orderNo, sku_code: r.sku, qty: r.qty, uom_code: 'PIECE', lpn_code: r.lpn, reason: r.reason, report_id: r.id });
      void qc.invalidateQueries({ queryKey: ['my-damage'] });
      wm.warn(`PEDIDO ${res.order_number} ABIERTO · ${res.replanned?.added ?? 0} LÍNEA(S) POR SURTIR DE NUEVO`);
      if (res.replanned?.task_id) nav(`/wm/pick?task=${res.replanned.task_id}`);
      else setOpen(null);
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-4" data-testid="damage-history">
      <div className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-400">Tus mermas (últimos 14 días)</div>
      <ul className="grid gap-1">
        {rows.map((r) => (
          <li key={r.id} className={`rounded-xl px-3 py-2 ${r.order_number ? 'bg-slate-900 text-slate-300' : 'border-2 border-amber-400 bg-amber-900/30 text-amber-50'}`}>
            <button type="button" className="w-full text-left" onClick={() => void (r.order_number ? r.task_id && nav(`/wm/pick?task=${r.task_id}`) : expand(r))} disabled={busy}>
              <div className="font-mono text-base font-black">{r.sku} · {fmtQty(r.qty)} pzas</div>
              <div className="text-xs">{new Date(r.created_at).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} · {r.lpn} · {r.reason}</div>
              <div className="text-xs font-bold">{r.order_number ? `Cargada al pedido ${r.order_number}${r.task_id ? ' · toca para ir a surtir' : ''}` : 'SIN PEDIDO · toca para asignarla a un pedido'}</div>
            </button>
            {open === r.id && !r.order_number && (
              <div className="mt-2">
                <select className="w-full rounded-xl bg-slate-800 px-3 py-3 text-lg text-white" value={orderNo} onChange={(e) => setOrderNo(e.target.value)} data-testid="history-order">
                  <option value="">— Elige el pedido —</option>
                  {orders.map((o) => (
                    <option key={o.order_number} value={o.order_number}>{o.order_number} · {o.customer} · {fmtQty(o.picked)} surtidas</option>
                  ))}
                </select>
                <BigButton tone="warning" className="mt-2" onClick={() => void link(r)} disabled={busy || !orderNo} testId="history-link">Abrir pedido y volver a surtir</BigButton>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
