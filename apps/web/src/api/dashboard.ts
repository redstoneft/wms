import { api } from './client';
import type { Dashboard, Kpis } from './types';

export const dashboardApi = {
  get: () => api.get<Dashboard>('/dashboard'),
  kpis: (q?: { from?: string; to?: string }) => api.get<Kpis>('/kpis', q),
};
