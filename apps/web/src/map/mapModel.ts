// Pure helpers that turn the /api/map payload into render-ready instances.
// Coordinate convention: API x (width, m) → Three x; API y (depth, m) → Three z;
// API z (height, m) → Three y. Rack positions have their CENTER at (x, y) and
// base height z; area locations (docks, staging…) use their CORNER at (x, y).
import type { LocationStatus, LocationType } from '@wms/shared';
import type { MapLocation, MapPayload, MapRack } from '../api/types';

export const STATUS_COLORS: Record<LocationStatus, string> = {
  FREE: '#b7c4cf',
  PARTIAL: '#f5c542',
  OCCUPIED: '#3b82f6',
  RESERVED: '#a855f7',
  BLOCKED: '#ef4444',
  QUARANTINE: '#f97316',
};
export const STATUS_LABELS: Record<LocationStatus, string> = {
  FREE: 'Libre',
  PARTIAL: 'Parcial',
  OCCUPIED: 'Ocupada',
  RESERVED: 'Reservada',
  BLOCKED: 'Bloqueada',
  QUARANTINE: 'Cuarentena',
};
export const AREA_TYPES: LocationType[] = ['RECEIVING', 'STAGING', 'SHIPPING', 'QUARANTINE', 'RETURNS', 'DAMAGED'];
export const HIGHLIGHT_COLOR = '#22d3ee';
export const SELECT_COLOR = '#facc15';
export const PALLET_BASE_COLOR = '#8b5a2b';
export const PALLET_LOAD_COLOR = '#c8a97e';

export type Vec3 = [number, number, number];

export interface SlotInstance {
  loc: MapLocation;
  center: Vec3;
  size: Vec3;
}
export interface PalletInstance {
  locId: string;
  status: LocationStatus;
  center: Vec3; // center of the whole pallet (base + load)
  size: Vec3; // footprint w, total height, d
  fill: number; // 0..1 relative fill used to scale the load
}
export interface AreaInstance {
  loc: MapLocation;
  center: Vec3;
  size: Vec3;
}
export interface FrameInstance {
  rackId: string;
  center: Vec3;
  size: Vec3;
  rotY: number;
}
export interface RackLabel {
  rack: MapRack;
  pos: Vec3;
}
export interface SceneModel {
  width: number;
  depth: number;
  height: number;
  slots: SlotInstance[];
  pallets: PalletInstance[];
  areas: AreaInstance[];
  uprights: FrameInstance[];
  beams: FrameInstance[];
  rackLabels: RackLabel[];
  slotIndexByLoc: Map<string, number>;
  palletIndicesByLoc: Map<string, number[]>;
  locById: Map<string, MapLocation>;
}

export function isArea(loc: MapLocation): boolean {
  return !loc.rack_id;
}

/** World-space center of a location box (rack slot = center semantics, area = corner semantics). */
export function locationCenter(loc: MapLocation): Vec3 {
  if (isArea(loc)) return [loc.x + loc.w / 2, loc.z + loc.h / 2, loc.y + loc.d / 2];
  return [loc.x, loc.z + loc.h / 2, loc.y];
}

