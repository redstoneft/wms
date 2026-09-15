// Rack bridges: a beam over a walkway after a bay, with positions only on the upper level; bays after it shift.
// Loose label batches by explicit codes (missing labels of a rack + the bridge) with a custom order name.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeFixture, sql, userWithRoles, type Client, type Fixture } from '../helpers.js';

let sup: Client;
let f: Fixture;
let rackId: string;
let aisleId: string;
let zoneCode: string;

beforeAll(async () => {
  sup = await userWithRoles('brsup', ['SUPERVISOR']);
  f = await makeFixture({ skus: 1 });
  const a = await sql<{ id: string; zone_code: string }>(`SELECT a.id, z.code AS zone_code FROM aisles a JOIN zones z ON z.id = a.zone_id WHERE z.warehouse_id = '${f.warehouse_id}' AND z.zone_type = 'STORAGE' LIMIT 1`);
  aisleId = a[0]!.id;
  zoneCode = a[0]!.zone_code;
});
afterAll(closeApp);

describe('rack bridge (puente) between two bays', () => {
  it('creates the bridge positions with their own name on the bridge level only, and shifts the bays after it', async () => {
    const r = await sup.post('/racks', {
      aisle_id: aisleId,
      code: 'R07',
      bays: 4,
      levels: 3,
      positions_per_bay: 2,
      bay_width_m: 2.7,
      level_height_m: 1.8,
      depth_m: 1.1,
      x_m: 10,
      y_m: 20,
      rotation_deg: 0,
      bridges: [{ after_bay: 2, width_m: 3, levels: [3], positions: 2, code: 'PTE' }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    rackId = r.body.id;
    expect(r.body.generated.created).toBe(4 * 3 * 2 + 2);
    const locs = await sql<{ code: string; level: number; position: number; bay: number; x_m: string; z_m: string }>(`SELECT code, level, position, bay, x_m::text, z_m::text FROM locations WHERE rack_id = '${rackId}' ORDER BY position, level`);
    const bridge = locs.filter((l) => l.code.includes('-PTE-'));
    expect(bridge.map((l) => l.code)).toEqual([`${zoneCode}-01-PTE-N03-P01`, `${zoneCode}-01-PTE-N03-P02`]);
    expect(bridge.every((l) => l.level === 3 && l.bay === 2)).toBe(true);
    // bridge spans x 10 + 2×2.7 = 15.4 … 18.4: slot centres at 16.15 and 17.65, on level 3 (z = 3.6)
    expect(bridge.map((l) => Number(l.x_m))).toEqual([16.15, 17.65]);
    expect(bridge.every((l) => Number(l.z_m) === 3.6)).toBe(true);
    // bay 3 starts after the bridge: first slot centre at 18.4 + 0.675
    const bay3 = locs.find((l) => l.code.endsWith('-N01-P05'))!;
    expect(Number(bay3.x_m)).toBe(19.08);
    // bays before the bridge are untouched
    const bay2 = locs.find((l) => l.code.endsWith('-N01-P03'))!;
    expect(Number(bay2.x_m)).toBe(13.38);
    // the map carries the bridge so the 3D can draw it
    const map = await sup.get(`/map?warehouse_id=${f.warehouse_id}`);
    const rack = map.body.racks.find((x: { id: string }) => x.id === rackId);
    expect(rack.bridges).toEqual([{ after_bay: 2, width_m: 3, levels: [3], positions: 2, code: 'PTE' }]);
  });

  it('rejects a bridge after the last bay or above the rack', async () => {
    const bad = await sup.patch(`/racks/${rackId}`, { bridges: [{ after_bay: 4, width_m: 3, levels: [3], positions: 2, code: 'PTE' }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe('BRIDGE_AFTER_LAST_BAY');
    const high = await sup.patch(`/racks/${rackId}`, { bridges: [{ after_bay: 2, width_m: 3, levels: [4], positions: 2, code: 'PTE' }] });
    expect(high.status).toBe(422);
    expect(high.body.error).toBe('BRIDGE_LEVEL');
  });

  it('loose labels: explicit codes (scanned or typed) in one batch with a custom order name; bridge labels say PUENTE', async () => {
    const codes = [`LOC-${zoneCode}-01-R07-N01-P07`, `${zoneCode}-01-R07-N02-P07`, `${zoneCode}-01-PTE-N03-P01`, `${zoneCode}-01-PTE-N03-P02`];
    const res = await sup.raw('GET', `/labels/locations.embarque.json?codes=${encodeURIComponent(codes.join(','))}&title=R07-FALTANTES-Y-PUENTE`);
    expect(res.status).toBe(200);
    const pedido = JSON.parse(res.text);
    expect(pedido.encabezado.num_orden_compra).toBe(`WMS-WH-${f.tag}-R07-FALTANTES-Y-PUENTE`);
    expect(pedido.etiquetas).toHaveLength(4);
    expect(pedido.lineas.filter((l: { descripcion: string }) => l.descripcion.includes('PUENTE'))).toHaveLength(2);
    expect(pedido.etiquetas.every((e: { zpl: string }) => e.zpl.includes('^XA'))).toBe(true);
    const sheet = await sup.raw('GET', `/labels/locations.html?codes=${encodeURIComponent(codes.join(','))}&title=prueba`);
    expect(sheet.status).toBe(200);
    expect((sheet.text.match(/class="l"/g) ?? []).length).toBe(4);
    expect(sheet.text).toContain('PUENTE');
    const missing = await sup.raw('GET', `/labels/locations.embarque.json?codes=${zoneCode}-01-R07-N01-P07,${zoneCode}-01-R07-N09-P99`);
    expect(missing.status).toBe(404);
  });
});
