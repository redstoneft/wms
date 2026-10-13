// /wm/return — quick return: a couple of pieces come back and go straight onto the pallet that already holds the
// product (chosen from the list, confirmed by scanning the pallet or its location at the rack). Damaged pieces go to
// the returns area. The return document is created closed; the office sees it in Devoluciones.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { UomCode } from '@wms/shared';
import { api } from '../api/client';
import { inventoryApi } from '../api/inventory';
import { labelsApi } from '../api/labels';
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
  // whole pallets coming back: how many NEW pallets are born at the returns area (0 = onto an existing pallet)
  const [newPallets, setNewPallets] = useState(0);
  // receiving onto an open return (reopened by the admin, or a formal one) instead of creating a new closed one
  const [onReturn, setOnReturn] = useState<{ id: string; return_number: string; customer: string | null } | null>(null);
  const openRet = useQuery({ queryKey: ['returns-open'], queryFn: returnsApi.open, refetchInterval: 30_000 });
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
      setOptions(opts);
      setSelected(opts[0]?.code ?? '');
      if (!opts.length) { setNewPallets(1); wm.warn(`NO HAY TARIMAS GUARDADAS CON ${sku.code}: entra como tarima(s) nueva(s) en devoluciones`); }
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
      const r = await returnsApi.quick({ sku_code: sku.code, qty: qty.qty, uom_code: qty.uom, damaged, to_lpn_code: damaged || newPallets > 0 ? undefined : selected, scanned, note: note.trim() || undefined, new_pallets: newPallets > 0 ? newPallets : undefined, return_id: onReturn?.id }, api.newKey());
      void openRet.refetch();
      setResult(r.data);
      setStep('DONE');
      wm.ok(r.replayed ? 'YA REGISTRADA' : r.data.pallets.length ? `DEVOLUCIÓN ${r.data.return_number} · ${r.data.pallets.length} TARIMA(S) NUEVA(S) EN ${r.data.location}` : damaged ? `DEVOLUCIÓN ${r.data.return_number} · A DEVOLUCIONES ${r.data.location}` : `DEVOLUCIÓN ${r.data.return_number} · ${fmtQty(r.data.qty_base)} PZAS EN ${r.data.lpn}`);
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const reset = () => { setStep('PRODUCT'); setSku(null); setQty(null); setDamaged(false); setOptions([]); setSelected(''); setNote(''); setNewPallets(0); setOnReturn(null); setResult(null); };

  if (step === 'PRODUCT')
    return (
      <div>
        <StepBar text="1 · ¿QUÉ PRODUCTO REGRESA?" />
        {onReturn && (
          <div className="mb-2 flex items-center justify-between rounded-2xl border-2 border-amber-400 bg-amber-900/40 px-3 py-2 text-sm text-amber-100" data-testid="return-on">
            <span>Recibiendo sobre <b>{onReturn.return_number}</b>{onReturn.customer ? ` · ${onReturn.customer}` : ''}</span>
            <button type="button" className="rounded-lg bg-slate-800 px-2 py-1 text-xs font-bold text-white" onClick={() => setOnReturn(null)}>quitar</button>
          </div>
        )}
        <ProductInput label="Escanea la pieza o la caja, o escribe clave o nombre" onPick={onProduct} disabled={busy} testId="return-product" />
        <div className="mt-2 text-xs text-slate-400">{onReturn ? 'Lo que registres se agrega a esa devolución (no se crea una nueva).' : 'Para una o dos piezas que regresan: van directo a la tarima que ya tiene ese producto. Queda registrada como devolución.'}</div>
        {!onReturn && (openRet.data?.length ?? 0) > 0 && (
          <div className="mt-4" data-testid="returns-open">
            <div className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-400">Devoluciones abiertas · toca una para recibir sobre ella</div>
            <ul className="grid gap-1">
              {openRet.data!.map((r) => (
                <li key={r.id}>
                  <button type="button" className="w-full rounded-xl bg-slate-800 px-3 py-2 text-left" onClick={() => { setOnReturn({ id: r.id, return_number: r.return_number, customer: r.customer }); wm.ok(`RECIBIENDO SOBRE ${r.return_number}`); }}>
                    <div className="font-mono text-base font-black">{r.return_number} <span className="text-xs font-normal text-slate-400">· {r.status}</span>{r.customer ? <span className="text-sm font-normal text-slate-300"> · {r.customer}</span> : null}</div>
                    <div className="text-xs text-slate-300">{r.lines.map((l) => `${l.sku_code} ${fmtQty(l.received_qty)}/${fmtQty(l.expected_qty)}`).join(' · ')}{r.reason ? ` · ${r.reason}` : ''}</div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
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
        <div className={`mt-3 rounded-2xl border-2 p-3 ${newPallets === 0 ? 'border-violet-500' : 'border-slate-700'} bg-slate-900`}>
          <button type="button" className="mb-1 w-full text-left text-sm font-semibold uppercase tracking-wide text-violet-300" onClick={() => setNewPallets(0)} disabled={!options.length}>{newPallets === 0 ? '● ' : '○ '}A una tarima que ya tiene este producto</button>
          {options.length ? (
            <select value={selected} onChange={(e) => { setSelected(e.target.value); setNewPallets(0); }} className="w-full rounded-lg border-2 border-slate-500 bg-slate-800 px-3 py-3 text-lg text-white" data-testid="return-pallet-select">
              {options.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.location} · {o.code} · {fmtQty(o.available)} pzas
                </option>
              ))}
            </select>
          ) : (
            <div className="text-sm text-slate-400">No hay tarimas guardadas con {sku.code}</div>
          )}
        </div>
        <div className={`mt-2 rounded-2xl border-2 p-3 ${newPallets > 0 ? 'border-violet-500' : 'border-slate-700'} bg-slate-900`} data-testid="return-new-pallets">
          <div className="flex items-center justify-between gap-2">
            <button type="button" className="text-left text-sm font-semibold uppercase tracking-wide text-violet-300" onClick={() => setNewPallets((n) => (n > 0 ? n : 1))}>{newPallets > 0 ? '● ' : '○ '}Tarimas nuevas (regresan tarimas completas)</button>
            <div className="flex items-center gap-2">
              <button type="button" className="h-12 w-12 rounded-xl bg-slate-700 text-2xl font-black" onClick={() => setNewPallets((n) => Math.max(0, n - 1))} aria-label="menos tarimas">−</button>
              <div className="w-8 text-center font-mono text-3xl font-black">{newPallets}</div>
              <button type="button" className="h-12 w-12 rounded-xl bg-slate-700 text-2xl font-black" onClick={() => setNewPallets((n) => Math.min(200, n + 1))} aria-label="más tarimas">+</button>
            </div>
          </div>
          <div className="mt-1 text-xs text-slate-400">Las {fmtQty(pieces)} pzas se reparten en {newPallets || 'N'} tarimas nuevas en el área de devoluciones, disponibles y con su acomodo. Imprime sus etiquetas al terminar.</div>
        </div>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Nota (opcional): cliente, motivo…" className="mt-3 w-full rounded-lg border-2 border-slate-500 bg-slate-900 px-3 py-3 text-lg text-white" data-testid="return-note" />
        {newPallets > 0 ? (
          <BigButton tone="success" className="mt-3" disabled={busy} onClick={() => submit()} testId="return-submit-new">
            Registrar en {newPallets} tarima{newPallets > 1 ? 's' : ''} nueva{newPallets > 1 ? 's' : ''}
          </BigButton>
        ) : (
          <BigButton tone="primary" className="mt-3" disabled={busy || !selected} onClick={() => setStep('CONFIRM')} testId="return-pallet-ok">
            Llevar a {chosen?.location ?? ''}
          </BigButton>
        )}
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
        <StepBar text={`DEVOLUCIÓN ${result.return_number} ${result.return_status === 'CLOSED' ? 'REGISTRADA' : 'ACTUALIZADA (sigue abierta)'}`} />
        <BigValue label={result.pallets.length ? `${result.pallets.length} tarima(s) nueva(s) en ${result.location}` : result.damaged ? 'Tarima nueva en devoluciones' : 'Agregado a la tarima'} value={result.pallets.length ? `${fmtQty(result.qty_base)} pzas de ${result.sku.code}` : `${result.lpn} · ${result.location}`} tone="ok" testId="return-done" />
        {result.pallets.length > 0 && (
          <>
            <ul className="mt-3 grid gap-1">
              {result.pallets.map((p) => (
                <li key={p.code} className="flex items-center justify-between rounded-xl bg-slate-800 px-3 py-2"><span className="font-mono text-lg font-black">{p.code}</span><span className="text-slate-300">{fmtQty(p.qty)} pzas{p.putaway_task ? ' · con acomodo' : ''}</span></li>
              ))}
            </ul>
            <BigButton tone="primary" className="mt-3" disabled={busy} onClick={async () => { setBusy(true); try { for (const p of result.pallets) await labelsApi.print({ label_type: 'LPN', entity_id: p.code }); wm.ok(`${result.pallets.length} ETIQUETAS ENVIADAS`); } catch (e) { wm.fail(e); } finally { setBusy(false); } }} testId="return-print-labels">
              Imprimir las {result.pallets.length} etiquetas
            </BigButton>
          </>
        )}
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
