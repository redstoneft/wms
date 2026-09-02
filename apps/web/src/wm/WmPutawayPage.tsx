// /wm/putaway — directed put-away: scan LPN → target location shown big → scan location → OK / UBICACIÓN INCORRECTA (supervisor override via authorization_id).
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { putawayApi } from '../api/storage';
import type { PutawayStartResult } from '../api/types';
import { ScanInput } from '../components/ScanInput';
import { fmtQty } from '../lib/format';
import { BigButton, BigValue, StepBar, useWm, WmShell } from './WmShell';

export default function WmPutawayPage() {
  return (
    <WmShell title="Ubicar (put-away)">
      <Flow />
    </WmShell>
  );
}

function Flow() {
  const wm = useWm();
  const [task, setTask] = useState<PutawayStartResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [override, setOverride] = useState<{ scanned: string; authId: string; reason: string } | null>(null);
  const [done, setDone] = useState<{ lpn: string; location: string; overridden: boolean } | null>(null);
  const pending = useQuery({ queryKey: ['putaway-tasks'], queryFn: () => putawayApi.tasks(), refetchInterval: 10_000, enabled: !task });

  const onLpn = async (code: string) => {
    setBusy(true);
    try {
      const r = await putawayApi.start(code);
      setTask(r);
      setDone(null);
      setOverride(null);
      wm.ok(`DESTINO ${r.target?.code ?? '?'}`);
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (locationBarcode: string, auth?: { authId: string; reason: string }) => {
    if (!task) return;
    setBusy(true);
    try {
      const r = await putawayApi.confirm(
        { task_id: task.task.id, lpn_code: task.lpn.code, location_barcode: locationBarcode, authorization_id: auth?.authId, override_reason: auth?.reason || undefined },
        api.newKey(),
      );
      wm.ok(r.replayed ? 'YA CONFIRMADO' : `UBICADO EN ${r.data.location}`);
      setDone({ lpn: r.data.lpn_code, location: r.data.location, overridden: r.data.overridden });
      setTask(null);
      setOverride(null);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'WRONG_LOCATION') {
        wm.error(e, 'UBICACIÓN INCORRECTA');
        setOverride({ scanned: locationBarcode, authId: '', reason: '' });
      } else wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  const resuggest = async () => {
    if (!task) return;
    setBusy(true);
    try {
      await putawayApi.resuggest(task.task.id);
      const r = await putawayApi.start(task.lpn.code);
      setTask(r);
      wm.ok(`NUEVO DESTINO ${r.target?.code ?? '?'}`);
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (!task) {
    return (
      <div>
        <StepBar text="1 · ESCANEA EL LPN DEL PALLET" />
        <ScanInput label="LPN" onScan={onLpn} autoUpper disabled={busy} testId="scan-lpn" placeholder="PLT-2026-…" />
        {done && (
          <div className="mt-3 rounded-2xl bg-emerald-600 p-4">
            <div className="text-xs font-bold uppercase tracking-widest">Último pallet ubicado</div>
            <div className="font-mono text-2xl font-black">
              {done.lpn} → {done.location}
            </div>
            {done.overridden && <div className="text-sm">Con autorización de supervisor</div>}
          </div>
        )}
        <div className="mt-4">
          <div className="mb-1 text-xs font-bold uppercase text-slate-400">Pendientes de ubicar ({pending.data?.length ?? 0})</div>
          <div className="flex flex-col gap-1">
            {pending.data?.slice(0, 30).map((t) => (
              <button key={t.id} type="button" onClick={() => onLpn(t.lpn_code)} className="flex min-h-14 items-center justify-between rounded-xl bg-slate-800 px-3 text-left">
                <span className="font-mono text-lg font-bold">{t.lpn_code}</span>
                <span className="text-sm text-slate-300">
                  {t.current_location ?? '—'} → <b className="text-sky-300">{t.suggested_location ?? '?'}</b>
                </span>
              </button>
            ))}
            {pending.data && pending.data.length === 0 && <div className="rounded-xl border-2 border-dashed border-slate-700 p-6 text-center text-slate-400">Sin tareas pendientes</div>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <StepBar text="2 · LLEVA EL PALLET Y ESCANEA LA UBICACIÓN" />
      <div className="grid gap-2 sm:grid-cols-2">
        <BigValue label="Pallet" value={task.lpn.code} />
        <BigValue label="Ubicación destino" value={task.target?.code ?? 'SIN DESTINO'} tone="accent" testId="target-location" />
      </div>
      <div className="mt-2 rounded-2xl bg-slate-900 p-3 text-sm text-slate-300">
        {task.contents.map((c) => (
          <div key={c.sku_code} className="flex justify-between">
            <span className="font-mono">{c.sku_code}</span>
            <span>{fmtQty(c.qty)} pzas</span>
          </div>
        ))}
      </div>
      <div className="mt-3">
        <ScanInput label="Código de la ubicación" onScan={(v) => confirm(v)} disabled={busy} testId="scan-location" placeholder="LOC-…" />
      </div>
      {override && (
        <div className="mt-3 rounded-2xl border-2 border-amber-400 bg-slate-900 p-3" data-testid="override-panel">
          <div className="text-lg font-black text-amber-300">¿UBICAR EN OTRO LUGAR? Requiere autorización de supervisor</div>
          <p className="mt-1 text-sm text-slate-300">
            Pide al supervisor que autorice en Oficina → Autorizaciones con tipo <b>PUTAWAY_LOCATION_OVERRIDE</b>, entidad <b>putaway_task</b> id:
          </p>
          <div className="my-1 select-all break-all rounded bg-slate-800 p-2 font-mono text-xs">{task.task.id}</div>
          <input value={override.authId} onChange={(e) => setOverride({ ...override, authId: e.target.value })} placeholder="ID de autorización (UUID)" className="mt-2 h-14 w-full rounded-xl bg-slate-800 px-3 font-mono text-white" />
          <input value={override.reason} onChange={(e) => setOverride({ ...override, reason: e.target.value })} placeholder="Motivo (opcional, usa el de la autorización)" className="mt-2 h-14 w-full rounded-xl bg-slate-800 px-3 text-white" />
          <BigButton tone="warning" className="mt-2" disabled={busy || override.authId.trim().length < 36} onClick={() => confirm(override.scanned, { authId: override.authId.trim(), reason: override.reason })}>
            Ubicar en {override.scanned} con autorización
          </BigButton>
        </div>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <BigButton tone="neutral" onClick={resuggest} disabled={busy}>
          Re-sugerir destino
        </BigButton>
        <BigButton tone="neutral" onClick={() => setTask(null)}>
          Cancelar
        </BigButton>
      </div>
    </div>
  );
}
