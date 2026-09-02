// users, roles, settings, authorizations, audit, slotting rules
import { api } from './client';
import type { AuditRow, Authorization, DirectoryUser, RoleRow, Settings, SlottingRule, UserRow } from './types';

export const adminApi = {
  users: () => api.get<UserRow[]>('/users'),
  directory: () => api.get<DirectoryUser[]>('/users/directory'),
  roles: () => api.get<RoleRow[]>('/roles'),
  createUser: (body: Record<string, unknown>) => api.post<{ id: string; username: string }>('/users', body),
  updateUser: (id: string, body: Record<string, unknown>) => api.patch<{ ok: true }>(`/users/${id}`, body),
  unlockUser: (id: string) => api.post<{ ok: true }>(`/users/${id}/unlock`),
  resetMfa: (id: string) => api.post<{ ok: true }>(`/users/${id}/mfa/reset`),
  settings: () => api.get<Settings>('/settings'),
  updateSettings: (body: Partial<Settings>) => api.put<Settings>('/settings', body),
  authorizations: (q?: { entity_type?: string; entity_id?: string; status?: string }) => api.get<Authorization[]>('/authorizations', q),
  authorize: (body: { exception_type: string; entity_type: string; entity_id: string; requested_by?: string; reason: string }) => api.post<Authorization>('/authorizations', body),
  revokeAuthorization: (id: string) => api.post<Authorization>(`/authorizations/${id}/revoke`),
  audit: (q?: { entity_type?: string; entity_id?: string; user_id?: string; action?: string; from?: string; to?: string; limit?: number; before_id?: string }) =>
    api.get<{ items: AuditRow[]; next_before_id: string | null }>('/audit', q),
  slottingRules: () => api.get<SlottingRule[]>('/slotting/rules'),
  createSlottingRule: (body: Record<string, unknown>) => api.post<SlottingRule>('/slotting/rules', body),
  deleteSlottingRule: (id: string) => api.delete<{ ok: true }>(`/slotting/rules/${id}`),
};
