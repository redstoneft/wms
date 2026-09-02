import { api } from './client';
import type { Attachment, Container, Paged, PurchaseOrder, Receipt, ReceiveScanResult } from './types';

export const inboundApi = {
  purchaseOrders: (q?: { status?: string; limit?: number }) => api.get<PurchaseOrder[]>('/purchase-orders', q),
  createPurchaseOrder: (body: Record<string, unknown>) => api.post<PurchaseOrder>('/purchase-orders', body),
  containers: (q?: { status?: string; limit?: number; offset?: number }) => api.get<Paged<Container>>('/containers', q),
  container: (id: string) => api.get<Container>(`/containers/${id}`),
  createContainer: (body: Record<string, unknown>) => api.post<Container>('/containers', body),
  transition: (id: string, body: { status: string; version: number; notes?: string; seal_number?: string; plates?: string; driver_name?: string }) =>
    api.post<Container>(`/containers/${id}/transition`, body),
  uploadPhoto: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return api.upload<Attachment>(`/containers/${id}/photos`, fd);
  },
  receipts: (q?: { status?: string; container_id?: string; limit?: number }) => api.get<Receipt[]>('/receipts', q),
  receipt: (id: string) => api.get<Receipt>(`/receipts/${id}`),
  createReceipt: (body: Record<string, unknown>) => api.post<Receipt>('/receipts', body),
  /** idempotent */
  scan: (body: Record<string, unknown>, key: string) => api.postIdem<ReceiveScanResult>('/receipts/scan', body, key),
  /** idempotent */
  closeLpn: (lpn_code: string, key: string) => api.postIdem<{ lpn_code: string; putaway_task: { id: string; suggested_location_id: string | null } | null }>('/receipts/lpn/close', { lpn_code }, key),
  complete: (body: { receipt_id: string; accept_differences: boolean; notes?: string }) =>
    api.post<{ receipt: Receipt; incidents: string[]; putaway_tasks: string[]; differences: { sku: string; expected: string; received: string }[] }>('/receipts/complete', body),
  close: (id: string) => api.post<Receipt>(`/receipts/${id}/close`),
};
