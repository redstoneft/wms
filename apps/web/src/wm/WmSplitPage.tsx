// /wm/split — part of an outbound pallet goes to another pallet of the same order (new, or one scanned): by height,
// by delivery destination, or because the customer asked for the split after the pick.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { UomCode } from '@wms/shared';
import { api } from '../api/client';
import { labelsApi } from '../api/labels';
import { pickingApi } from '../api/orders';
import type { OutboundPallet } from '../api/types';
import { QtyPad } from '../components/QtyPad';
import { ScanInput } from '../components/ScanInput';
import { fmtQty } from '../lib/format';
import { BigButton, BigValue, StepBar, useWm, WmShell } from './WmShell';

type Source = { code: string; status: string; location: string | null; destination: string | null; order: { order_number: string; customer: string; destination: string | null } | null; contents: { sku_code: string; description: string; status: string; qty: string }[]; pallets: OutboundPallet[] };
type Result = { from_lpn: string; from_left: string; to_lpn: string; to_qty: string; created: boolean; sku: string; qty: string; destination: string | null; pallets: OutboundPallet[] };

export default function WmSplitPage() {
  return (
    <WmShell title="Dividir tarima">
      <Flow />
    </WmShell>
  );
}

function Flow() {
  const wm = useWm();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [src, setSrc] = useState<Source | null>(null);
  const [sku, setSku] = useState<{ sku_code: string; description: string; qty: string } | null>(null);
  const [qty, setQty] = useState<{ qty: string; uom: UomCode } | null>(null);
  const [target, setTarget] = useState<{ mode: 'NEW' | 'EXISTING'; lpn: string; destination: string }>({ mode: 'NEW', lpn: '', destination: '' });
  const [result, setResult] = useState<Result | null>(null);

  const load = async (code: string) => {
    setBusy(true);
    try {
      const r = await pickingApi.pallet(code);
      if (!r.found) { wm.warn(`NO EXISTE LA TARIMA ${code}`); return; }
      if (!r.order || !['PICKING', 'STAGED'].includes(r.status)) { wm.warn(`${r.code} NO ES UNA TARIMA DE SALIDA (está ${r.status})`); return; }
      if (!r.contents.length) { wm.warn(`${r.code} ESTÁ VACÍA`); return; }
      setSrc(r);
      setSku(r.contents.length === 1 ? r.contents[0]! : null);
      wm.ok(`${r.code} · pedido ${r.order.order_number} · ${r.contents.length} producto(s)`);
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    if (!src || !sku || !qty) return;
    setBusy(true);
    try {
      const r = await pickingApi.splitPallet({ from_lpn_code: src.code, sku_code: sku.sku_code, qty: qty.qty, uom_code: qty.uom, to_lpn_code: target.mode === 'EXISTING' ? target.lpn : undefined, destination: target.destination.trim() || undefined }, api.newKey());
      setResult(r.data);
      wm.ok(r.replayed ? 'YA REGISTRADO' : `${fmtQty(r.data.qty)} PZAS DE ${r.data.sku} → ${r.data.to_lpn}${r.data.created ? ' (NUEVA)' : ''}`);
      if (r.data.created) {
        try { await labelsApi.print({ label_type: 'LPN', entity_id: r.data.to_lpn }); wm.ok(`ETIQUETA ${r.data.to_lpn} ENVIADA`); } catch (e) { wm.fail(e); }
      }
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const reset = () => { setSrc(null); setSku(null); setQty(null); setTarget({ mode: 'NEW', lpn: '', destination: '' }); setResult(null); };
  const print = async (lpn: string) => {
    try { await labelsApi.print({ label_type: 'LPN', entity_id: lpn }); wm.ok(`ETIQUETA ${lpn} ENVIADA`); } catch (e) { wm.fail(e); }
  };

  if (result)
    return (
      <div>
        <StepBar text="TARIMA DIVIDIDA" />
        <div className="grid gap-2 sm:grid-cols-2">
          <BigValue label={`Origen ${result.from_lpn}`} value={`quedan ${fmtQty(result.from_left)}`} tone={result.from_left === '0' ? 'default' : 'ok'} />
          <BigValue label={`Destino ${result.to_lpn}${result.created ? ' (nueva)' : ''}`} value={`${fmtQty(result.to_qty)} pzas`} tone="accent" testId="split-to" />
        </div>
        {result.destination && <div className="mt-2 text-center text-violet-300">Entrega: {result.destination}</div>}
        {result.from_left === '0' && <div className="mt-2 text-center text-sm text-amber-300">La tarima de origen quedó vacía: ya no se usa.</div>}
        <div className="mt-3 grid gap-2">
          <BigButton tone="primary" onClick={() => void print(result.to_lpn)} disabled={busy}>Reimprimir etiqueta de {result.to_lpn}</BigButton>
          {result.from_left !== '0' && <BigButton tone="neutral" onClick={() => void print(result.from_lpn)} disabled={busy}>Reimprimir etiqueta de {result.from_lpn}</BigButton>}
          <BigButton tone="neutral" onClick={() => { const keep = src; reset(); if (keep && result.from_left !== '0') void load(keep.code); }} testId="split-again">Dividir otra vez</BigButton>
          <BigButton tone="neutral" onClick={() => nav('/wm/stage')}>Ir a staging</BigButton>
        </div>
        <div className="mt-3 rounded-2xl bg-slate-900 p-2 text-sm">
          <div className="mb-1 text-xs font-bold uppercase text-slate-400">Tarimas del pedido</div>
          {result.pallets.map((p) => (
            <div key={p.lpn_code} className="flex justify-between border-b border-slate-800 py-1 font-mono"><span>{p.lpn_code}</span><span>{fmtQty(p.qty)} pz{p.destination ? ` · ${p.destination}` : ''}</span></div>
          ))}
        </div>
      </div>
    );
  if (!src)
    return (
      <div>
        <StepBar text="1 · ESCANEA LA TARIMA DE SALIDA QUE VAS A DIVIDIR" />
        <ScanInput label="LPN de la tarima (surtida o en staging)" autoUpper onScan={load} disabled={busy} testId="split-scan-lpn" />
        <div className="mt-3 text-sm text-slate-300">Sirve para separar por altura, por destino (CEDIS / tienda) o cuando el cliente pide la división después de surtir. El pedido no cambia: solo se reparte entre tarimas.</div>
      </div>
    );
  const head = (
    <div className="mb-3 rounded-2xl bg-slate-800 px-4 py-2">
      <div className="flex items-center justify-between">
        <div className="font-mono text-xl font-black">{src.code}</div>
        <div className="text-sm text-slate-300">{src.status === 'STAGED' ? 'en staging' : 'surtida'} · {src.location ?? ''}</div>
      </div>
      <div className="text-sm text-slate-300">Pedido {src.order?.order_number} · {src.order?.customer}{src.destination ? ` · entrega ${src.destination}` : ''}</div>
    </div>
  );
  if (!sku)
    return (
      <div>
        <StepBar text="2 · ¿QUÉ PRODUCTO PASAS A OTRA TARIMA?" />
        {head}
        <div className="grid gap-2">
          {src.contents.map((c) => (
            <button key={c.sku_code} type="button" onClick={() => setSku(c)} className="rounded-2xl bg-slate-900 px-4 py-3 text-left active:bg-sky-700" data-testid="split-sku">
              <div className="font-mono text-lg font-black">{c.sku_code} <span className="text-sm font-normal text-slate-300">{fmtQty(c.qty)} pzas</span></div>
              <div className="text-sm text-slate-300">{c.description}</div>
            </button>
          ))}
        </div>
        <div className="mt-3"><ScanInput label="…o escanea el código del producto" onScan={(v) => { const c = src.contents.find((x) => x.sku_code.toUpperCase() === v.trim().toUpperCase()); if (c) setSku(c); else wm.warn('ESE PRODUCTO NO ESTÁ EN LA TARIMA'); }} disabled={busy} testId="split-scan-sku" active={false} /></div>
        <BigButton tone="neutral" className="mt-3" onClick={reset}>Otra tarima</BigButton>
      </div>
    );
  if (!qty)
    return (
      <div>
        <StepBar text="3 · ¿CUÁNTO PASA A LA OTRA TARIMA?" />
        {head}
        <div className="rounded-2xl bg-slate-900 px-4 py-2 text-lg"><span className="font-mono font-bold">{sku.sku_code}</span> {sku.description} · hay {fmtQty(sku.qty)}</div>
        <div className="mt-2"><QtyPad hint={`MÁXIMO ${fmtQty(sku.qty)} PZAS`} onConfirm={(q, u) => setQty({ qty: q, uom: u })} onCancel={() => setSku(src.contents.length === 1 ? sku : null)} busy={busy} confirmLabel="SIGUIENTE" /></div>
      </div>
    );
  return (
    <div>
      <StepBar text="4 · ¿A QUÉ TARIMA VA?" />
      {head}
      <div className="rounded-2xl bg-slate-900 px-4 py-2 text-lg">{fmtQty(qty.qty)} {qty.uom === 'PIECE' ? 'pzas' : qty.uom.toLowerCase()} de <span className="font-mono font-bold">{sku.sku_code}</span></div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => setTarget({ ...target, mode: 'NEW', lpn: '' })} className={`rounded-2xl py-3 text-base font-black ${target.mode === 'NEW' ? 'bg-emerald-600' : 'bg-slate-800'}`} data-testid="split-target-new">TARIMA NUEVA (se imprime etiqueta)</button>
        <button type="button" onClick={() => setTarget({ ...target, mode: 'EXISTING' })} className={`rounded-2xl py-3 text-base font-black ${target.mode === 'EXISTING' ? 'bg-emerald-600' : 'bg-slate-800'}`} data-testid="split-target-existing">A OTRA TARIMA DEL PEDIDO</button>
      </div>
      {target.mode === 'EXISTING' && (
        <div className="mt-2">
          {target.lpn ? <BigValue label="Tarima destino" value={target.lpn} tone="ok" /> : <ScanInput label="Escanea la tarima destino (mismo pedido, mismo lugar)" autoUpper onScan={(v) => setTarget({ ...target, lpn: v.trim().toUpperCase() })} disabled={busy} testId="split-scan-target" />}
          {src.pallets.filter((p) => p.lpn_code !== src.code).length > 0 && (
            <div className="mt-1 grid gap-1">
              {src.pallets.filter((p) => p.lpn_code !== src.code).map((p) => (
                <button key={p.lpn_code} type="button" onClick={() => setTarget({ ...target, lpn: p.lpn_code })} className={`rounded-xl px-3 py-2 text-left font-mono ${target.lpn === p.lpn_code ? 'bg-emerald-700' : 'bg-slate-800'}`}>{p.lpn_code} · {fmtQty(p.qty)} pz{p.destination ? ` · ${p.destination}` : ''}</button>
              ))}
            </div>
          )}
        </div>
      )}
      <label className="mt-3 block">
        <div className="mb-1 text-xs font-bold uppercase text-slate-400">Entrega de la tarima destino (opcional)</div>
        <input value={target.destination} onChange={(e) => setTarget({ ...target, destination: e.target.value })} placeholder="Ej. CEDIS 7494 · Tienda 1166" className="w-full rounded-lg border-2 border-slate-500 bg-slate-900 px-3 py-2 text-lg text-white" data-testid="split-destination" />
      </label>
      <BigButton tone="success" className="mt-3" onClick={submit} disabled={busy || (target.mode === 'EXISTING' && !target.lpn)} testId="split-confirm">Pasar a la tarima</BigButton>
      <BigButton tone="neutral" className="mt-2" onClick={() => setQty(null)}>Regresar</BigButton>
    </div>
  );
}
