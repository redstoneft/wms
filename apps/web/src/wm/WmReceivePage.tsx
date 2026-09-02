// /wm/receive — receiving by scanning: receipt → barcode → qty (+UoM) → new pallet | add to LPN → label → close LPN → complete.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { UomCode } from '@wms/shared';
import { api, ApiError } from '../api/client';
import { inboundApi } from '../api/inbound';
import { masterdataApi } from '../api/masterdata';
import type { Receipt, ReceiveScanResult, Sku } from '../api/types';
import { QtyPad } from '../components/QtyPad';
import { ScanInput } from '../components/ScanInput';
import { fmtQty, fmtUom, toBigInt } from '../lib/format';
import { LabelPrintPanel } from './LabelPrintPanel';
import { BigButton, BigValue, useWm, WmList, WmShell } from './WmShell';

type Step = 'RECEIPT' | 'SCAN' | 'LPN_CHOICE' | 'QTY' | 'RESULT' | 'LABEL' | 'COMPLETE';

export default function WmReceivePage() {
  return (
    <WmShell title="Recepción" step={undefined}>
      <Flow />
    </WmShell>
  );
}

function Flow() {
  const wm = useWm();
  const qc = useQueryClient();
  const [sp] = useSearchParams();
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [step, setStep] = useState<Step>('RECEIPT');
  const [barcode, setBarcode] = useState('');
  const [sku, setSku] = useState<Sku | null>(null);
  const [scannedUom, setScannedUom] = useState<UomCode>('PIECE');
  const [currentLpn, setCurrentLpn] = useState<string | null>(null);
  const [useCurrent, setUseCurrent] = useState(false);
  const [damaged, setDamaged] = useState(false);
  const [lot, setLot] = useState('');
  const [expiry, setExpiry] = useState('');
  const [last, setLast] = useState<ReceiveScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [differences, setDifferences] = useState<{ sku: string; expected: string; received: string }[] | null>(null);

  const receipts = useQuery({ queryKey: ['receipts', 'open'], queryFn: () => inboundApi.receipts({ status: 'OPEN,IN_PROGRESS', limit: 100 }), refetchInterval: 10_000 });
  // SKU catalogue for barcode → SKU/UoM resolution before the qty step (see API_GAPS.md)
  const skus = useQuery({ queryKey: ['skus', 'all'], queryFn: () => masterdataApi.skus({ limit: 500, active: 'true' }), staleTime: 60_000 });
  const barcodeMap = useMemo(() => {
    const m = new Map<string, { sku: Sku; uom: UomCode }>();
    for (const s of skus.data?.items ?? []) {
      m.set(s.code, { sku: s, uom: 'PIECE' });
      for (const b of s.barcodes) m.set(b.barcode, { sku: s, uom: b.uom_code });
    }
    return m;
  }, [skus.data]);

  const detail = useQuery({ queryKey: ['receipt', receipt?.id], queryFn: () => inboundApi.receipt(receipt!.id), enabled: !!receipt, refetchInterval: 8_000 });

  // deep link ?receipt=<id>
  useEffect(() => {
    const id = sp.get('receipt');
    if (id && !receipt && receipts.data) {
      const r = receipts.data.find((x) => x.id === id);
      if (r) {
        setReceipt(r);
        setStep('SCAN');
      }
    }
  }, [sp, receipts.data, receipt]);

  const openLpns = (detail.data?.lpns ?? []).filter((l) => l.status === 'OPEN');

  const onProductScan = useCallback(
    async (code: string) => {
      const hit = barcodeMap.get(code);
      if (!hit) {
        wm.fail(new ApiError(404, { error: 'BARCODE_UNKNOWN', message: `Código ${code} no corresponde a ningún SKU activo` }));
        return;
      }
      setBarcode(code);
      setSku(hit.sku);
      setScannedUom(hit.uom);
      setDamaged(false);
      setLot('');
      setExpiry('');
      wm.ok();
      if (currentLpn && openLpns.some((l) => l.code === currentLpn)) setStep('LPN_CHOICE');
      else {
        setUseCurrent(false);
        setStep('QTY');
      }
    },
    [barcodeMap, currentLpn, openLpns, wm],
  );

  const submitQty = async (qty: string, uom: UomCode) => {
    if (!receipt || !sku) return;
    if (sku.requires_lot && !lot.trim()) {
      wm.fail(new ApiError(422, { error: 'LOT_REQUIRED', message: `El SKU ${sku.code} requiere lote` }));
      return;
    }
    if (sku.requires_expiry && !expiry) {
      wm.fail(new ApiError(422, { error: 'EXPIRY_REQUIRED', message: `El SKU ${sku.code} requiere fecha de caducidad` }));
      return;
    }
    setBusy(true);
    try {
      const r = await inboundApi.scan(
        {
          receipt_id: receipt.id,
          barcode,
          qty,
          uom_code: uom,
          lpn_code: useCurrent && currentLpn ? currentLpn : undefined,
          damaged,
          lot: lot.trim() || undefined,
          expiry_date: expiry || undefined,
        },
        api.newKey(),
      );
      setLast(r.data);
      setCurrentLpn(r.data.lpn.code);
      wm.ok(r.replayed ? 'YA REGISTRADO (reintento)' : `${r.data.lpn.is_new ? 'NUEVO PALLET' : 'AGREGADO'} ${r.data.lpn.code}`);
      if (r.data.unexpected_sku) wm.warn('SKU NO ESPERADO en esta recepción — se creó incidencia');
      void qc.invalidateQueries({ queryKey: ['receipt', receipt.id] });
      setStep('RESULT');
    } catch (e) {
      wm.fail(e);
      setStep('SCAN');
    } finally {
      setBusy(false);
    }
  };

  const closeLpn = async () => {
    if (!currentLpn) return;
    setBusy(true);
    try {
      const r = await inboundApi.closeLpn(currentLpn, api.newKey());
      wm.ok(r.data.putaway_task ? `LPN CERRADO · TAREA PUT-AWAY CREADA` : 'LPN CERRADO');
      setCurrentLpn(null);
      void qc.invalidateQueries({ queryKey: ['receipt', receipt?.id] });
      setStep('SCAN');
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  const complete = async (accept: boolean) => {
    if (!receipt) return;
    setBusy(true);
    try {
      const r = await inboundApi.complete({ receipt_id: receipt.id, accept_differences: accept });
      wm.ok(`RECEPCIÓN ${r.receipt.status === 'COMPLETED' ? 'COMPLETADA' : 'COMPLETADA CON INCIDENCIAS'}`);
      void qc.invalidateQueries({ queryKey: ['receipts'] });
      setReceipt(null);
      setCurrentLpn(null);
      setDifferences(null);
      setStep('RECEIPT');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'RECEIPT_DIFFERENCES') {
        setDifferences((e.details as { differences: { sku: string; expected: string; received: string }[] }).differences);
        wm.warn('HAY DIFERENCIAS — confirma para aceptarlas');
        setStep('COMPLETE');
      } else wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  // ---------------- render ----------------
  if (step === 'RECEIPT' || !receipt) {
    return (
      <div>
        <StepBar text="1 · ELIGE LA RECEPCIÓN" />
        <WmList
          items={receipts.data}
          keyOf={(r) => r.id}
          empty="No hay recepciones abiertas. Crea una en modo oficina."
          testId="receipt-list"
          onSelect={(r) => {
            setReceipt(r);
            setStep('SCAN');
            feedbackOk(wm);
          }}
          render={(r) => (
            <div className="flex items-center justify-between">
              <div>
                <div className="font-mono text-2xl font-black">{r.receipt_number}</div>
                <div className="text-sm text-slate-300">
                  {r.container && 'container_number' in r.container ? r.container.container_number : 'Sin contenedor'} · {r.lines?.length ?? 0} líneas
                </div>
              </div>
              <span className="rounded-full bg-amber-400 px-3 py-1 text-sm font-bold text-amber-950">{r.status}</span>
            </div>
          )}
        />
      </div>
    );
  }

  const lines = detail.data?.lines ?? [];
  const header = (
    <div className="mb-3 flex items-center justify-between rounded-2xl bg-slate-800 px-4 py-2">
      <div>
        <div className="text-xs uppercase text-slate-400">Recepción</div>
        <div className="font-mono text-xl font-black">{receipt.receipt_number}</div>
      </div>
      <div className="text-right">
        <div className="text-xs uppercase text-slate-400">Pallet actual</div>
        <div className="font-mono text-xl font-black text-emerald-300" data-testid="current-lpn">
          {currentLpn ?? '—'}
        </div>
      </div>
    </div>
  );

  if (step === 'SCAN') {
    return (
      <div>
        <StepBar text="2 · ESCANEA EL PRODUCTO" />
        {header}
        <ScanInput label="Código de barras del producto" onScan={onProductScan} testId="scan-product" />
        <div className="mt-3 grid grid-cols-2 gap-2">
          <BigButton tone="neutral" onClick={closeLpn} disabled={!currentLpn || busy} testId="close-lpn">
            Cerrar LPN
          </BigButton>
          <BigButton tone="warning" onClick={() => setStep('COMPLETE')} testId="complete-receipt">
            Completar recepción
          </BigButton>
        </div>
        {currentLpn && (
          <BigButton tone="primary" className="mt-2" onClick={() => setStep('LABEL')} testId="print-label">
            Imprimir etiqueta {currentLpn}
          </BigButton>
        )}
        <div className="mt-4 rounded-2xl bg-slate-900 p-3">
          <div className="mb-1 text-xs font-bold uppercase text-slate-400">Esperado vs recibido</div>
          {lines.length === 0 ? (
            <div className="text-slate-400">Recepción ciega: sin líneas esperadas</div>
          ) : (
            <ul className="divide-y divide-slate-800 text-lg">
              {lines.map((l) => {
                const e = toBigInt(l.expected_qty);
                const r = toBigInt(l.received_qty);
                const tone = r === e ? 'text-emerald-400' : r > e ? 'text-amber-300' : r === 0n ? 'text-slate-300' : 'text-sky-300';
                return (
                  <li key={l.id} className="flex items-center justify-between py-1.5">
                    <span className="font-mono">{l.sku.code}</span>
                    <span className={`font-mono font-bold ${tone}`}>
                      {fmtQty(r)} / {fmtQty(e)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {openLpns.length > 0 && (
            <div className="mt-2 text-xs text-slate-400">
              LPN abiertos: {openLpns.map((l) => l.code).join(', ')}
              {openLpns.length > 1 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {openLpns.map((l) => (
                    <button key={l.id} type="button" onClick={() => setCurrentLpn(l.code)} className="rounded bg-slate-700 px-2 py-1 font-mono text-xs text-white">
                      usar {l.code}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (step === 'LPN_CHOICE' && sku) {
    return (
      <div>
        <StepBar text="3 · ¿A QUÉ PALLET?" />
        {header}
        <BigValue label="Producto" value={`${sku.code}`} tone="accent" />
        <div className="mt-1 mb-4 text-center text-slate-300">{sku.description}</div>
        <div className="grid gap-3">
          <BigButton
            tone="success"
            onClick={() => {
              setUseCurrent(true);
              setStep('QTY');
            }}
            testId="add-to-lpn"
          >
            Agregar a {currentLpn}
          </BigButton>
          <BigButton
            tone="primary"
            onClick={() => {
              setUseCurrent(false);
              setStep('QTY');
            }}
            testId="new-lpn"
          >
            Nuevo pallet
          </BigButton>
          <BigButton tone="neutral" onClick={() => setStep('SCAN')}>
            Cancelar
          </BigButton>
        </div>
      </div>
    );
  }

  if (step === 'QTY' && sku) {
    const expected = lines.find((l) => l.sku.code === sku.code);
    return (
      <div>
        <StepBar text={`4 · CANTIDAD · ${useCurrent && currentLpn ? `AGREGAR A ${currentLpn}` : 'NUEVO PALLET'}`} />
        <div className="mb-3 rounded-2xl bg-sky-700 px-4 py-2">
          <div className="font-mono text-2xl font-black">{sku.code}</div>
          <div className="text-sm">{sku.description}</div>
          {expected && (
            <div className="mt-1 text-xs text-sky-100">
              Esperado {fmtUom(expected.expected_qty, sku.uoms)} · Recibido {fmtUom(expected.received_qty, sku.uoms)}
            </div>
          )}
        </div>
        <div className="mb-3 grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setDamaged((v) => !v)} className={`h-14 rounded-xl text-lg font-bold ${damaged ? 'bg-rose-600 text-white' : 'bg-slate-700 text-slate-200'}`}>
            {damaged ? 'DAÑADO ✓' : 'Marcar dañado'}
          </button>
          <div className="flex flex-col gap-1">
            {sku.requires_lot && <input value={lot} onChange={(e) => setLot(e.target.value)} placeholder="LOTE (requerido)" className="h-14 rounded-xl bg-slate-800 px-3 text-lg text-white" />}
            {sku.requires_expiry && <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} className="h-14 rounded-xl bg-slate-800 px-3 text-lg text-white" aria-label="Caducidad" />}
          </div>
        </div>
        <QtyPad uoms={sku.uoms} defaultUom={scannedUom} onConfirm={submitQty} onCancel={() => setStep('SCAN')} busy={busy} confirmLabel="RECIBIR" />
      </div>
    );
  }

  if (step === 'RESULT' && last) {
    return (
      <div>
        <StepBar text="5 · PALLET REGISTRADO" />
        {header}
        <BigValue label={last.lpn.is_new ? 'Nuevo LPN' : 'Agregado al LPN'} value={last.lpn.code} tone="ok" testId="result-lpn" />
        <div className="mt-3 grid grid-cols-2 gap-2 text-center">
          <div className="rounded-2xl bg-slate-800 p-3">
            <div className="text-xs uppercase text-slate-400">SKU</div>
            <div className="font-mono text-2xl font-black">{last.sku.code}</div>
          </div>
          <div className="rounded-2xl bg-slate-800 p-3">
            <div className="text-xs uppercase text-slate-400">Cantidad base</div>
            <div className="font-mono text-2xl font-black">{fmtQty(last.qty_base)}</div>
          </div>
        </div>
        <div className="mt-2 text-center text-slate-300">
          Línea: {fmtQty(last.line.received_qty)} / {fmtQty(last.line.expected_qty)} · {last.line.status}
        </div>
        <div className="mt-4 grid gap-2">
          <BigButton tone="success" onClick={() => setStep('SCAN')} testId="continue-scan">
            Seguir escaneando (mismo pallet)
          </BigButton>
          <BigButton tone="primary" onClick={() => setStep('LABEL')} testId="print-label">
            Imprimir etiqueta
          </BigButton>
          <BigButton tone="neutral" onClick={closeLpn} disabled={busy} testId="close-lpn">
            Cerrar LPN {last.lpn.code}
          </BigButton>
        </div>
      </div>
    );
  }

  if (step === 'LABEL' && currentLpn) {
    return (
      <div>
        <StepBar text={`ETIQUETA · ${currentLpn}`} />
        <LabelPrintPanel labelType="LPN" entityId={currentLpn} onDone={() => setStep('SCAN')} />
      </div>
    );
  }

  if (step === 'COMPLETE') {
    return (
      <div>
        <StepBar text="COMPLETAR RECEPCIÓN" />
        {header}
        {differences ? (
          <div className="rounded-2xl bg-amber-400 p-4 text-amber-950">
            <div className="text-2xl font-black">HAY DIFERENCIAS</div>
            <ul className="mt-2 divide-y divide-amber-500/40 text-lg">
              {differences.map((d) => (
                <li key={d.sku} className="flex justify-between py-1 font-mono">
                  <span>{d.sku}</span>
                  <span>
                    {fmtQty(d.received)} / {fmtQty(d.expected)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm">Al aceptar se crearán incidencias de faltante / sobrante y la recepción quedará CON INCIDENCIA.</p>
          </div>
        ) : (
          <div className="rounded-2xl bg-slate-800 p-4 text-lg">Se cerrarán los LPN abiertos, se compararán cantidades y se crearán tareas de put-away.{openLpns.length > 0 && ` LPN abiertos: ${openLpns.length}.`}</div>
        )}
        <div className="mt-4 grid gap-2">
          <BigButton tone={differences ? 'warning' : 'success'} onClick={() => complete(!!differences)} disabled={busy} testId="confirm-complete">
            {differences ? 'Aceptar diferencias y completar' : 'Confirmar completar'}
          </BigButton>
          <BigButton
            tone="neutral"
            onClick={() => {
              setDifferences(null);
              setStep('SCAN');
            }}
          >
            Regresar
          </BigButton>
        </div>
      </div>
    );
  }
  return null;
}

function StepBar({ text }: { text: string }) {
  return (
    <div className="mb-3 rounded-xl bg-sky-700 px-4 py-2 text-center text-base font-black uppercase tracking-wide" data-testid="wm-step">
      {text}
    </div>
  );
}
function feedbackOk(wm: ReturnType<typeof useWm>) {
  wm.ok();
}
