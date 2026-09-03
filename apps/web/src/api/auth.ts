import { api } from './client';
import type { LoginResponse, Me } from './types';
import { getDeviceId } from '../lib/device';

export const authApi = {
  login: (username: string, password: string) => api.post<LoginResponse>('/auth/login', { username, password, device_id: getDeviceId() }),
  logout: () => api.post<{ ok: true }>('/auth/logout'),
  me: () => api.get<Me>('/auth/me'),
  mfaEnroll: () => api.post<{ secret: string; otpauth_uri: string }>('/auth/mfa/enroll'),
  mfaEnrollConfirm: (code: string) => api.post<{ ok: true }>('/auth/mfa/enroll/confirm', { code }),
  mfaVerify: (code: string, rememberDevice = false) => api.post<{ ok: true; device_remembered: boolean; trusted_days: number }>('/auth/mfa/verify', { code, remember_device: rememberDevice }),
  trustedDevices: () => api.get<{ id: string; device_id: string | null; user_agent: string | null; ip: string | null; created_at: string; last_used_at: string; expires_at: string }[]>('/auth/devices'),
  revokeTrustedDevice: (id: string) => api.delete<{ ok: true; revoked: number }>(`/auth/devices/${id}`),
  revokeAllTrustedDevices: () => api.delete<{ ok: true; revoked: number }>('/auth/devices'),
  changePassword: (current_password: string, new_password: string) => api.post<{ ok: true }>('/auth/password', { current_password, new_password }),
  sessions: () => api.get<{ id: string; ip: string | null; user_agent: string | null; device_id: string | null; created_at: string; last_seen_at: string; mfa_verified: boolean }[]>('/auth/sessions'),
};
