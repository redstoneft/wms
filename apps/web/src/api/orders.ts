// orders, picking, staging, verification
import { api } from './client';
import type { AllocateResult, Order, OrderDetail, OrderListItem, Paged, PendingVerificationOrder, PickScanResult, PickTaskRow, PickTaskView, StagingRow, VerificationRow, VerificationView } from './types';

export const ordersApi = {
  list: (q?: { status?: string; q?: string; customer_id?: string; limit?: number; offset?: number }) => api.get<Paged<OrderListItem>>('/orders', q),
  get: (id: string) => api.get<OrderDetail>(`/orders/${id}`),
  create: (body: Record<string, unknown>) => api.post<Order>('/orders', body),
  accept: (id: string) => api.post<Order>(`/orders/${id}/accept`),
  allocate: (body: { order_id: string; strategy?: string; allow_partial: boolean }) => api.post<AllocateResult>('/orders/allocate', body),
  cancel: (body: { order_id: string; reason: string; authorization_id?: string }) => api.post<{ order_id: string; status: string; deallocated: string }>('/orders/cancel', body),
};

export const pickingApi = {
  tasks: (q?: { status?: string; mine?: 'true' | 'false' }) => api.get<PickTaskRow[]>('/picking/tasks', q),
  task: (id: string) => api.get<PickTaskView>(`/picking/tasks/${id}`),
  createTask: (order_id: string, assigned_to?: string) => api.post<{ task: { id: string }; lines: number; staging: { code: string } }>('/picking/tasks', { order_id, assigned_to }),
  start: (id: string) => api.post<PickTaskView>(`/picking/tasks/${id}/start`),
  /** idempotent */
  scan: (body: { pick_task_id: string; line_id: string; step: 'LOCATION' | 'LPN' | 'QTY'; scanned?: string; qty?: string; uom_code?: string }, key: string) =>
    api.postIdem<PickScanResult>('/picking/scan', body, key),
  short: (body: { pick_task_id: string; line_id: string; reason: string }) => api.post<{ line_id: string; status: string; deallocated: string; incident: string; task_completed: boolean }>('/picking/short', body),
  /** idempotent */
  stage: (body: { lpn_code: string; staging_location_barcode: string }, key: string) =>
    api.postIdem<{ lpn_code: string; location: string; order_status: string | null; movements: string[] }>('/staging/scan', body, key),
  staging: () => api.get<StagingRow[]>('/staging'),
};

export const verificationApi = {
  pendingOrders: () => api.get<PendingVerificationOrder[]>('/verifications/pending-orders'),
  get: (id: string) => api.get<VerificationView>(`/verifications/${id}`),
  list: (q?: { order_id?: string; status?: string; limit?: number }) => api.get<VerificationRow[]>('/verifications', q),
  start: (body: { order_id: string; authorization_id?: string }) => api.post<{ verification_id: string; order_number: string; lpn_count: number; same_user_authorized: boolean }>('/verifications/start', body),
  /** idempotent */
  scan: (body: { verification_id: string; lpn_code: string; barcode: string; qty: string; uom_code?: string }, key: string) =>
    api.postIdem<{ line_id: string; sku: string; lpn: string; scanned: string; complete: boolean }>('/verifications/scan', body, key),
  complete: (verification_id: string) => api.post<{ status: 'PASSED' | 'FAILED'; lines?: number; mismatches?: unknown[]; changed?: boolean }>('/verifications/complete', { verification_id }),
};
