// /wm/transfer — start a transfer (scan LPN → scan destination) and complete in-transit transfers (scan LPN → scan location); cancel with reason.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { transfersApi } from '../api/storage';
import type { TransferRow } from '../api/types';
import { ScanInput } from '../components/ScanInput';
import { BigButton, BigValue, StepBar, useWm, WmList, WmShell } from './WmShell';

type Mode = 'MENU' | 'NEW_LPN' | 'NEW_DEST' | 'LIST' | 'COMPLETE_LPN' | 'COMPLETE_LOC' | 'CANCEL';

export default function WmTransferPage() {
  return (
    <WmShell title="Traslados">
      <Flow />
    </WmShell>
  );
}

/** Reusable completion flow (also used by replenishment). */
export function CompleteTransferFlow({ transfer, onDone, onCancel }: { transfer: { id: string; lpn_code: string; to_code: string; to_barcode: string }; onDone: () => void; onCancel: () => void }) {
  const wm = useWm();
  const [lpnOk, setLpnOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const onLpn = (v: string) => {
    if (v.toUpperCase() !== transfer.lpn_code.toUpperCase()) {
      wm.fail({ message: `LPN INCORRECTO — este traslado es de ${transfer.lpn_code}` });
      return;
    }
    setLpnOk(true);
    wm.ok();
  };
  const onLoc = async (v: string) => {
    setBusy(true);
    try {
      const r = await transfersApi.complete({ transfer_id: transfer.id, lpn_code: transfer.lpn_code, location_barcode: v }, api.newKey());
      wm.ok(r.replayed ? 'YA COMPLETADO' : `TRASLADO COMPLETADO EN ${r.data.location}`);
      onDone();
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <StepBar text={lpnOk ? '2 · ESCANEA LA UBICACIÓN DESTINO' : '1 · ESCANEA EL LPN'} />
      <div className="grid gap-2 sm:grid-cols-2">
        <BigValue label="Pallet" value={transfer.lpn_code} tone={lpnOk ? 'ok' : 'default'} />
        <BigValue label="Destino" value={transfer.to_code} tone="accent" testId="target-location" />
      </div>
      <div className="mt-3">{lpnOk ? <ScanInput label="Ubicación destino" onScan={onLoc} disabled={busy} testId="scan-location" /> : <ScanInput label="LPN" onScan={onLpn} autoUpper testId="scan-lpn" />}</div>
      <BigButton tone="neutral" className="mt-3" onClick={onCancel}>
        Regresar
      </BigButton>
    </div>
  );
}

function Flow() {
  const wm = useWm();
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>('MENU');
  const [lpn, setLpn] = useState('');
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState<TransferRow | null>(null);
  const [reason, setReason] = useState('');
  const list = useQuery({ queryKey: ['transfers', 'IN_TRANSIT'], queryFn: () => transfersApi.list('IN_TRANSIT'), refetchInterval: 10_000 });

  const start = async (dest: string) => {
    setBusy(true);
    try {
      const r = await transfersApi.start({ lpn_code: lpn, to_location_barcode: dest }, api.newKey());
      wm.ok(r.replayed ? 'YA INICIADO' : `TRASLADO INICIADO → ${r.data.to_location.code}`);
      void qc.invalidateQueries({ queryKey: ['transfers'] });
      setMode('MENU');
      setLpn('');
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!current) return;
    setBusy(true);
    try {
      await transfersApi.cancel(current.id, reason.trim());
      wm.ok('TRASLADO CANCELADO · pallet regresa a disponible');
      void qc.invalidateQueries({ queryKey: ['transfers'] });
      setCurrent(null);
      setReason('');
      setMode('LIST');
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'MENU')
    return (
      <div className="grid gap-3">
        <StepBar text="¿QUÉ QUIERES HACER?" />
        <BigButton tone="primary" onClick={() => setMode('NEW_LPN')} testId="new-transfer">
          Nuevo traslado
        </BigButton>
        <BigButton tone="neutral" onClick={() => setMode('LIST')} testId="in-transit">
          En tránsito ({list.data?.length ?? 0})
        </BigButton>
      </div>
    );
  if (mode === 'NEW_LPN')
    return (
      <div>
        <StepBar text="1 · ESCANEA EL LPN A MOVER" />
        <ScanInput
          label="LPN"
          autoUpper
          onScan={(v) => {
            setLpn(v);
            wm.ok();
            setMode('NEW_DEST');
          }}
          testId="scan-lpn"
        />
        <BigButton tone="neutral" className="mt-3" onClick={() => setMode('MENU')}>
          Regresar
        </BigButton>
      </div>
    );
  if (mode === 'NEW_DEST')
    return (
      <div>
        <StepBar text="2 · ESCANEA LA UBICACIÓN DESTINO" />
        <BigValue label="Pallet" value={lpn} />
        <div className="mt-3">
          <ScanInput label="Ubicación destino" onScan={start} disabled={busy} testId="scan-location" />
        </div>
        <BigButton tone="neutral" className="mt-3" onClick={() => setMode('NEW_LPN')}>
          Regresar
        </BigButton>
      </div>
    );
  if (mode === 'LIST')
    return (
      <div>
        <StepBar text="TRASLADOS EN TRÁNSITO · ELIGE UNO" />
        <WmList
          items={list.data}
          keyOf={(t) => t.id}
          empty="No hay traslados en tránsito"
          onSelect={(t) => {
            setCurrent(t);
            setMode('COMPLETE_LPN');
          }}
          render={(t) => (
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="font-mono text-xl font-black">{t.lpn_code}</div>
                <div className="text-sm text-slate-300">
                  {t.from_code} → <b className="text-sky-300">{t.to_code}</b> · {t.started_by_username ?? ''}
                </div>
              </div>
              <span className="rounded-full bg-sky-500 px-3 py-1 text-xs font-bold">{t.transfer_type}</span>
            </div>
          )}
        />
        <BigButton tone="neutral" className="mt-3" onClick={() => setMode('MENU')}>
          Regresar
        </BigButton>
      </div>
    );
  if ((mode === 'COMPLETE_LPN' || mode === 'COMPLETE_LOC') && current)
    return (
      <div>
        <CompleteTransferFlow
          transfer={current}
          onDone={() => {
            void qc.invalidateQueries({ queryKey: ['transfers'] });
            setCurrent(null);
            setMode('LIST');
          }}
          onCancel={() => setMode('LIST')}
        />
        <BigButton tone="danger" className="mt-2" onClick={() => setMode('CANCEL')}>
          Cancelar traslado
        </BigButton>
      </div>
    );
  if (mode === 'CANCEL' && current)
    return (
      <div>
        <StepBar text="CANCELAR TRASLADO · MOTIVO" />
        <BigValue label="Pallet" value={current.lpn_code} />
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motivo (mínimo 3 caracteres)" className="mt-3 h-28 w-full rounded-xl bg-slate-800 p-3 text-lg text-white" />
        <div className="mt-3 grid grid-cols-2 gap-2">
          <BigButton tone="neutral" onClick={() => setMode('COMPLETE_LPN')}>
            Regresar
          </BigButton>
          <BigButton tone="danger" onClick={cancel} disabled={busy || reason.trim().length < 3}>
            Confirmar cancelación
          </BigButton>
        </div>
      </div>
    );
  return null;
}
