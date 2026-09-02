// Read-only PostgREST client for the Supabase mirrors of Aspel SAE.
// Two sources exist in the business today:
//   * ERP project  (clean tables: sae_inventario, sae_compras[+lineas], sae_facturas, sku_alias, productos, pedidos[+lineas], clientes, cedis)
//   * RAW project  (1:1 Firebird mirror: sae_inve01, sae_clie01, sae_prov01, ...)
// Both are fed by scheduled connectors on the Windows server; the WMS never talks to Firebird directly
// and never writes to Supabase. Credentials come from the environment and are never logged.
import { RuleError } from '../../errors.js';

export interface SaeSource {
  url: string;
  key: string;
}

export interface SaeConfig {
  erp: SaeSource | null;
  raw: SaeSource | null;
  poSinceDays: number;
  intervalMinutes: number;
}

export function saeConfig(): SaeConfig {
  const erpUrl = process.env.SAE_SUPABASE_URL?.trim();
  const erpKey = process.env.SAE_SUPABASE_KEY?.trim();
  const rawUrl = process.env.SAE_RAW_SUPABASE_URL?.trim();
  const rawKey = process.env.SAE_RAW_SUPABASE_KEY?.trim();
  return {
    erp: erpUrl && erpKey ? { url: erpUrl.replace(/\/+$/, ''), key: erpKey } : null,
    raw: rawUrl && rawKey ? { url: rawUrl.replace(/\/+$/, ''), key: rawKey } : null,
    poSinceDays: Math.max(1, Number(process.env.SAE_PO_SINCE_DAYS ?? 60) || 60),
    intervalMinutes: Math.max(0, Number(process.env.SAE_SYNC_INTERVAL_MINUTES ?? 30) || 0),
  };
}

export function requireSource(src: SaeSource | null, name: string): SaeSource {
  if (!src) throw new RuleError('SAE_NOT_CONFIGURED', `SAE source '${name}' is not configured (SAE_${name === 'raw' ? 'RAW_' : ''}SUPABASE_URL / _KEY)`);
  return src;
}

const PAGE = 1000;

/** Fetches every row of a PostgREST query, paginating with Range headers. */
export async function fetchAll<T = Record<string, unknown>>(src: SaeSource, table: string, params: Record<string, string> = {}, opts: { timeoutMs?: number; max?: number } = {}): Promise<T[]> {
  const out: T[] = [];
  const qs = new URLSearchParams(params).toString();
  const max = opts.max ?? 200_000;
  for (let from = 0; from < max; from += PAGE) {
    const to = from + PAGE - 1;
    const res = await fetch(`${src.url}/rest/v1/${table}${qs ? `?${qs}` : ''}`, {
      headers: { apikey: src.key, Authorization: `Bearer ${src.key}`, Range: `${from}-${to}`, 'Range-Unit': 'items', Accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    if (res.status === 416) break; // range not satisfiable = past the end
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new RuleError('SAE_SOURCE_ERROR', `SAE source ${table} responded ${res.status}: ${text}`);
    }
    const rows = (await res.json()) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/** Trims SAE keys (Firebird CHAR columns arrive padded with spaces). */
export const key = (v: unknown): string => String(v ?? '').trim();
export const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
