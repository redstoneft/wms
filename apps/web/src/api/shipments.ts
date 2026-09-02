import { api } from './client';
import type { LoadScanResult, ReleaseCheck, Shipment, ShipmentDetail, ShipmentListItem } from './types';

export const shipmentsApi = {
  list: (q?: { status?: string; limit?: number }) => api.get<ShipmentListItem[]>('/shipments', q),
  get: (id: string) => api.get<ShipmentDetail>(`/shipments/${id}`),
  create: (body: Record<string, unknown>) => api.post<Shipment>('/shipments', body),
  addOrder: (id: string, order_id: string) => api.post<{ ok: true }>(`/shipments/${id}/orders`, { order_id }),
  removeOrder: (id: string, orderId: string) => api.delete<{ ok: true }>(`/shipments/${id}/orders/${orderId}`),
  releaseCheck: (id: string) => api.get<ReleaseCheck>(`/shipments/${id}/release-check`),
  release: (shipment_id: string, version: number) => api.post<{ shipment_id: string; status: string; check: ReleaseCheck }>('/shipments/release', { shipment_id, version }),
  depart: (id: string) => api.post<{ shipment_id: string; status: string; lpns: number; movements: number }>(`/shipments/${id}/depart`),
  /** idempotent */
  loadScan: (body: { shipment_id: string; lpn_code: string; dock_location_barcode?: string }, key: string) => api.postIdem<LoadScanResult>('/loading/scan', body, key),
  /** idempotent */
  unload: (body: { shipment_id: string; lpn_code: string; reason: string }, key: string) => api.postIdem<{ lpn_code: string; movements: string[] }>('/loading/unload', body, key),
};
