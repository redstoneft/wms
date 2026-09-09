// /wm/training — guided, mandatory training: one step at a time, the server prepares a real exercise in the school
// warehouse, the operator performs it on the real screen, and the server verifies it before unlocking the next one.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { trainingApi, type TrainingStep } from '../api/training';
import { useAuth } from '../auth/AuthContext';
import { BigButton, StepBar, useWm, WmShell } from './WmShell';

export default function WmTrainingPage() {
  return (
    <WmShell title="Capacitación" backTo="/wm">
      <Guide />
    </WmShell>
  );
}

function Guide() {
  const wm = useWm();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { refresh } = useAuth();
  const q = useQuery({ queryKey: ['training'], queryFn: trainingApi.me, refetchInterval: 15_000 });
  const [hint, setHint] = useState<string | null>(null);
  const prepare = useMutation({
    mutationFn: (k: TrainingStep['key']) => trainingApi.prepare(k),
    onSuccess: () => {
      wm.ok('EJERCICIO LISTO');
      setHint(null);
      void qc.invalidateQueries({ queryKey: ['training'] });
    },
    onError: (e) => wm.fail(e),
  });
  const check = useMutation({
    mutationFn: (k: TrainingStep['key']) => trainingApi.check(k),
    onSuccess: async (r) => {
      if (r.ok) {
        wm.ok(r.training_completed ? '¡CAPACITACIÓN COMPLETADA!' : 'PASO COMPLETADO');
        setHint(null);
        await refresh();
      } else {
        wm.warn('AÚN NO');
        setHint(r.hint);
      }
      void qc.invalidateQueries({ queryKey: ['training'] });
    },
    onError: (e) => wm.fail(e),
  });

  const t = q.data;
  if (!t) return <div className="py-10 text-center text-slate-300">Cargando…</div>;
  const current = t.steps.find((s) => s.status === 'CURRENT') ?? null;
  const done = t.steps_done;

  if (!t.steps.length)
    return (
      <div className="py-10 text-center text-xl text-slate-300">
        Tu rol no tiene operaciones de piso; no hay capacitación que hacer.
        <BigButton tone="neutral" className="mt-6" onClick={() => nav('/wm')}>
          Regresar
        </BigButton>
      </div>
    );

  if (!current || t.completed_at)
    return (
      <div>
        <StepBar text="CAPACITACIÓN COMPLETADA" />
        <div className="rounded-2xl bg-emerald-900/60 p-5 text-center text-emerald-100">
          <div className="text-5xl">✓</div>
          <div className="mt-2 text-xl font-black">Ya puedes operar en el almacén real.</div>
          <div className="mt-1 text-sm">{t.steps_total} operaciones practicadas en el almacén escuela.</div>
        </div>
        <BigButton tone="primary" className="mt-4" onClick={() => nav('/wm')} testId="training-go">
          Ir al modo almacén
        </BigButton>
      </div>
    );

  return (
    <div>
      <StepBar text={`PASO ${done + 1} DE ${t.steps_total} · ${current.label.toUpperCase()}`} />
      <div className="mb-3 flex gap-1" aria-label="progreso">
        {t.steps.map((s) => (
          <div key={s.key} className={`h-2 flex-1 rounded ${s.status === 'COMPLETED' ? 'bg-emerald-500' : s.status === 'CURRENT' ? 'bg-sky-500' : 'bg-slate-700'}`} title={s.label} />
        ))}
      </div>
      <div className="rounded-2xl bg-slate-800 p-4">
        <div className="text-sm uppercase tracking-wide text-slate-400">Objetivo</div>
        <div className="text-lg font-semibold">{current.goal}</div>
        <div className="mt-2 rounded-lg bg-amber-900/50 p-2 text-sm text-amber-100">Todo se hace en el almacén escuela ({t.school.warehouse}). Usa únicamente las etiquetas de práctica (ESC-… y CAP…).</div>
      </div>

      {!current.prepared ? (
        <BigButton tone="primary" className="mt-4" onClick={() => prepare.mutate(current.key)} disabled={prepare.isPending} testId="training-prepare">
          1 · Preparar ejercicio
        </BigButton>
      ) : (
        <>
          <div className="mt-4 rounded-2xl bg-slate-800 p-4">
            <div className="text-sm uppercase tracking-wide text-slate-400">Qué vas a escanear</div>
            <div className="mt-2 grid gap-1">
              {current.codes.map((c) => (
                <div key={c.label + c.value} className="flex items-center justify-between rounded bg-slate-900 px-3 py-2">
                  <span className="text-sm text-slate-300">{c.label}</span>
                  <span className="font-mono text-lg font-black" data-testid="training-code">
                    {c.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-4 rounded-2xl bg-slate-800 p-4">
            <div className="text-sm uppercase tracking-wide text-slate-400">Pasos</div>
            <ol className="mt-2 grid gap-2">
              {current.instructions.map((line, i) => (
                <li key={i} className="flex gap-3">
                  <span className="grid h-8 w-8 flex-none place-items-center rounded-full bg-sky-600 font-black">{i + 1}</span>
                  <span className="text-base leading-snug">{line}</span>
                </li>
              ))}
            </ol>
          </div>
          {hint && (
            <div className="mt-4 rounded-2xl bg-amber-900/60 p-4 text-amber-100" data-testid="training-hint">
              <div className="text-sm font-bold uppercase">Todavía no está</div>
              <div>{hint}</div>
            </div>
          )}
          <BigButton tone="primary" className="mt-4" onClick={() => nav(current.page)} testId="training-go-page">
            2 · Ir a {current.label}
          </BigButton>
          <BigButton tone="success" className="mt-3" onClick={() => check.mutate(current.key)} disabled={check.isPending} testId="training-check">
            3 · Ya lo hice, verificar
          </BigButton>
          <BigButton tone="neutral" className="mt-3" onClick={() => prepare.mutate(current.key)} disabled={prepare.isPending}>
            Preparar de nuevo (nuevo ejercicio)
          </BigButton>
        </>
      )}

      <div className="mt-6 text-xs text-slate-400">
        Completados: {done} de {t.steps_total} · Intentos en este paso: {current.attempts}
      </div>
    </div>
  );
}
