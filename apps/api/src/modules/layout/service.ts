import type { RackBridge } from '@wms/shared';
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
  /** bridges over walkways (see zRackBridge, parsed by rackBridges()); bays after a bridge shift by its width. Raw JSON from the DB is accepted. */
  bridges?: unknown;
}

export function rackBridges(g: { bridges?: unknown }): RackBridge[] {
  const raw = Array.isArray(g.bridges) ? (g.bridges as RackBridge[]) : [];
  return [...raw].sort((a, b) => a.after_bay - b.after_bay);
}

/** Local X (meters along the rack) where bay `bay` starts, counting the bridges before it. */
export function bayStartM(g: RackGeometry, bay: number): number {
  const shift = rackBridges(g).filter((b) => b.after_bay < bay).reduce((acc, b) => acc + b.width_m, 0);
  return (bay - 1) * g.bay_width_m + shift;
}

/** Local X where a bridge starts: right after its bay (earlier bridges already counted). */
export function bridgeStartM(g: RackGeometry, bridge: RackBridge): number {
  return bayStartM(g, bridge.after_bay) + g.bay_width_m;
}

/** Total length of the rack along its axis, bridges included. */
export function rackLengthM(g: RackGeometry): number {
  return g.bays * g.bay_width_m + rackBridges(g).reduce((acc, b) => acc + b.width_m, 0);
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
  return localToWorld(g, bayStartM(g, bay) + (posInBay - 0.5) * slotW, level);
}

/** World coordinates of a pallet position on a bridge. */
export function bridgeWorldCoords(g: RackGeometry, bridge: RackBridge, level: number, pos: number): { x: number; y: number; z: number } {
  const slotW = bridge.width_m / bridge.positions;
  return localToWorld(g, bridgeStartM(g, bridge) + (pos - 0.5) * slotW, level);
}

/** Bridge location code: <ZONE>-<AISLE>-<PTE>-N<LEVEL>-P<POS> e.g. ALM-F-PTE-N03-P01 */
export function bridgeLocationCode(zone: string, aisle: string, seg: string, level: number, pos: number): string {
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return `${zone}-${aisle}-${seg}-N${pad2(level)}-P${pad2(pos)}`;
}

function localToWorld(g: RackGeometry, localX: number, level: number): { x: number; y: number; z: number } {
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
  const bridgeOps: { code: string; geometry: Record<string, number> }[] = [];
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
  // bridges: positions only on their levels, coded <ZONE>-<AISLE>-<PTE>-N##-P## so the labels stand out
  rackBridges(rack).forEach((br, k) => {
    if (br.after_bay >= rack.bays) throw new RuleError('BRIDGE_AFTER_LAST_BAY', `Bridge after bay ${br.after_bay}: the rack has ${rack.bays} bays`);
    const seg = k === 0 ? br.code : `${br.code}${k + 1}`;
    for (const level of br.levels) {
      if (level > rack.levels) throw new RuleError('BRIDGE_LEVEL', `Bridge level ${level} exceeds the rack's ${rack.levels} levels`);
      for (let p = 1; p <= br.positions; p++) {
        const code = bridgeLocationCode(aisle.zone.code, aisle.code, seg, level, p);
        wanted.add(code);
        const w = bridgeWorldCoords(rack, br, level, p);
        bridgeOps.push({
          code,
          geometry: {
            bay: br.after_bay,
            level,
            position: 900 + k * 10 + p, // sorts after every regular position of the rack
            x_m: w.x,
            y_m: w.y,
            z_m: w.z,
            width_m: round2(br.width_m / br.positions),
            depth_m: rack.depth_m,
            height_m: rack.level_height_m,
            pick_sequence: pickSequence(aisle.code, rack.code, br.after_bay, level, Math.min(9, rack.positions_per_bay + p)),
          },
        });
      }
    }
  });
  for (const { code, geometry } of bridgeOps) {
    const ex = byCode.get(code);
    if (ex) {
      await tx.locations.update({ where: { id: ex.id }, data: { ...geometry, is_active: true } });
      updated++;
    } else {
      await tx.locations.create({ data: { warehouse_id: aisle.zone.warehouse_id, zone_id: aisle.zone_id, rack_id: rack.id, code, barcode: `LOC-${code}`, location_type: opts.location_type, pallet_capacity: opts.pallet_capacity, max_weight_kg: opts.max_weight_kg, ...geometry } });
      created++;
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
