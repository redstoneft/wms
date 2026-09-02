// Small, dependency-free UI kit (Tailwind classes only).
import { useEffect, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cls, es } from '../../lib/format';

// ---------- Button ----------
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success' | 'warning';
type Size = 'sm' | 'md' | 'lg' | 'xl';
const variantCls: Record<Variant, string> = {
  primary: 'bg-sky-600 text-white hover:bg-sky-700 disabled:bg-sky-300',
  secondary: 'bg-white text-slate-800 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400',
  danger: 'bg-rose-600 text-white hover:bg-rose-700 disabled:bg-rose-300',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-300',
  warning: 'bg-amber-500 text-white hover:bg-amber-600 disabled:bg-amber-300',
  ghost: 'bg-transparent text-slate-700 hover:bg-slate-100 disabled:text-slate-400',
};
const sizeCls: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-5 text-base',
  xl: 'min-h-16 px-6 text-xl font-bold',
};
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  block?: boolean;
}
export function Button({ variant = 'primary', size = 'md', loading, block, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={cls('inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors select-none disabled:cursor-not-allowed', variantCls[variant], sizeCls[size], block && 'w-full', className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Spinner size={size === 'xl' ? 24 : 16} />}
      {children}
    </button>
  );
}

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg className={cls('animate-spin', className)} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

// ---------- Form fields ----------
export function Field({ label, hint, error, children, required, className }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; required?: boolean; className?: string }) {
  return (
    <label className={cls('block text-sm', className)}>
      <span className="mb-1 block font-medium text-slate-700">
        {label}
        {required && <span className="text-rose-600"> *</span>}
      </span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-rose-600">{error}</span>}
    </label>
  );
}
const inputBase = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-500 focus:ring-2 focus:ring-sky-200 disabled:bg-slate-100';
export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cls(inputBase, className)} {...rest} />;
}
export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cls(inputBase, 'min-h-20', className)} {...rest} />;
}
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cls(inputBase, 'pr-8', className)} {...rest}>
      {children}
    </select>
  );
}
export function Checkbox({ label, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm text-slate-700">
      <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500" {...rest} />
      {label}
    </label>
  );
}

