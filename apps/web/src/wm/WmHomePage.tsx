import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { WM_NAV } from '../layout/nav';
import { WmShell } from './WmShell';

export default function WmHomePage() {
  const nav = useNavigate();
  const { canAny, user } = useAuth();
  const items = WM_NAV.filter((i) => canAny(...i.perms));
  return (
    <WmShell title="Modo almacén" backTo="/" step={`Operador: ${user?.full_name ?? ''}`}>
      {items.length === 0 ? (
        <div className="py-12 text-center text-xl text-slate-300">Tu rol no tiene operaciones de piso asignadas.</div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {items.map((i) => (
            <button key={i.to} type="button" onClick={() => nav(i.to)} data-testid={`wm-nav-${i.to.split('/').pop()}`} className="flex min-h-28 flex-col items-center justify-center gap-2 rounded-2xl bg-slate-800 text-white active:bg-sky-700">
              <span className="text-4xl leading-none">{i.icon}</span>
              <span className="text-xl font-black uppercase tracking-wide">{i.label}</span>
            </button>
          ))}
        </div>
      )}
    </WmShell>
  );
}
