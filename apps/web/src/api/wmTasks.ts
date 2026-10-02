// Tasks an operator creates for themself from the handheld, stating the purpose.
import { api } from './client';

export type SelfTaskKind = 'PICK' | 'COUNT' | 'PUTAWAY' | 'RECEIPT';
export interface SelfTaskResult {
  kind: SelfTaskKind;
  id: string;
  next: string;
  mode?: 'ALLOCATED' | 'FREE';
  order_number?: string;
  lines?: number;
  staging?: string;
  lpn?: string;
  receipt_number?: string;
  dock?: string;
}
export interface DamageReportResult {
  mode: 'STORAGE' | 'OUTBOUND';
  lpn: string;
  damaged_lpn: string;
  sku: string;
  qty: string;
  order_number: string | null;
  replanned: { task_id: string | null; added: number; short: string[] } | null;
}
export interface LpnRecountResult {
  mode: 'APPLIED' | 'COUNT' | 'OUTBOUND';
  lpn: string;
  location: string;
  deltas: { sku: string; system: string; counted: string; delta: string }[];
  task_id: string | null;
  status: string;
  order_number?: string;
  order_status?: string;
  replanned?: { task_id: string | null; added: number; short: string[] };
}
export interface HandheldOrderResult {
  order_id: string;
  order_number: string;
  lines: number;
  task_id: string | null;
  staging?: string;
  next: string;
}
export const wmTasksApi = {
  reportDamage: (body: { lpn_code: string; sku_code: string; qty: string; uom_code: string; reason: string; order_number?: string }) => api.post<DamageReportResult>('/wm/damage', body),
  damageOrders: (sku: string) => api.get<{ orders: { order_number: string; customer: string; status: string; picked: string }[] }>(`/wm/damage/orders?sku=${encodeURIComponent(sku)}`),
  linkDamageToOrder: (body: { order_number: string; sku_code: string; qty: string; uom_code: string; lpn_code?: string; reason: string }) => api.post<DamageReportResult>('/wm/damage/link-order', body),
  recountLpn: (body: { lpn_code: string; purpose: string; lines: { sku_code: string; qty: string; uom_code: string }[] }) => api.post<LpnRecountResult>('/wm/lpn-recount', body),
  createOrder: (body: { order_number: string; customer_code: string; destination?: string; purpose: string; lines: { sku_code: string; qty: string; uom_code: string }[]; start_now: boolean }) => api.post<HandheldOrderResult>('/wm/orders', body),
  create: (body: { kind: SelfTaskKind; reference: string; purpose: string; new_order?: { customer_code: string; destination?: string } }) => api.post<SelfTaskResult>('/wm/tasks', body),
};
