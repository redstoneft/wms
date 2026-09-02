import { api } from './client';

export type SaeEntity = 'skus' | 'customers' | 'suppliers' | 'purchase_orders' | 'customer_orders';

export interface SaeRun {
  id: string;
  entity: SaeEntity;
  status: 'RUNNING' | 'OK' | 'FAILED';
  trigger: 'SCHEDULED' | 'MANUAL';
  started_at: string;
  finished_at: string | null;
  source_rows: number;
  created: number;
  updated: number;
  skipped: number;
  errors?: { ref: string; message: string }[];
  error_count?: number;
  notes: string | null;
}

export interface SaeStatus {
  configured: { erp: boolean; raw: boolean; erp_host: string | null; raw_host: string | null };
  po_since_days: number;
  interval_minutes: number;
  source_freshness: { erp_updated_at: string | null; raw_synced_at: string | null };
  wms_counts: { skus: string | number; customers: string | number; suppliers: string | number; pos: string | number; orders: string | number };
  last_runs: SaeRun[];
  entities: SaeEntity[];
}

export interface SaeSyncResult {
  entity: SaeEntity;
  run_id: string;
  status: 'OK' | 'FAILED';
  source_rows: number;
  created: number;
  updated: number;
  skipped: number;
  errors: { ref: string; message: string }[];
  notes?: string;
}

export interface SaeStockCompare {
  checked_at: string;
  sae_updated_at: string | null;
  skus_sae: number;
  skus_matching: number;
  skus_differing: number;
  sae_units: string | number;
  wms_units: string | number;
  products: number;
  differences: { sku: string; gtin: string | null; description: string | null; in_wms: boolean; sae_existencia: string | number; wms_total: string | number; wms_available: string | number; diff: string | number; sae_keys: { key: string; existencia: string | number; factor: string | number }[] }[];
}

export const saeApi = {
  status: () => api.get<SaeStatus>('/sae/status'),
  sync: (entities?: SaeEntity[]) => api.post<{ results: SaeSyncResult[] }>('/sae/sync', entities ? { entities } : {}),
  runs: (q?: { entity?: SaeEntity; limit?: number }) => api.get<SaeRun[]>('/sae/runs', q),
  stockCompare: () => api.get<SaeStockCompare>('/sae/stock-compare'),
};
