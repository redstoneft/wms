// Warehouse-mode shell for Zebra handhelds / RF / tablets: full-screen, dark,
// high contrast, huge buttons, audible + haptic + colour feedback, blocking
// error banners with a big OK button.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, errorMessage, NetworkError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { OfflineBanner } from '../components/OfflineBanner';
import { feedback } from '../lib/feedback';
import { cls } from '../lib/format';

interface WmError {
  title: string;
  message: string;
  details?: string;
  code?: string;
  requestId?: string;
}
interface WmFeedback {
  ok: (msg?: string) => void;
  warn: (msg?: string) => void;
  /** show a blocking red banner; returns a promise resolved when the operator presses OK */
  error: (e: unknown, title?: string) => void;
  /** map any thrown error to a blocking banner and sounds */
  fail: (e: unknown) => void;
  clearError: () => void;
  error$: WmError | null;
}
const Ctx = createContext<WmFeedback | null>(null);

export function useWm(): WmFeedback {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWm outside WmShell');
  return v;
}

function describe(e: unknown): WmError {
  if (e instanceof ApiError) {
    const d = e.details as Record<string, unknown> | undefined;
    let details = '';
    if (d && typeof d === 'object') {
      if (typeof d.expected === 'string' || typeof d.scanned === 'string') details = `Esperado: ${String(d.expected ?? '?')} · Escaneado: ${String(d.scanned ?? '?')}`;
      else if (typeof d.hint === 'string') details = d.hint;
      else if (Array.isArray(d.blocking_reasons)) details = (d.blocking_reasons as string[]).join('\n');
      else if (Array.isArray(d.reasons)) details = (d.reasons as string[]).join('\n');
    }
    const title = e.status === 422 ? 'OPERACIÓN RECHAZADA' : e.status === 409 ? 'CONFLICTO' : e.status === 403 ? 'SIN PERMISO' : e.status === 404 ? 'NO ENCONTRADO' : 'ERROR';
    return { title, message: e.message, details, code: e.code, requestId: e.requestId };
  }
  if (e instanceof NetworkError) return { title: 'SIN CONEXIÓN', message: e.message, details: 'La operación se reintentó automáticamente. Verifica la red y repite el escaneo.' };
  return { title: 'ERROR', message: errorMessage(e) };
}

