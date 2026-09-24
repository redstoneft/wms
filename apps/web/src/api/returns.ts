import { api } from './client';
import type { QuickReturnResult, Return } from './types';

export const returnsApi = {
  list: (q?: { status?: string; limit?: number }) => api.get<Return[]>('/returns', q),
  get: (id: string) => api.get<Return>(`/returns/${id}`),
  create: (body: Record<string, unknown>) => api.post<Return>('/returns', body),
  /** idempotent */
  receive: (body: { return_id: string; line_id: string; qty: string; uom_code?: string; returns_location_barcode: string }, key: string) =>
    api.postIdem<{ lpn_code: string; sku: string; qty: string }>('/returns/receive', body, key),
  /** idempotent */
  classify: (body: { return_id: string; line_id: string; disposition: string; qty: string; reason: string }, key: string) =>
    api.postIdem<{ disposition: string; qty: string; lpn_code: string; return_status: string; putaway_task: string | null }>('/returns/classify', body, key),
  /** quick return from the handheld; idempotent */
  quick: (body: { sku_code: string; qty: string; uom_code?: string; damaged?: boolean; to_lpn_code?: string; scanned?: string; note?: string }, key: string) => api.postIdem<QuickReturnResult>('/returns/quick', body, key),
  close: (id: string) => api.post<{ ok: true }>(`/returns/${id}/close`),
};
