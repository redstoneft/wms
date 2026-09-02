// /wm/pick — directed picking: my tasks → start → line by line: LOCATION → LPN/SKU → QTY. Errors block. Short-line only from office mode.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { UomCode } from '@wms/shared';
import { api } from '../api/client';
import { pickingApi } from '../api/orders';
import type { PickLine, PickTaskView } from '../api/types';
import { QtyPad } from '../components/QtyPad';
import { ScanInput } from '../components/ScanInput';
import { fmtQty, fmtUom, toBigInt } from '../lib/format';
import { BigButton, BigValue, StepBar, useWm, WmList, WmShell } from './WmShell';

export default function WmPickPage() {
  return (
    <WmShell title="Surtido">
      <Flow />
    </WmShell>
  );
}

function nextLine(v: PickTaskView): PickLine | null {
  return v.lines.find((l) => l.status === 'IN_PROGRESS') ?? v.lines.find((l) => l.status === 'PENDING') ?? null;
}

function Flow() {
  const wm = useWm();
  const qc = useQueryClient();
  const nav = useNavigate();
  const tasks = useQuery({ queryKey: ['pick-tasks', 'mine'], queryFn: () => pickingApi.tasks({ status: 'PENDING,IN_PROGRESS', mine: 'true' }), refetchInterval: 10_000 });
  const [taskId, setTaskId] = useState<string | null>(null);
  const view = useQuery({ queryKey: ['pick-task', taskId], queryFn: () => pickingApi.task(taskId!), enabled: !!taskId });
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState<PickTaskView | null>(null);

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
        <StepBar text="MIS TAREAS DE SURTIDO · ELIGE UNA" />
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
                  {t.customer} · {t.picked_lines}/{t.lines} líneas · staging {t.staging_code ?? '—'}
                </div>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-bold ${t.status === 'IN_PROGRESS' ? 'bg-sky-500' : 'bg-amber-400 text-amber-950'}`}>{t.status}</span>
            </div>
          )}
        />
      </div>
    );

  const v = completed ?? view.data;
  const line = nextLine(v);
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
      </div>
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
      <div className="mt-3">
        {stepNo === 0 && <ScanInput label="Escanea la ubicación" onScan={(s) => scan(line, 'LOCATION', s)} disabled={busy} testId="scan-location" />}
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
