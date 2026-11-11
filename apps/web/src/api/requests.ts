// staff requests waiting for an office decision (re-receipts, counts with differences)
import { api } from './client';

export interface RequestLine {
  line_id: string;
  location: string;
  lpn: string | null;
  sku: string;
  description: string;
  system_qty: string;
  proposed_qty: string;
  delta: string;
  current_qty: string;
  applicable: boolean;
  why: string | null;
}
export interface StaffRequest {
  id: string;
  kind: 'RE_RECEIPT' | 'COUNT';
  status: string;
  lpn: string | null;
  purpose: string | null;
  requested_by: string | null;
  requested_by_username: string | null;
  created_at: string;
  lines: RequestLine[];
  applicable: boolean;
}
export interface RequestsView {
  requests: StaffRequest[];
  pending: number;
  other: { incidents_open: number; receipts_to_close: number; returns_inspecting: number; assemblies_open: number };
}
export interface RequestDecisionResult {
  id: string;
  decision: 'APPROVE' | 'REJECT';
  status: string;
  adjusted: number;
  skipped: { line_id: string; reason: string }[];
}

export const requestsApi = {
  list: () => api.get<RequestsView>('/requests'),
  pending: () => api.get<{ pending: number }>('/requests/pending'),
  decide: (id: string, body: { decision: 'APPROVE' | 'REJECT'; reason: string }) => api.post<RequestDecisionResult>(`/requests/${id}/decide`, body),
};
