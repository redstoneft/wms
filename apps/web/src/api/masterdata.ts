import { api, type Query } from './client';
import type { Paged, Party, Printer, QuarantineReason, Sku } from './types';

export interface ListQuery extends Query {
  q?: string;
  active?: 'true' | 'false';
  limit?: number;
  offset?: number;
}
type PartyKind = 'customers' | 'suppliers' | 'carriers';

export const masterdataApi = {
  skus: (q: ListQuery = {}) => api.get<Paged<Sku>>('/skus', q),
  sku: (idOrCode: string) => api.get<Sku>(`/skus/${encodeURIComponent(idOrCode)}`),
  createSku: (body: Record<string, unknown>) => api.post<Sku>('/skus', body),
  updateSku: (id: string, body: Record<string, unknown>) => api.patch<Sku>(`/skus/${id}`, body),
  parties: (kind: PartyKind, q: ListQuery = {}) => api.get<Paged<Party>>(`/${kind}`, q),
  createParty: (kind: PartyKind, body: Record<string, unknown>) => api.post<Party>(`/${kind}`, body),
  updateParty: (kind: PartyKind, id: string, body: Record<string, unknown>) => api.patch<Party>(`/${kind}/${id}`, body),
  printers: () => api.get<Printer[]>('/printers'),
  createPrinter: (body: Record<string, unknown>) => api.post<Printer>('/printers', body),
  updatePrinter: (id: string, body: Record<string, unknown>) => api.patch<Printer>(`/printers/${id}`, body),
  quarantineReasons: () => api.get<QuarantineReason[]>('/quarantine-reasons'),
  createQuarantineReason: (body: { code: string; description: string }) => api.post<QuarantineReason>('/quarantine-reasons', body),
};
