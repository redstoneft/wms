import { api } from './client';
import type { Aisle, LocationDetail, LocationRow, MapPayload, MapSearchResult, MapSearchType, Rack, Warehouse, Zone } from './types';

export interface LocationQuery {
  warehouse_id?: string;
  zone_id?: string;
  rack_id?: string;
  type?: string;
  status?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export const layoutApi = {
  warehouses: () => api.get<Warehouse[]>('/warehouses'),
  createWarehouse: (body: Record<string, unknown>) => api.post<Warehouse>('/warehouses', body),
  updateWarehouse: (id: string, body: Record<string, unknown>) => api.patch<Warehouse>(`/warehouses/${id}`, body),
  zones: (warehouse_id?: string) => api.get<Zone[]>('/zones', { warehouse_id }),
  createZone: (body: Record<string, unknown>) => api.post<Zone>('/zones', body),
  updateZone: (id: string, body: Record<string, unknown>) => api.patch<Zone>(`/zones/${id}`, body),
  createAisle: (body: { zone_id: string; code: string; name?: string }) => api.post<Aisle>('/aisles', body),
  racks: (q?: { zone_id?: string; aisle_id?: string }) => api.get<Rack[]>('/racks', q),
  createRack: (body: Record<string, unknown>) => api.post<Rack & { generated: { created: number; updated: number; deactivated: number } }>('/racks', body),
  updateRack: (id: string, body: Record<string, unknown>) => api.patch<Rack & { generated: { created: number; updated: number; deactivated: number } }>(`/racks/${id}`, body),
  locations: (q: LocationQuery) => api.get<{ items: LocationRow[] }>('/locations', q as Record<string, string | number | undefined>),
  location: (idOrCode: string) => api.get<LocationDetail>(`/locations/${encodeURIComponent(idOrCode)}`),
  createLocation: (body: Record<string, unknown>) => api.post<LocationRow>('/locations', body),
  updateLocation: (id: string, body: Record<string, unknown>) => api.patch<LocationRow>(`/locations/${id}`, body),
  map: (warehouse_id?: string) => api.get<MapPayload>('/map', { warehouse_id }),
  mapSearch: (type: MapSearchType, q: string) => api.get<MapSearchResult>('/map/search', { type, q }),
};
