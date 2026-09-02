import { api } from './client';
import type { LoginResponse, Me } from './types';
import { getDeviceId } from '../lib/device';

export const authApi = {
  login: (username: string, password: string) => api.post<LoginResponse>('/auth/login', { username, password, device_id: getDeviceId() }),
  logout: () => api.post<{ ok: true }>('/auth/logout'),
  me: () => api.get<Me>('/auth/me'),
  mfaEnroll: () => api.post<{ secret: string; otpauth_uri: string }>('/auth/mfa/enroll'),
  mfaEnrollConfirm: (code: string) => api.post<{ ok: true }>('/auth/mfa/enroll/confirm', { code }),
  mfaVerify: (code: string) => api.post<{ ok: true }>('/auth/mfa/verify', { code }),
  changePassword: (current_password: string, new_password: string) => api.post<{ ok: true }>('/auth/password', { current_password, new_password }),
  sessions: () => api.get<{ id: string; ip: string | null; user_agent: string | null; device_id: string | null; created_at: string; last_seen_at: string; mfa_verified: boolean }[]>('/auth/sessions'),
};
