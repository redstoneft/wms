// Formatting helpers. Quantities are strings/bigint — never floats.
import { UomTable, type UomCode } from '@wms/shared';

export type QtyLike = string | number | bigint | null | undefined;

export function toBigInt(v: QtyLike): bigint {
  if (v === null || v === undefined || v === '') return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  const s = String(v).trim();
  if (!/^-?\d+$/.test(s)) return 0n;
  return BigInt(s);
}

const nf = new Intl.NumberFormat('es-MX');

export function fmtQty(v: QtyLike): string {
  return nf.format(toBigInt(v));
}

export function fmtNum(v: string | number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isNaN(n)) return String(v);
  return new Intl.NumberFormat('es-MX', { maximumFractionDigits: digits }).format(n);
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined) return '—';
  return `${new Intl.NumberFormat('es-MX', { maximumFractionDigits: digits }).format(v)} %`;
}

const dtf = new Intl.DateTimeFormat('es-MX', { dateStyle: 'short', timeStyle: 'short' });
const df = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium' });
const tf = new Intl.DateTimeFormat('es-MX', { timeStyle: 'medium' });

export function fmtDateTime(v: string | Date | null | undefined): string {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return String(v);
  return dtf.format(d);
}
export function fmtDate(v: string | Date | null | undefined): string {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return String(v);
  return df.format(d);
}
export function fmtTime(v: string | Date | null | undefined): string {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v) : v;
  return tf.format(d);
}

export function relTime(v: string | Date | null | undefined): string {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v) : v;
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'hace instantes';
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
  return `hace ${Math.floor(diff / 86400)} d`;
}

export interface UomDef {
  uom_code: UomCode;
  base_qty: string | number | bigint;
}

/** Builds a UomTable from API rows (base_qty arrives as string). */
export function uomTable(defs: UomDef[] | null | undefined): UomTable | null {
  if (!defs || defs.length === 0) return null;
  try {
    return new UomTable(defs.map((d) => ({ uom_code: d.uom_code, base_qty: toBigInt(d.base_qty) })));
  } catch {
    return null;
  }
}

/** "2 PALLET + 3 CASE + 4 PIECE" when UoMs are known, otherwise "N PIECE". */
export function fmtUom(base: QtyLike, defs?: UomDef[] | null): string {
  const b = toBigInt(base);
  const t = uomTable(defs);
  if (!t) return `${fmtQty(b)} PIECE`;
  return t.format(b);
}

export function truncate(s: string | null | undefined, n = 40): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function cls(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** Spanish labels for enum codes used across the UI. */
export const ES: Record<string, string> = {
  // inventory statuses
  AVAILABLE: 'Disponible',
  ALLOCATED: 'Asignado',
  PICKING: 'Surtiendo',
  STAGING: 'En staging',
  LOADED: 'Cargado',
  QUARANTINE: 'Cuarentena',
  DAMAGED: 'Dañado',
  BLOCKED: 'Bloqueado',
  IN_TRANSFER: 'En traslado',
  // location statuses
  FREE: 'Libre',
  PARTIAL: 'Parcial',
  OCCUPIED: 'Ocupada',
  RESERVED: 'Reservada',
  ACTIVE: 'Activa',
  // orders
  IMPORTED: 'Importado',
  ACCEPTED: 'Aceptado',
  PARTIALLY_ALLOCATED: 'Parcialmente asignado',
  PICKED: 'Surtido',
  STAGED: 'En staging',
  VERIFIED: 'Verificado',
  LOADING: 'Cargando',
  SHIPPED: 'Embarcado',
  CANCELLED: 'Cancelado',
  // containers / receipts
  SCHEDULED: 'Programado',
  ARRIVED: 'Arribó',
  UNLOADING: 'Descargando',
  UNLOADED: 'Descargado',
  RECEIVING: 'Recibiendo',
  RECEIVED: 'Recibido',
  CLOSED: 'Cerrado',
  WITH_INCIDENT: 'Con incidencia',
  OPEN: 'Abierto',
  IN_PROGRESS: 'En proceso',
  COMPLETED: 'Completado',
  // shipments
  RELEASED: 'Liberado',
  DEPARTED: 'Salió',
  // incidents
  IN_REVIEW: 'En revisión',
  RESOLVED: 'Resuelto',
  REJECTED: 'Rechazado',
  LOW: 'Baja',
  MEDIUM: 'Media',
  HIGH: 'Alta',
  CRITICAL: 'Crítica',
  // tasks
  PENDING: 'Pendiente',
  ASSIGNED: 'Asignada',
  RECOUNT: 'Reconteo',
  PENDING_APPROVAL: 'Por aprobar',
  APPROVED: 'Aprobado',
  IN_TRANSIT: 'En tránsito',
  SHORT: 'Incompleto',
  PASSED: 'Aprobada',
  FAILED: 'Fallida',
  // location types
  RESERVE: 'Reserva',
  SHIPPING: 'Embarques',
  RETURNS: 'Devoluciones',
  // zone types
  STORAGE: 'Almacenamiento',
  // returns
  INSPECTING: 'Inspección',
  CLASSIFIED: 'Clasificada',
  RESTOCK: 'Reingresar',
  SCRAP: 'Desechar',
  // misc
  MATCHED: 'Coincide',
  VARIANCE: 'Diferencia',
  ADJUSTED: 'Ajustado',
  COUNTED: 'Contado',
  SENT: 'Enviada',
  QUEUED: 'En cola',
  PREVIEW: 'Vista previa',
  VALIDATED: 'Validado',
  APPLIED: 'Aplicado',
  CONSUMED: 'Consumido',
  STORED: 'Almacenado',
};

export function es(code: string | null | undefined): string {
  if (!code) return '—';
  return ES[code] ?? code.replaceAll('_', ' ');
}
