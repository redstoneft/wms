// /wm/assembly — handheld assembly flow: scan station → scan input pallet(s) and pieces consumed → scan finished product →
// pallets produced (cases per pallet, pieces per case) → scrap → confirm → print the new LPN labels.
import { useState } from 'react';
import { api } from '../api/client';
import { assemblyApi, type AssemblyResult } from '../api/assembly';
import { inventoryApi } from '../api/inventory';
import { labelsApi } from '../api/labels';
import { masterdataApi } from '../api/masterdata';
import { ScanInput } from '../components/ScanInput';
import { fmtQty } from '../lib/format';
import { BigButton, BigValue, StepBar, useWm, WmShell } from './WmShell';

type Step = 'STATION' | 'IN_LPN' | 'IN_SKU' | 'IN_QTY' | 'IN_MORE' | 'OUT_SKU' | 'PALLETS' | 'SCRAP' | 'CONFIRM' | 'DONE';
interface InLine {
  lpn_code: string;
  sku_code: string;
  description: string;
  available: string;
  qty: string;
}

export default function WmAssemblyPage() {
  return (
    <WmShell title="Armado">
      <Flow />
    </WmShell>
  );
}

function Num({ label, value, onChange, testId }: { label: string; value: string; onChange: (v: string) => void; testId?: string }) {
  return (
    <label className="block">
      <div className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-300">{label}</div>
      <input type="number" inputMode="numeric" min={0} value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded-lg border-2 border-slate-500 bg-slate-900 px-3 py-3 font-mono text-3xl text-white" data-testid={testId} />
    </label>
  );
}

