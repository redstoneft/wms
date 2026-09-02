// Scan input for handheld scanners (keyboard-wedge: types the code and sends Enter).
//  - keeps focus (refocus on blur, on route change, after every action)
//  - Enter submits; identical value within 400 ms is ignored (double-scan guard)
//  - visual "listo para escanear" state
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { cls } from '../lib/format';

export interface ScanInputProps {
  onScan: (value: string) => void | Promise<void>;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  /** when false the component does not steal focus (e.g. while a qty pad is open) */
  active?: boolean;
  autoUpper?: boolean;
  size?: 'md' | 'xl';
  className?: string;
  inputMode?: 'text' | 'numeric';
  /** clears the field after a scan (default true) */
  clearOnScan?: boolean;
  testId?: string;
}

export function ScanInput({ onScan, label, placeholder = 'Escanea…', disabled, active = true, autoUpper = false, size = 'xl', className, inputMode = 'text', clearOnScan = true, testId = 'scan-input' }: ScanInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const last = useRef<{ v: string; t: number }>({ v: '', t: 0 });
  const loc = useLocation();

  const focus = useCallback(() => {
    if (!active || disabled) return;
    const el = ref.current;
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
  }, [active, disabled]);

  // focus on mount, on route change, when (re)activated and periodically as a safety net
  useEffect(() => {
    focus();
    const id = window.setInterval(() => {
      const ae = document.activeElement;
      // do not steal focus from other inputs/buttons the operator is using
      if (!ae || ae === document.body || ae.tagName === 'CANVAS') focus();
    }, 800);
    return () => window.clearInterval(id);
  }, [focus, loc.pathname, busy]);

  const submit = useCallback(async () => {
    const raw = value.trim();
    if (!raw || busy) return;
    const v = autoUpper ? raw.toUpperCase() : raw;
    const now = Date.now();
    if (last.current.v === v && now - last.current.t < 400) {
      setValue('');
      return;
    }
    last.current = { v, t: now };
    setBusy(true);
    try {
      await onScan(v);
    } finally {
      setBusy(false);
      if (clearOnScan) setValue('');
      requestAnimationFrame(focus);
    }
  }, [value, busy, autoUpper, onScan, clearOnScan, focus]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      void submit();
    }
  };

  const big = size === 'xl';
  return (
    <div className={cls('w-full', className)}>
      {label && <div className={cls('mb-1 font-semibold uppercase tracking-wide', big ? 'text-sm text-slate-300' : 'text-xs text-slate-600')}>{label}</div>}
      <div className="relative">
        <input
          ref={ref}
          data-testid={testId}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => setTimeout(focus, 50)}
          disabled={disabled || busy}
          placeholder={placeholder}
          inputMode={inputMode}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          enterKeyHint="done"
          aria-label={label ?? 'Escanear'}
          className={cls(
            'w-full rounded-xl border-2 font-mono tracking-wider outline-none transition-colors',
            big ? 'h-20 px-5 text-3xl' : 'h-11 px-3 text-base',
            big ? 'border-sky-400 bg-slate-800 text-white placeholder:text-slate-500 focus:border-emerald-400 focus:ring-4 focus:ring-emerald-500/30' : 'border-slate-300 bg-white text-slate-900 focus:border-sky-500 focus:ring-2 focus:ring-sky-200',
            (disabled || busy) && 'opacity-60',
          )}
        />
        <div className={cls('pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-full px-2 py-0.5 text-xs font-bold', busy ? 'bg-amber-400 text-amber-950' : 'bg-emerald-500 text-emerald-950')}>{busy ? 'PROCESANDO' : 'LISTO PARA ESCANEAR'}</div>
      </div>
    </div>
  );
}
