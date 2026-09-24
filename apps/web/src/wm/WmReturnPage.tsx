// /wm/return — quick return: a couple of pieces come back and go straight onto the pallet that already holds the
// product (chosen from the list, confirmed by scanning the pallet or its location at the rack). Damaged pieces go to
// the returns area. The return document is created closed; the office sees it in Devoluciones.
import { useState } from 'react';
import type { UomCode } from '@wms/shared';
import { api } from '../api/client';
import { inventoryApi } from '../api/inventory';
import { masterdataApi } from '../api/masterdata';
import { returnsApi } from '../api/returns';
import type { QuickReturnResult } from '../api/types';
import { ProductInput } from '../components/ProductInput';
import { QtyPad } from '../components/QtyPad';
import { ScanInput } from '../components/ScanInput';
import { fmtQty } from '../lib/format';
import { BigButton, BigValue, StepBar, useWm, WmShell } from './WmShell';

type Step = 'PRODUCT' | 'QTY' | 'PALLET' | 'CONFIRM' | 'DONE';
interface Option { code: string; location: string; available: string }

export default function WmReturnPage() {
  return (
    <WmShell title="Devolución">
      <Flow />
    </WmShell>
  );
}

function Flow() {
  const wm = useWm();
  const [step, setStep] = useState<Step>('PRODUCT');
  const [sku, setSku] = useState<{ code: string; description: string; uoms: { uom_code: UomCode; base_qty: string }[] } | null>(null);
  const [qty, setQty] = useState<{ qty: string; uom: UomCode } | null>(null);
  const [damaged, setDamaged] = useState(false);
  const [options, setOptions] = useState<Option[]>([]);
  const [selected, setSelected] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<QuickReturnResult | null>(null);
  const pieces = qty && sku ? Number(qty.qty) * Number(sku.uoms.find((u) => u.uom_code === qty.uom)?.base_qty ?? 1) : 0;
  const chosen = options.find((o) => o.code === selected) ?? null;

  const onProduct = async (code: string) => {
    setBusy(true);
    try {
      const r = await masterdataApi.skuByBarcode(code);
      setSku({ code: r.sku.code, description: r.sku.description, uoms: r.uoms.map((u) => ({ uom_code: u.uom_code, base_qty: String(u.base_qty) })) });
      setDamaged(false);
      setStep('QTY');
      wm.ok(`${r.sku.code} · ${r.sku.description}`);
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const loadPallets = async () => {
    if (!sku) return;
    setBusy(true);
    try {
      const rows = await inventoryApi.lpns({ sku: sku.code, status: 'STORED', limit: 100 });
      const opts = rows
        .map((l) => ({ code: l.code, location: l.location_code ?? '', available: String((l.contents ?? []).filter((c) => c.sku_code === sku.code).reduce((a, c) => a + Number(c.qty), 0)) }))
        .filter((o) => o.location)
        .sort((a, b) => a.location.localeCompare(b.location));
      if (!opts.length) {
        wm.warn(`NO HAY TARIMAS GUARDADAS CON ${sku.code}: márcala como dañada o recíbela en Recibir`);
        return;
      }
      setOptions(opts);
      setSelected(opts[0]!.code);
      setStep('PALLET');
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const submit = async (scanned?: string) => {
    if (!sku || !qty) return;
    setBusy(true);
    try {
      const r = await returnsApi.quick({ sku_code: sku.code, qty: qty.qty, uom_code: qty.uom, damaged, to_lpn_code: damaged ? undefined : selected, scanned, note: note.trim() || undefined }, api.newKey());
      setResult(r.data);
      setStep('DONE');
      wm.ok(r.replayed ? 'YA REGISTRADA' : damaged ? `DEVOLUCIÓN ${r.data.return_number} · A DEVOLUCIONES ${r.data.location}` : `DEVOLUCIÓN ${r.data.return_number} · ${fmtQty(r.data.qty_base)} PZAS EN ${r.data.lpn}`);
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const reset = () => { setStep('PRODUCT'); setSku(null); setQty(null); setDamaged(false); setOptions([]); setSelected(''); setNote(''); setResult(null); };

  if (step === 'PRODUCT')
    return (
      <div>
        <StepBar text="1 · ¿QUÉ PRODUCTO REGRESA?" />
        <ProductInput label="Escanea la pieza o la caja, o escribe clave o nombre" onPick={onProduct} disabled={busy} testId="return-product" />
        <div className="mt-2 text-xs text-slate-400">Para una o dos piezas que regresan: van directo a la tarima que ya tiene ese producto. Queda registrada como devolución.</div>
      </div>
    );
  if (step === 'QTY' && sku)
    return (
      <div>
        <StepBar text="2 · ¿CUÁNTO REGRESA?" />
        <div className="mb-3 rounded-2xl bg-sky-700 px-4 py-2">
          <div className="font-mono text-2xl font-black">{sku.code}</div>
          <div className="text-sm">{sku.description}</div>
        </div>
        <button type="button" onClick={() => setDamaged((v) => !v)} className={`mb-3 h-14 w-full rounded-xl text-lg font-bold ${damaged ? 'bg-rose-600 text-white' : 'bg-slate-700 text-slate-200'}`} data-testid="return-damaged">
          {damaged ? 'DAÑADA ✓ · va al área de devoluciones' : 'Marcar como dañada'}
        </button>
        <QtyPad uoms={sku.uoms} defaultUom="PIECE" hint="PIEZAS O CAJAS QUE REGRESAN" confirmLabel="CONTINUAR" busy={busy} onCancel={reset} onConfirm={(q, u) => { setQty({ qty: q, uom: u }); if (damaged) setStep('CONFIRM'); else void loadPallets(); }} />
      </div>
    );
  if (step === 'PALLET' && sku && qty)
    return (
      <div>
        <StepBar text="3 · ¿A QUÉ TARIMA VA?" />
        <BigValue label="Regresa" value={`${fmtQty(pieces)} pzas de ${sku.code}`} tone="accent" />
        <div className="mt-3 rounded-2xl border-2 border-violet-500 bg-slate-900 p-3">
          <div className="mb-1 text-sm font-semibold uppercase tracking-wide text-violet-300">Tarimas que ya tienen este producto</div>
          <select value={selected} onChange={(e) => setSelected(e.target.value)} className="w-full rounded-lg border-2 border-slate-500 bg-slate-800 px-3 py-3 text-lg text-white" data-testid="return-pallet-select">
            {options.map((o) => (
              <option key={o.code} value={o.code}>
                {o.location} · {o.code} · {fmtQty(o.available)} pzas
              </option>
            ))}
          </select>
        </div>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Nota (opcional): cliente, motivo…" className="mt-3 w-full rounded-lg border-2 border-slate-500 bg-slate-900 px-3 py-3 text-lg text-white" data-testid="return-note" />
        <BigButton tone="primary" className="mt-3" disabled={busy || !selected} onClick={() => setStep('CONFIRM')} testId="return-pallet-ok">
          Llevar a {chosen?.location ?? ''}
        </BigButton>
        <BigButton tone="neutral" className="mt-3" onClick={() => setStep('QTY')}>
          Regresar
        </BigButton>
      </div>
    );
  if (step === 'CONFIRM' && sku && qty)
    return (
      <div>
        <StepBar text={damaged ? '3 · CONFIRMA LA DEVOLUCIÓN DAÑADA' : '4 · EN EL RACK: ESCANEA LA TARIMA O LA UBICACIÓN'} />
        <div className="grid gap-2 sm:grid-cols-2">
          <BigValue label="Regresa" value={`${fmtQty(pieces)} pzas de ${sku.code}`} tone="accent" />
          {!damaged && chosen && <BigValue label="Destino" value={`${chosen.location} · ${chosen.code}`} tone="ok" testId="return-target" />}
          {damaged && <BigValue label="Destino" value="Área de devoluciones (dañado)" tone="warn" />}
        </div>
        {damaged ? (
          <>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Nota (opcional): cliente, qué tiene…" className="mt-3 w-full rounded-lg border-2 border-slate-500 bg-slate-900 px-3 py-3 text-lg text-white" data-testid="return-note" />
            <BigButton tone="success" className="mt-3" disabled={busy} onClick={() => submit()} testId="return-submit">
              Registrar devolución dañada
            </BigButton>
          </>
        ) : (
          <div className="mt-3">
            <ScanInput label="Escanea el LPN de la tarima o la etiqueta de la ubicación" autoUpper onScan={(v) => submit(v)} disabled={busy} testId="return-scan" />
            <div className="mt-1 text-xs text-slate-400">Deja las piezas en esa tarima y escanea para confirmar. Las piezas quedan disponibles de inmediato.</div>
          </div>
        )}
        <BigButton tone="neutral" className="mt-3" onClick={() => setStep(damaged ? 'QTY' : 'PALLET')}>
          Regresar
        </BigButton>
      </div>
    );
  if (step === 'DONE' && result)
    return (
      <div>
        <StepBar text={`DEVOLUCIÓN ${result.return_number} REGISTRADA`} />
        <BigValue label={result.damaged ? 'Tarima nueva en devoluciones' : 'Agregado a la tarima'} value={`${result.lpn} · ${result.location}`} tone="ok" testId="return-done" />
        <div className="mt-2 text-center text-lg text-slate-300">
          {fmtQty(result.qty_base)} pzas de {result.sku.code}{result.incident ? ` · incidencia ${result.incident}` : ''}
        </div>
        <BigButton tone="primary" className="mt-4" onClick={reset} testId="return-again">
          Otra devolución
        </BigButton>
      </div>
    );
  return null;
}
