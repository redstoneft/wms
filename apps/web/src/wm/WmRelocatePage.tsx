// /wm/relocate — relocate a stored pallet in one step: scan the LPN, pick the destination from the list (floor
// positions included, flagged) or scan it, confirm. The engine never sends pallets to floor positions by itself.
import { useState } from 'react';
import { api } from '../api/client';
import { inventoryApi } from '../api/inventory';
import { transfersApi } from '../api/storage';
import type { LpnDetail, RelocateOptions } from '../api/types';
import { ScanInput } from '../components/ScanInput';
import { LocationPicker } from './LocationPicker';
import { BigButton, BigValue, StepBar, useWm, WmShell } from './WmShell';

type Mode = 'LPN' | 'DEST';

export default function WmRelocatePage() {
  return (
    <WmShell title="Reubicar tarima">
      <Flow />
    </WmShell>
  );
}

function Flow() {
  const wm = useWm();
  const [mode, setMode] = useState<Mode>('LPN');
  const [lpn, setLpn] = useState<LpnDetail | null>(null);
  const [opts, setOpts] = useState<RelocateOptions | null>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setMode('LPN');
    setLpn(null);
    setOpts(null);
    setSelected('');
  };

  const onLpn = async (code: string) => {
    setBusy(true);
    try {
      const [detail, o] = await Promise.all([inventoryApi.lpn(code), transfersApi.relocateOptions(code)]);
      setLpn(detail);
      setOpts(o);
      setSelected(o.options[0]?.code ?? '');
      setMode('DEST');
      wm.ok();
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  const move = async (location: string) => {
    if (!opts) return;
    setBusy(true);
    try {
      const r = await transfersApi.relocate({ lpn_code: opts.lpn_code, location }, api.newKey());
      wm.ok(r.replayed ? 'YA REUBICADA' : `TARIMA ${r.data.lpn_code} AHORA EN ${r.data.to}`);
      reset();
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'LPN')
    return (
      <div>
        <StepBar text="1 · ESCANEA LA TARIMA A MOVER" />
        <ScanInput label="LPN" autoUpper onScan={onLpn} disabled={busy} testId="scan-lpn" />
        <p className="mt-3 text-sm text-slate-400">Mueve una tarima ya acomodada a otra posición en un solo paso. Las tarimas del andén se ubican con <b>Ubicar</b>.</p>
      </div>
    );

  const contents = (lpn?.balances ?? []).filter((b) => Number(b.qty) > 0);
  const floor = opts?.options.filter((o) => o.manual_only).length ?? 0;
  return (
    <div>
      <StepBar text="2 · ELIGE O ESCANEA EL DESTINO" />
      <div className="grid gap-2 sm:grid-cols-2">
        <BigValue label="Tarima" value={opts?.lpn_code ?? ''} tone="ok" />
        <BigValue label="Está en" value={opts?.current?.code ?? '—'} testId="current-location" />
      </div>
      {contents.length > 0 && (
        <div className="mt-2 rounded-xl bg-slate-800 p-2 text-sm" data-testid="contents">
          {contents.map((b) => (
            <div key={b.id} className="flex justify-between gap-2">
              <span className="font-mono">{b.sku.code}</span>
              <span className="truncate text-slate-300">{b.sku.description}</span>
              <b>{b.qty}</b>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 rounded-2xl border-2 border-violet-500 bg-slate-900 p-3" data-testid="destination-chooser">
        <div className="mb-2 text-sm font-bold text-violet-300">
          Destinos que aceptan esta tarima{floor > 0 ? ` · ${floor} de piso (solo porque tú los eliges)` : ''}
        </div>
        {opts && opts.options.length > 0 ? (
          <>
            <LocationPicker list={opts.options} selected={selected} onSelect={setSelected} testId="destination-select" />
            <BigButton tone="success" className="mt-2" onClick={() => move(selected)} disabled={busy || !selected} testId="destination-use">
              Reubicar en {selected || '…'}
            </BigButton>
          </>
        ) : (
          <div className="text-slate-300">Ninguna posición libre acepta esta tarima. Escanea una ubicación si sabes dónde va.</div>
        )}
      </div>
      <div className="mt-3">
        <ScanInput label="…o escanea la ubicación destino" onScan={move} disabled={busy} testId="scan-location" />
      </div>
      <BigButton tone="neutral" className="mt-3" onClick={reset} disabled={busy}>
        Regresar
      </BigButton>
    </div>
  );
}