export function WmShell({ title, children, backTo = '/wm', step, onBack }: { title: string; children: ReactNode; backTo?: string; step?: ReactNode; onBack?: () => void }) {
  const nav = useNavigate();
  const { user, logout } = useAuth();
  const [flash, setFlash] = useState<'ok' | 'err' | null>(null);
  const [toast, setToast] = useState<{ tone: 'ok' | 'warn'; msg: string } | null>(null);
  const [error, setError] = useState<WmError | null>(null);

  const doFlash = useCallback((kind: 'ok' | 'err') => {
    setFlash(kind);
    setTimeout(() => setFlash(null), 320);
  }, []);
  const ok = useCallback(
    (msg?: string) => {
      feedback.ok();
      doFlash('ok');
      if (msg) {
        setToast({ tone: 'ok', msg });
        setTimeout(() => setToast(null), 1800);
      }
    },
    [doFlash],
  );
  const warn = useCallback((msg?: string) => {
    feedback.warn();
    if (msg) {
      setToast({ tone: 'warn', msg });
      setTimeout(() => setToast(null), 2500);
    }
  }, []);
  const showError = useCallback(
    (e: unknown, title?: string) => {
      feedback.error();
      doFlash('err');
      const d = describe(e);
      setError(title ? { ...d, title } : d);
    },
    [doFlash],
  );
  const value = useMemo<WmFeedback>(() => ({ ok, warn, error: showError, fail: showError, clearError: () => setError(null), error$: error }), [ok, warn, showError, error]);

  return (
    <Ctx.Provider value={value}>
      <div className="flex h-screen flex-col bg-slate-950 text-white" onPointerDown={() => feedback.prime()}>
        <OfflineBanner />
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-800 bg-slate-900 px-3">
          <button
            type="button"
            onClick={() => (onBack ? onBack() : nav(backTo))}
            className="grid h-11 min-w-16 place-items-center rounded-lg bg-slate-800 px-3 text-lg font-bold active:bg-slate-700"
            aria-label="Regresar"
          >
            ◀ ATRÁS
          </button>
          <h1 className="flex-1 truncate text-center text-lg font-black uppercase tracking-wide">{title}</h1>
          <button type="button" onClick={() => nav('/')} className="grid h-11 place-items-center rounded-lg bg-slate-800 px-3 text-xs font-bold text-slate-300" title="Ir a modo oficina">
            OFICINA
          </button>
          <button type="button" onClick={() => void logout().then(() => nav('/login'))} className="grid h-11 place-items-center rounded-lg bg-slate-800 px-3 text-xs font-bold text-slate-300" title={user?.username}>
            {user?.username?.slice(0, 10).toUpperCase() ?? 'SALIR'}
          </button>
        </header>
        {step && <div className="shrink-0 bg-sky-700 px-4 py-2 text-center text-base font-bold uppercase tracking-wide text-white">{step}</div>}
        <main className="thin-scroll flex-1 overflow-y-auto p-3 sm:p-4">{children}</main>

        {toast && <div className={cls('pointer-events-none fixed inset-x-0 bottom-6 mx-auto w-fit max-w-[90vw] rounded-xl px-6 py-3 text-center text-xl font-black shadow-2xl', toast.tone === 'ok' ? 'bg-emerald-500 text-emerald-950' : 'bg-amber-400 text-amber-950')}>{toast.msg}</div>}
        {flash && <div className={cls('wm-flash fixed inset-0 z-[60]', flash === 'ok' ? 'bg-emerald-500' : 'bg-rose-600')} />}

        {error && (
          <div className="fixed inset-0 z-[70] flex flex-col bg-rose-700 p-4 text-white" role="alertdialog" aria-modal="true" data-testid="wm-error">
            <div className="flex-1 overflow-y-auto">
              <div className="text-sm font-bold uppercase tracking-widest text-rose-200">{error.code ?? 'ERROR'}</div>
              <h2 className="mt-1 text-4xl font-black leading-tight">{error.title}</h2>
              <p className="mt-4 whitespace-pre-line text-2xl font-bold" data-testid="wm-error-message">
                {error.message}
              </p>
              {error.details && <p className="mt-3 whitespace-pre-line text-lg text-rose-100">{error.details}</p>}
              {error.requestId && <p className="mt-6 font-mono text-xs text-rose-200">ref {error.requestId}</p>}
            </div>
            <button type="button" autoFocus onClick={() => setError(null)} data-testid="wm-error-ok" className="h-24 w-full rounded-2xl bg-white text-4xl font-black text-rose-700 active:bg-rose-100">
              OK
            </button>
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}

/** Huge action button for warehouse mode (min 64px tall). */
export function BigButton({ children, onClick, tone = 'primary', disabled, className, testId }: { children: ReactNode; onClick?: () => void; tone?: 'primary' | 'success' | 'danger' | 'neutral' | 'warning'; disabled?: boolean; className?: string; testId?: string }) {
  const t = {
    primary: 'bg-sky-500 text-white active:bg-sky-600',
    success: 'bg-emerald-500 text-emerald-950 active:bg-emerald-600',
    danger: 'bg-rose-600 text-white active:bg-rose-700',
    warning: 'bg-amber-400 text-amber-950 active:bg-amber-500',
    neutral: 'bg-slate-700 text-white active:bg-slate-600',
  }[tone];
  return (
    <button type="button" data-testid={testId} onClick={onClick} disabled={disabled} className={cls('min-h-16 w-full rounded-2xl px-4 text-xl font-black uppercase tracking-wide shadow disabled:opacity-40', t, className)}>
      {children}
    </button>
  );
}

/** Large info block: label + huge value (e.g. target location). */
export function BigValue({ label, value, tone = 'default', mono = true, testId }: { label: string; value: ReactNode; tone?: 'default' | 'accent' | 'ok' | 'warn'; mono?: boolean; testId?: string }) {
  const t = { default: 'bg-slate-800 text-white', accent: 'bg-sky-600 text-white', ok: 'bg-emerald-600 text-white', warn: 'bg-amber-400 text-amber-950' }[tone];
  return (
    <div className={cls('rounded-2xl px-4 py-3', t)}>
      <div className="text-xs font-bold uppercase tracking-widest opacity-80">{label}</div>
      <div data-testid={testId} className={cls('mt-1 break-all text-3xl font-black leading-tight sm:text-4xl', mono && 'font-mono')}>
        {value}
      </div>
    </div>
  );
}

export function WmList<T>({ items, render, empty, onSelect, keyOf, testId }: { items: T[] | undefined; render: (i: T) => ReactNode; empty: string; onSelect: (i: T) => void; keyOf: (i: T) => string; testId?: string }) {
  if (!items) return <div className="py-10 text-center text-xl text-slate-400">Cargando…</div>;
  if (items.length === 0) return <div className="rounded-2xl border-2 border-dashed border-slate-700 py-12 text-center text-xl text-slate-400">{empty}</div>;
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      {items.map((i) => (
        <button key={keyOf(i)} type="button" onClick={() => onSelect(i)} className="min-h-16 w-full rounded-2xl bg-slate-800 px-4 py-3 text-left text-white active:bg-slate-700">
          {render(i)}
        </button>
      ))}
    </div>
  );
}
