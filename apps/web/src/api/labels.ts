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
};
