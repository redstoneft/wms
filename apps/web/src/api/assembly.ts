// Assembly orders: components → finished product on new pallets.
import { api } from './client';

export interface AssemblyPalletInput {
  cases: number;
  pieces_per_case: number;
}
export interface AssemblyInput {
  station_barcode: string;
  inputs: { lpn_code: string; sku_code: string; qty: number | string }[];
  output: { sku_code: string; lot?: string; expiry_date?: string; pallets: AssemblyPalletInput[] };
  scrap?: { qty: number | string; reason: string };
  notes?: string;
}
export interface AssemblyOrder {
  id: string;
  code: string;
  status: string;
  output_qty: string;
  consumed_qty: string;
  scrap_qty: string;
  scrap_reason: string | null;
  incident_id: string | null;
  notes: string | null;
  created_by: string;
  created_at: string;
  station: { id: string; code: string; barcode: string };
  output_sku: { id: string; code: string; description: string; gtin: string | null };
  inputs: { id: string; qty: string; lpn: { code: string; status: string }; sku: { code: string; description: string } }[];
  outputs: { id: string; cases: number; pieces_per_case: number; qty: string; putaway_task_id: string | null; lpn: { code: string; status: string } }[];
}
export interface AssemblyResult extends AssemblyOrder {
  consumed: { lpn: string; sku: string; qty: string; lpn_status: string }[];
  produced: { lpn: string; cases: number; pieces_per_case: number; qty: string; putaway_task_id: string | null; suggested_location: string | null }[];
  warnings: string[];
}

export const assemblyApi = {
  /** idempotent */
  complete: (body: AssemblyInput, key: string) => api.postIdem<AssemblyResult>('/assembly', body, key),
  list: (q?: { limit?: number; sku?: string }) => api.get<AssemblyOrder[]>('/assembly', q),
  get: (id: string) => api.get<AssemblyOrder>(`/assembly/${id}`),
};