function Flow() {
  const wm = useWm();
  const [step, setStep] = useState<Step>('STATION');
  const [station, setStation] = useState('');
  const [lines, setLines] = useState<InLine[]>([]);
  const [draft, setDraft] = useState<InLine | null>(null);
  const [options, setOptions] = useState<{ sku_code: string; description: string; qty: string }[]>([]);
  const [out, setOut] = useState<{ code: string; description: string; requires_lot: boolean; requires_expiry: boolean; case_qty: string } | null>(null);
  const [nPallets, setNPallets] = useState('1');
  const [cases, setCases] = useState('');
  const [ppc, setPpc] = useState('');
  const [lot, setLot] = useState('');
  const [expiry, setExpiry] = useState('');
  const [scrap, setScrap] = useState('0');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AssemblyResult | null>(null);

  const consumed = lines.reduce((a, l) => a + (Number(l.qty) || 0), 0);
  const produced = (Number(nPallets) || 0) * (Number(cases) || 0) * (Number(ppc) || 0);
  const scrapN = Number(scrap) || 0;
  const single = new Set(lines.map((l) => l.sku_code)).size <= 1;
  const balanced = !single || consumed === produced + scrapN;

  const onLpn = async (code: string) => {
    setBusy(true);
    try {
      const d = await inventoryApi.lpn(code);
      const bySku = new Map<string, { sku_code: string; description: string; qty: bigint }>();
      for (const b of d.balances) {
        if ((b.status !== 'AVAILABLE' && b.status !== 'BLOCKED') || BigInt(b.qty) <= 0n) continue; // blocked = bodies waiting for assembly
        const cur = bySku.get(b.sku.code) ?? { sku_code: b.sku.code, description: b.sku.description, qty: 0n };
        cur.qty += BigInt(b.qty);
        bySku.set(b.sku.code, cur);
      }
      const avail = [...bySku.values()].map((c) => ({ ...c, qty: c.qty.toString() }));
      if (!avail.length) throw new Error('El pallet no tiene inventario disponible ni bloqueado');
      if (avail.length === 1) {
        setDraft({ lpn_code: d.code, sku_code: avail[0]!.sku_code, description: avail[0]!.description, available: avail[0]!.qty, qty: avail[0]!.qty });
        setStep('IN_QTY');
      } else {
        setDraft({ lpn_code: d.code, sku_code: '', description: '', available: '0', qty: '' });
        setOptions(avail);
        setStep('IN_SKU');
      }
      wm.ok();
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const onOutSku = async (code: string) => {
    setBusy(true);
    try {
      const r = await masterdataApi.skuByBarcode(code);
      const caseUom = r.uoms.find((u) => u.uom_code === 'CASE');
      setOut({ code: r.sku.code, description: r.sku.description, requires_lot: r.sku.requires_lot, requires_expiry: r.sku.requires_expiry, case_qty: caseUom ? String(caseUom.base_qty) : '' });
      if (caseUom && !ppc) setPpc(String(caseUom.base_qty));
      wm.ok(lines.every((l) => l.sku_code === r.sku.code) ? `${r.sku.code} · MISMO CÓDIGO: REEMPAQUE` : `${r.sku.code} · ${r.sku.description}`);
      setStep('PALLETS');
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    if (!out) return;
    setBusy(true);
    try {
      const n = Number(nPallets);
      const r = await assemblyApi.complete(
        {
          station_barcode: station,
          inputs: lines.map((l) => ({ lpn_code: l.lpn_code, sku_code: l.sku_code, qty: Number(l.qty) })),
          output: { sku_code: out.code, lot: lot || undefined, expiry_date: expiry || undefined, pallets: Array.from({ length: n }, () => ({ cases: Number(cases), pieces_per_case: Number(ppc) })) },
          scrap: scrapN > 0 ? { qty: scrapN, reason } : undefined,
        },
        api.newKey(),
      );
      setResult(r.data);
      wm.ok(r.replayed ? 'YA REGISTRADO' : `ARMADO ${r.data.code} · ${r.data.produced.length} TARIMAS NUEVAS`);
      setStep('DONE');
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const print = async (lpn: string) => {
    try {
      await labelsApi.print({ label_type: 'LPN', entity_id: lpn });
      wm.ok(`ETIQUETA ${lpn} ENVIADA`);
    } catch (e) {
      wm.fail(e);
    }
  };
  const reset = () => {
    setStep('STATION');
    setLines([]);
    setDraft(null);
    setOut(null);
    setNPallets('1');
    setCases('');
    setPpc('');
    setLot('');
    setExpiry('');
    setScrap('0');
    setReason('');
    setResult(null);
  };

  if (step === 'STATION')
    return (
      <div>
        <StepBar text="1 · ESCANEA LA ESTACIÓN DE ARMADO" />
        <ScanInput
          label="Ubicación (zona ARM o staging)"
          autoUpper
          onScan={(v) => {
            setStation(v);
            wm.ok();
            setStep('IN_LPN');
          }}
          testId="scan-station"
        />
      </div>
    );
  if (step === 'IN_LPN')
    return (
      <div>
        <StepBar text={lines.length ? `2 · ESCANEA OTRO PALLET DE INSUMO (${lines.length} agregado${lines.length > 1 ? 's' : ''})` : '2 · ESCANEA EL PALLET DE INSUMO (cuerpos)'} />
        <BigValue label="Estación" value={station} tone="accent" />
        <div className="mt-3">
          <ScanInput label="LPN de entrada" autoUpper onScan={onLpn} disabled={busy} testId="scan-lpn" />
        </div>
        {lines.length > 0 && (
          <BigButton tone="primary" className="mt-3" onClick={() => setStep('OUT_SKU')} testId="inputs-done">
            Listo, sin más insumos
          </BigButton>
        )}
        <BigButton tone="neutral" className="mt-3" onClick={() => (lines.length ? setStep('IN_MORE') : setStep('STATION'))}>
          Regresar
        </BigButton>
      </div>
    );
  if (step === 'IN_SKU' && draft)
    return (
      <div>
        <StepBar text="¿QUÉ INSUMO SE CONSUME DE ESTE PALLET?" />
        <BigValue label="Pallet" value={draft.lpn_code} />
        <div className="mt-3 grid gap-2">
          {options.map((o) => (
            <BigButton
              key={o.sku_code}
              tone="neutral"
              onClick={() => {
                setDraft({ ...draft, sku_code: o.sku_code, description: o.description, available: o.qty, qty: o.qty });
                setStep('IN_QTY');
              }}
            >
              {o.sku_code} · {o.description} · {fmtQty(o.qty)} pzas
            </BigButton>
          ))}
        </div>
      </div>
    );
  if (step === 'IN_QTY' && draft)
    return (
      <div>
        <StepBar text="3 · ¿CUÁNTAS PIEZAS SE CONSUMEN?" />
        <div className="grid gap-2 sm:grid-cols-2">
          <BigValue label="Pallet" value={draft.lpn_code} />
          <BigValue label="Disponible" value={`${fmtQty(draft.available)} pzas`} />
        </div>
        <div className="mt-2 text-sm text-slate-300">
          {draft.sku_code} · {draft.description}
        </div>
        <div className="mt-3">
          <Num label="Piezas consumidas" value={draft.qty} onChange={(v) => setDraft({ ...draft, qty: v })} testId="in-qty" />
        </div>
        <BigButton
          tone="success"
          className="mt-3"
          disabled={!(Number(draft.qty) > 0) || Number(draft.qty) > Number(draft.available)}
          onClick={() => {
            setLines((ls) => [...ls, draft]);
            setDraft(null);
            wm.ok();
            setStep('IN_MORE');
          }}
          testId="in-qty-ok"
        >
          Agregar
        </BigButton>
        <BigButton tone="neutral" className="mt-3" onClick={() => setStep('IN_LPN')}>
          Regresar
        </BigButton>
      </div>
    );
  if (step === 'IN_MORE')
    return (
      <div>
        <StepBar text="INSUMOS AGREGADOS" />
        <ul className="grid gap-1 font-mono text-lg">
          {lines.map((l, i) => (
            <li key={i} className="flex justify-between rounded bg-slate-800 px-3 py-2">
              <span>
                {l.lpn_code} · {l.sku_code}
              </span>
              <span>{fmtQty(l.qty)} pzas</span>
            </li>
          ))}
        </ul>
        <BigButton tone="primary" className="mt-3" onClick={() => setStep('OUT_SKU')} testId="inputs-done">
          Continuar al producto terminado
        </BigButton>
        <BigButton tone="neutral" className="mt-3" onClick={() => setStep('IN_LPN')}>
          Agregar otro insumo
        </BigButton>
      </div>
    );
  if (step === 'OUT_SKU')
    return (
      <div>
        <StepBar text="4 · ESCANEA EL PRODUCTO TERMINADO (caja o clave)" />
        <BigValue label="Consumido" value={`${fmtQty(consumed)} pzas`} />
        <div className="mt-3">
          <ScanInput label="Código de barras / clave SAE / GTIN" onScan={onOutSku} disabled={busy} testId="scan-out-sku" />
        </div>
        <BigButton tone="neutral" className="mt-3" onClick={() => setStep('IN_MORE')}>
          Regresar
        </BigButton>
      </div>
    );
  if (step === 'PALLETS' && out)
    return (
      <div>
        <StepBar text="5 · ¿CUÁNTAS TARIMAS SALIERON Y CÓMO VAN EMPACADAS?" />
        <div className="text-sm text-slate-300">
          {out.code} · {out.description}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Num label="Tarimas" value={nPallets} onChange={setNPallets} testId="n-pallets" />
          <Num label="Cajas por tarima" value={cases} onChange={setCases} testId="cases" />
          <Num label="Piezas por caja" value={ppc} onChange={setPpc} testId="ppc" />
        </div>
        {(out.requires_lot || out.requires_expiry) && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {out.requires_lot && (
              <label className="block">
                <div className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-300">Lote</div>
                <input value={lot} onChange={(e) => setLot(e.target.value)} className="w-full rounded-lg border-2 border-slate-500 bg-slate-900 px-3 py-3 font-mono text-2xl text-white" />
              </label>
            )}
            {out.requires_expiry && (
              <label className="block">
                <div className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-300">Caducidad</div>
                <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} className="w-full rounded-lg border-2 border-slate-500 bg-slate-900 px-3 py-3 font-mono text-2xl text-white" />
              </label>
            )}
          </div>
        )}
        <div className="mt-3">
          <BigValue label="Producido" value={`${fmtQty(produced)} pzas`} tone={balanced ? 'ok' : 'warn'} testId="produced" />
        </div>
        <BigButton tone="primary" className="mt-3" disabled={produced <= 0 || (out.requires_lot && !lot) || (out.requires_expiry && !expiry)} onClick={() => setStep('SCRAP')} testId="pallets-ok">
          Continuar
        </BigButton>
        <BigButton tone="neutral" className="mt-3" onClick={() => setStep('OUT_SKU')}>
          Regresar
        </BigButton>
      </div>
    );
  if (step === 'SCRAP')
    return (
      <div>
        <StepBar text="6 · ¿HUBO MERMA?" />
        <div className="grid gap-2 sm:grid-cols-2">
          <BigValue label="Consumido" value={`${fmtQty(consumed)} pzas`} />
          <BigValue label="Producido" value={`${fmtQty(produced)} pzas`} />
        </div>
        <div className="mt-3">
          <Num label="Piezas de merma" value={scrap} onChange={setScrap} testId="scrap" />
        </div>
        {scrapN > 0 && (
          <label className="mt-3 block">
            <div className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-300">Motivo</div>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="cuerpos golpeados" className="w-full rounded-lg border-2 border-slate-500 bg-slate-900 px-3 py-3 text-xl text-white" data-testid="scrap-reason" />
          </label>
        )}
        {!balanced && <div className="mt-3 rounded-lg bg-amber-900/60 p-3 text-amber-200">La cuenta no cuadra: consumido {fmtQty(consumed)} ≠ producido {fmtQty(produced)} + merma {fmtQty(scrapN)}. Ajusta la merma o las tarimas.</div>}
        <BigButton tone="primary" className="mt-3" disabled={!balanced || (scrapN > 0 && reason.trim().length < 3)} onClick={() => setStep('CONFIRM')} testId="scrap-ok">
          Continuar
        </BigButton>
        <BigButton tone="neutral" className="mt-3" onClick={() => setStep('PALLETS')}>
          Regresar
        </BigButton>
      </div>
    );
  if (step === 'CONFIRM' && out)
    return (
      <div>
        <StepBar text="7 · CONFIRMA EL ARMADO" />
        <div className="grid gap-2 font-mono text-lg">
          {lines.map((l, i) => (
            <div key={i} className="rounded bg-slate-800 px-3 py-2">
              − {fmtQty(l.qty)} pzas de {l.sku_code} · {l.lpn_code}
            </div>
          ))}
          <div className="rounded bg-emerald-900/60 px-3 py-2 text-emerald-100">
            + {nPallets} tarima(s) × {cases} cajas × {ppc} pzas de {out.code} = {fmtQty(produced)} pzas
          </div>
          {scrapN > 0 && <div className="rounded bg-amber-900/60 px-3 py-2 text-amber-100">Merma {fmtQty(scrapN)} pzas · {reason}</div>}
        </div>
        <BigButton tone="success" className="mt-3" onClick={submit} disabled={busy} testId="confirm">
          Registrar armado
        </BigButton>
        <BigButton tone="neutral" className="mt-3" onClick={() => setStep('SCRAP')}>
          Regresar
        </BigButton>
      </div>
    );
  if (step === 'DONE' && result)
    return (
      <div>
        <StepBar text={`ARMADO ${result.code} · IMPRIME Y PEGA LAS ETIQUETAS`} />
        <div className="grid gap-2">
          {result.produced.map((p) => (
            <div key={p.lpn} className="rounded-lg bg-slate-800 p-3">
              <div className="font-mono text-2xl font-black" data-testid="new-lpn">
                {p.lpn}
              </div>
              <div className="text-sm text-slate-300">
                {p.cases} cajas × {p.pieces_per_case} = {fmtQty(p.qty)} pzas{p.suggested_location ? ` · acomodo sugerido ${p.suggested_location}` : ''}
              </div>
              <BigButton tone="neutral" className="mt-2" onClick={() => void print(p.lpn)}>
                Imprimir etiqueta
              </BigButton>
            </div>
          ))}
        </div>
        {result.warnings.length > 0 && <div className="mt-3 rounded-lg bg-amber-900/60 p-3 text-amber-200">{result.warnings.join(' · ')}</div>}
        <div className="mt-3 text-sm text-slate-300">Las tarimas nuevas ya tienen tarea de acomodo: ve a Ubicar, escanea cada LPN y llévalo a donde te indique.</div>
        <BigButton tone="primary" className="mt-3" onClick={reset} testId="again">
          Otro armado
        </BigButton>
      </div>
    );
  return null;
}
