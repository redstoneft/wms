import { describe, expect, it } from 'vitest';
import { locationCode, pickSequence, positionWorldCoords } from '../../src/modules/layout/service.js';
import { evaluateFit } from '../../src/inventory/location-rules.js';
import type { LocationRow } from '../../src/inventory/ledger.js';

describe('layout geometry', () => {
  it('builds WAREHOUSE→ZONE→AISLE→RACK→LEVEL→POSITION codes', () => {
    expect(locationCode('A', '03', 'R05', 2, 4)).toBe('A-03-R05-N02-P04');
    expect(locationCode('A', '03', '5', 2, 4)).toBe('A-03-R05-N02-P04');
  });
  it('computes world coordinates with rotation', () => {
    const g = { bays: 2, levels: 2, positions_per_bay: 1, bay_width_m: 2, level_height_m: 1.5, depth_m: 1, x_m: 10, y_m: 5, rotation_deg: 0 };
    expect(positionWorldCoords(g, 1, 1, 1)).toEqual({ x: 11, y: 5.5, z: 0 });
    expect(positionWorldCoords(g, 2, 2, 1)).toEqual({ x: 13, y: 5.5, z: 1.5 });
    const r = positionWorldCoords({ ...g, rotation_deg: 90 }, 1, 1, 1);
    expect(r.x).toBeCloseTo(9.5, 1);
    expect(r.y).toBeCloseTo(6, 1);
  });
  it('pick sequence orders aisle → rack → bay → level → position', () => {
    expect(pickSequence('01', 'R01', 1, 1, 1)).toBeLessThan(pickSequence('01', 'R01', 1, 2, 1));
    expect(pickSequence('01', 'R01', 2, 1, 1)).toBeGreaterThan(pickSequence('01', 'R01', 1, 3, 1));
    expect(pickSequence('02', 'R01', 1, 1, 1)).toBeGreaterThan(pickSequence('01', 'R09', 9, 9, 9));
  });
});

describe('location fit rules', () => {
  const loc = (over: Partial<LocationRow> = {}): LocationRow => ({
    id: 'l',
    warehouse_id: 'w',
    zone_id: null,
    rack_id: null,
    code: 'A-01-R01-N01-P01',
    barcode: 'LOC-A',
    location_type: 'RESERVE',
    admin_status: 'ACTIVE',
    pallet_capacity: 1,
    max_weight_kg: '1500',
    height_m: '1.8',
    restrictions: null,
    is_active: true,
    level: 1,
    pick_sequence: 1,
    ...over,
  });
  const occ = (o: Partial<Parameters<typeof evaluateFit>[1]> = {}) => ({ lpn_count: 0, reserved_count: 0, weight_kg: 0, lpn_ids: [], sku_ids: [], compatibility_groups: [], ...o });
  const profile = (p: Partial<Parameters<typeof evaluateFit>[2]> = {}) => ({ sku_ids: ['s'], families: ['F'], compatibility_groups: ['G'], weight_kg: 500, height_cm: 150, ...p });

  it('accepts a free, active, compatible location', () => {
    expect(evaluateFit(loc(), occ(), profile()).ok).toBe(true);
  });
  it('rejects full, reserved, blocked, quarantine, inactive', () => {
    expect(evaluateFit(loc(), occ({ lpn_count: 1 }), profile()).reasons).toContain('LOCATION_FULL');
    expect(evaluateFit(loc(), occ({ reserved_count: 1 }), profile()).reasons).toContain('LOCATION_FULL');
    expect(evaluateFit(loc({ admin_status: 'BLOCKED' }), occ(), profile()).reasons).toContain('LOCATION_BLOCKED');
    expect(evaluateFit(loc({ admin_status: 'QUARANTINE' }), occ(), profile()).reasons).toContain('LOCATION_QUARANTINE');
    expect(evaluateFit(loc({ is_active: false }), occ(), profile()).reasons).toContain('LOCATION_INACTIVE');
  });
  it('rejects weight and height violations', () => {
    expect(evaluateFit(loc(), occ({ weight_kg: 1200 }), profile({ weight_kg: 400 })).reasons).toContain('WEIGHT_EXCEEDED');
    expect(evaluateFit(loc(), occ(), profile({ height_cm: 200 })).reasons).toContain('HEIGHT_EXCEEDED');
    expect(evaluateFit(loc({ restrictions: { max_height_cm: 100 } }), occ(), profile({ height_cm: 120 })).reasons).toContain('HEIGHT_EXCEEDED');
  });
  it('enforces family / compatibility restrictions and neighbour compatibility', () => {
    expect(evaluateFit(loc({ restrictions: { allowed_families: ['X'] } }), occ(), profile()).reasons).toContain('FAMILY_NOT_ALLOWED');
    expect(evaluateFit(loc({ restrictions: { allowed_compatibility_groups: ['Z'] } }), occ(), profile()).reasons).toContain('COMPAT_GROUP_NOT_ALLOWED');
    expect(evaluateFit(loc({ pallet_capacity: 2 }), occ({ lpn_count: 1, compatibility_groups: ['CHEM'] }), profile({ compatibility_groups: ['FOOD'] })).reasons).toContain('INCOMPATIBLE_WITH_CONTENTS');
    expect(evaluateFit(loc({ pallet_capacity: 2 }), occ({ lpn_count: 1, compatibility_groups: ['FOOD'] }), profile({ compatibility_groups: ['FOOD'] })).ok).toBe(true);
  });
});
