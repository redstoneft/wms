// /wm/count — blind cycle counting: task → scan location → (LPN) → scan product → qty → … → finish (RECOUNT flow when status RECOUNT).
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { UomCode } from '@wms/shared';
import { api } from '../api/client';
import { countsApi } from '../api/storage';
import type { CountTask } from '../api/types';
import { QtyPad } from '../components/QtyPad';
import { ScanInput } from '../components/ScanInput';
import { BigButton, BigValue, StepBar, useWm, WmList, WmShell } from './WmShell';

type Step = 'TASK' | 'LOCATION' | 'LPN' | 'PRODUCT' | 'QTY' | 'DONE';

export default function WmCountPage() {
  return (
    <WmShell title="Conteo cíclico">
      <Flow />
    </WmShell>
  );
}

function Flow() {
  const wm = useWm();
  const qc = useQueryClient();
  const tasks = useQuery({ queryKey: ['counts', 'mine'], queryFn: () => countsApi.list('PENDING,IN_PROGRESS,RECOUNT'), refetchInterval: 15_000 });
  const [task, setTask] = useState<CountTask | null>(null);
  const view = useQuery({ queryKey: ['count', task?.id], queryFn: () => countsApi.get(task!.id), enabled: !!task });
  const [step, setStep] = useState<Step>('TASK');
  const [location, setLocation] = useState('');
  const [lpn, setLpn] = useState<string | null>(null);
  const [product, setProduct] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ status: string; variances: number } | null>(null);

  const submit = async (qty: string, uom: UomCode) => {
    if (!task) return;
    setBusy(true);
    try {
      const r = await countsApi.submit({ count_task_id: task.id, location_barcode: location, lpn_code: lpn ?? undefined, barcode: product, qty, uom_code: uom }, api.newKey());
      wm.ok(r.replayed ? 'YA REGISTRADO' : `${r.data.sku} · ${r.data.qty} pzas · ${r.data.status}`);
      void qc.invalidateQueries({ queryKey: ['count', task.id] });
      setStep('LPN');
      setLpn(null);
      setProduct('');
    } catch (e) {
      wm.fail(e);
      setStep('PRODUCT');
    } finally {
      setBusy(false);
    }
  };
  const finish = async () => {
    if (!task) return;
    setBusy(true);
    try {
      const r = await countsApi.finish(task.id);
      setResult(r);
      if (r.status === 'CLOSED') wm.ok('CONTEO CERRADO · TODO COINCIDE');
      else wm.warn(`${r.variances} DIFERENCIA(S) → ${r.status}`);
      void qc.invalidateQueries({ queryKey: ['counts'] });
      setStep('DONE');
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (step === 'TASK' || !task)
    return (
      <div>
        <StepBar text="ELIGE UNA TAREA DE CONTEO" />
        <WmList
          items={tasks.data}
          keyOf={(t) => t.id}
          empty="No tienes conteos asignados"
          onSelect={(t) => {
            setTask(t);
            setStep('LOCATION');
            setResult(null);
            wm.ok();
          }}
          render={(t) => (
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-xl font-black">
                  {t.count_type} · {t.scope.location_ids.length} ubicaciones
                </div>
                <div className="text-sm text-slate-300">
                  {t.is_blind ? 'Ciego' : 'Con sistema'} · {t.lines ?? 0} líneas · {t.notes ?? ''}
                </div>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-bold ${t.status === 'RECOUNT' ? 'bg-amber-400 text-amber-950' : 'bg-sky-500'}`}>{t.status}</span>
            </div>
          )}
        />
      </div>
    );

  const isRecount = task.status === 'RECOUNT' || view.data?.task.status === 'RECOUNT';
  const counted = view.data?.lines.filter((l) => l.status !== 'PENDING' && l.status !== 'RECOUNT').length ?? 0;
  const total = view.data?.lines.length ?? 0;
  const head = (
    <div className="mb-3 flex items-center justify-between rounded-2xl bg-slate-800 px-4 py-2">
      <div>
        <div className="text-xs uppercase text-slate-400">{isRecount ? 'RECONTEO' : 'Conteo'} {task.count_type}</div>
        <div className="text-lg font-black">
          {counted}/{total} líneas
        </div>
      </div>
      <BigButton tone="warning" className="!min-h-12 !w-auto px-4 text-base" onClick={finish} disabled={busy} testId="finish-count">
        Terminar
      </BigButton>
    </div>
  );

  if (step === 'LOCATION')
    return (
      <div>
        <StepBar text="1 · ESCANEA LA UBICACIÓN" />
        {head}
        <ScanInput
          label="Ubicación"
          onScan={(v) => {
            const ok = view.data?.locations.some((l) => l.barcode === v || l.code === v.toUpperCase());
            if (!ok) {
              wm.fail({ message: `La ubicación ${v} no es parte de este conteo` });
              return;
            }
            setLocation(v);
            wm.ok();
            setStep('LPN');
          }}
          testId="scan-location"
        />
        <div className="mt-3 rounded-2xl bg-slate-900 p-3">
          <div className="mb-1 text-xs font-bold uppercase text-slate-400">Ubicaciones a visitar</div>
          <div className="flex flex-wrap gap-1">
            {view.data?.locations.map((l) => {
              const lines = view.data?.lines.filter((x) => x.location_code === l.code) ?? [];
              const done = lines.length > 0 && lines.every((x) => x.status !== 'PENDING' && x.status !== 'RECOUNT');
              return (
                <button key={l.id} type="button" onClick={() => { setLocation(l.barcode); setStep('LPN'); }} className={`rounded-lg px-2 py-1 font-mono text-sm ${done ? 'bg-emerald-700' : 'bg-slate-700'}`}>
                  {l.code}
                </button>
              );
            })}
          </div>
        </div>
        <BigButton tone="neutral" className="mt-3" onClick={() => { setTask(null); setStep('TASK'); }}>
          Cambiar de tarea
        </BigButton>
      </div>
    );

  if (step === 'LPN')
    return (
      <div>
        <StepBar text="2 · ESCANEA EL LPN (O SIN LPN)" />
        {head}
        <BigValue label="Ubicación" value={location} tone="accent" />
        <div className="mt-3">
          <ScanInput
            label="LPN del pallet"
            autoUpper
            onScan={(v) => {
              setLpn(v);
              wm.ok();
              setStep('PRODUCT');
            }}
            testId="scan-lpn"
          />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <BigButton tone="neutral" onClick={() => { setLpn(null); setStep('PRODUCT'); }}>
            Sin LPN
          </BigButton>
          <BigButton tone="neutral" onClick={() => setStep('LOCATION')}>
            Otra ubicación
          </BigButton>
        </div>
        <div className="mt-3 rounded-2xl bg-slate-900 p-3 text-sm">
          <div className="mb-1 text-xs font-bold uppercase text-slate-400">Registrado en esta ubicación</div>
          {view.data?.lines.filter((l) => l.location_code === location.replace(/^LOC-/, '')).map((l) => (
            <div key={l.id} className="flex justify-between py-0.5 font-mono">
              <span>
                {l.lpn_code ?? '—'} · {l.sku_code}
              </span>
              <span>
                {l.counted_qty ?? '?'} {l.system_qty !== null ? `(sist. ${l.system_qty})` : ''} · {l.status}
              </span>
            </div>
          ))}
        </div>
      </div>
    );

  if (step === 'PRODUCT')
    return (
      <div>
        <StepBar text="3 · ESCANEA EL PRODUCTO" />
        {head}
        <div className="grid gap-2 sm:grid-cols-2">
          <BigValue label="Ubicación" value={location} tone="accent" />
          <BigValue label="LPN" value={lpn ?? 'SIN LPN'} />
        </div>
        <div className="mt-3">
          <ScanInput
            label="Código del producto"
            onScan={(v) => {
              setProduct(v);
              wm.ok();
              setStep('QTY');
            }}
            testId="scan-product"
          />
        </div>
        <BigButton tone="neutral" className="mt-3" onClick={() => setStep('LPN')}>
          Regresar
        </BigButton>
      </div>
    );

  if (step === 'QTY')
    return (
      <div>
        <StepBar text="4 · ¿CUÁNTAS PIEZAS HAY? (CONTEO CIEGO)" />
        <div className="mb-3 grid grid-cols-3 gap-2 text-center text-sm">
          <div className="rounded-xl bg-slate-800 p-2">
            <div className="text-xs text-slate-400">Ubicación</div>
            <div className="font-mono font-bold">{location}</div>
          </div>
          <div className="rounded-xl bg-slate-800 p-2">
            <div className="text-xs text-slate-400">LPN</div>
            <div className="font-mono font-bold">{lpn ?? '—'}</div>
          </div>
          <div className="rounded-xl bg-slate-800 p-2">
            <div className="text-xs text-slate-400">Producto</div>
            <div className="font-mono font-bold">{product}</div>
          </div>
        </div>
        <QtyPad allowZero onConfirm={submit} onCancel={() => setStep('PRODUCT')} busy={busy} confirmLabel="REGISTRAR" />
      </div>
    );

  if (step === 'DONE' && result)
    return (
      <div>
        <StepBar text="RESULTADO" />
        <BigValue label="Estado del conteo" value={result.status} tone={result.status === 'CLOSED' ? 'ok' : 'warn'} mono={false} />
        <div className="mt-2 text-center text-xl">{result.variances} línea(s) con diferencia</div>
        {result.status === 'RECOUNT' && <div className="mt-2 rounded-2xl bg-amber-400 p-3 text-center font-bold text-amber-950">Las líneas con diferencia requieren reconteo por OTRA persona.</div>}
        {result.status === 'PENDING_APPROVAL' && <div className="mt-2 rounded-2xl bg-sky-600 p-3 text-center font-bold">Pendiente de aprobación del supervisor (Oficina → Almacenaje → Conteos).</div>}
        <BigButton tone="primary" className="mt-4" onClick={() => { setTask(null); setStep('TASK'); }}>
          Volver a tareas
        </BigButton>
      </div>
    );
  return null;
}
