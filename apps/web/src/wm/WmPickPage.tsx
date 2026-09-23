// /wm/pick — directed picking: my tasks → start → line by line: LOCATION → LPN/SKU → QTY. Errors block. Short-line only from office mode.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import type { UomCode } from '@wms/shared';
import { api } from '../api/client';
import { pickingApi } from '../api/orders';
import type { PickLine, PickTaskView } from '../api/types';
import { QtyPad } from '../components/QtyPad';
import { ScanInput } from '../components/ScanInput';
import { fmtQty, fmtUom, toBigInt } from '../lib/format';
import { WmFreePick } from './WmFreePick';
import { BigButton, BigValue, StepBar, useWm, WmList, WmShell } from './WmShell';

export default function WmPickPage() {
  return (
    <WmShell title="Surtido">
      <Flow />
    </WmShell>
  );
}

/** Shared picking: my own line in progress first, then a free line; lines other pickers are on are skipped. */
function nextLine(v: PickTaskView, me: string | undefined): PickLine | null {
  return v.lines.find((l) => l.status === 'IN_PROGRESS' && l.picker_id === me) ?? v.lines.find((l) => l.status === 'PENDING') ?? v.lines.find((l) => l.status === 'IN_PROGRESS' && !l.picker_id) ?? null;
}
function othersBusy(v: PickTaskView, me: string | undefined): number {
  return v.lines.filter((l) => l.status === 'IN_PROGRESS' && l.picker_id && l.picker_id !== me).length;
}

