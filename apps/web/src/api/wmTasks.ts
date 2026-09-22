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
export interface LpnRecountResult {
  mode: 'APPLIED' | 'COUNT';
  lpn: string;
  location: string;
  deltas: { sku: string; system: string; counted: string; delta: string }[];
  task_id: string | null;
  status: string;
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
  recountLpn: (body: { lpn_code: string; purpose: string; lines: { sku_code: string; qty: string; uom_code: string }[] }) => api.post<LpnRecountResult>('/wm/lpn-recount', body),
  createOrder: (body: { order_number: string; customer_code: string; destination?: string; purpose: string; lines: { sku_code: string; qty: string; uom_code: string }[]; start_now: boolean }) => api.post<HandheldOrderResult>('/wm/orders', body),
  create: (body: { kind: SelfTaskKind; reference: string; purpose: string; new_order?: { customer_code: string; destination?: string } }) => api.post<SelfTaskResult>('/wm/tasks', body),
};
