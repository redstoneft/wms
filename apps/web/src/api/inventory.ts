import { api } from './client';
import type { InventoryLpnRow, InventorySkuRow, LpnDetail, LpnTimeline, MovementRow, ReconcileResult, SkuTimeline, ZoneInventoryRow } from './types';

export const inventoryApi = {
  skus: (q?: { q?: string; status?: string; limit?: number; offset?: number }) => api.get<InventorySkuRow[]>('/inventory/skus', q),
  lpns: (q?: { q?: string; status?: string; location_id?: string; zone_id?: string; sku?: string; limit?: number; offset?: number }) => api.get<InventoryLpnRow[]>('/inventory/lpns', q),
  lpn: (code: string) => api.get<LpnDetail>(`/inventory/lpns/${encodeURIComponent(code)}`),
  lpnTimeline: (code: string) => api.get<LpnTimeline>(`/inventory/lpns/${encodeURIComponent(code)}/timeline`),
  skuTimeline: (code: string) => api.get<SkuTimeline>(`/inventory/skus/${encodeURIComponent(code)}/timeline`),
  byZone: () => api.get<ZoneInventoryRow[]>('/inventory/by-zone'),
  movements: (q?: { lpn?: string; sku?: string; type?: string; order_id?: string; from?: string; to?: string; limit?: number; before_id?: string }) => api.get<MovementRow[]>('/inventory/movements', q),
  /** idempotent */
  adjust: (body: Record<string, unknown>, key: string) => api.postIdem<{ movement_id: string; incident_id: string; lpn_code: string; sku_code: string; qty_base: string }>('/inventory/adjust', body, key),
  /** idempotent */
  status: (body: Record<string, unknown>, key: string) => api.postIdem<{ lpn_code: string; movements: string[] }>('/inventory/status', body, key),
  reconcile: () => api.get<ReconcileResult>('/inventory/reconcile'),
};