// ---------- Badges ----------
const statusColor: Record<string, string> = {
  // generic positive/neutral/negative mapping
  AVAILABLE: 'bg-emerald-100 text-emerald-800',
  FREE: 'bg-emerald-100 text-emerald-800',
  COMPLETE: 'bg-emerald-100 text-emerald-800',
  COMPLETED: 'bg-emerald-100 text-emerald-800',
  PASSED: 'bg-emerald-100 text-emerald-800',
  RELEASED: 'bg-emerald-100 text-emerald-800',
  APPROVED: 'bg-emerald-100 text-emerald-800',
  APPLIED: 'bg-emerald-100 text-emerald-800',
  VALIDATED: 'bg-emerald-100 text-emerald-800',
  MATCHED: 'bg-emerald-100 text-emerald-800',
  ACTIVE: 'bg-emerald-100 text-emerald-800',
  SENT: 'bg-emerald-100 text-emerald-800',
  RESTOCK: 'bg-emerald-100 text-emerald-800',
  SHIPPED: 'bg-slate-200 text-slate-700',
  DEPARTED: 'bg-slate-200 text-slate-700',
  CLOSED: 'bg-slate-200 text-slate-700',
  CONSUMED: 'bg-slate-200 text-slate-700',
  CANCELLED: 'bg-slate-200 text-slate-500 line-through',
  REVOKED: 'bg-slate-200 text-slate-500',
  ALLOCATED: 'bg-violet-100 text-violet-800',
  RESERVED: 'bg-violet-100 text-violet-800',
  PARTIALLY_ALLOCATED: 'bg-violet-100 text-violet-800',
  PICKING: 'bg-sky-100 text-sky-800',
  PICKED: 'bg-sky-100 text-sky-800',
  IN_PROGRESS: 'bg-sky-100 text-sky-800',
  IN_TRANSIT: 'bg-sky-100 text-sky-800',
  IN_TRANSFER: 'bg-sky-100 text-sky-800',
  LOADING: 'bg-sky-100 text-sky-800',
  OCCUPIED: 'bg-sky-100 text-sky-800',
  RECEIVING: 'bg-sky-100 text-sky-800',
  UNLOADING: 'bg-sky-100 text-sky-800',
  STAGING: 'bg-indigo-100 text-indigo-800',
  STAGED: 'bg-indigo-100 text-indigo-800',
  VERIFIED: 'bg-teal-100 text-teal-800',
  LOADED: 'bg-teal-100 text-teal-800',
  PARTIAL: 'bg-amber-100 text-amber-800',
  PENDING: 'bg-amber-100 text-amber-800',
  OPEN: 'bg-amber-100 text-amber-800',
  IMPORTED: 'bg-amber-100 text-amber-800',
  SCHEDULED: 'bg-amber-100 text-amber-800',
  ARRIVED: 'bg-amber-100 text-amber-800',
  UNLOADED: 'bg-amber-100 text-amber-800',
  RECOUNT: 'bg-amber-100 text-amber-800',
  PENDING_APPROVAL: 'bg-amber-100 text-amber-800',
  OVER: 'bg-amber-100 text-amber-800',
  MEDIUM: 'bg-amber-100 text-amber-800',
  IN_REVIEW: 'bg-amber-100 text-amber-800',
  QUEUED: 'bg-amber-100 text-amber-800',
  QUARANTINE: 'bg-orange-100 text-orange-800',
  INSPECTING: 'bg-orange-100 text-orange-800',
  HIGH: 'bg-orange-100 text-orange-800',
  BLOCKED: 'bg-rose-100 text-rose-800',
  DAMAGED: 'bg-rose-100 text-rose-800',
  FAILED: 'bg-rose-100 text-rose-800',
  REJECTED: 'bg-rose-100 text-rose-800',
  WITH_INCIDENT: 'bg-rose-100 text-rose-800',
  SHORT: 'bg-rose-100 text-rose-800',
  CRITICAL: 'bg-rose-600 text-white',
  VARIANCE: 'bg-rose-100 text-rose-800',
  SCRAP: 'bg-rose-100 text-rose-800',
  LOW: 'bg-slate-100 text-slate-700',
  RESOLVED: 'bg-emerald-100 text-emerald-800',
  CONSUMED_AUTH: 'bg-slate-200 text-slate-700',
};
export function StatusChip({ status, className }: { status: string | null | undefined; className?: string }) {
  if (!status) return <span className="text-slate-400">—</span>;
  return <span className={cls('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap', statusColor[status] ?? 'bg-slate-100 text-slate-700', className)}>{es(status)}</span>;
}
export function Badge({ children, tone = 'slate', className }: { children: ReactNode; tone?: 'slate' | 'sky' | 'emerald' | 'amber' | 'rose' | 'violet'; className?: string }) {
  const t: Record<string, string> = {
    slate: 'bg-slate-100 text-slate-700',
    sky: 'bg-sky-100 text-sky-800',
    emerald: 'bg-emerald-100 text-emerald-800',
    amber: 'bg-amber-100 text-amber-800',
    rose: 'bg-rose-100 text-rose-800',
    violet: 'bg-violet-100 text-violet-800',
  };
  return <span className={cls('inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium', t[tone], className)}>{children}</span>;
}

