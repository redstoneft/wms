import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { cls } from '../lib/format';
import { errorMessage } from '../api/client';

export type ToastTone = 'info' | 'success' | 'error' | 'warn';
interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
}
interface ToastApi {
  push: (tone: ToastTone, title: string, body?: string) => void;
  success: (title: string, body?: string) => void;
  error: (title: string, e?: unknown) => void;
  info: (title: string, body?: string) => void;
  warn: (title: string, body?: string) => void;
}
const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((tone: ToastTone, title: string, body?: string) => {
    const id = ++seq.current;
    setItems((xs) => [...xs.slice(-4), { id, tone, title, body }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), tone === 'error' ? 8000 : 4000);
  }, []);
  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (t, b) => push('success', t, b),
      error: (t, e) => push('error', t, e === undefined ? undefined : errorMessage(e)),
      info: (t, b) => push('info', t, b),
      warn: (t, b) => push('warn', t, b),
    }),
    [push],
  );
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed right-3 top-3 z-[100] flex w-80 max-w-[90vw] flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            className={cls(
              'pointer-events-auto rounded-lg border px-4 py-3 text-sm shadow-lg',
              t.tone === 'success' && 'border-emerald-300 bg-emerald-50 text-emerald-900',
              t.tone === 'error' && 'border-rose-300 bg-rose-50 text-rose-900',
              t.tone === 'warn' && 'border-amber-300 bg-amber-50 text-amber-900',
              t.tone === 'info' && 'border-sky-300 bg-sky-50 text-sky-900',
            )}
            onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))}
          >
            <div className="font-semibold">{t.title}</div>
            {t.body && <div className="mt-0.5 break-words opacity-90">{t.body}</div>}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useToast outside ToastProvider');
  return v;
}
