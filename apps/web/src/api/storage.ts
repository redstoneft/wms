// put-away, transfers, replenishment, cycle counts
import { api } from './client';
import type { CountTask, CountTaskView, PutawayConfirmResult, PutawayStartResult, PutawayTaskRow, ReplenRule, ReplenTaskRow, TransferRow, TransferStartResult } from './types';

export const putawayApi = {
  tasks: (status?: string) => api.get<PutawayTaskRow[]>('/putaway/tasks', { status }),
  task: (id: string) => api.get<Record<string, unknown>>(`/putaway/tasks/${id}`),
  suggest: (lpn_code: string) => api.post<Record<string, unknown>>('/putaway/suggest', { lpn_code }),
  start: (lpn_code: string) => api.post<PutawayStartResult>('/putaway/start', { lpn_code }),
  /** idempotent */
  confirm: (body: { task_id: string; lpn_code: string; location_barcode: string; override_reason?: string; authorization_id?: string }, key: string) =>
    api.postIdem<PutawayConfirmResult>('/putaway/confirm', body, key),
  resuggest: (id: string) => api.post<{ task: unknown; explanation: unknown }>(`/putaway/tasks/${id}/resuggest`),
  cancel: (id: string, reason: string) => api.post<{ ok: true }>(`/putaway/tasks/${id}/cancel`, { reason }),
};

export const transfersApi = {
  list: (status = 'IN_TRANSIT') => api.get<TransferRow[]>('/transfers', { status }),
  /** idempotent */
  start: (body: { lpn_code: string; to_location_barcode: string; reason?: string }, key: string) => api.postIdem<TransferStartResult>('/transfers/start', body, key),
  /** idempotent */
  complete: (body: { transfer_id: string; lpn_code: string; location_barcode: string }, key: string) =>
    api.postIdem<{ transfer_id: string; lpn_code: string; location: string; movements: string[] }>('/transfers/complete', body, key),
  cancel: (id: string, reason: string) => api.post<{ ok: true; lpn_code: string }>(`/transfers/${id}/cancel`, { reason }),
};

export const replenApi = {
  rules: () => api.get<ReplenRule[]>('/replenishment/rules'),
  upsertRule: (body: { sku_code: string; pick_location_barcode: string; min_qty: string; max_qty: string }) => api.post<ReplenRule>('/replenishment/rules', body),
  deleteRule: (id: string) => api.delete<{ ok: true }>(`/replenishment/rules/${id}`),
  tasks: (status = 'PENDING,IN_PROGRESS') => api.get<ReplenTaskRow[]>('/replenishment/tasks', { status }),
  evaluate: () => api.post<{ created: number }>('/replenishment/evaluate'),
  start: (id: string) => api.post<{ task_id: string; transfer: { id: string }; lpn_code: string; to_location: { id: string; code: string; barcode: string } }>(`/replenishment/tasks/${id}/start`),
};

export const countsApi = {
  list: (status?: string, limit = 100) => api.get<CountTask[]>('/counts', { status, limit }),
  get: (id: string) => api.get<CountTaskView>(`/counts/${id}`),
  create: (body: Record<string, unknown>) => api.post<CountTask & { lines: number; locations: number }>('/counts', body),
  /** idempotent */
  submit: (body: { count_task_id: string; location_barcode: string; lpn_code?: string; barcode: string; qty: string; uom_code?: string }, key: string) =>
    api.postIdem<{ line_id: string; status: string; sku: string; qty: string }>('/counts/submit', body, key),
  finish: (id: string) => api.post<{ status: string; variances: number; lines?: number }>(`/counts/${id}/finish`),
  approve: (body: { count_task_id: string; decision: 'APPROVE' | 'REJECT'; reason: string }) =>
    api.post<{ status: string; adjusted: number; skipped: { line_id: string; reason: string }[]; incident_id?: string }>('/counts/approve', body),
};
