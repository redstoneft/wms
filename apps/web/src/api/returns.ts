import { api } from './client';
import type { QuickReturnResult, Return } from './types';

export const returnsApi = {
  list: (q?: { status?: string; limit?: number }) => api.get<Return[]>('/returns', q),
  get: (id: string) => api.get<Return>(`/returns/${id}`),
  create: (body: Record<string, unknown>) => api.post<Return>('/returns', body),
  /** idempotent */
  receive: (body: { return_id: string; line_id: string; qty: string; uom_code?: string; returns_location_barcode: string; pallets?: number }, key: string) =>
    api.postIdem<{ lpn_code: string; sku: string; qty: string; pallets: { code: string; qty: string; line_id: string }[] }>('/returns/receive', body, key),
  reopen: (id: string, reason: string) => api.post<{ id: string; return_number: string; status: string }>(`/returns/${id}/reopen`, { reason }),
  /** idempotent */
  classify: (body: { return_id: string; line_id: string; disposition: string; qty: string; reason: string }, key: string) =>
    api.postIdem<{ disposition: string; qty: string; lpn_code: string; return_status: string; putaway_task: string | null }>('/returns/classify', body, key),
  /** quick return from the handheld; idempotent */
  open: () => api.get<{ id: string; return_number: string; status: string; customer: string | null; reason: string | null; created_at: string; lines: { id: string; sku_code: string; description: string; case_qty: string | null; expected_qty: string; received_qty: string; lpn: { code: string; status: string; location: string | null; putaway_task_id: string | null; suggested: string | null } | null }[] }[]>('/returns/open'),
  splitPallet: (body: { return_id: string; lpn_code: string; pallets?: number; parts?: string[] }, key: string) => api.postIdem<{ return_number: string; sku: string; total: string; pallets: { code: string; qty: string; putaway_task_id: string | null; suggested: string | null; line_id: string }[] }>('/returns/split-pallet', body, key),
  quick: (body: { sku_code: string; qty: string; uom_code?: string; damaged?: boolean; to_lpn_code?: string; scanned?: string; note?: string; new_pallets?: number; return_id?: string }, key: string) => api.postIdem<QuickReturnResult>('/returns/quick', body, key),
  close: (id: string) => api.post<{ ok: true }>(`/returns/${id}/close`),
};
