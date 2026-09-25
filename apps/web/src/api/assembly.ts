// Assembly orders: components → finished product on new pallets.
import { api } from './client';

export interface AssemblyPalletInput {
  cases: number;
  pieces_per_case: number;
  /** pieces in one incomplete case at the end of the pallet */
  partial_pieces?: number;
  /** defective pieces found on this pallet (scrap) */
  defective?: number;
}
export interface AssemblyInput {
  station_barcode?: string;
  inputs: { lpn_code: string; sku_code: string; qty: number | string }[];
  output: { sku_code: string; lot?: string; expiry_date?: string; pallets: AssemblyPalletInput[] };
  scrap?: { qty: number | string; reason: string };
  notes?: string;
  /** produced straight for this order: outbound pallets, no put-away */
  for_order_number?: string;
}
export interface AssemblyOrder {
  id: string;
  code: string;
  status: string; // IN_PROGRESS | COMPLETED | CANCELLED
  started_at?: string | null;
  completed_at?: string | null;
  mode: 'ASSEMBLY' | 'REPACK';
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
  for_order?: { id: string; order_number: string; status: string; staging_assignments: { location: { code: string } }[] } | null;
  outputs: { id: string; cases: number; pieces_per_case: number; partial_pieces?: number; defective_qty?: string; qty: string; putaway_task_id: string | null; lpn: { code: string; status: string }; location?: string | null; suggested_location?: string | null; putaway_status?: string | null }[];
}
export interface AssemblyResult extends AssemblyOrder {
  consumed: { lpn: string; sku: string; qty: string; lpn_status: string }[];
  produced: { lpn: string; cases: number; pieces_per_case: number; partial_pieces?: number; defective?: number; qty: string; putaway_task_id: string | null; suggested_location: string | null }[];
  warnings: string[];
  /** when produced for an order: its number and staging lane */
  for_order: { order_number: string; staging: string | null; pick_task_id: string } | null;
}

export interface AssemblyStartInput {
  station_barcode?: string;
  inputs: { lpn_code: string; sku_code: string; qty: number | string }[];
  output_sku_code: string;
  notes: string;
  for_order_number?: string;
}
export interface AssemblyFinishInput {
  lot?: string;
  expiry_date?: string;
  pallets: AssemblyPalletInput[];
  scrap?: { qty: number | string; reason: string };
  notes?: string;
  for_order_number?: string;
}
export const assemblyApi = {
  /** idempotent: everything at once */
  complete: (body: AssemblyInput, key: string) => api.postIdem<AssemblyResult>('/assembly', body, key),
  /** phase 1 (idempotent): components to the station, order stays open */
  start: (body: AssemblyStartInput, key: string) => api.postIdem<AssemblyOrder & { moved: { lpn: string; sku: string; qty: string; from: string | null; blocked: string }[] }>('/assembly/start', body, key),
  /** phase 2 (idempotent): pallets produced + defective pieces */
  finish: (id: string, body: AssemblyFinishInput, key: string) => api.postIdem<AssemblyResult>(`/assembly/${id}/complete`, body, key),
  cancel: (id: string, reason: string) => api.post<{ id: string; code: string; status: string }>(`/assembly/${id}/cancel`, { reason }),
  list: (q?: { limit?: number; sku?: string; status?: string }) => api.get<AssemblyOrder[]>('/assembly', q),
  get: (id: string) => api.get<AssemblyOrder>(`/assembly/${id}`),
};
