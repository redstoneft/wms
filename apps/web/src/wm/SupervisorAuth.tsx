// Supervisor authorization on the operator's handheld, without copying IDs:
//  - the supervisor types their own username/password (+ MFA code if enrolled) right here → an authorization is created
//    for this exception and the caller continues with its id;
//  - if the logged-in user already holds the override permission, they approve on their own authority with a reason.
import { useState } from 'react';
import type { Permission } from '@wms/shared';
import { adminApi } from '../api/admin';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { BigButton, useWm } from './WmShell';

interface Props {
  title: string;
  exceptionType: string;
  entityType: string;
  entityId: string;
  /** permission that lets the current user approve on their own authority */
  selfPermission?: Permission;
  busy?: boolean;
  onAuthorized: (authorizationId: string, reason: string) => void | Promise<void>;
  onSelf?: (reason: string) => void | Promise<void>;
  onCancel?: () => void;
}

export function SupervisorAuth({ title, exceptionType, entityType, entityId, selfPermission, busy, onAuthorized, onSelf, onCancel }: Props) {
  const wm = useWm();
  const { can } = useAuth();
  const [reason, setReason] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsMfa, setNeedsMfa] = useState(false);
  const [working, setWorking] = useState(false);
  const [manualId, setManualId] = useState('');
  const canSelf = !!selfPermission && can(selfPermission) && !!onSelf;
  const reasonOk = reason.trim().length >= 3;

  const authorize = async () => {
    setWorking(true);
    try {
      const r = await adminApi.inlineAuthorize({ username: username.trim(), password, code: code.trim() || undefined, exception_type: exceptionType, entity_type: entityType, entity_id: entityId, reason: reason.trim() });
      wm.ok(`AUTORIZADO POR ${r.supervisor.toUpperCase()}`);
      setPassword('');
      setCode('');
      await onAuthorized(r.id, reason.trim());
    } catch (e) {
      if (e instanceof ApiError && e.code === 'MFA_CODE_REQUIRED') {
        setNeedsMfa(true);
        wm.warn('ESTE SUPERVISOR USA CÓDIGO MFA: CAPTÚRALO');
      } else wm.fail(e);
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="mt-3 rounded-2xl border-2 border-amber-400 bg-slate-900 p-3" data-testid="supervisor-auth">
      <div className="text-lg font-black text-amber-300">{title}</div>
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motivo (obligatorio)" className="mt-2 h-14 w-full rounded-xl bg-slate-800 px-3 text-lg text-white" data-testid="auth-reason" />
      {canSelf && (
        <BigButton tone="warning" className="mt-2" disabled={busy || working || !reasonOk} onClick={() => void onSelf!(reason.trim())} testId="auth-self">
          Autorizar yo mismo (tengo permiso de supervisor)
        </BigButton>
      )}
      <div className="mt-3 text-sm font-semibold uppercase tracking-wide text-slate-300">{canSelf ? 'O que autorice otro supervisor aquí mismo' : 'El supervisor autoriza aquí mismo con su usuario'}</div>
      <div className="mt-1 grid gap-2">
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Usuario del supervisor" autoCapitalize="none" autoCorrect="off" className="h-14 w-full rounded-xl bg-slate-800 px-3 text-lg text-white" data-testid="auth-username" />
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Contraseña del supervisor" className="h-14 w-full rounded-xl bg-slate-800 px-3 text-lg text-white" data-testid="auth-password" />
        {needsMfa && <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" placeholder="Código de verificación (6 dígitos)" className="h-14 w-full rounded-xl bg-slate-800 px-3 font-mono text-lg text-white" data-testid="auth-code" />}
      </div>
      <BigButton tone="warning" className="mt-2" disabled={busy || working || !reasonOk || !username.trim() || !password} onClick={authorize} testId="auth-submit">
        Autorizar con usuario de supervisor
      </BigButton>
      <details className="mt-2 text-xs text-slate-400">
        <summary>Tengo un ID de autorización de oficina</summary>
        <div className="mt-1 flex gap-2">
          <input value={manualId} onChange={(e) => setManualId(e.target.value)} placeholder="ID (UUID)" className="h-12 w-full rounded-xl bg-slate-800 px-3 font-mono text-white" />
          <BigButton tone="neutral" disabled={busy || working || manualId.trim().length < 36} onClick={() => void onAuthorized(manualId.trim(), reason.trim())}>
            Usar
          </BigButton>
        </div>
      </details>
      {onCancel && (
        <BigButton tone="neutral" className="mt-2" onClick={onCancel}>
          Cancelar
        </BigButton>
      )}
    </div>
  );
}
