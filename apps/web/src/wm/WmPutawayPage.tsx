// /wm/putaway — directed put-away: scan LPN → target location shown big → scan location → OK / UBICACIÓN INCORRECTA (supervisor override via authorization_id).
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { putawayApi } from '../api/storage';
import type { PutawayOption, PutawayStartResult } from '../api/types';
import { ScanInput } from '../components/ScanInput';
import { fmtQty } from '../lib/format';
import { LocationPicker } from './LocationPicker';
import { SupervisorAuth } from './SupervisorAuth';
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
  const [override, setOverride] = useState<{ scanned: string } | null>(null);
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

  const confirm = async (locationBarcode: string, auth?: { authId?: string; reason: string }) => {
    if (!task) return;
    setBusy(true);
    try {
      const r = await putawayApi.confirm(
        { task_id: task.task.id, lpn_code: task.lpn.code, location_barcode: locationBarcode, authorization_id: auth?.authId || undefined, override_reason: auth?.reason || undefined },
        api.newKey(),
      );
      wm.ok(r.replayed ? 'YA CONFIRMADO' : `UBICADO EN ${r.data.location}`);
      setDone({ lpn: r.data.lpn_code, location: r.data.location, overridden: r.data.overridden });
      setTask(null);
      setOverride(null);
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'WRONG_LOCATION' || e.code === 'REASON_REQUIRED')) {
        wm.error(e, e.code === 'WRONG_LOCATION' ? 'UBICACIÓN INCORRECTA' : 'FALTA EL MOTIVO');
        setOverride({ scanned: locationBarcode });
      } else wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  // choosing the destination: "another one" (engine) or a location from the list
  const [options, setOptions] = useState<{ list: PutawayOption[]; selected: string } | null>(null);
  const choose = async (body: { location_code?: string; other?: boolean }) => {
    if (!task) return;
    setBusy(true);
    try {
      const r = await putawayApi.choose(task.task.id, body);
      setTask({ ...task, target: r.target, task: { ...task.task, suggested_location_id: r.target.id } });
      setOptions(null);
      setOverride(null);
      wm.ok(`NUEVO DESTINO ${r.target.code}`);
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const openOptions = async () => {
    if (!task) return;
    setBusy(true);
    try {
      const r = await putawayApi.options(task.task.id);
      if (!r.options.length) {
        wm.warn('NO HAY OTRA UBICACIÓN DISPONIBLE');
        return;
      }
      setOptions({ list: r.options, selected: r.options.find((o) => !o.is_current)?.code ?? r.options[0]!.code });
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
        <SupervisorAuth
          title={`¿Ubicar en ${override.scanned} en vez de ${task.target?.code ?? '?'}?`}
          exceptionType="PUTAWAY_LOCATION_OVERRIDE"
          entityType="putaway_task"
          entityId={task.task.id}
          selfPermission="putaway.override"
          busy={busy}
          onAuthorized={(id, reason) => confirm(override.scanned, { authId: id, reason })}
          onSelf={(reason) => confirm(override.scanned, { reason })}
          onCancel={() => setOverride(null)}
        />
      )}
      {options && (
        <div className="mt-3 rounded-2xl border-2 border-violet-500 bg-slate-900 p-3" data-testid="location-chooser">
          <div className="mb-1 text-sm font-semibold uppercase tracking-wide text-violet-300">Elige la ubicación destino</div>
          <LocationPicker list={options.list} selected={options.selected} onSelect={(code) => setOptions({ ...options, selected: code })} testId="location-select" />
          <div className="mt-2 grid grid-cols-2 gap-2">
            <BigButton tone="neutral" onClick={() => setOptions(null)}>
              Cancelar
            </BigButton>
            <BigButton tone="success" onClick={() => choose({ location_code: options.selected })} disabled={busy} testId="location-use">
              Usar esta ubicación
            </BigButton>
          </div>
        </div>
      )}
      {!options && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <BigButton tone="neutral" onClick={() => choose({ other: true })} disabled={busy} testId="location-other">
            Otra ubicación (automática)
          </BigButton>
          <BigButton tone="neutral" onClick={openOptions} disabled={busy} testId="location-pick">
            Elegir ubicación de la lista
          </BigButton>
        </div>
      )}
      <BigButton tone="neutral" className="mt-2" onClick={() => { setTask(null); setOptions(null); }}>
        Cancelar
      </BigButton>
    </div>
  );
}
