// Delivery calendar (whiteboard) — kept from the handheld, shown on a TV through a read-only board link.
import { api } from './client';

export interface Delivery {
  id: string;
  title: string;
  delivery_date: string;
  delivery_time: string | null;
  notes: string | null;
  status: 'PLANNED' | 'DONE' | 'CANCELLED';
  overdue: boolean;
}
export interface DeliveryInput {
  title: string;
  customer_code?: string;
  order_number?: string;
  delivery_date: string;
  delivery_time?: string;
  notes?: string;
}
export const deliveriesApi = {
  list: (days = 21) => api.get<Delivery[]>('/deliveries', { days }),
  create: (body: DeliveryInput) => api.post<Delivery>('/deliveries', body),
  update: (id: string, body: Partial<DeliveryInput> & { status?: Delivery['status'] }) => api.patch<Delivery>(`/deliveries/${id}`, body),
  remove: (id: string) => api.delete<{ id: string }>(`/deliveries/${id}`),
  boardLink: (name: string) => api.post<{ id: string; name: string; token: string }>('/deliveries/board-link', { name }),
  boardLinks: () => api.get<{ id: string; name: string; created_at: string }[]>('/deliveries/board-links'),
  revokeBoardLink: (id: string) => api.delete<{ id: string }>(`/deliveries/board-links/${id}`),
};

/** Public feed for the TV (token in the URL, no session). */
export async function fetchBoard(token: string, days = 14): Promise<{ board: string; generated_at: string; items: Delivery[] }> {
  const r = await fetch(`/api/board/deliveries?k=${encodeURIComponent(token)}&days=${days}`, { credentials: 'omit', cache: 'no-store' });
  if (!r.ok) throw new Error(r.status === 403 ? 'Enlace del tablero inválido o revocado' : `HTTP ${r.status}`);
  return (await r.json()) as { board: string; generated_at: string; items: Delivery[] };
}

const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
/** "martes 29 sep" · "HOY" / "MAÑANA" prefixes for the board */
export function dayLabel(iso: string): { name: string; rel: string | null } {
  const d = new Date(`${iso}T12:00:00`);
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86400_000);
  const name = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return { name, rel: diff === 0 ? 'HOY' : diff === 1 ? 'MAÑANA' : diff < 0 ? 'ATRASADA' : null };
}
export function groupByDay(items: Delivery[]): { date: string; items: Delivery[] }[] {
  const map = new Map<string, Delivery[]>();
  for (const it of items) map.set(it.delivery_date, [...(map.get(it.delivery_date) ?? []), it]);
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, list]) => ({ date, items: list }));
}
