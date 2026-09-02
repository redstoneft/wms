import { api } from './client';
import type { Attachment, Incident, IncidentDetail, Paged } from './types';

export const incidentsApi = {
  list: (q?: { status?: string; severity?: string; type?: string; entity_type?: string; entity_id?: string; limit?: number; offset?: number }) => api.get<Paged<Incident>>('/incidents', q),
  get: (id: string) => api.get<IncidentDetail>(`/incidents/${id}`),
  create: (body: Record<string, unknown>) => api.post<Incident>('/incidents', body),
  comment: (id: string, body: string) => api.post<{ id: string }>(`/incidents/${id}/comments`, { body }),
  photo: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return api.upload<Attachment>(`/incidents/${id}/photos`, fd);
  },
  status: (id: string, body: { status: 'IN_REVIEW' | 'RESOLVED' | 'CLOSED' | 'REJECTED'; resolution?: string; comment?: string }) => api.post<Incident>(`/incidents/${id}/status`, body),
  assign: (id: string, assigned_to: string | null) => api.post<Incident>(`/incidents/${id}/assign`, { assigned_to }),
};