// ---------- Layout bits ----------
export function Card({ title, actions, children, className, padded = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cls('rounded-xl border border-slate-200 bg-white shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-4' : ''}>{children}</div>
    </section>
  );
}
export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
export function KV({ label, children, mono }: { label: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={cls('truncate text-sm text-slate-900', mono && 'font-mono')}>{children ?? '—'}</dd>
    </div>
  );
}
export function Stat({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: 'default' | 'warn' | 'error' | 'ok' }) {
  const t = { default: 'text-slate-900', warn: 'text-amber-600', error: 'text-rose-600', ok: 'text-emerald-600' }[tone ?? 'default'];
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={cls('mt-1 text-2xl font-bold tabular-nums', t)}>{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

// ---------- Table ----------
export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  className?: string;
  align?: 'left' | 'right' | 'center';
}
export function Table<T>({ columns, rows, rowKey, onRowClick, empty, loading, dense, selectedKey }: { columns: Column<T>[]; rows: T[] | undefined; rowKey: (r: T) => string; onRowClick?: (r: T) => void; empty?: ReactNode; loading?: boolean; dense?: boolean; selectedKey?: string | null }) {
  return (
    <div className="thin-scroll overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full min-w-max text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={cls('px-3 py-2 font-semibold', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center', c.className)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {loading && !rows && (
            <>
              {[0, 1, 2, 3, 4].map((i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c.key} className="px-3 py-2">
                      <div className="skeleton h-4 w-24 rounded" />
                    </td>
                  ))}
                </tr>
              ))}
            </>
          )}
          {rows && rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-10 text-center text-slate-500">
                {empty ?? 'Sin registros'}
              </td>
            </tr>
          )}
          {rows?.map((r) => {
            const k = rowKey(r);
            return (
              <tr key={k} onClick={onRowClick ? () => onRowClick(r) : undefined} className={cls(onRowClick && 'cursor-pointer hover:bg-sky-50', selectedKey === k && 'bg-sky-50')}>
                {columns.map((c) => (
                  <td key={c.key} className={cls('px-3', dense ? 'py-1.5' : 'py-2', c.align === 'right' && 'text-right tabular-nums', c.align === 'center' && 'text-center', c.className)}>
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Empty / Skeleton / Alert ----------
export function EmptyState({ title, hint, action }: { title: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <div className="text-base font-semibold text-slate-700">{title}</div>
      {hint && <div className="mt-1 max-w-md text-sm text-slate-500">{hint}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
export function Skeleton({ className }: { className?: string }) {
  return <div className={cls('skeleton rounded-lg', className ?? 'h-6 w-full')} />;
}
export function Alert({ tone = 'info', title, children, className }: { tone?: 'info' | 'warn' | 'error' | 'success'; title?: ReactNode; children?: ReactNode; className?: string }) {
  const t = {
    info: 'border-sky-200 bg-sky-50 text-sky-900',
    warn: 'border-amber-200 bg-amber-50 text-amber-900',
    error: 'border-rose-200 bg-rose-50 text-rose-900',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  }[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cls('rounded-lg border px-4 py-3 text-sm', t, className)}>
      {title && <div className="font-semibold">{title}</div>}
      {children && <div className={title ? 'mt-1' : ''}>{children}</div>}
    </div>
  );
}

// ---------- Tabs ----------
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: ReactNode; count?: number }[]; value: T; onChange: (k: T) => void }) {
  return (
    <div role="tablist" className="mb-4 flex flex-wrap gap-1 border-b border-slate-200">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          type="button"
          aria-selected={value === t.key}
          onClick={() => onChange(t.key)}
          className={cls('-mb-px border-b-2 px-3 py-2 text-sm font-medium', value === t.key ? 'border-sky-600 text-sky-700' : 'border-transparent text-slate-500 hover:text-slate-700')}
        >
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 text-xs text-slate-600">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------- Drawer / Modal ----------
export function Drawer({ open, onClose, title, children, width = 'max-w-xl', footer }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; width?: string; footer?: ReactNode }) {
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <div className={cls('relative flex h-full w-full flex-col bg-white shadow-2xl', width)}>
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="rounded-md p-1 text-slate-500 hover:bg-slate-100">
            ✕
          </button>
        </header>
        <div className="thin-scroll flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="border-t border-slate-200 px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}
export function Modal({ open, onClose, title, children, footer, size = 'max-w-lg' }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; size?: string }) {
  useEscape(open, onClose);
  const id = useId();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby={id}>
      <div className="absolute inset-0 bg-slate-900/50" onClick={onClose} />
      <div className={cls('relative w-full rounded-xl bg-white shadow-2xl', size)}>
        {title && (
          <header className="border-b border-slate-200 px-5 py-3">
            <h2 id={id} className="text-base font-semibold text-slate-900">
              {title}
            </h2>
          </header>
        )}
        <div className="thin-scroll max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}
export function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel = 'Confirmar', danger, loading, children }: { open: boolean; onClose: () => void; onConfirm: () => void; title: ReactNode; message?: ReactNode; confirmLabel?: string; danger?: boolean; loading?: boolean; children?: ReactNode }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancelar
          </Button>
          <Button autoFocus variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {message && <p className="text-sm text-slate-700">{message}</p>}
      {children}
    </Modal>
  );
}

function useEscape(active: boolean, onClose: () => void) {
  useEffect(() => {
    if (!active) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [active, onClose]);
}

// ---------- Pagination ----------
export function Pagination({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange: (offset: number) => void }) {
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages <= 1) return null;
  return (
    <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
      <span>
        {total} registros · página {page} de {pages}
      </span>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onChange(Math.max(0, offset - limit))}>
          Anterior
        </Button>
        <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => onChange(offset + limit)}>
          Siguiente
        </Button>
      </div>
    </div>
  );
}

export function ProgressBar({ value, max, tone = 'sky', label }: { value: number; max: number; tone?: 'sky' | 'emerald' | 'amber' | 'rose'; label?: ReactNode }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const t = { sky: 'bg-sky-500', emerald: 'bg-emerald-500', amber: 'bg-amber-500', rose: 'bg-rose-500' }[tone];
  return (
    <div>
      {label && <div className="mb-1 flex justify-between text-xs text-slate-600">{label}</div>}
      <div className="h-3 w-full overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuenow={value} aria-valuemax={max}>
        <div className={cls('h-full transition-all', t)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
