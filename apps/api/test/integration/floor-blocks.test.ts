// Floor blocks: a grid of rack-less storage locations that the map draws as areas and put-away can assign.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeFixture, sql, userWithRoles, type Client, type Fixture } from '../helpers.js';

let sup: Client;
let f: Fixture;
beforeAll(async () => {
  sup = await userWithRoles('fbsup', ['SUPERVISOR']);
  f = await makeFixture({ skus: 1 });
});
afterAll(closeApp);

describe('floor blocks', () => {
  it('creates the grid with row letters and column numbers, positions and capacity; rejects clashes and out-of-bounds', async () => {
    const r = await sup.post('/locations/floor-blocks', { warehouse_id: f.warehouse_id, prefix: `PISO-${f.tag}`, x_m: 1, y_m: 30, rows: 2, cols: 3, block_width_m: 2.4, block_depth_m: 2.4, gap_x_m: 0, gap_y_m: 1.2, pallet_capacity: 8 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.created).toBe(6);
    expect(r.body.locations.map((l: { code: string }) => l.code)).toEqual([`PISO-${f.tag}-A01`, `PISO-${f.tag}-A02`, `PISO-${f.tag}-A03`, `PISO-${f.tag}-B01`, `PISO-${f.tag}-B02`, `PISO-${f.tag}-B03`]);
    const b02 = r.body.locations[4];
    expect(b02).toMatchObject({ x_m: 3.4, y_m: 33.6, barcode: `LOC-PISO-${f.tag}-B02` });
    const row = await sql<{ location_type: string; pallet_capacity: number; rack_id: string | null; width_m: string; depth_m: string }>(`SELECT location_type, pallet_capacity, rack_id, width_m::text, depth_m::text FROM locations WHERE code = 'PISO-${f.tag}-B02'`);
    expect(row[0]).toEqual({ location_type: 'RESERVE', pallet_capacity: 8, rack_id: null, width_m: '2.40', depth_m: '2.40' });
    // the map lists them as areas
    const map = await sup.get(`/map?warehouse_id=${f.warehouse_id}`);
    expect(map.status).toBe(200);
    const codes = (map.body.locations as { code: string; rack_id: string | null }[]).filter((l) => l.code.startsWith(`PISO-${f.tag}`));
    expect(codes).toHaveLength(6);
    expect(codes.every((l) => l.rack_id === null)).toBe(true);
    // same codes again: conflict, nothing created
    const dup = await sup.post('/locations/floor-blocks', { warehouse_id: f.warehouse_id, prefix: `PISO-${f.tag}`, x_m: 1, y_m: 30, rows: 1, cols: 1, block_width_m: 2.4, block_depth_m: 2.4, pallet_capacity: 8 });
    expect(dup.status).toBe(409);
    // a second grid continues the numbering (columns 4..5) and can grow towards the front
    const more = await sup.post('/locations/floor-blocks', { warehouse_id: f.warehouse_id, prefix: `PISO-${f.tag}`, x_m: 8.2, y_m: 30, rows: 1, cols: 2, block_width_m: 2.4, block_depth_m: 2.4, pallet_capacity: 8, first_col: 4, rows_direction: 'DOWN' });
    expect(more.status, JSON.stringify(more.body)).toBe(201);
    expect(more.body.locations.map((l: { code: string; y_m: number }) => [l.code, l.y_m])).toEqual([[`PISO-${f.tag}-A04`, 27.6], [`PISO-${f.tag}-A05`, 27.6]]);
    const out = await sup.post('/locations/floor-blocks', { warehouse_id: f.warehouse_id, prefix: `PISO-${f.tag}-X`, x_m: 1, y_m: 1000, rows: 1, cols: 1, block_width_m: 2.4, block_depth_m: 2.4, pallet_capacity: 8 });
    expect(out.status).toBe(422);
    expect(out.body.error).toBe('OUT_OF_BOUNDS');
  });
});
