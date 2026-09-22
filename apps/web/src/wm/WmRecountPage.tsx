// /wm/recount — re-receive a pallet: scan the LPN, then scan what it REALLY holds product by product with quantities.
// Supervisors get the adjustments applied at once; other roles leave a finished count for recount/approval.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { UomCode } from '@wms/shared';
import { inventoryApi } from '../api/inventory';
import { masterdataApi } from '../api/masterdata';
import { wmTasksApi, type LpnRecountResult } from '../api/wmTasks';
import { QtyPad } from '../components/QtyPad';
import { ScanInput } from '../components/ScanInput';
import { fmtQty } from '../lib/format';
import { BigButton, BigValue, StepBar, useWm, WmShell } from './WmShell';

interface Line {
  sku_code: string;
  description: string;
  qty: string;
  uom_code: UomCode;
  uoms: { uom_code: UomCode; base_qty: string }[];
}

export default function WmRecountPage() {
  return (
    <WmShell title="Re-recibir tarima">
      <Flow />
    </WmShell>
  );
}

function Flow() {
  const wm = useWm();
  const nav = useNavigate();
  const [lpn, setLpn] = useState<{ code: string; location: string; contents: { sku_code: string; description: string; qty: string }[] } | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [pending, setPending] = useState<Omit<Line, 'qty' | 'uom_code'> | null>(null);
  const [purpose, setPurpose] = useState('');
  const [step, setStep] = useState<'LPN' | 'LINES' | 'PURPOSE' | 'DONE'>('LPN');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LpnRecountResult | null>(null);
  const pieces = lines.reduce((a, l) => a + Number(l.qty) * Number(l.uoms.find((u) => u.uom_code === l.uom_code)?.base_qty ?? 1), 0);

  const onLpn = async (code: string) => {
    setBusy(true);
    try {
      const d = await inventoryApi.lpn(code);
      const contents = d.balances.filter((b) => Number(b.qty) > 0).map((b) => ({ sku_code: b.sku.code, description: b.sku.description, qty: String(b.qty) }));
      setLpn({ code: d.code, location: d.current_location?.code ?? '', contents });
      setStep('LINES');
      wm.ok(`${d.code} · el sistema tiene ${contents.length} producto(s)`);
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const onProduct = async (code: string) => {
    setBusy(true);
    try {
      const r = await masterdataApi.skuByBarcode(code);
      setPending({ sku_code: r.sku.code, description: r.sku.description, uoms: r.uoms.map((u) => ({ uom_code: u.uom_code, base_qty: String(u.base_qty) })) });
      wm.ok(`${r.sku.code} · ${r.sku.description}`);
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    if (!lpn) return;
    setBusy(true);
    try {
      const r = await wmTasksApi.recountLpn({ lpn_code: lpn.code, purpose: purpose.trim(), lines: lines.map((l) => ({ sku_code: l.sku_code, qty: l.qty, uom_code: l.uom_code })) });
      setResult(r);
      setStep('DONE');
      wm.ok(r.mode === 'APPLIED' ? 'TARIMA CORREGIDA EN EL SISTEMA' : 'RECUENTO REGISTRADO · FALTA SEGUNDA CUENTA Y APROBACIÓN');
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const reset = () => {
    setLpn(null);
    setLines([]);
    setPending(null);
    setPurpose('');
    setResult(null);
    setStep('LPN');
  };

  if (step === 'LPN')
    return (
      <div>
        <StepBar text="1 · ESCANEA LA TARIMA QUE VAS A RE-RECIBIR" />
        <ScanInput label="LPN" autoUpper onScan={onLpn} disabled={busy} testId="recount-lpn" />
        <div className="mt-2 text-xs text-slate-400">Después escaneas cada producto que trae de verdad y su cantidad. Lo que no escanees se toma como que no está.</div>
      </div>
    );
  if (step === 'LINES' && lpn)
    return (
      <div>
        <StepBar text={pending ? `CANTIDAD REAL DE ${pending.sku_code}` : `2 · ESCANEA LO QUE TRAE LA TARIMA (${lines.length} producto${lines.length === 1 ? '' : 's'})`} />
        <div className="mb-2 flex items-center justify-between rounded-2xl bg-slate-800 px-4 py-2">
          <div>
            <div className="text-xs uppercase text-slate-400">Tarima</div>
            <div className="text-lg font-black">
              {lpn.code} <span className="text-sm font-normal text-slate-300">{lpn.location}</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase text-slate-400">Contado</div>
            <div className="text-lg font-black">{fmtQty(pieces)} pzas</div>
          </div>
        </div>
        <details className="mb-2 text-xs text-slate-400">
          <summary>Lo que dice el sistema ({lpn.contents.length})</summary>
          <ul className="mt-1">
            {lpn.contents.map((c) => (
              <li key={c.sku_code}>
                {c.sku_code} · {c.description} · {fmtQty(c.qty)} pzas
              </li>
            ))}
          </ul>
        </details>
        {pending ? (
          <div>
            <div className="rounded-2xl bg-slate-900 px-4 py-2 text-lg">
              <span className="font-mono font-bold">{pending.sku_code}</span> {pending.description}
            </div>
            <div className="mt-3">
              <QtyPad uoms={pending.uoms} hint="¿CUÁNTO HAY DE VERDAD?" confirmLabel="AGREGAR" allowZero busy={busy} onCancel={() => setPending(null)} onConfirm={(q, u) => { setLines((ls) => [...ls, { ...pending, qty: q, uom_code: u }]); setPending(null); wm.ok(`${q} ${u} DE ${pending.sku_code}`); }} />
            </div>
          </div>
        ) : (
          <>
            <ScanInput label="Código de barras / clave del producto" onScan={onProduct} disabled={busy} testId="recount-product" />
            <ul className="mt-3 grid gap-1 font-mono text-base" data-testid="recount-lines">
              {lines.map((l, i) => (
                <li key={i} className="flex items-center justify-between gap-2 rounded bg-slate-900 px-3 py-2">
                  <span>
                    {l.sku_code} <span className="text-xs text-slate-400">{l.description.slice(0, 24)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    {fmtQty(l.qty)} {l.uom_code === 'CASE' ? 'cajas' : l.uom_code === 'PIECE' ? 'pzas' : l.uom_code}
                    <button type="button" className="rounded bg-slate-700 px-2 py-1 text-xs font-bold text-white" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Quitar">
                      ✕
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <BigButton tone="neutral" onClick={reset}>
                Otra tarima
              </BigButton>
              <BigButton tone="primary" disabled={lines.length === 0} onClick={() => setStep('PURPOSE')} testId="recount-lines-ok">
                Continuar
              </BigButton>
            </div>
          </>
        )}
      </div>
    );
  if (step === 'PURPOSE' && lpn)
    return (
      <div>
        <StepBar text="3 · ¿POR QUÉ SE RE-RECIBE? (OBLIGATORIO)" />
        <BigValue label="Tarima" value={lpn.code} tone="accent" />
        <div className="mt-2 text-sm text-slate-300">
          {lines.length} producto(s) · {fmtQty(pieces)} piezas contadas
        </div>
        <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={3} placeholder="Ej.: tarima revuelta con dos productos · se capturó con factor equivocado" className="mt-3 w-full rounded-lg border-2 border-slate-500 bg-slate-900 px-3 py-3 text-xl text-white" data-testid="recount-purpose" />
        <BigButton tone="success" className="mt-3" disabled={busy || purpose.trim().length < 5} onClick={submit} testId="recount-submit">
          Registrar contenido real
        </BigButton>
        <BigButton tone="neutral" className="mt-3" onClick={() => setStep('LINES')}>
          Regresar
        </BigButton>
      </div>
    );
  if (step === 'DONE' && result)
    return (
      <div>
        <StepBar text={result.mode === 'APPLIED' ? 'TARIMA CORREGIDA' : 'RECUENTO REGISTRADO'} />
        <BigValue label="Tarima" value={`${result.lpn} · ${result.location}`} tone="ok" />
        <ul className="mt-3 grid gap-1 font-mono text-base" data-testid="recount-deltas">
          {result.deltas.map((d) => (
            <li key={d.sku} className="flex justify-between rounded bg-slate-900 px-3 py-2">
              <span>{d.sku}</span>
              <span>
                {fmtQty(d.system)} → {fmtQty(d.counted)} <span className={Number(d.delta) === 0 ? 'text-slate-400' : Number(d.delta) > 0 ? 'text-emerald-300' : 'text-rose-300'}>({Number(d.delta) > 0 ? '+' : ''}{fmtQty(d.delta)})</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-3 text-sm text-slate-300">
          {result.mode === 'APPLIED' ? 'Los ajustes ya están en el inventario, con incidencia y auditoría a tu nombre.' : 'Como tu rol no aprueba ajustes, quedó como conteo terminado: otra persona debe recontar (Conteo) y el supervisor aprobar. El inventario cambia hasta entonces.'}
        </div>
        <div className="mt-4 grid gap-2">
          <BigButton tone="primary" onClick={reset}>
            Otra tarima
          </BigButton>
          <BigButton tone="neutral" onClick={() => nav('/wm')}>
            Volver al menú
          </BigButton>
        </div>
      </div>
    );
  return null;
}
