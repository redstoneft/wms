// /wm/assembly — handheld assembly flow: scan station → scan input pallet(s) and pieces consumed → scan finished product →
// pallets produced (cases per pallet, pieces per case) → scrap → confirm → print the new LPN labels.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { assemblyApi, type AssemblyOrder, type AssemblyResult } from '../api/assembly';
import { inventoryApi } from '../api/inventory';
import { labelsApi } from '../api/labels';
import { putawayApi } from '../api/storage';
import type { PutawayOption } from '../api/types';
import { LocationPicker } from './LocationPicker';
import { masterdataApi } from '../api/masterdata';
import { ScanInput } from '../components/ScanInput';
import { fmtQty } from '../lib/format';
import { BigButton, BigValue, StepBar, useWm, WmShell } from './WmShell';

type Step = 'HOME' | 'REVIEW' | 'STATION' | 'IN_LPN' | 'IN_SKU' | 'IN_QTY' | 'IN_MORE' | 'OUT_SKU' | 'PALLETS' | 'SCRAP' | 'PURPOSE' | 'CONFIRM' | 'CONFIRM_START' | 'START_DONE' | 'DONE';
/** ONESHOT: everything at once · START: take components to the station, confirm later · FINISH: confirm an open order */
type Flow = 'ONESHOT' | 'START' | 'FINISH';
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
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>('HOME');
  const [flow, setFlow] = useState<Flow>('ONESHOT');
  const [open, setOpen] = useState<AssemblyOrder | null>(null); // the open order being confirmed (FINISH)
  const [started, setStarted] = useState<AssemblyOrder | null>(null);
  const openList = useQuery({ queryKey: ['assembly', 'open'], queryFn: () => assemblyApi.list({ status: 'IN_PROGRESS', limit: 50 }), enabled: step === 'HOME', refetchInterval: 15_000 });
  const doneList = useQuery({ queryKey: ['assembly', 'done'], queryFn: () => assemblyApi.list({ status: 'COMPLETED', limit: 10 }), enabled: step === 'HOME' });
  const [review, setReview] = useState<AssemblyOrder | null>(null);
  const openReview = async (id: string) => {
    setBusy(true);
    try {
      setReview(await assemblyApi.get(id));
      setStep('REVIEW');
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const [station, setStation] = useState('');
  const [lines, setLines] = useState<InLine[]>([]);
  const [draft, setDraft] = useState<InLine | null>(null);
  const [options, setOptions] = useState<{ sku_code: string; description: string; qty: string }[]>([]);
  const [out, setOut] = useState<{ code: string; description: string; requires_lot: boolean; requires_expiry: boolean; case_qty: string } | null>(null);
  // one entry per physical pallet (cases on it); pallets need not be equal: 70 + 70 + 30 is fine
  // one row per physical pallet: full cases, pieces in one incomplete case, defective pieces found on it
  const [pallets, setPallets] = useState<{ cases: string; partial: string; defective: string }[]>([{ cases: '', partial: '', defective: '' }]);
  const newRow = (cases = '') => ({ cases, partial: '', defective: '' });
  const [ppc, setPpc] = useState('');
  const [lot, setLot] = useState('');
  const [expiry, setExpiry] = useState('');
  const [scrap, setScrap] = useState('0');
  const [reason, setReason] = useState('');
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AssemblyResult | null>(null);

  const consumed = flow === 'FINISH' && open ? Number(open.consumed_qty) : lines.reduce((a, l) => a + (Number(l.qty) || 0), 0);
  const ppcN = Number(ppc) || 0;
  const produced = pallets.reduce((a, p) => a + (Number(p.cases) || 0) * ppcN + (Number(p.partial) || 0), 0);
  const defectiveTotal = pallets.reduce((a, p) => a + (Number(p.defective) || 0), 0);
  const setCount = (n: number) => setPallets((rows) => (n > rows.length ? [...rows, ...Array.from({ length: n - rows.length }, () => newRow(rows[rows.length - 1]?.cases ?? ''))] : rows.slice(0, Math.max(1, n))));
  const palletsPayload = () => pallets.map((p) => ({ cases: Number(p.cases) || 0, pieces_per_case: ppcN, partial_pieces: Number(p.partial) || 0, defective: Number(p.defective) || 0 })).filter((p) => p.cases > 0 || p.partial_pieces > 0);
  const scrapN = defectiveTotal + (Number(scrap) || 0); // defective per pallet + extra difference declared as scrap
  const single = flow === 'FINISH' && open ? new Set(open.inputs.map((i) => i.sku.code)).size <= 1 : new Set(lines.map((l) => l.sku_code)).size <= 1;
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
      setStep(flow === 'START' ? 'PURPOSE' : 'PALLETS');
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const submitStart = async () => {
    if (!out) return;
    setBusy(true);
    try {
      const r = await assemblyApi.start({ station_barcode: station || undefined, inputs: lines.map((l) => ({ lpn_code: l.lpn_code, sku_code: l.sku_code, qty: Number(l.qty) })), output_sku_code: out.code, notes: purpose.trim() }, api.newKey());
      setStarted(r.data);
      wm.ok(r.replayed ? 'YA REGISTRADO' : `ARMADO ${r.data.code} ABIERTO · ${lines.length} TARIMA(S) EN LA ESTACIÓN`);
      void qc.invalidateQueries({ queryKey: ['assembly', 'open'] });
      setStep('START_DONE');
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const submitFinish = async () => {
    if (!open) return;
    setBusy(true);
    try {
      const r = await assemblyApi.finish(open.id, { lot: lot || undefined, expiry_date: expiry || undefined, pallets: palletsPayload(), scrap: Number(scrap) > 0 ? { qty: Number(scrap), reason } : undefined, notes: reason && Number(scrap) <= 0 && defectiveTotal > 0 ? `Defectuosas: ${reason}` : undefined }, api.newKey());
      setResult(r.data);
      wm.ok(r.replayed ? 'YA REGISTRADO' : `ARMADO ${r.data.code} CONFIRMADO · ${r.data.produced.length} TARIMAS NUEVAS`);
      void qc.invalidateQueries({ queryKey: ['assembly', 'open'] });
      setStep('DONE');
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  /** confirm an open order: load its finished SKU (for lot/expiry/case size) and go straight to the pallets */
  const pickOpen = async (o: AssemblyOrder) => {
    setBusy(true);
    try {
      const r = await masterdataApi.skuByBarcode(o.output_sku.code);
      const caseUom = r.uoms.find((u) => u.uom_code === 'CASE');
      setOut({ code: r.sku.code, description: r.sku.description, requires_lot: r.sku.requires_lot, requires_expiry: r.sku.requires_expiry, case_qty: caseUom ? String(caseUom.base_qty) : '' });
      setPpc(caseUom ? String(caseUom.base_qty) : '');
      setOpen(o);
      setFlow('FINISH');
      setStation(o.station.barcode);
      setStep('PALLETS');
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const cancelOpen = async (o: AssemblyOrder) => {
    const why = window.prompt(`¿Cancelar el armado ${o.code}? Las tarimas se desbloquean y regresan a rack (tarea de acomodo). Motivo:`);
    if (!why || why.trim().length < 3) return;
    setBusy(true);
    try {
      await assemblyApi.cancel(o.id, why.trim());
      wm.ok(`ARMADO ${o.code} CANCELADO`);
      void qc.invalidateQueries({ queryKey: ['assembly', 'open'] });
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
      const r = await assemblyApi.complete(
        {
          station_barcode: station || undefined,
          inputs: lines.map((l) => ({ lpn_code: l.lpn_code, sku_code: l.sku_code, qty: Number(l.qty) })),
          output: { sku_code: out.code, lot: lot || undefined, expiry_date: expiry || undefined, pallets: palletsPayload() },
          scrap: Number(scrap) > 0 ? { qty: Number(scrap), reason } : undefined,
          notes: purpose.trim(),
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
  const print = async (lpn: string, reprintReason?: string) => {
    try {
      await labelsApi.print({ label_type: 'LPN', entity_id: lpn, reprint_reason: reprintReason });
      wm.ok(`ETIQUETA ${lpn} ENVIADA`);
    } catch (e) {
      wm.fail(e);
    }
  };
  const reset = () => {
    setStep('HOME');
    setFlow('ONESHOT');
    setOpen(null);
    setStarted(null);
    setLines([]);
    setDraft(null);
    setOut(null);
    setPallets([newRow()]);
    setPpc('');
    setLot('');
    setExpiry('');
    setScrap('0');
    setReason('');
    setPurpose('');
    setResult(null);
  };

  if (step === 'HOME')
    return (
      <div>
        <StepBar text="ARMADO · ¿QUÉ VAS A HACER?" />
        <div className="grid gap-3">
          <BigButton tone="primary" onClick={() => { setFlow('START'); setStation(''); setStep('IN_LPN'); }} testId="asm-start">
            Surtir para armar
            <span className="block text-sm font-normal normal-case text-slate-200">Llevas las tarimas de cuerpos a la mesa; el armado queda abierto y se confirma después</span>
          </BigButton>
          <BigButton tone="neutral" onClick={() => { setFlow('ONESHOT'); setStation(''); setStep('IN_LPN'); }} testId="asm-oneshot">
            Armado inmediato (todo de una vez)
            <span className="block text-sm font-normal normal-case text-slate-300">Ya está armado: insumos, tarimas que salieron y merma en un solo paso</span>
          </BigButton>
        </div>
        {(doneList.data ?? []).length > 0 && (
          <div className="mt-4 rounded-2xl bg-slate-900 p-3">
            <div className="mb-1 text-xs font-bold uppercase text-slate-400">Armados terminados · toca uno para cambiar destino o reimprimir etiquetas</div>
            <ul className="grid gap-2" data-testid="asm-done-list">
              {(doneList.data ?? []).map((o) => (
                <li key={o.id}>
                  <button type="button" className="w-full rounded-xl bg-slate-800 p-3 text-left" onClick={() => void openReview(o.id)} disabled={busy} data-testid={`asm-done-${o.code}`}>
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-lg font-black">{o.code}</span>
                      <span className="text-sm text-slate-300">{o.outputs.length} tarima(s)</span>
                    </div>
                    <div className="text-sm text-slate-200">{o.output_sku.code} · {o.output_sku.description.slice(0, 30)} · {fmtQty(o.output_qty)} pzas</div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-4 rounded-2xl bg-slate-900 p-3">
          <div className="mb-1 text-xs font-bold uppercase text-slate-400">Armados en proceso · toca uno para confirmar que ya quedó</div>
          {(openList.data ?? []).length === 0 && <div className="text-sm text-slate-400">{openList.isLoading ? 'Cargando…' : 'Ninguno abierto'}</div>}
          <ul className="grid gap-2" data-testid="asm-open-list">
            {(openList.data ?? []).map((o) => (
              <li key={o.id} className="rounded-xl bg-slate-800 p-3">
                <button type="button" className="w-full text-left" onClick={() => void pickOpen(o)} disabled={busy} data-testid={`asm-open-${o.code}`}>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-lg font-black">{o.code}</span>
                    <span className="text-sm text-slate-300">{o.station.code}</span>
                  </div>
                  <div className="text-sm text-slate-200">
                    {o.output_sku.code} · {o.output_sku.description.slice(0, 30)} · {fmtQty(o.consumed_qty)} pzas en {o.inputs.length} tarima(s)
                  </div>
                  <div className="text-xs text-slate-400">{o.notes?.slice(0, 60)}</div>
                </button>
                <div className="mt-2 flex gap-2">
                  <button type="button" className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-bold text-white" onClick={() => void pickOpen(o)} disabled={busy}>
                    Confirmar armado
                  </button>
                  <button type="button" className="rounded-lg bg-slate-700 px-3 py-2 text-sm font-bold text-white" onClick={() => void cancelOpen(o)} disabled={busy}>
                    Cancelar
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
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
        <div className="flex items-center justify-between rounded-2xl bg-slate-800 px-4 py-2">
          <div>
            <div className="text-xs uppercase text-slate-400">Estación</div>
            <div className="font-mono text-lg font-black">{station || 'Mesa de armado (automática)'}</div>
          </div>
          <button type="button" className="rounded-lg bg-slate-700 px-3 py-2 text-xs font-bold text-white" onClick={() => setStep('STATION')} data-testid="change-station">
            {station ? 'Cambiar' : 'Escanear otra'}
          </button>
        </div>
        <div className="mt-3">
          <ScanInput label="LPN de entrada" autoUpper onScan={onLpn} disabled={busy} testId="scan-lpn" />
        </div>
        {lines.length > 0 && (
          <BigButton tone="primary" className="mt-3" onClick={() => setStep('OUT_SKU')} testId="inputs-done">
            Listo, sin más insumos
          </BigButton>
        )}
        <BigButton tone="neutral" className="mt-3" onClick={() => (lines.length ? setStep('IN_MORE') : setStep('HOME'))}>
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
        <StepBar text={flow === 'START' ? '4 · ¿QUÉ PRODUCTO VA A SALIR? (escanea caja o clave)' : '4 · ESCANEA EL PRODUCTO TERMINADO (caja o clave)'} />
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
        <StepBar text={flow === 'FINISH' ? `1 · ${open?.code ?? ''} · ¿CUÁNTAS TARIMAS SALIERON Y CÓMO VAN EMPACADAS?` : '5 · ¿CUÁNTAS TARIMAS SALIERON Y CÓMO VAN EMPACADAS?'} />
        <div className="text-sm text-slate-300">
          {out.code} · {out.description}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Num label="Tarimas" value={String(pallets.length)} onChange={(v) => setCount(Math.min(50, Number(v) || 0))} testId="n-pallets" />
          <Num label="Cajas en todas" value={pallets.every((p) => p.cases === pallets[0]!.cases) ? pallets[0]!.cases : ''} onChange={(v) => setPallets((rows) => rows.map((p) => ({ ...p, cases: v })))} testId="cases" />
          <Num label="Piezas por caja" value={ppc} onChange={setPpc} testId="ppc" />
        </div>
        <div className="mt-3 rounded-2xl bg-slate-900 p-3" data-testid="pallet-rows">
          <div className="mb-1 text-xs font-bold uppercase text-slate-400">Por tarima: cajas completas · piezas en la caja incompleta (si hay) · defectuosas</div>
          <div className="grid gap-2">
            {pallets.map((p, i) => (
              <div key={i} className="rounded-xl bg-slate-800 px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="font-mono font-bold text-slate-200">Tarima {i + 1}</span>
                  <span className="text-sm text-slate-300">= {fmtQty((Number(p.cases) || 0) * ppcN + (Number(p.partial) || 0))} pzas{(Number(p.defective) || 0) > 0 ? ` · ${p.defective} defectuosas` : ''}</span>
                  <button type="button" className="rounded bg-slate-700 px-2 py-1 text-xs font-bold text-white disabled:opacity-40" onClick={() => setPallets((rows) => rows.filter((_, j) => j !== i))} disabled={pallets.length <= 1} aria-label={`Quitar tarima ${i + 1}`}>
                    ✕
                  </button>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <label className="block">
                    <div className="text-[11px] font-semibold uppercase text-slate-400">Cajas completas</div>
                    <input type="number" inputMode="numeric" min={0} value={p.cases} onChange={(e) => setPallets((rows) => rows.map((x, j) => (j === i ? { ...x, cases: e.target.value } : x)))} className="w-full rounded-lg border-2 border-slate-500 bg-slate-900 px-2 py-2 font-mono text-2xl text-white" data-testid={`pallet-cases-${i}`} />
                  </label>
                  <label className="block">
                    <div className="text-[11px] font-semibold uppercase text-slate-400">Caja incompleta: pzas</div>
                    <input type="number" inputMode="numeric" min={0} max={Math.max(0, ppcN - 1)} value={p.partial} onChange={(e) => setPallets((rows) => rows.map((x, j) => (j === i ? { ...x, partial: e.target.value } : x)))} placeholder="0" className="w-full rounded-lg border-2 border-slate-500 bg-slate-900 px-2 py-2 font-mono text-2xl text-white" data-testid={`pallet-partial-${i}`} />
                  </label>
                  <label className="block">
                    <div className="text-[11px] font-semibold uppercase text-rose-300">Defectuosas</div>
                    <input type="number" inputMode="numeric" min={0} value={p.defective} onChange={(e) => setPallets((rows) => rows.map((x, j) => (j === i ? { ...x, defective: e.target.value } : x)))} placeholder="0" className="w-full rounded-lg border-2 border-rose-800 bg-slate-900 px-2 py-2 font-mono text-2xl text-white" data-testid={`pallet-defective-${i}`} />
                  </label>
                </div>
              </div>
            ))}
          </div>
          <button type="button" className="mt-2 w-full rounded-xl border-2 border-slate-500 py-2 text-sm font-bold text-slate-200" onClick={() => setCount(pallets.length + 1)} data-testid="pallet-add">
            + Agregar tarima
          </button>
          <div className="mt-2 grid grid-cols-3 gap-2 text-center text-sm">
            <div className="rounded-lg bg-slate-800 p-2"><div className="text-[11px] uppercase text-slate-400">Consumido</div><div className="font-mono text-lg font-black">{fmtQty(consumed)}</div></div>
            <div className="rounded-lg bg-slate-800 p-2"><div className="text-[11px] uppercase text-slate-400">Producido</div><div className="font-mono text-lg font-black">{fmtQty(produced)}</div></div>
            <div className="rounded-lg bg-slate-800 p-2"><div className="text-[11px] uppercase text-slate-400">Defectuosas</div><div className="font-mono text-lg font-black text-rose-300">{fmtQty(defectiveTotal)}</div></div>
          </div>
          {single && consumed - produced - defectiveTotal !== 0 && (
            <div className={`mt-2 rounded-lg p-2 text-sm ${consumed - produced - defectiveTotal > 0 ? 'bg-amber-900/60 text-amber-200' : 'bg-rose-900/60 text-rose-200'}`}>
              {consumed - produced - defectiveTotal > 0
                ? `Faltan ${fmtQty(consumed - produced - defectiveTotal)} pzas por explicar (en el siguiente paso se registran como merma adicional con motivo).`
                : `Se producen ${fmtQty(produced + defectiveTotal - consumed)} pzas más de las consumidas: revisa cajas o piezas por caja.`}
            </div>
          )}
          {defectiveTotal > 0 && (
            <label className="mt-2 block">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-300">Motivo de las defectuosas</div>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="mangos rotos, cuerpos golpeados…" className="w-full rounded-lg border-2 border-slate-500 bg-slate-900 px-3 py-3 text-xl text-white" data-testid="defective-reason" />
            </label>
          )}
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
        <BigButton tone="primary" className="mt-3" disabled={produced <= 0 || pallets.some((p) => !((Number(p.cases) || 0) > 0 || (Number(p.partial) || 0) > 0)) || (single && produced + defectiveTotal > consumed) || (defectiveTotal > 0 && reason.trim().length < 3) || (out.requires_lot && !lot) || (out.requires_expiry && !expiry)} onClick={() => { if (single && consumed - produced - defectiveTotal > 0) { setScrap(String(consumed - produced - defectiveTotal)); setStep('SCRAP'); } else { setScrap('0'); setStep(flow === 'FINISH' ? 'CONFIRM' : 'PURPOSE'); } }} testId="pallets-ok">
          Continuar
        </BigButton>
        <BigButton tone="neutral" className="mt-3" onClick={() => (flow === 'FINISH' ? reset() : setStep('OUT_SKU'))}>
          Regresar
        </BigButton>
      </div>
    );
  if (step === 'SCRAP')
    return (
      <div>
        <StepBar text="¿Y LAS PIEZAS QUE FALTAN? (MERMA ADICIONAL)" />
        <div className="grid gap-2 sm:grid-cols-2">
          <BigValue label="Consumido" value={`${fmtQty(consumed)} pzas`} />
          <BigValue label="Producido" value={`${fmtQty(produced)} pzas`} />
        </div>
        <div className="mt-2 text-sm text-slate-300">Se consumieron {fmtQty(consumed)} pzas y entre tarimas ({fmtQty(produced)}) y defectuosas ({fmtQty(defectiveTotal)}) solo se explican {fmtQty(produced + defectiveTotal)}. La diferencia se registra como merma con motivo.</div>
        <div className="mt-3">
          <Num label="Merma adicional (piezas)" value={scrap} onChange={setScrap} testId="scrap" />
        </div>
        {scrapN > 0 && (
          <label className="mt-3 block">
            <div className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-300">Motivo (merma y defectuosas)</div>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="cuerpos golpeados" className="w-full rounded-lg border-2 border-slate-500 bg-slate-900 px-3 py-3 text-xl text-white" data-testid="scrap-reason" />
          </label>
        )}
        {!balanced && <div className="mt-3 rounded-lg bg-amber-900/60 p-3 text-amber-200">La cuenta no cuadra: consumido {fmtQty(consumed)} ≠ producido {fmtQty(produced)} + merma {fmtQty(scrapN)}. Ajusta la merma o las tarimas.</div>}
        <BigButton tone="primary" className="mt-3" disabled={!balanced || (scrapN > 0 && reason.trim().length < 3)} onClick={() => setStep(flow === 'FINISH' ? 'CONFIRM' : 'PURPOSE')} testId="scrap-ok">
          Continuar
        </BigButton>
        <BigButton tone="neutral" className="mt-3" onClick={() => setStep('PALLETS')}>
          Regresar
        </BigButton>
      </div>
    );
  if (step === 'PURPOSE')
    return (
      <div>
        <StepBar text="7 · ¿PARA QUÉ SE HACE ESTE ARMADO? (OBLIGATORIO)" />
        <label className="block">
          <div className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-300">Para qué</div>
          <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={3} placeholder="Ej.: pedido de Walmart sale mañana · reponer picking de sartén 20 cm" className="w-full rounded-lg border-2 border-slate-500 bg-slate-900 px-3 py-3 text-xl text-white" data-testid="asm-purpose" />
          <div className="mt-1 text-xs text-slate-400">Mínimo 5 letras. Queda en la orden y en la auditoría.</div>
        </label>
        <BigButton tone="primary" className="mt-3" disabled={purpose.trim().length < 5} onClick={() => setStep(flow === 'START' ? 'CONFIRM_START' : 'CONFIRM')} testId="purpose-ok">
          Continuar
        </BigButton>
        <BigButton tone="neutral" className="mt-3" onClick={() => setStep('SCRAP')}>
          Regresar
        </BigButton>
      </div>
    );
  if (step === 'CONFIRM_START' && out)
    return (
      <div>
        <StepBar text="6 · CONFIRMA EL SURTIDO PARA ARMAR" />
        <div className="grid gap-2 font-mono text-lg">
          {lines.map((l, i) => (
            <div key={i} className="rounded bg-slate-800 px-3 py-2">
              → {fmtQty(l.qty)} pzas de {l.sku_code} · {l.lpn_code} a {station || 'la mesa de armado'}
            </div>
          ))}
          <div className="rounded bg-emerald-900/60 px-3 py-2 text-emerald-100">Producto que va a salir: {out.code} · {out.description}</div>
          <div className="rounded bg-slate-800 px-3 py-2 text-slate-200">Para qué: {purpose}</div>
        </div>
        <div className="mt-2 text-sm text-slate-300">Las tarimas quedan apartadas en la estación (nadie las puede surtir). Cuando terminen de armar, entras a "Armados en proceso" y confirmas tarimas y defectuosas.</div>
        <BigButton tone="success" className="mt-3" onClick={submitStart} disabled={busy} testId="confirm-start">
          Surtir para armar
        </BigButton>
        <BigButton tone="neutral" className="mt-3" onClick={() => setStep('PURPOSE')}>
          Regresar
        </BigButton>
      </div>
    );
  if (step === 'START_DONE' && started)
    return (
      <div>
        <StepBar text={`ARMADO ${started.code} ABIERTO`} />
        <BigValue label="Estación" value={started.station.code} tone="ok" />
        <div className="mt-2 text-center text-lg text-slate-300">
          {fmtQty(started.consumed_qty)} pzas en {started.inputs.length} tarima(s) apartadas para {started.output_sku.code}.
        </div>
        <div className="mt-4 grid gap-2">
          <BigButton tone="primary" onClick={() => void pickOpen(started)} testId="start-finish-now">
            Ya quedó armado: confirmar ahora
          </BigButton>
          <BigButton tone="neutral" onClick={reset}>
            Después (queda en Armados en proceso)
          </BigButton>
        </div>
      </div>
    );
  if (step === 'CONFIRM' && out && flow === 'FINISH' && open)
    return (
      <div>
        <StepBar text="3 · CONFIRMA QUE YA QUEDÓ ARMADO" />
        <div className="grid gap-2 font-mono text-lg">
          {open.inputs.map((l) => (
            <div key={l.id} className="rounded bg-slate-800 px-3 py-2">
              − {fmtQty(l.qty)} pzas de {l.sku.code} · {l.lpn.code}
            </div>
          ))}
          <div className="rounded bg-emerald-900/60 px-3 py-2 text-emerald-100">
            + {pallets.length} tarima(s) de {out.code}: {pallets.map((p) => `${Number(p.cases) || 0} cajas${(Number(p.partial) || 0) > 0 ? ` + 1 con ${p.partial}` : ''}`).join(' · ')} × {ppc} pzas = {fmtQty(produced)} pzas
          </div>
          {scrapN > 0 && <div className="rounded bg-amber-900/60 px-3 py-2 text-amber-100">Defectuosas / merma {fmtQty(scrapN)} pzas{pallets.some((p) => (Number(p.defective) || 0) > 0) ? ` (${pallets.map((p, i) => ((Number(p.defective) || 0) > 0 ? `tarima ${i + 1}: ${p.defective}` : '')).filter(Boolean).join(', ')})` : ''} · {reason}</div>}
        </div>
        <div className="mt-2 text-sm text-slate-300">Las tarimas nuevas nacen en la estación con etiqueta y tarea de acomodo; al ubicarlas eliges la posición de la lista.</div>
        <BigButton tone="success" className="mt-3" onClick={submitFinish} disabled={busy} testId="confirm-finish">
          Confirmar armado
        </BigButton>
        <BigButton tone="neutral" className="mt-3" onClick={() => setStep('SCRAP')}>
          Regresar
        </BigButton>
      </div>
    );
  if (step === 'CONFIRM' && out)
    return (
      <div>
        <StepBar text="8 · CONFIRMA EL ARMADO" />
        <div className="grid gap-2 font-mono text-lg">
          {lines.map((l, i) => (
            <div key={i} className="rounded bg-slate-800 px-3 py-2">
              − {fmtQty(l.qty)} pzas de {l.sku_code} · {l.lpn_code}
            </div>
          ))}
          <div className="rounded bg-emerald-900/60 px-3 py-2 text-emerald-100">
            + {pallets.length} tarima(s) de {out.code}: {pallets.map((p) => `${Number(p.cases) || 0} cajas${(Number(p.partial) || 0) > 0 ? ` + 1 con ${p.partial}` : ''}`).join(' · ')} × {ppc} pzas = {fmtQty(produced)} pzas
          </div>
          {scrapN > 0 && <div className="rounded bg-amber-900/60 px-3 py-2 text-amber-100">Merma {fmtQty(scrapN)} pzas · {reason}</div>}
          <div className="rounded bg-slate-800 px-3 py-2 text-slate-200">Para qué: {purpose}</div>
        </div>
        <BigButton tone="success" className="mt-3" onClick={submit} disabled={busy} testId="confirm">
          Registrar armado
        </BigButton>
        <BigButton tone="neutral" className="mt-3" onClick={() => setStep('PURPOSE')}>
          Regresar
        </BigButton>
      </div>
    );
  if (step === 'REVIEW' && review)
    return (
      <div>
        <StepBar text={`ARMADO ${review.code} · DESTINOS Y ETIQUETAS`} />
        <div className="mb-2 text-sm text-slate-300">{review.output_sku.code} · {review.output_sku.description} · {fmtQty(review.output_qty)} pzas</div>
        <div className="grid gap-2">
          {review.outputs.map((o) => (
            <PalletCard key={o.id} lpn={o.lpn.code} detail={`${o.cases} cajas × ${o.pieces_per_case}${o.partial_pieces ? ` + 1 caja con ${o.partial_pieces}` : ''} = ${fmtQty(o.qty)} pzas`} taskId={o.putaway_task_id} destination={o.suggested_location ?? null} placed={o.putaway_status === 'COMPLETED'} busy={busy} setBusy={setBusy} onPrint={print} onChanged={() => void openReview(review.id)} />
          ))}
        </div>
        <BigButton tone="neutral" className="mt-3" onClick={reset}>
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
            <PalletCard key={p.lpn} lpn={p.lpn} detail={`${p.cases} cajas × ${p.pieces_per_case}${p.partial_pieces ? ` + 1 caja con ${p.partial_pieces}` : ''} = ${fmtQty(p.qty)} pzas${p.defective ? ` · ${p.defective} defectuosas` : ''}`} taskId={p.putaway_task_id} destination={p.suggested_location} placed={false} busy={busy} setBusy={setBusy} onPrint={print} onChanged={(code) => setResult({ ...result, produced: result.produced.map((x) => (x.lpn === p.lpn ? { ...x, suggested_location: code } : x)) })} />
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

/** One finished pallet: where it goes (changeable from the list of valid locations) and its label (reprint carries the new destination). */
function PalletCard({ lpn, detail, taskId, destination, placed, busy, setBusy, onPrint, onChanged }: { lpn: string; detail: string; taskId: string | null; destination: string | null; placed: boolean; busy: boolean; setBusy: (b: boolean) => void; onPrint: (lpn: string, reason?: string) => Promise<void>; onChanged: (code: string) => void }) {
  const wm = useWm();
  const [opts, setOpts] = useState<{ list: PutawayOption[]; selected: string } | null>(null);
  const [changed, setChanged] = useState(false);
  const load = async () => {
    if (!taskId) return;
    setBusy(true);
    try {
      const r = await putawayApi.options(taskId);
      if (!r.options.length) { wm.warn('NO HAY OTRA UBICACIÓN DISPONIBLE'); return; }
      setOpts({ list: r.options, selected: r.options.find((o) => !o.is_current)?.code ?? r.options[0]!.code });
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const choose = async () => {
    if (!taskId || !opts) return;
    setBusy(true);
    try {
      const r = await putawayApi.choose(taskId, { location_code: opts.selected });
      wm.ok(`${lpn} → ${r.target.code}`);
      setOpts(null);
      setChanged(true);
      onChanged(r.target.code);
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-lg bg-slate-800 p-3">
      <div className="font-mono text-2xl font-black" data-testid="new-lpn">{lpn}</div>
      <div className="text-sm text-slate-300">{detail}</div>
      <div className="mt-1 text-sm">
        <span className="text-slate-400">{placed ? 'Ubicada en' : 'Destino'}: </span>
        <span className="font-mono text-lg font-black text-violet-300" data-testid="pallet-destination">{destination ?? 'sin destino'}</span>
      </div>
      {opts && (
        <div className="mt-2 rounded-xl border-2 border-violet-500 bg-slate-900 p-2" data-testid="pallet-dest-chooser">
          <LocationPicker list={opts.list} selected={opts.selected} onSelect={(code) => setOpts({ ...opts, selected: code })} testId="pallet-dest-select" />
          <div className="mt-2 grid grid-cols-2 gap-2">
            <BigButton tone="neutral" onClick={() => setOpts(null)}>Cancelar</BigButton>
            <BigButton tone="success" onClick={choose} disabled={busy} testId="pallet-dest-use">Usar esta ubicación</BigButton>
          </div>
        </div>
      )}
      {!opts && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          {taskId && !placed && (
            <BigButton tone="neutral" onClick={load} disabled={busy} testId="pallet-dest-change">
              Cambiar ubicación
            </BigButton>
          )}
          <BigButton tone="primary" onClick={() => void onPrint(lpn, changed ? 'Cambio de ubicación de acomodo' : undefined)} disabled={busy} testId="pallet-print">
            {changed ? 'Reimprimir con la nueva ubicación' : 'Imprimir etiqueta'}
          </BigButton>
        </div>
      )}
    </div>
  );
}
