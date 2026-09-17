// /wm/lookup — scan a pallet (LPN) or a location label and see what it holds. Read-only.
import { useState } from 'react';
import { inventoryApi } from '../api/inventory';
import type { InventoryLpnRow, LpnDetail } from '../api/types';
import { ScanInput } from '../components/ScanInput';
import { es, fmtDateTime, fmtQty } from '../lib/format';
import { BigButton, BigValue, StepBar, useWm, WmShell } from './WmShell';

type Result = { kind: 'LPN'; lpn: LpnDetail } | { kind: 'LOCATION'; code: string; lpns: InventoryLpnRow[] };

export default function WmLookupPage() {
  return (
    <WmShell title="Consultar">
      <Flow />
    </WmShell>
  );
}

function Flow() {
  const wm = useWm();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const onScan = async (raw: string) => {
    const code = raw.trim().toUpperCase();
    setBusy(true);
    try {
      if (code.startsWith('LOC-') || /^[A-Z]{2,4}-[A-Z0-9]+-R\d\d-N\d\d-P\d+$/.test(code) || code.startsWith('HID-')) {
        const loc = code.replace(/^LOC-/, '');
        const lpns = await inventoryApi.lpns({ location_code: loc, limit: 50 });
        setResult({ kind: 'LOCATION', code: loc, lpns });
        wm.ok(lpns.length ? `${lpns.length} TARIMA(S) EN ${loc}` : `${loc} VACÍA`);
      } else {
        const lpn = await inventoryApi.lpn(code);
        setResult({ kind: 'LPN', lpn });
        const total = lpn.balances.reduce((a, b) => a + Number(b.qty), 0);
        wm.ok(`${lpn.code} · ${fmtQty(total)} pzas · ${lpn.current_location?.code ?? 'sin ubicación'}`);
      }
    } catch (e) {
      setResult(null);
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <StepBar text="ESCANEA UNA TARIMA (LPN) O UNA UBICACIÓN" />
      <ScanInput label="LPN o ubicación" autoUpper onScan={onScan} disabled={busy} testId="lookup-scan" />
      {result?.kind === 'LPN' && <LpnCard lpn={result.lpn} />}
      {result?.kind === 'LOCATION' && (
        <div className="mt-3">
          <BigValue label="Ubicación" value={result.code} tone="accent" />
          {result.lpns.length === 0 && <div className="mt-2 text-center text-lg text-slate-300">Sin tarimas registradas en esta ubicación.</div>}
          <ul className="mt-2 grid gap-2" data-testid="lookup-location-lpns">
            {result.lpns.map((l) => (
              <li key={l.id} className="rounded-2xl bg-slate-800 px-4 py-2">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xl font-black">{l.code}</span>
                  <span className="rounded-full bg-slate-600 px-2 text-xs font-bold">{es(l.status)}</span>
                </div>
                <ul className="text-sm text-slate-200">
                  {(l.contents ?? []).map((c) => (
                    <li key={`${c.sku_code}-${c.status}`}>
                      <span className="font-mono font-bold">{c.sku_code}</span> {c.description} · <b>{fmtQty(c.qty)}</b> pzas {c.status !== 'AVAILABLE' && <span className="text-amber-300">({es(c.status)})</span>}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
      {result && (
        <BigButton tone="neutral" className="mt-3" onClick={() => setResult(null)}>
          Otra consulta
        </BigButton>
      )}
    </div>
  );
}

function LpnCard({ lpn }: { lpn: LpnDetail }) {
  const rows = lpn.balances.filter((b) => Number(b.qty) > 0);
  const total = rows.reduce((a, b) => a + Number(b.qty), 0);
  return (
    <div className="mt-3" data-testid="lookup-lpn">
      <div className="grid gap-2 sm:grid-cols-2">
        <BigValue label="Tarima" value={lpn.code} tone="accent" />
        <BigValue label="Ubicación" value={lpn.current_location?.code ?? 'sin ubicación'} tone={lpn.current_location ? 'ok' : 'warn'} />
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-sm text-slate-300">
        <span className="rounded-full bg-slate-700 px-2 py-0.5 font-bold">{es(lpn.status)}</span>
        {lpn.cases_count ? <span>{lpn.cases_count} cajas</span> : null}
        {lpn.lot && <span>Lote {lpn.lot}</span>}
        {lpn.expiry_date && <span>Cad. {String(lpn.expiry_date).slice(0, 10)}</span>}
        {lpn.order && <span>Pedido {lpn.order.order_number}</span>}
        {lpn.receipt && <span>Recepción {lpn.receipt.receipt_number}</span>}
        <span>Creada {fmtDateTime(lpn.created_at)}</span>
      </div>
      <ul className="mt-3 grid gap-2">
        {rows.length === 0 && <li className="text-center text-lg text-slate-300">Tarima vacía.</li>}
        {rows.map((b) => (
          <li key={b.id} className="rounded-2xl bg-slate-800 px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xl font-black">{b.sku.code}</span>
              <span className="text-2xl font-black">
                {fmtQty(b.qty)} <span className="text-sm font-normal text-slate-300">pzas</span>
              </span>
            </div>
            <div className="text-sm text-slate-200">{b.sku.description}</div>
            {b.status !== 'AVAILABLE' && <div className="text-xs font-bold text-amber-300">{es(b.status)}</div>}
          </li>
        ))}
      </ul>
      <div className="mt-2 text-right text-lg font-bold">
        Total {fmtQty(total)} pzas · {rows.length} producto(s)
      </div>
    </div>
  );
}
