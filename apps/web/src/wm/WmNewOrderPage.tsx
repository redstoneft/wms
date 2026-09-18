// /wm/new-order — capture a manual order on the handheld: number, customer, scanned products with quantities,
// purpose; then save it (someone picks later) or start picking it right away.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { UomCode } from '@wms/shared';
import { masterdataApi } from '../api/masterdata';
import { wmTasksApi } from '../api/wmTasks';
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
type Step = 'NUMBER' | 'CUSTOMER' | 'LINES' | 'PURPOSE';

export default function WmNewOrderPage() {
  return (
    <WmShell title="Capturar pedido">
      <Flow />
    </WmShell>
  );
}

function Flow() {
  const wm = useWm();
  const nav = useNavigate();
  const [step, setStep] = useState<Step>('NUMBER');
  const [number, setNumber] = useState('');
  const [customer, setCustomer] = useState<{ code: string; name: string } | null>(null);
  const [customerQ, setCustomerQ] = useState('');
  const [destination, setDestination] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [pending, setPending] = useState<Omit<Line, 'qty' | 'uom_code'> | null>(null);
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false);
  const customers = useQuery({ queryKey: ['customers', 'all'], queryFn: () => masterdataApi.parties('customers', { limit: 500 }), enabled: step === 'CUSTOMER' });
  const customerRows = useMemo(() => {
    const raw = customers.data as unknown as { items?: { code: string; name: string }[] } | { code: string; name: string }[] | undefined;
    const list = Array.isArray(raw) ? raw : raw?.items ?? [];
    const q = customerQ.trim().toLowerCase();
    return list.filter((c) => !q || c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)).slice(0, 12);
  }, [customers.data, customerQ]);
  const totalPieces = lines.reduce((a, l) => a + Number(l.qty) * Number(l.uoms.find((u) => u.uom_code === l.uom_code)?.base_qty ?? 1), 0);

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
  const save = async (startNow: boolean) => {
    if (!customer) return;
    setBusy(true);
    try {
      const r = await wmTasksApi.createOrder({ order_number: number, customer_code: customer.code, destination: destination.trim() || undefined, purpose: purpose.trim(), lines: lines.map((l) => ({ sku_code: l.sku_code, qty: l.qty, uom_code: l.uom_code })), start_now: startNow });
      wm.ok(startNow ? `PEDIDO ${r.order_number} CAPTURADO · SURTIDO ASIGNADO · CARRIL ${r.staging ?? ''}` : `PEDIDO ${r.order_number} CAPTURADO · ${r.lines} línea(s)`);
      nav(r.next);
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (step === 'NUMBER')
    return (
      <div>
        <StepBar text="1 · NÚMERO DEL PEDIDO (ORDEN DE COMPRA DEL CLIENTE)" />
        <ScanInput label="Número de pedido" autoUpper onScan={(v) => { setNumber(v.replace(/\s+/g, ' ').trim()); wm.ok(); setStep('CUSTOMER'); }} testId="new-order-number" placeholder="Escanea o escribe y Enter" />
        <div className="mt-1 text-xs text-slate-400">Letras, números, espacios y . _ - / #</div>
        <div className="mt-2 text-xs text-slate-400">Usa el número de orden de compra del cliente. El cliente se elige en el siguiente paso.</div>
      </div>
    );
  if (step === 'CUSTOMER')
    return (
      <div>
        <StepBar text="2 · ¿DE QUÉ CLIENTE ES?" />
        <BigValue label="Pedido" value={number} tone="accent" />
        <input value={customerQ} onChange={(e) => setCustomerQ(e.target.value)} placeholder="Buscar cliente…" className="mt-3 w-full rounded-lg border-2 border-slate-500 bg-slate-900 px-3 py-3 text-xl text-white" data-testid="new-order-customer-q" />
        <div className="mt-2 grid gap-2">
          {customerRows.map((c) => (
            <BigButton key={c.code} tone="neutral" onClick={() => { setCustomer(c); wm.ok(`CLIENTE ${c.name}`); setStep('LINES'); }} testId={`new-order-customer-${c.code}`}>
              {c.name}
              <span className="block text-sm font-normal normal-case text-slate-300">{c.code}</span>
            </BigButton>
          ))}
          {customers.isLoading && <div className="text-center text-slate-300">Cargando clientes…</div>}
        </div>
        <BigButton tone="neutral" className="mt-3" onClick={() => setStep('NUMBER')}>
          Regresar
        </BigButton>
      </div>
    );
  if (step === 'LINES')
    return (
      <div>
        <StepBar text={pending ? `CANTIDAD DE ${pending.sku_code}` : `3 · ESCANEA LOS PRODUCTOS DEL PEDIDO (${lines.length} línea${lines.length === 1 ? '' : 's'})`} />
        <div className="mb-2 flex items-center justify-between rounded-2xl bg-slate-800 px-4 py-2">
          <div>
            <div className="text-xs uppercase text-slate-400">Pedido</div>
            <div className="text-lg font-black">
              {number} <span className="text-sm font-normal text-slate-300">{customer?.name}</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase text-slate-400">Piezas</div>
            <div className="text-lg font-black">{fmtQty(totalPieces)}</div>
          </div>
        </div>
        {pending ? (
          <div>
            <div className="rounded-2xl bg-slate-900 px-4 py-2 text-lg">
              <span className="font-mono font-bold">{pending.sku_code}</span> {pending.description}
            </div>
            <div className="mt-3">
              <QtyPad uoms={pending.uoms} defaultUom={pending.uoms.some((u) => u.uom_code === 'CASE') ? 'CASE' : 'PIECE'} hint="¿CUÁNTO PIDE EL CLIENTE?" confirmLabel="AGREGAR" busy={busy} onCancel={() => setPending(null)} onConfirm={(q, u) => { setLines((ls) => [...ls, { ...pending, qty: q, uom_code: u }]); setPending(null); wm.ok(`${q} ${u} DE ${pending.sku_code}`); }} />
            </div>
          </div>
        ) : (
          <>
            <ScanInput label="Código de barras / clave del producto" onScan={onProduct} disabled={busy} testId="new-order-product" />
            <ul className="mt-3 grid gap-1 font-mono text-base" data-testid="new-order-lines">
              {lines.map((l, i) => (
                <li key={i} className="flex items-center justify-between gap-2 rounded bg-slate-900 px-3 py-2">
                  <span>
                    {l.sku_code} <span className="text-xs text-slate-400">{l.description.slice(0, 26)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    {fmtQty(l.qty)} {l.uom_code === 'CASE' ? 'cajas' : l.uom_code === 'PIECE' ? 'pzas' : l.uom_code}
                    <button type="button" className="rounded bg-slate-700 px-2 py-1 text-xs font-bold text-white" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Quitar línea">
                      ✕
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <BigButton tone="neutral" onClick={() => setStep('CUSTOMER')}>
                Regresar
              </BigButton>
              <BigButton tone="primary" disabled={lines.length === 0} onClick={() => setStep('PURPOSE')} testId="new-order-lines-ok">
                Continuar
              </BigButton>
            </div>
          </>
        )}
      </div>
    );
  return (
    <div>
      <StepBar text="4 · ¿PARA QUÉ? Y GUARDAR" />
      <div className="grid gap-2 sm:grid-cols-2">
        <BigValue label="Pedido" value={number} tone="accent" />
        <BigValue label="Cliente" value={customer?.name ?? ''} />
      </div>
      <div className="mt-2 text-sm text-slate-300">
        {lines.length} línea(s) · {fmtQty(totalPieces)} piezas
      </div>
      <input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="Destino o sucursal (opcional)" className="mt-3 w-full rounded-lg border-2 border-slate-500 bg-slate-900 px-3 py-3 text-lg text-white" data-testid="new-order-destination" />
      <label className="mt-3 block">
        <div className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-300">Para qué se captura este pedido</div>
        <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={3} placeholder="Ej.: pedido de mostrador, pasa por él hoy" className="w-full rounded-lg border-2 border-slate-500 bg-slate-900 px-3 py-3 text-xl text-white" data-testid="new-order-purpose" />
      </label>
      <div className="mt-3 grid gap-2">
        <BigButton tone="success" disabled={busy || purpose.trim().length < 5} onClick={() => save(true)} testId="new-order-save-pick">
          Guardar y surtirlo ahora
        </BigButton>
        <BigButton tone="primary" disabled={busy || purpose.trim().length < 5} onClick={() => save(false)} testId="new-order-save">
          Solo guardar (se surte después)
        </BigButton>
        <BigButton tone="neutral" onClick={() => setStep('LINES')}>
          Regresar
        </BigButton>
      </div>
    </div>
  );
}
