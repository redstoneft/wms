// Tasks an operator creates for themself from the handheld, stating the purpose.
import { api } from './client';

export type SelfTaskKind = 'PICK' | 'COUNT' | 'PUTAWAY';
export interface SelfTaskResult {
  kind: SelfTaskKind;
  id: string;
  next: string;
  order_number?: string;
  lines?: number;
  staging?: string;
  lpn?: string;
}
export const wmTasksApi = {
  create: (body: { kind: SelfTaskKind; reference: string; purpose: string }) => api.post<SelfTaskResult>('/wm/tasks', body),
};
