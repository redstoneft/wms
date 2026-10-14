// /wm/merge — unir tarimas: a small storage pallet is emptied onto another storage pallet of the same model. The
// operator carries the pieces to where the destination pallet is; the source pallet disappears and its spot is freed.
import { useState } from 'react';
import { api } from '../api/client';
import { pickingApi } from '../api/orders';
import { ScanInput } from '../components/ScanInput';
import { fmtQty } from '../lib/format';
import { BigButton, BigValue, StepBar, useWm, WmShell } from './WmShell';

type Pallet = { code: string; status: string; location: string | null; order: { order_number: string } | null; contents: { sku_code: string; description: string; status: string; qty: string }[] };
type Result = { from_lpn: string; from_location: string | null; to_lpn: string; to_location: string | null; to_qty: string; moved: { sku: string; qty: string }[] };

export default function WmMergePage() {
  return (
    <WmShell title="Unir tarimas">
      <Flow />
    </WmShell>
  );
}

function Flow() {
  const wm = useWm();
  const [busy, setBusy] = useState(false);
  const [src, setSrc] = useState<Pallet | null>(null);
  const [dst, setDst] = useState<Pallet | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const fetchPallet = async (code: string): Promise<Pallet | null> => {
    const r = await pickingApi.pallet(code);
    if (!r.found) { wm.warn(`NO EXISTE LA TARIMA ${code}`); return null; }
    if (r.order || !['STORED', 'OPEN'].includes(r.status)) { wm.warn(`${r.code} NO ES UNA TARIMA DE ALMACÉN (está ${r.status})`); return null; }
    if (!r.contents.length) { wm.warn(`${r.code} ESTÁ VACÍA`); return null; }
    return r;
  };
  const loadSrc = async (code: string) => {
    setBusy(true);
    try {
      const p = await fetchPallet(code);
      if (!p) return;
      if (p.contents.some((c) => c.status !== 'AVAILABLE')) { wm.warn(`${p.code} TIENE PIEZAS ${p.contents.filter((c) => c.status !== 'AVAILABLE').map((c) => c.status).join('/')}: sepáralas antes`); return; }
      setSrc(p);
      wm.ok(`${p.code} · ${p.contents.map((c) => `${fmtQty(c.qty)} ${c.sku_code}`).join(' · ')} · en ${p.location ?? '?'}`);
    } catch (e) { wm.fail(e); } finally { setBusy(false); }
  };
  const loadDst = async (code: string) => {
    if (!src) return;
    if (code.trim().toUpperCase() === src.code) { wm.warn('ES LA MISMA TARIMA'); return; }
    setBusy(true);
    try {
      const p = await fetchPallet(code);
      if (!p) return;
      const missing = src.contents.filter((c) => !p.contents.some((d) => d.sku_code === c.sku_code)).map((c) => c.sku_code);
      if (missing.length) { wm.warn(`${p.code} NO TIENE ${missing.join(', ')}: solo se unen tarimas del mismo modelo`); return; }
      setDst(p);
      wm.ok(`${p.code} · ${p.contents.map((c) => `${fmtQty(c.qty)} ${c.sku_code}`).join(' · ')} · en ${p.location ?? '?'}`);
    } catch (e) { wm.fail(e); } finally { setBusy(false); }
  };
  const submit = async () => {
    if (!src || !dst) return;
    setBusy(true);
    try {
      const r = await pickingApi.mergePallet({ from_lpn_code: src.code, to_lpn_code: dst.code }, api.newKey());
      setResult(r.data);
      wm.ok(r.replayed ? 'YA REGISTRADO' : `${src.code} UNIDA A ${dst.code} · ahora ${fmtQty(r.data.to_qty)} pzas`);
    } catch (e) { wm.fail(e); } finally { setBusy(false); }
  };
  const reset = () => { setSrc(null); setDst(null); setResult(null); };

  if (result)
    return (
      <div>
        <StepBar text="TARIMAS UNIDAS" />
        <div className="grid gap-2 sm:grid-cols-2">
          <BigValue label={`Origen ${result.from_lpn}`} value="vacía · ya no se usa" />
          <BigValue label={`Destino ${result.to_lpn}`} value={`${fmtQty(result.to_qty)} pzas · ${result.to_location ?? ''}`} tone="accent" testId="merge-to" />
        </div>
        <div className="mt-2 rounded-2xl bg-slate-900 p-3 text-sm">
          {result.moved.map((m) => <div key={m.sku} className="font-mono">{fmtQty(m.qty)} × {m.sku}</div>)}
          <div className="mt-2 text-amber-300">Lleva las piezas a {result.to_location ?? 'la tarima destino'} y retira la etiqueta {result.from_lpn}. La posición {result.from_location ?? ''} quedó libre.</div>
        </div>
        <BigButton tone="primary" className="mt-3" onClick={reset} testId="merge-again">Unir otra tarima</BigButton>
      </div>
    );
  if (!src)
    return (
      <div>
        <StepBar text="1 · ESCANEA LA TARIMA CHICA (LA QUE SE VACÍA)" />
        <ScanInput label="LPN de la tarima de almacén" autoUpper onScan={loadSrc} disabled={busy} testId="merge-scan-from" />
        <div className="mt-3 text-sm text-slate-300">Todo lo que tenga pasa a otra tarima del mismo modelo. La tarima chica desaparece y su posición queda libre. Si tiene surtido planeado, el sistema no la deja unir.</div>
      </div>
    );
  const card = (p: Pallet, label: string) => (
    <div className="mb-2 rounded-2xl bg-slate-800 px-4 py-2">
      <div className="flex items-center justify-between"><div className="text-xs font-bold uppercase text-slate-400">{label}</div><div className="text-sm text-slate-300">{p.location ?? ''}</div></div>
      <div className="font-mono text-xl font-black">{p.code}</div>
      {p.contents.map((c) => <div key={c.sku_code} className="text-sm"><span className="font-mono font-bold">{c.sku_code}</span> {c.description} · {fmtQty(c.qty)} pzas</div>)}
    </div>
  );
  if (!dst)
    return (
      <div>
        <StepBar text="2 · ESCANEA LA TARIMA DESTINO (MISMO MODELO)" />
        {card(src, 'Se vacía')}
        <ScanInput label="LPN de la tarima que recibe" autoUpper onScan={loadDst} disabled={busy} testId="merge-scan-to" />
        <BigButton tone="neutral" className="mt-3" onClick={reset}>Otra tarima</BigButton>
      </div>
    );
  return (
    <div>
      <StepBar text="3 · CONFIRMA" />
      {card(src, 'Se vacía')}
      {card(dst, 'Recibe')}
      <div className="rounded-2xl bg-slate-900 px-4 py-2 text-base">Lleva {src.contents.map((c) => `${fmtQty(c.qty)} ${c.sku_code}`).join(' + ')} a <b>{dst.location ?? dst.code}</b> y súbelas a la tarima {dst.code}.</div>
      <BigButton tone="success" className="mt-3" onClick={submit} disabled={busy} testId="merge-confirm">Unir tarimas</BigButton>
      <BigButton tone="neutral" className="mt-2" onClick={() => setDst(null)}>Otra tarima destino</BigButton>
    </div>
  );
}