function Flow() {
  const wm = useWm();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { user } = useAuth();
  // shared picking: every picker sees every open pick and can join one another picker started
  const seeAll = true;
  const tasks = useQuery({ queryKey: ['pick-tasks', 'all'], queryFn: () => pickingApi.tasks({ status: 'PENDING,IN_PROGRESS', mine: 'false' }), refetchInterval: 10_000 });
  const [taskId, setTaskId] = useState<string | null>(null);
  const view = useQuery({ queryKey: ['pick-task', taskId], queryFn: () => pickingApi.task(taskId!), enabled: !!taskId });
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState<PickTaskView | null>(null);
  // choosing the pallet: other pallets that hold the line's product
  const [chooser, setChooser] = useState<{ lineId: string; remaining: string; candidates: { lpn_code: string; location: string; available: string; enough: boolean; mixed: boolean }[]; selected: string } | null>(null);
  const openChooser = async (line: PickLine) => {
    if (!taskId) return;
    setBusy(true);
    try {
      const r = await pickingApi.candidates(taskId, line.id);
      if (!r.candidates.length) {
        wm.warn('NO HAY OTRA TARIMA CON ESTE PRODUCTO');
        return;
      }
      setChooser({ lineId: line.id, remaining: r.remaining, candidates: r.candidates, selected: r.candidates.find((c) => c.enough)?.lpn_code ?? r.candidates[0]!.lpn_code });
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const relocate = async () => {
    if (!taskId || !chooser) return;
    setBusy(true);
    try {
      const v = await pickingApi.relocate(taskId, chooser.lineId, chooser.selected);
      qc.setQueryData(['pick-task', taskId], v);
      wm.ok(`LÍNEA CAMBIADA A ${chooser.selected}`);
      setChooser(null);
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  const start = async (id: string) => {
    setBusy(true);
    try {
      const v = await pickingApi.start(id);
      qc.setQueryData(['pick-task', id], v);
      setTaskId(id);
      setCompleted(null);
      wm.ok(`PEDIDO ${v.order.order_number} · ${v.lines.length} líneas`);
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  const scan = async (line: PickLine, step: 'LOCATION' | 'LPN' | 'QTY', scanned?: string, qty?: string, uom?: UomCode) => {
    if (!taskId) return;
    setBusy(true);
    try {
      const r = await pickingApi.scan({ pick_task_id: taskId, line_id: line.id, step, scanned, qty, uom_code: uom }, api.newKey());
      const d = r.data;
      if (step === 'LOCATION') wm.ok(`UBICACIÓN OK · toma ${d.expected_lpn}`);
      else if (step === 'LPN') wm.ok(`PALLET OK · faltan ${fmtQty(d.remaining ?? '0')}`);
      else if (d.next === 'NEXT_LINE') wm.ok(d.task_completed ? 'PEDIDO SURTIDO COMPLETO' : 'LÍNEA COMPLETA · siguiente');
      else wm.ok(`REGISTRADO · faltan ${fmtQty(d.remaining ?? '0')}`);
      const v = await pickingApi.task(taskId);
      qc.setQueryData(['pick-task', taskId], v);
      if (d.task_completed) {
        setCompleted(v);
        void qc.invalidateQueries({ queryKey: ['pick-tasks'] });
      }
    } catch (e) {
      wm.fail(e);
      void qc.invalidateQueries({ queryKey: ['pick-task', taskId] });
    } finally {
      setBusy(false);
    }
  };

  if (!taskId || !view.data)
    return (
      <div>
        <StepBar text={seeAll ? 'TAREAS DE SURTIDO ABIERTAS · ELIGE UNA' : 'MIS TAREAS DE SURTIDO · ELIGE UNA'} />
        {busy && <div className="text-center text-slate-300">Iniciando…</div>}
        <WmList
          items={tasks.data}
          keyOf={(t) => t.id}
          empty="No tienes tareas de surtido asignadas"
          onSelect={(t) => start(t.id)}
          testId="pick-task-list"
          render={(t) => (
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-xl font-black">
                  {t.order_number} <span className="text-sm font-normal text-slate-300">P{t.priority}</span>
                </div>
                <div className="text-sm text-slate-300">
                  {t.customer} · {t.mode === 'FREE' ? <span className="rounded bg-violet-600 px-1.5 text-xs font-bold text-white">SURTIDO LIBRE</span> : null} {t.picked_lines}/{t.lines} líneas · staging {t.staging_code ?? '—'}
                  {seeAll && t.assigned_username && <span className="ml-2 text-xs text-amber-300">· {t.status === 'IN_PROGRESS' ? 'en curso' : 'asignada'}: {t.assigned_username}</span>}
                </div>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-bold ${t.status === 'IN_PROGRESS' ? 'bg-sky-500' : 'bg-amber-400 text-amber-950'}`}>{t.status}</span>
            </div>
          )}
        />
      </div>
    );

  const v = completed ?? view.data;
  if (v.task.mode === 'FREE' && v.task.status !== 'COMPLETED' && !completed)
    return (
      <WmFreePick
        view={v}
        onRefresh={(nv) => qc.setQueryData(['pick-task', v.task.id], nv)}
        onPause={() => { setTaskId(null); void qc.invalidateQueries({ queryKey: ['pick-tasks'] }); }}
        onClosed={(nv) => { qc.setQueryData(['pick-task', v.task.id], nv); setCompleted(nv); void qc.invalidateQueries({ queryKey: ['pick-tasks'] }); }}
        onCancelled={() => { setTaskId(null); setCompleted(null); void qc.invalidateQueries({ queryKey: ['pick-tasks'] }); }}
      />
    );
  const line = nextLine(v, user?.id);
  const busyByOthers = othersBusy(v, user?.id);
  const done = v.lines.filter((l) => l.status === 'PICKED' || l.status === 'SHORT').length;
  const head = (
    <div className="mb-3 flex items-center justify-between rounded-2xl bg-slate-800 px-4 py-2">
      <div>
        <div className="text-xs uppercase text-slate-400">Pedido</div>
        <div className="text-xl font-black">
          {v.order.order_number} <span className="text-sm font-normal text-slate-300">{v.order.customer}</span>
        </div>
      </div>
      <div className="text-right">
        <div className="text-xs uppercase text-slate-400">Líneas</div>
        <div className="text-xl font-black">
          {done}/{v.lines.length}
        </div>
      </div>
      <div className="text-right">
        <div className="text-xs uppercase text-slate-400">Staging</div>
        <div className="font-mono text-xl font-black text-violet-300">{v.staging?.code ?? '—'}</div>
        {busyByOthers > 0 && <div className="text-xs text-amber-300">{busyByOthers} línea(s) con otro surtidor</div>}
      </div>
    </div>
  );

  if (!line && v.task.status !== 'COMPLETED' && busyByOthers > 0)
    return (
      <div>
        <StepBar text="LAS LÍNEAS QUE FALTAN LAS ESTÁN SURTIENDO OTROS" />
        {head}
        <ul className="grid gap-1 text-base">
          {v.lines.filter((l) => l.status === 'IN_PROGRESS').map((l) => (
            <li key={l.id} className="flex justify-between rounded bg-slate-900 px-3 py-2">
              <span className="font-mono">{l.location_code} · {l.sku_code}</span>
              <span className="text-amber-300">{l.picker_username ?? 'otro surtidor'}</span>
            </li>
          ))}
        </ul>
        <BigButton tone="neutral" className="mt-3" onClick={() => void qc.invalidateQueries({ queryKey: ['pick-task', taskId] })}>
          Actualizar
        </BigButton>
        <BigButton tone="neutral" className="mt-3" onClick={() => setTaskId(null)}>
          Volver a tareas
        </BigButton>
      </div>
    );
  if (!line || v.task.status === 'COMPLETED')
    return (
      <div>
        <StepBar text="PEDIDO SURTIDO" />
        {head}
        <BigValue label="LPN de salida" value={v.task.outbound_lpn ?? v.lines.find((l) => l.full_pallet)?.lpn_code ?? '—'} tone="ok" />
        <div className="mt-2 text-center text-lg text-slate-300">Lleva el(los) pallet(s) al carril de staging {v.staging?.code ?? ''} y escanéalos en STAGING.</div>
        <div className="mt-4 grid gap-2">
          <BigButton tone="primary" onClick={() => nav('/wm/stage')}>
            Ir a staging
          </BigButton>
          <BigButton tone="neutral" onClick={() => { setTaskId(null); setCompleted(null); }}>
            Volver a tareas
          </BigButton>
        </div>
      </div>
    );

  const remaining = toBigInt(line.qty) - toBigInt(line.picked_qty);
  const stepNo = line.scan_step;
  return (
    <div>
      <StepBar text={stepNo === 0 ? `LÍNEA ${line.sequence} · 1 VE A LA UBICACIÓN Y ESCANÉALA` : stepNo === 1 ? `LÍNEA ${line.sequence} · 2 ESCANEA EL PALLET O PRODUCTO` : `LÍNEA ${line.sequence} · 3 CANTIDAD`} />
      {head}
      <div className="grid gap-2 sm:grid-cols-2">
        <BigValue label="Ubicación" value={line.location_code} tone={stepNo >= 1 ? 'ok' : 'accent'} testId="pick-location" />
        <BigValue label="Pallet / SKU" value={stepNo >= 1 ? `${line.lpn_code}` : '• • •'} tone={stepNo >= 2 ? 'ok' : stepNo === 1 ? 'accent' : 'default'} />
      </div>
      <div className="mt-2 rounded-2xl bg-slate-900 px-4 py-2 text-lg">
        <span className="font-mono font-bold">{line.sku_code}</span> {line.sku_description}
        <div className="text-sm text-slate-300">
          Necesario {fmtUom(line.qty, line.uoms)} · surtido {fmtQty(line.picked_qty)} {line.full_pallet && <span className="ml-2 rounded bg-violet-600 px-2 text-xs font-bold text-white">PALLET COMPLETO</span>}
        </div>
      </div>
      {chooser && chooser.lineId === line.id && (
        <div className="mt-3 rounded-2xl border-2 border-violet-500 bg-slate-900 p-3" data-testid="pallet-chooser">
          <div className="mb-1 text-sm font-semibold uppercase tracking-wide text-violet-300">Elige la tarima para {fmtQty(chooser.remaining)} pzas de {line.sku_code}</div>
          <select value={chooser.selected} onChange={(e) => setChooser({ ...chooser, selected: e.target.value })} className="w-full rounded-lg border-2 border-slate-500 bg-slate-800 px-3 py-3 text-lg text-white" data-testid="pallet-select">
            {chooser.candidates.map((c) => (
              <option key={c.lpn_code} value={c.lpn_code}>
                {c.lpn_code} · {c.location} · {fmtQty(c.available)} pzas{c.enough ? '' : ' (no alcanza)'}{c.mixed ? ' · mixta' : ''}
              </option>
            ))}
          </select>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <BigButton tone="neutral" onClick={() => setChooser(null)}>
              Cancelar
            </BigButton>
            <BigButton tone="success" onClick={relocate} disabled={busy || !chooser.candidates.find((c) => c.lpn_code === chooser.selected)?.enough} testId="pallet-relocate">
              Usar esta tarima
            </BigButton>
          </div>
        </div>
      )}
      <div className="mt-3">
        {stepNo === 0 && !chooser && <ScanInput label="Escanea la ubicación" onScan={(s) => scan(line, 'LOCATION', s)} disabled={busy} testId="scan-location" />}
        {stepNo === 0 && !chooser && toBigInt(line.picked_qty) === 0n && (
          <button type="button" className="mt-2 w-full rounded-2xl border-2 border-violet-500 py-3 text-sm font-bold text-violet-300" onClick={() => void openChooser(line)} disabled={busy} data-testid="pallet-change">
            Tomar de otra tarima (elegir de la lista)
          </button>
        )}
        {stepNo === 1 && <ScanInput label="Escanea el LPN o el código del producto" onScan={(s) => scan(line, 'LPN', s)} disabled={busy} testId="scan-lpn" />}
        {stepNo === 2 && (
          <QtyPad
            uoms={line.uoms}
            hint={`FALTAN ${fmtUom(remaining, line.uoms)}`}
            initial={line.full_pallet ? remaining.toString() : ''}
            onConfirm={(q, u) => scan(line, 'QTY', undefined, q, u)}
            busy={busy}
            confirmLabel="SURTIR"
          />
        )}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <BigButton tone="neutral" onClick={() => setTaskId(null)}>
          Pausar tarea
        </BigButton>
        <div className="rounded-2xl bg-slate-900 p-2 text-center text-xs text-slate-400">Faltantes (short) sólo por supervisor en modo oficina.</div>
      </div>
    </div>
  );
}
