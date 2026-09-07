import type { Tx } from '../../db.js';
import { RuleError } from '../../errors.js';

export interface RackGeometry {
  bays: number;
  levels: number;
  positions_per_bay: number;
  bay_width_m: number;
  level_height_m: number;
  depth_m: number;
  x_m: number;
  y_m: number;
  rotation_deg: number;
}

/** Location code: <ZONE>-<AISLE>-R<RACK>-N<LEVEL>-P<POSITION> e.g. A-03-R05-N02-P04 */
export function locationCode(zone: string, aisle: string, rack: string, level: number, position: number): string {
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const rackNo = rack.replace(/^R/i, '');
  return `${zone}-${aisle}-R${rackNo.padStart(2, '0')}-N${pad2(level)}-P${pad2(position)}`;
}

/** World coordinates (meters) of a position center within a rack. */
export function positionWorldCoords(g: RackGeometry, bay: number, level: number, posInBay: number): { x: number; y: number; z: number } {
  const slotW = g.bay_width_m / g.positions_per_bay;
  const localX = (bay - 1) * g.bay_width_m + (posInBay - 0.5) * slotW;
  const localY = g.depth_m / 2;
  const rad = (g.rotation_deg * Math.PI) / 180;
  const x = g.x_m + localX * Math.cos(rad) - localY * Math.sin(rad);
  const y = g.y_m + localX * Math.sin(rad) + localY * Math.cos(rad);
  const z = (level - 1) * g.level_height_m;
  return { x: round2(x), y: round2(y), z: round2(z) };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * (Re)generates the locations of a rack. Existing locations keep their id and
 * inventory; only geometry is refreshed. New slots are added; slots that no
 * longer exist are deactivated only if empty (never deleted).
 */
export async function syncRackLocations(
  tx: Tx,
  rack: { id: string; code: string; aisle_id: string } & RackGeometry,
  opts: { location_type: string; pallet_capacity: number; max_weight_kg: number },
): Promise<{ created: number; updated: number; deactivated: number }> {
  const aisle = await tx.aisles.findUniqueOrThrow({ where: { id: rack.aisle_id }, include: { zone: true } });
  const existing = await tx.locations.findMany({ where: { rack_id: rack.id } });
  const byCode = new Map(existing.map((l) => [l.code, l]));
  const wanted = new Set<string>();
  let created = 0;
  let updated = 0;
  for (let bay = 1; bay <= rack.bays; bay++) {
    for (let level = 1; level <= rack.levels; level++) {
      for (let p = 1; p <= rack.positions_per_bay; p++) {
        const position = (bay - 1) * rack.positions_per_bay + p;
        const code = locationCode(aisle.zone.code, aisle.code, rack.code, level, position);
        wanted.add(code);
        const w = positionWorldCoords(rack, bay, level, p);
        const slotW = rack.bay_width_m / rack.positions_per_bay;
        const geometry = {
          bay,
          level,
          position,
          x_m: w.x,
          y_m: w.y,
          z_m: w.z,
          width_m: round2(slotW),
          depth_m: rack.depth_m,
          height_m: rack.level_height_m,
          pick_sequence: pickSequence(aisle.code, rack.code, bay, level, p),
        };
        const ex = byCode.get(code);
        if (ex) {
          await tx.locations.update({ where: { id: ex.id }, data: { ...geometry, is_active: true } });
          updated++;
        } else {
          await tx.locations.create({
            data: {
              warehouse_id: aisle.zone.warehouse_id,
              zone_id: aisle.zone_id,
              rack_id: rack.id,
              code,
              barcode: `LOC-${code}`,
              location_type: opts.location_type,
              pallet_capacity: opts.pallet_capacity,
              max_weight_kg: opts.max_weight_kg,
              ...geometry,
            },
          });
          created++;
        }
      }
    }
  }
  let deactivated = 0;
  for (const l of existing) {
    if (!wanted.has(l.code)) {
      const occupied = await tx.lpns.count({ where: { current_location_id: l.id } });
      if (occupied > 0) {
        throw new RuleError('LOCATION_OCCUPIED', `Cannot shrink rack: location ${l.code} still holds ${occupied} LPN(s)`);
      }
      await tx.locations.update({ where: { id: l.id }, data: { is_active: false } });
      deactivated++;
    }
  }
  return { created, updated, deactivated };
}

/** Order rank of an aisle/rack code: numeric codes by value ("01" < "02"), alphanumeric ones alphabetically ("A" < "B" < "X" < "Z"). */
export function codeRank(code: string): number {
  const s = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^\d+$/.test(s)) return Math.min(parseInt(s, 10), 500);
  let v = 0;
  for (const ch of s) v = v * 36 + (ch >= '0' && ch <= '9' ? ch.charCodeAt(0) - 47 : ch.charCodeAt(0) - 54); // 0-9 → 1-10, A-Z → 11-36
  return Math.min(v, 500);
}

/** Deterministic pick-route order: aisle → rack → bay → level (low first) → position in the bay.
 *  Fields are packed so they never overlap (fits a 32-bit int): aisle ≤ 500, rack ≤ 99, bay ≤ 199, level ≤ 19, position in bay ≤ 9. */
export function pickSequence(aisle: string, rack: string, bay: number, level: number, positionInBay: number): number {
  return codeRank(aisle) * 4_000_000 + Math.min(codeRank(rack), 99) * 40_000 + Math.min(bay, 199) * 200 + Math.min(level, 19) * 10 + Math.min(positionInBay, 9);
}
