// Office-mode shell: left sidebar (desktop) / bottom nav (tablet), top bar with
// user, connectivity indicator and warehouse-mode toggle.
import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { OfflineBanner, OnlineDot } from '../components/OfflineBanner';
import { cls } from '../lib/format';
import { NAV, WM_NAV } from './nav';

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout, canAny } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const groups = NAV.map((g) => ({ ...g, items: g.items.filter((i) => i.perms.length === 0 || canAny(...i.perms)) })).filter((g) => g.items.length > 0);
  const wmItems = WM_NAV.filter((i) => canAny(...i.perms));

  return (
    <div className="flex h-full min-h-screen bg-slate-100">
      {/* sidebar (desktop) */}
      <aside className={cls('fixed inset-y-0 left-0 z-30 w-60 shrink-0 flex-col border-r border-slate-800 bg-slate-900 text-slate-200 transition-transform lg:static lg:flex lg:translate-x-0', open ? 'flex translate-x-0' : 'hidden -translate-x-full lg:flex')}>
        <div className="flex h-14 items-center gap-2 border-b border-slate-800 px-4">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-sky-500 font-black text-slate-900">W</span>
          <div className="leading-tight">
            <div className="text-sm font-bold text-white">WMS CEDIS</div>
            <div className="text-[10px] uppercase tracking-widest text-slate-400">Digital twin</div>
          </div>
        </div>
        <nav className="thin-scroll flex-1 overflow-y-auto px-2 py-3 text-sm">
          {groups.map((g) => (
            <div key={g.label} className="mb-3">
              <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-slate-500">{g.label}</div>
              {g.items.map((i) => (
                <NavLink key={i.to} to={i.to} end={i.to === '/'} onClick={() => setOpen(false)} className={({ isActive }) => cls('flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-slate-800', isActive && 'bg-sky-600/20 text-sky-300')}>
                  <span className="w-5 text-center text-base leading-none">{i.icon}</span>
                  {i.label}
                </NavLink>
              ))}
            </div>
          ))}
          {wmItems.length > 0 && (
            <div className="mb-3">
              <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-slate-500">Modo almacén (RF)</div>
              <NavLink to="/wm" onClick={() => setOpen(false)} className={({ isActive }) => cls('flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-slate-800', isActive && 'bg-emerald-600/20 text-emerald-300')}>
                <span className="w-5 text-center text-base leading-none">▮</span>
                Abrir modo almacén
              </NavLink>
            </div>
          )}
        </nav>
        <div className="border-t border-slate-800 p-3 text-xs">
          <div className="truncate font-semibold text-white">{user?.full_name}</div>
          <div className="truncate text-slate-400">
            {user?.username} · {user?.roles.join(', ')}
          </div>
          <div className="mt-2 flex gap-2">
            <button type="button" className="rounded bg-slate-800 px-2 py-1 hover:bg-slate-700" onClick={() => nav('/account')}>
              Mi cuenta
            </button>
            <button type="button" className="rounded bg-slate-800 px-2 py-1 hover:bg-slate-700" onClick={() => void logout().then(() => nav('/login'))}>
              Salir
            </button>
          </div>
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-20 bg-slate-900/50 lg:hidden" onClick={() => setOpen(false)} />}

      <div className="flex min-w-0 flex-1 flex-col">
        <OfflineBanner />
        <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur">
          <button type="button" className="rounded-md p-2 text-slate-700 hover:bg-slate-100 lg:hidden" aria-label="Menú" onClick={() => setOpen(true)}>
            ☰
          </button>
          <div className="flex-1" />
          <OnlineDot />
          {wmItems.length > 0 && (
            <button type="button" onClick={() => nav('/wm')} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700" title="Cambiar a modo almacén (pantalla completa, escáner)">
              MODO ALMACÉN
            </button>
          )}
          <div className="hidden items-center gap-2 text-sm sm:flex">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-slate-800 text-xs font-bold text-white">{user?.full_name?.slice(0, 1).toUpperCase()}</span>
            <span className="text-slate-700">{user?.full_name}</span>
          </div>
        </header>
        <main className="flex-1 p-4 pb-20 lg:p-6 lg:pb-6">{children}</main>
        {/* bottom nav (tablet / small screens) */}
        <nav className="fixed inset-x-0 bottom-0 z-10 flex justify-around border-t border-slate-200 bg-white py-1 text-[11px] lg:hidden">
          {groups
            .flatMap((g) => g.items)
            .slice(0, 5)
            .map((i) => (
              <NavLink key={i.to} to={i.to} end={i.to === '/'} className={({ isActive }) => cls('flex flex-col items-center px-2 py-1 text-slate-600', isActive && 'text-sky-700')}>
                <span className="text-lg leading-none">{i.icon}</span>
                {i.label}
              </NavLink>
            ))}
        </nav>
      </div>
    </div>
  );
}
