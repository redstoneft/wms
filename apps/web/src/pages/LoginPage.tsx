import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Alert, Button, Field, Input } from '../components/ui';
import { OfflineBanner } from '../components/OfflineBanner';

export default function LoginPage() {
  const { login, user, loading, mfaPending } = useAuth();
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!loading && user && !mfaPending) return <Navigate to={loc.state?.from ?? '/'} replace />;
  if (!loading && user && mfaPending) return <Navigate to="/mfa" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await login(username.trim(), password);
      if (r.mfa_required) nav('/mfa', { replace: true });
      else nav(loc.state?.from ?? '/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 423) setError('Cuenta bloqueada temporalmente por intentos fallidos. Intenta más tarde o pide a un administrador desbloquearla.');
      else if (err instanceof ApiError && err.status === 401) setError('Usuario o contraseña incorrectos.');
      else if (err instanceof ApiError && err.status === 429) setError('Demasiados intentos. Espera un minuto.');
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-slate-900">
      <OfflineBanner />
      <div className="flex flex-1 items-center justify-center p-4">
        <form onSubmit={submit} className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-2xl" aria-label="Iniciar sesión">
          <div className="mb-6 flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-lg bg-sky-500 text-lg font-black text-slate-900">W</span>
            <div>
              <h1 className="text-lg font-bold text-slate-900">WMS CEDIS</h1>
              <p className="text-xs text-slate-500">Sistema de administración de almacén</p>
            </div>
          </div>
          {error && (
            <Alert tone="error" className="mb-4">
              {error}
            </Alert>
          )}
          <Field label="Usuario" required>
            <Input name="username" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} required autoCapitalize="none" data-testid="login-username" />
          </Field>
          <Field label="Contraseña" required className="mt-3">
            <Input name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required data-testid="login-password" />
          </Field>
          <Button type="submit" block size="lg" className="mt-6" loading={busy} data-testid="login-submit">
            Entrar
          </Button>
          <p className="mt-4 text-center text-xs text-slate-400">La sesión se protege con cookie segura. Los administradores requieren MFA (TOTP).</p>
        </form>
      </div>
    </div>
  );
}
