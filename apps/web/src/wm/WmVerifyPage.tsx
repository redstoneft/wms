// /wm/verify — second-person blind verification: pending orders → start (SAME_USER needs supervisor authorization_id) → scan LPN → scan product → qty → complete → PASSED/FAILED.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { UomCode } from '@wms/shared';
import { api, ApiError } from '../api/client';
import { verificationApi } from '../api/orders';
import type { PendingVerificationOrder } from '../api/types';
import { QtyPad } from '../components/QtyPad';
import { ScanInput } from '../components/ScanInput';
import { fmtQty } from '../lib/format';
import { BigButton, BigValue, StepBar, useWm, WmList, WmShell } from './WmShell';

type Step = 'ORDER' | 'AUTH' | 'LPN' | 'PRODUCT' | 'QTY' | 'RESULT';

export default function WmVerifyPage() {
  return (
    <WmShell title="Verificación">
      <Flow />
    </WmShell>
  );
}

function Flow() {
  const wm = useWm();
  const qc = useQueryClient();
  const pending = useQuery({ queryKey: ['verif-pending'], queryFn: verificationApi.pendingOrders, refetchInterval: 10_000 });
  const [order, setOrder] = useState<PendingVerificationOrder | null>(null);
  const [vid, setVid] = useState<string | null>(null);
  const view = useQuery({ queryKey: ['verification', vid], queryFn: () => verificationApi.get(vid!), enabled: !!vid });
  const [step, setStep] = useState<Step>('ORDER');
  const [authId, setAuthId] = useState('');
  const [lpn, setLpn] = useState('');
  const [product, setProduct] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ status: string; mismatches?: unknown[]; changed?: boolean } | null>(null);

  const start = async (o: PendingVerificationOrder, auth?: string) => {
    setBusy(true);
    try {
      const r = await verificationApi.start({ order_id: o.id, authorization_id: auth || undefined });
      setVid(r.verification_id);
      setOrder(o);
      setResult(null);
      wm.ok(`VERIFICACIÓN INICIADA · ${r.lpn_count} pallets${r.same_user_authorized ? ' · autorizada' : ''}`);
      setStep('LPN');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SAME_USER') {
        setOrder(o);
        wm.fail(e, 'SURTIDOR = VERIFICADOR');
        setStep('AUTH');
      } else wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (qty: string, uom: UomCode) => {
    if (!vid) return;
    setBusy(true);
    try {
      const r = await verificationApi.scan({ verification_id: vid, lpn_code: lpn, barcode: product, qty, uom_code: uom }, api.newKey());
      wm.ok(r.replayed ? 'YA REGISTRADO' : r.data.complete ? `${r.data.sku} COMPLETO` : `${r.data.sku} · ${fmtQty(r.data.scanned)} verificadas`);
      void qc.invalidateQueries({ queryKey: ['verification', vid] });
      setProduct('');
      setStep('PRODUCT');
    } catch (e) {
      wm.fail(e);
      setStep('PRODUCT');
    } finally {
      setBusy(false);
    }
  };

  const complete = async () => {
    if (!vid) return;
    setBusy(true);
    try {
      const r = await verificationApi.complete(vid);
      setResult(r);
      if (r.status === 'PASSED') wm.ok('VERIFICACIÓN APROBADA');
      else wm.fail({ message: 'VERIFICACIÓN FALLIDA — se creó incidencia; el pedido debe revisarse' }, 'FAILED');
      void qc.invalidateQueries({ queryKey: ['verif-pending'] });
      setStep('RESULT');
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (step === 'ORDER')
    return (
      <div>
        <StepBar text="PEDIDOS EN STAGING · ELIGE UNO PARA VERIFICAR" />
        {busy && <div className="text-center text-slate-300">Iniciando…</div>}
        <WmList
          items={pending.data}
          keyOf={(o) => o.id}
          empty="No hay pedidos listos para verificar"
          onSelect={(o) => start(o)}
          render={(o) => (
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-xl font-black">
                  {o.order_number} <span className="text-sm font-normal text-slate-300">P{o.priority}</span>
                </div>
                <div className="text-sm text-slate-300">
                  {o.customer} · surtió {o.picker ?? '?'} · {o.staged_lpns} pallets en {o.staging_code ?? '—'}
                </div>
              </div>
            </div>
          )}
        />
      </div>
    );

  if (step === 'AUTH' && order)
    return (
      <div>
        <StepBar text="AUTORIZACIÓN DE SUPERVISOR REQUERIDA" />
        <div className="rounded-2xl bg-amber-400 p-4 text-amber-950">
          <div className="text-xl font-black">Tú surtiste este pedido. Un supervisor debe autorizar la excepción.</div>
          <p className="mt-1 text-sm">
            Oficina → Autorizaciones: tipo <b>SAME_USER_VERIFICATION</b>, entidad <b>order</b>, id:
          </p>
          <div className="my-1 select-all break-all rounded bg-amber-300 p-2 font-mono text-xs">{order.id}</div>
        </div>
        <input value={authId} onChange={(e) => setAuthId(e.target.value)} placeholder="ID de autorización (UUID)" className="mt-3 h-14 w-full rounded-xl bg-slate-800 px-3 font-mono text-white" />
        <div className="mt-3 grid grid-cols-2 gap-2">
          <BigButton tone="neutral" onClick={() => setStep('ORDER')}>
            Otro pedido
          </BigButton>
          <BigButton tone="warning" disabled={busy || authId.trim().length < 36} onClick={() => start(order, authId.trim())}>
            Iniciar con autorización
          </BigButton>
        </div>
      </div>
    );

  const v = view.data;
  const progress = v ? v.progress : { scanned_lines: 0, total_lines: 0 };
  const pct = progress.total_lines ? Math.round((progress.scanned_lines / progress.total_lines) * 100) : 0;
  const head = (
    <div className="mb-3 rounded-2xl bg-slate-800 px-4 py-2">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase text-slate-400">Pedido</div>
          <div className="text-xl font-black">{order?.order_number}</div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase text-slate-400">Progreso</div>
          <div className="text-xl font-black" data-testid="verify-progress">
            {progress.scanned_lines}/{progress.total_lines} líneas
          </div>
        </div>
      </div>
      <div className="mt-2 h-4 w-full overflow-hidden rounded-full bg-slate-700">
        <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );

  if (step === 'LPN')
    return (
      <div>
        <StepBar text="1 · ESCANEA UN PALLET DEL PEDIDO" />
        {head}
        <ScanInput
          label="LPN"
          autoUpper
          onScan={(s) => {
            setLpn(s);
            wm.ok();
            setStep('PRODUCT');
          }}
          testId="scan-lpn"
        />
        <div className="mt-3 rounded-2xl bg-slate-900 p-3 text-sm">
          <div className="mb-1 text-xs font-bold uppercase text-slate-400">Pallets del pedido</div>
          <div className="flex flex-wrap gap-1">{v?.lpns.map((c) => <span key={c} className="rounded bg-slate-700 px-2 py-1 font-mono">{c}</span>)}</div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <BigButton tone="neutral" onClick={() => { setStep('ORDER'); setVid(null); }}>
            Pausar
          </BigButton>
          <BigButton tone="success" onClick={complete} disabled={busy} testId="complete-verification">
            Completar verificación
          </BigButton>
        </div>
        {v && (
          <div className="mt-3 rounded-2xl bg-slate-900 p-3 text-sm">
            <div className="mb-1 text-xs font-bold uppercase text-slate-400">Líneas (ciego: sin cantidades esperadas)</div>
            {v.lines.map((l) => (
              <div key={l.id} className="flex justify-between py-0.5 font-mono">
                <span>
                  {l.lpn} · {l.sku}
                </span>
                <span className={l.complete ? 'text-emerald-400' : ''}>{fmtQty(l.scanned_qty)}{l.expected_qty !== null ? ` / ${fmtQty(l.expected_qty)}` : ''}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );

  if (step === 'PRODUCT')
    return (
      <div>
        <StepBar text="2 · ESCANEA EL PRODUCTO" />
        {head}
        <BigValue label="LPN" value={lpn} tone="ok" />
        <div className="mt-3">
          <ScanInput label="Código del producto" onScan={(s) => { setProduct(s); wm.ok(); setStep('QTY'); }} testId="scan-product" />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <BigButton tone="neutral" onClick={() => setStep('LPN')}>
            Otro pallet
          </BigButton>
          <BigButton tone="success" onClick={complete} disabled={busy} testId="complete-verification">
            Completar verificación
          </BigButton>
        </div>
      </div>
    );

  if (step === 'QTY')
    return (
      <div>
        <StepBar text="3 · ¿CUÁNTAS PIEZAS CUENTAS? (CIEGO)" />
        {head}
        <div className="mb-3 grid grid-cols-2 gap-2 text-center">
          <div className="rounded-xl bg-slate-800 p-2">
            <div className="text-xs text-slate-400">LPN</div>
            <div className="font-mono font-bold">{lpn}</div>
          </div>
          <div className="rounded-xl bg-slate-800 p-2">
            <div className="text-xs text-slate-400">Producto</div>
            <div className="font-mono font-bold">{product}</div>
          </div>
        </div>
        <QtyPad onConfirm={submit} onCancel={() => setStep('PRODUCT')} busy={busy} confirmLabel="VERIFICAR" />
      </div>
    );

  if (step === 'RESULT' && result)
    return (
      <div>
        <StepBar text="RESULTADO" />
        <BigValue label="Verificación" value={result.status === 'PASSED' ? 'APROBADA' : 'FALLIDA'} tone={result.status === 'PASSED' ? 'ok' : 'warn'} mono={false} testId="verify-result" />
        {result.status === 'FAILED' && <div className="mt-2 rounded-2xl bg-rose-700 p-3 text-center font-bold">{result.changed ? 'El inventario en staging cambió durante la verificación.' : `${result.mismatches?.length ?? 0} línea(s) no coinciden. Se creó una incidencia; el pedido debe corregirse y verificarse de nuevo.`}</div>}
        <BigButton tone="primary" className="mt-4" onClick={() => { setStep('ORDER'); setVid(null); setOrder(null); }}>
          Volver a pedidos
        </BigButton>
      </div>
    );
  return null;
}
