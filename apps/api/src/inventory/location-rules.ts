// Rules deciding whether a location can accept an LPN. Used by the slotting
// engine (to rank candidates) and by put-away / transfer confirmation (to
// enforce). Always evaluated inside the caller's transaction with the
// location row locked, so capacity checks are race-free.

import type { Tx } from '../db.js';
import type { LocationRow, LpnRow } from './ledger.js';

export interface LocationFit {
  ok: boolean;
  reasons: string[];
  lpn_count: number;
  reserved_count: number;
  weight_kg: number;
}

export interface LpnProfile {
  sku_ids: string[];
  families: (string | null)[];
  compatibility_groups: (string | null)[];
  weight_kg: number;
  height_cm: number | null;
}

export async function lpnProfile(tx: Tx, lpn: LpnRow): Promise<LpnProfile> {
  const rows = await tx.$queryRaw<{ sku_id: string; family: string | null; compatibility_group: string | null; weight: string; pallet_height_cm: string | null }[]>`
    SELECT b.sku_id, s.family, s.compatibility_group, (sum(b.qty) * s.unit_weight_kg)::text AS weight, s.pallet_height_cm::text AS pallet_height_cm
      FROM inventory_balances b JOIN skus s ON s.id = b.sku_id
     WHERE b.lpn_id = ${lpn.id}::uuid AND b.qty > 0
     GROUP BY b.sku_id, s.family, s.compatibility_group, s.unit_weight_kg, s.pallet_height_cm`;
  const weight = lpn.weight_kg ? Number(lpn.weight_kg) : rows.reduce((a, r) => a + Number(r.weight), 0);
  const heights = rows.map((r) => (r.pallet_height_cm ? Number(r.pallet_height_cm) : null)).filter((h): h is number => h !== null);
  return {
    sku_ids: rows.map((r) => r.sku_id),
    families: rows.map((r) => r.family),
    compatibility_groups: rows.map((r) => r.compatibility_group),
    weight_kg: weight,
    height_cm: heights.length ? Math.max(...heights) : null,
  };
}

export interface LocationOccupancy {
  lpn_count: number;
  reserved_count: number;
  weight_kg: number;
  lpn_ids: string[];
  sku_ids: string[];
  compatibility_groups: (string | null)[];
}

export async function locationOccupancy(tx: Tx, locationId: string, excludeLpnId?: string): Promise<LocationOccupancy> {
  const occ = await tx.$queryRaw<{ lpn_id: string; sku_id: string; compatibility_group: string | null; weight: string }[]>`
    SELECT l.id AS lpn_id, b.sku_id, s.compatibility_group, (b.qty * s.unit_weight_kg)::text AS weight
      FROM lpns l JOIN inventory_balances b ON b.lpn_id = l.id AND b.qty > 0 JOIN skus s ON s.id = b.sku_id
     WHERE l.current_location_id = ${locationId}::uuid`;
  const res = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM (
      SELECT lpn_id FROM putaway_tasks WHERE suggested_location_id = ${locationId}::uuid AND status IN ('PENDING','ASSIGNED','IN_PROGRESS')
        AND lpn_id IS DISTINCT FROM ${excludeLpnId ?? null}::uuid
      UNION ALL
      SELECT lpn_id FROM transfers WHERE to_location_id = ${locationId}::uuid AND status = 'IN_TRANSIT'
        AND lpn_id IS DISTINCT FROM ${excludeLpnId ?? null}::uuid
    ) r`;
  const filtered = occ.filter((o) => o.lpn_id !== excludeLpnId);
  return {
    lpn_count: new Set(filtered.map((o) => o.lpn_id)).size,
    reserved_count: Number(res[0]?.n ?? 0n),
    weight_kg: filtered.reduce((a, o) => a + Number(o.weight), 0),
    lpn_ids: [...new Set(filtered.map((o) => o.lpn_id))],
    sku_ids: [...new Set(filtered.map((o) => o.sku_id))],
    compatibility_groups: [...new Set(filtered.map((o) => o.compatibility_group))],
  };
}

export function evaluateFit(location: LocationRow, occ: LocationOccupancy, profile: LpnProfile): LocationFit {
  const reasons: string[] = [];
  if (!location.is_active) reasons.push('LOCATION_INACTIVE');
  if (location.admin_status !== 'ACTIVE') reasons.push(`LOCATION_${location.admin_status}`);
  if (occ.lpn_count + occ.reserved_count >= location.pallet_capacity) reasons.push('LOCATION_FULL');
  const maxW = Number(location.max_weight_kg);
  if (occ.weight_kg + profile.weight_kg > maxW) reasons.push('WEIGHT_EXCEEDED');
  const maxHeightCm = Number(location.height_m) * 100;
  const restr = (location.restrictions ?? {}) as {
    allowed_families?: string[];
    allowed_compatibility_groups?: string[];
    max_height_cm?: number;
  };
  const limitH = restr.max_height_cm ?? maxHeightCm;
  if (profile.height_cm !== null && profile.height_cm > limitH) reasons.push('HEIGHT_EXCEEDED');
  if (restr.allowed_families?.length) {
    const bad = profile.families.filter((f) => !f || !restr.allowed_families!.includes(f));
    if (bad.length) reasons.push('FAMILY_NOT_ALLOWED');
  }
  if (restr.allowed_compatibility_groups?.length) {
    const bad = profile.compatibility_groups.filter((g) => !g || !restr.allowed_compatibility_groups!.includes(g));
    if (bad.length) reasons.push('COMPAT_GROUP_NOT_ALLOWED');
  }
  // incompatible with what is already there
  const mine = new Set(profile.compatibility_groups.filter(Boolean));
  const theirs = new Set(occ.compatibility_groups.filter(Boolean));
  if (mine.size && theirs.size) {
    for (const g of mine) if (!theirs.has(g)) reasons.push('INCOMPATIBLE_WITH_CONTENTS');
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], lpn_count: occ.lpn_count, reserved_count: occ.reserved_count, weight_kg: occ.weight_kg };
}

/** Full check for a concrete LPN → location, inside a transaction (location must be locked by caller). */
export async function checkLocationAccepts(tx: Tx, location: LocationRow, lpn: LpnRow): Promise<LocationFit> {
  const [occ, profile] = await Promise.all([locationOccupancy(tx, location.id, lpn.id), lpnProfile(tx, lpn)]);
  return evaluateFit(location, occ, profile);
}