export function buildSceneModel(p: MapPayload): SceneModel {
  const width = Number(p.warehouse.width_m);
  const depth = Number(p.warehouse.depth_m);
  const height = Number(p.warehouse.height_m);
  const slots: SlotInstance[] = [];
  const pallets: PalletInstance[] = [];
  const areas: AreaInstance[] = [];
  const slotIndexByLoc = new Map<string, number>();
  const palletIndicesByLoc = new Map<string, number[]>();
  const locById = new Map<string, MapLocation>();

  for (const loc of p.locations) {
    locById.set(loc.id, loc);
    if (isArea(loc)) {
      areas.push({ loc, center: [loc.x + loc.w / 2, 0.05, loc.y + loc.d / 2], size: [loc.w, 0.1, loc.d] });
      if (loc.lpn_count > 0) {
        // pallets laid out in a grid inside the area footprint
        const pw = 1.1;
        const cols = Math.max(1, Math.floor(loc.w / (pw + 0.2)));
        const rows = Math.max(1, Math.floor(loc.d / (pw + 0.2)));
        const perLayer = cols * rows;
        const n = Math.min(loc.lpn_count, perLayer * 3);
        const idxs: number[] = [];
        for (let i = 0; i < n; i++) {
          const layer = Math.floor(i / perLayer);
          const k = i % perLayer;
          const c = k % cols;
          const r = Math.floor(k / cols);
          const ph = 1.2;
          const x = loc.x + 0.15 + (pw + 0.2) * c + pw / 2;
          const z = loc.y + 0.15 + (pw + 0.2) * r + pw / 2;
          idxs.push(pallets.length);
          pallets.push({ locId: loc.id, status: loc.status, center: [x, 0.1 + layer * ph + ph / 2, z], size: [pw, ph, pw], fill: 1 });
        }
        palletIndicesByLoc.set(loc.id, idxs);
      }
      continue;
    }
    const w = loc.w * 0.94;
    const d = loc.d * 0.94;
    const h = loc.h * 0.96;
    const center: Vec3 = [loc.x, loc.z + h / 2, loc.y];
    slotIndexByLoc.set(loc.id, slots.length);
    slots.push({ loc, center, size: [w, h, d] });
    if (loc.lpn_count > 0) {
      const fill = Math.max(0.35, Math.min(1, loc.pallet_capacity > 0 ? loc.lpn_count / loc.pallet_capacity : 1));
      const ph = Math.max(0.5, (loc.h - 0.15) * 0.85 * fill);
      palletIndicesByLoc.set(loc.id, [pallets.length]);
      pallets.push({ locId: loc.id, status: loc.status, center: [loc.x, loc.z + ph / 2, loc.y], size: [w * 0.9, ph, d * 0.9], fill });
    }
  }

  // rack frames
  const uprights: FrameInstance[] = [];
  const beams: FrameInstance[] = [];
  const rackLabels: RackLabel[] = [];
  for (const r of p.racks) {
    const theta = (r.rotation_deg * Math.PI) / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const toWorld = (lx: number, ly: number, h: number): Vec3 => [r.x_m + lx * cos - ly * sin, h, r.y_m + lx * sin + ly * cos];
    const H = r.levels * r.level_height_m + 0.15;
    const L = r.bays * r.bay_width_m;
    const post = 0.09;
    for (let b = 0; b <= r.bays; b++) {
      for (const ly of [post / 2, r.depth_m - post / 2]) {
        uprights.push({ rackId: r.id, center: toWorld(b * r.bay_width_m, ly, H / 2), size: [post, H, post], rotY: -theta });
      }
    }
    for (let b = 0; b < r.bays; b++) {
      for (let lvl = 1; lvl <= r.levels; lvl++) {
        // beams at the base of every level above the floor and at the top
        const h = lvl === r.levels ? r.levels * r.level_height_m : lvl * r.level_height_m;
        for (const ly of [post / 2, r.depth_m - post / 2]) {
          beams.push({ rackId: r.id, center: toWorld((b + 0.5) * r.bay_width_m, ly, h), size: [r.bay_width_m - post, 0.1, post], rotY: -theta });
        }
      }
    }
    rackLabels.push({ rack: r, pos: toWorld(L / 2, r.depth_m / 2, H + 0.6) });
  }

  return { width, depth, height, slots, pallets, areas, uprights, beams, rackLabels, slotIndexByLoc, palletIndicesByLoc, locById };
}

export interface MapFilters {
  zoneId: string;
  type: string;
  status: string;
  availability: '' | 'AVAILABLE' | 'FULL';
}

export function locationVisible(loc: MapLocation, f: MapFilters, skuLocIds: Set<string> | null): boolean {
  if (f.zoneId && loc.zone_id !== f.zoneId) return false;
  if (f.type && loc.location_type !== f.type) return false;
  if (f.status && loc.status !== f.status) return false;
  if (f.availability === 'AVAILABLE' && !(loc.status === 'FREE' || loc.status === 'PARTIAL')) return false;
  if (f.availability === 'FULL' && loc.status !== 'OCCUPIED') return false;
  if (skuLocIds && !skuLocIds.has(loc.id)) return false;
  return true;
}
