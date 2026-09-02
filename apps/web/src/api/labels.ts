import { api } from './client';
import type { LabelHistoryRow, LabelPreview, LabelPrintResult } from './types';

export interface PrintLabelInput {
  label_type: string;
  entity_id: string;
  printer_id?: string;
  copies?: number;
  reprint_reason?: string;
}

export const labelsApi = {
  preview: (body: PrintLabelInput) => api.post<LabelPreview>('/labels/preview', body),
  print: (body: PrintLabelInput) => api.post<LabelPrintResult>('/labels/print', body),
  history: (q?: { entity_id?: string; label_type?: string; limit?: number }) => api.get<LabelHistoryRow[]>('/labels/history', q),
  zpl: (id: string) => api.getText(`/labels/${id}/zpl`),
  /** Batch by rack/zone: printable sheet and ZPL are plain GET links (same-origin cookie); direct print is a POST. */
  sheetUrl: (q: { rack_id?: string; zone_id?: string }) => `/api/labels/locations.html?${new URLSearchParams(q as Record<string, string>)}`,
  zplUrl: (q: { rack_id?: string; zone_id?: string }) => `/api/labels/locations.zpl?${new URLSearchParams(q as Record<string, string>)}`,
  printBatch: (body: { rack_id?: string; zone_id?: string; printer_id?: string }) => api.post<{ total: number; sent: number; failed: { code: string; error: string }[] }>('/labels/print-batch', body),
};
