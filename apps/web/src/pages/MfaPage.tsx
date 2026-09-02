// MFA verify / enroll (TOTP). Enrollment renders the otpauth URI as a QR (qrcode pkg) plus the secret text.
import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { authApi } from '../api/auth';
import { errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Alert, Button, Field, Input } from '../components/ui';

export default function MfaPage() {
  const { user, mfaPending, refresh, logout } = useAuth();
  const nav = useNavigate();
  const enrollMode = !!user?.mfa_enrollment_required;
  const [secret, setSecret] = useState<{ secret: string; otpauth_uri: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enrollMode || secret) return;
    authApi
      .mfaEnroll()
      .then(async (s) => {
        setSecret(s);
        setQr(await QRCode.toDataURL(s.otpauth_uri, { width: 220, margin: 1 }));
      })
      .catch((e) => setError(errorMessage(e)));
  }, [enrollMode, secret]);

  if (user && !mfaPending) return <Navigate to="/" replace />;
  if (!user) return <Navigate to="/login" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (enrollMode) await authApi.mfaEnrollConfirm(code);
      else await authApi.mfaVerify(code);
      await refresh();
      nav('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err) === 'Invalid MFA code' ? 'Código incorrecto. Verifica la hora del dispositivo e intenta de nuevo.' : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 p-4">
      <form onSubmit={submit} className="w-full max-w-md rounded-2xl bg-white p-8 shadow-2xl">
        <h1 className="text-lg font-bold text-slate-900">{enrollMode ? 'Configurar autenticación en dos pasos' : 'Verificación en dos pasos'}</h1>
        <p className="mt-1 text-sm text-slate-500">
          Usuario <b>{user.username}</b>. {enrollMode ? 'Tu cuenta requiere MFA. Escanea el código con Google Authenticator, Authy o similar y captura el código de 6 dígitos.' : 'Captura el código de 6 dígitos de tu aplicación autenticadora.'}
        </p>
        {enrollMode && (
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
            {qr ? <img src={qr} alt="QR de enrolamiento TOTP" className="mx-auto h-56 w-56" /> : <div className="skeleton mx-auto h-56 w-56 rounded" />}
            {secret && (
              <div className="mt-3 text-center">
                <div className="text-xs uppercase tracking-wide text-slate-500">Clave manual</div>
                <code className="block break-all font-mono text-sm text-slate-800" data-testid="mfa-secret">
                  {secret.secret}
                </code>
              </div>
            )}
          </div>
        )}
        {error && (
          <Alert tone="error" className="mt-4">
            {error}
          </Alert>
        )}
        <Field label="Código de 6 dígitos" required className="mt-4">
          <Input inputMode="numeric" pattern="\d{6}" maxLength={6} autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="text-center font-mono text-2xl tracking-[0.5em]" data-testid="mfa-code" />
        </Field>
        <Button type="submit" block size="lg" className="mt-5" loading={busy} disabled={code.length !== 6}>
          {enrollMode ? 'Activar MFA' : 'Verificar'}
        </Button>
        <button type="button" className="mt-4 w-full text-center text-xs text-slate-500 underline" onClick={() => void logout().then(() => nav('/login'))}>
          Cancelar y cerrar sesión
        </button>
      </form>
    </div>
  );
}
