import { useOnline } from '../lib/online';

export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div role="alert" className="flex items-center justify-center gap-2 bg-rose-600 px-4 py-2 text-center text-sm font-semibold text-white">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-white" />
      SIN CONEXIÓN — las operaciones se reintentarán automáticamente al reconectar
    </div>
  );
}

export function OnlineDot() {
  const online = useOnline();
  return (
    <span className="inline-flex items-center gap-1.5 text-xs" title={online ? 'Conectado' : 'Sin conexión'}>
      <span className={online ? 'h-2.5 w-2.5 rounded-full bg-emerald-500' : 'h-2.5 w-2.5 animate-pulse rounded-full bg-rose-500'} />
      <span className="hidden sm:inline">{online ? 'En línea' : 'Sin conexión'}</span>
    </span>
  );
}
