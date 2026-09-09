import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { WM_NAV } from '../layout/nav';
import { WmShell } from './WmShell';

export default function WmHomePage() {
  const nav = useNavigate();
  const { canAny, user } = useAuth();
  const items = WM_NAV.filter((i) => canAny(...i.perms));
  const training = user?.training;
  return (
    <WmShell title="Modo almacén" backTo="/" step={`Operador: ${user?.full_name ?? ''}`}>
      {items.length === 0 ? (
        <div className="py-12 text-center text-xl text-slate-300">Tu rol no tiene operaciones de piso asignadas.</div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {training && !training.completed && (
            <button type="button" onClick={() => nav('/wm/training')} data-testid="wm-nav-training" className="col-span-2 flex min-h-28 flex-col items-center justify-center gap-2 rounded-2xl bg-amber-500 text-slate-950 active:bg-amber-400 sm:col-span-3">
              <span className="text-4xl leading-none">🎓</span>
              <span className="text-xl font-black uppercase tracking-wide">Capacitación guiada · {training.steps_done} de {training.steps_total}</span>
            </button>
          )}
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
