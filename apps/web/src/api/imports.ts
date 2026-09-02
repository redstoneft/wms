import { api } from './client';
import type { ImportJob, ImportResult, ImportTemplate } from './types';

export const importsApi = {
  templates: () => api.get<Record<string, ImportTemplate>>('/imports/templates'),
  templateUrl: (type: string) => `/api/imports/templates/${type.toLowerCase()}.csv`,
  templateCsv: (type: string) => api.getText(`/imports/templates/${type.toLowerCase()}.csv`),
  run: (type: string, mode: 'VALIDATE' | 'APPLY', file: File) => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    return api.upload<ImportResult>('/imports', fd, { type, mode });
  },
  history: (q?: { type?: string; limit?: number }) => api.get<ImportJob[]>('/imports', q),
  job: (id: string) => api.get<ImportJob>(`/imports/${id}`),
};
