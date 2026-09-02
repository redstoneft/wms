import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Permission } from '@wms/shared';
import { useQueryClient } from '@tanstack/react-query';
import { authApi } from '../api/auth';
import { ApiError, setAuthHandlers } from '../api/client';
import type { Me } from '../api/types';

interface AuthState {
  user: Me | null;
  loading: boolean;
  /** MFA verification/enrollment pending for this session */
  mfaPending: boolean;
  refresh: () => Promise<Me | null>;
  login: (username: string, password: string) => Promise<{ mfa_required: boolean; mfa_enrollment_required: boolean }>;
  logout: () => Promise<void>;
  can: (...perms: Permission[]) => boolean;
  canAny: (...perms: Permission[]) => boolean;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  const refresh = useCallback(async () => {
    try {
      const me = await authApi.me();
      setUser(me);
      return me;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setAuthHandlers({
      unauthorized: () => {
        setUser(null);
        qc.clear();
      },
      mfaRequired: () => {
        setUser((u) => (u ? { ...u, mfa_pending: true } : u));
      },
    });
    void refresh();
  }, [refresh, qc]);

  const login = useCallback(
    async (username: string, password: string) => {
      const r = await authApi.login(username, password);
      const me = await authApi.me();
      setUser(me);
      setLoading(false);
      return { mfa_required: r.mfa_required, mfa_enrollment_required: r.mfa_enrollment_required };
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setUser(null);
      qc.clear();
    }
  }, [qc]);

  const value = useMemo<AuthState>(() => {
    const set = new Set<string>(user?.permissions ?? []);
    return {
      user,
      loading,
      mfaPending: !!user?.mfa_pending,
      refresh,
      login,
      logout,
      can: (...perms) => perms.every((p) => set.has(p)),
      canAny: (...perms) => perms.some((p) => set.has(p)),
    };
  }, [user, loading, refresh, login, logout]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
