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
  sheetUrl: (q: { rack_id?: string; zone_id?: string; codes?: string; title?: string; kind?: string }) => `/api/labels/locations.html?${new URLSearchParams(q as Record<string, string>)}`,
  zplUrl: (q: { rack_id?: string; zone_id?: string; codes?: string; title?: string; kind?: string }) => `/api/labels/locations.zpl?${new URLSearchParams(q as Record<string, string>)}`,
  embarqueUrl: (q: { rack_id?: string; zone_id?: string; codes?: string; title?: string; kind?: string }) => `/api/labels/locations.embarque.json?${new URLSearchParams(q as Record<string, string>)}`,
  /** WebUSB station (browser on the printer PC): claim queued labels and report the result. */
  station: {
    ping: (printerId: string) => api.get<{ printer: string; name: string; queued: number }>(`/printers/${printerId}/station/ping`),
    jobs: (printerId: string, limit = 5) => api.get<{ printer: string; jobs: { id: string; label_type: string; entity: string; zpl: string; is_reprint: boolean; created_at: string }[] }>(`/printers/${printerId}/station/jobs`, { limit }),
    result: (printerId: string, jobId: string, body: { ok: boolean; error?: string }) => api.post<{ id: string; status: string }>(`/printers/${printerId}/station/jobs/${jobId}/result`, body),
  },
  printBatch: (body: { rack_id?: string; zone_id?: string; printer_id?: string; kind?: string }) => api.post<{ total: number; sent: number; failed: { code: string; error: string }[] }>('/labels/print-batch', body),
};
