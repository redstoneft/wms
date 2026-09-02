// Batch location labels: printable sheet, ZPL file and direct print for a whole rack.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, sql, userWithRoles, type Client } from '../helpers.js';

let sup: Client;
let rackId: string;
let rackLocations = 0;

beforeAll(async () => {
  sup = await userWithRoles('lblsup', ['SUPERVISOR']);
  const r = await sql<{ rack_id: string; n: bigint }>(`SELECT rack_id, count(*) AS n FROM locations WHERE rack_id IS NOT NULL AND is_active GROUP BY rack_id ORDER BY n DESC LIMIT 1`);
  rackId = r[0]!.rack_id;
  rackLocations = Number(r[0]!.n);
});
afterAll(closeApp);

describe('location labels in batch (labelling a rack)', () => {
  it('renders a printable sheet with one label per position, in picking order', async () => {
    const res = await sup.raw('GET', `/labels/locations.html?rack_id=${rackId}`);
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/html');
    const html = res.text;
    expect((html.match(/class="l"/g) ?? []).length).toBe(rackLocations);
    expect(html).toContain('data:image/png;base64,'); // Code128 embedded
    const codes = [...html.matchAll(/<div class="code">([^<]+)<\/div>/g)].map((m) => m[1]);
    const ordered = await sql<{ code: string }>(`SELECT code FROM locations WHERE rack_id = '${rackId}' AND is_active ORDER BY pick_sequence, code`);
    expect(codes).toEqual(ordered.map((o) => o.code));
  });

  it('exports a ZPL file with every label and audits the export', async () => {
    const res = await sup.raw('GET', `/labels/locations.zpl?rack_id=${rackId}`);
    expect(res.status).toBe(200);
    expect(String(res.headers['content-disposition'])).toContain('.zpl');
    expect((res.text.match(/\^XA/g) ?? []).length).toBe(rackLocations);
    expect(res.text).toContain('LOC-');
    const aud = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM audit_logs WHERE action = 'labels.location_zpl' AND entity_id = '${rackId}'`);
    expect(aud[0]!.n).toBeGreaterThanOrEqual(1n);
  });

  it('rejects a batch without filter and a batch for an unknown rack', async () => {
    const none = await sup.raw('GET', '/labels/locations.html');
    expect(none.status).toBe(422);
    const unknown = await sup.raw('GET', '/labels/locations.zpl?rack_id=00000000-0000-7000-8000-000000000001');
    expect(unknown.status).toBe(404);
  });

  it('direct print reports per-position failures when the printer is unreachable, and stops early', async () => {
    const r = await sup.post('/labels/print-batch', { rack_id: rackId });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(rackLocations);
    expect(r.body.sent).toBe(0);
    expect(r.body.failed.length).toBeGreaterThanOrEqual(1);
    expect(r.body.failed.length).toBeLessThanOrEqual(3);
  });

  it('moving a rack (PATCH with coordinates only) keeps its bays, levels and positions intact', async () => {
    const before = await sql<{ n: bigint; bays: number; ppb: number }>(`SELECT count(*) AS n, r.bays, r.positions_per_bay AS ppb FROM locations l JOIN racks r ON r.id = l.rack_id WHERE l.rack_id = '${rackId}' AND l.is_active GROUP BY r.bays, r.positions_per_bay`);
    const rack = await sql<{ x_m: string; y_m: string }>(`SELECT x_m::text, y_m::text FROM racks WHERE id = '${rackId}'`);
    const r = await sup.patch(`/racks/${rackId}`, { x_m: Number(rack[0]!.x_m) + 0.5, y_m: Number(rack[0]!.y_m) });
    expect(r.status).toBe(200);
    expect(r.body.generated).toMatchObject({ deactivated: 0, created: 0 });
    const after = await sql<{ n: bigint; bays: number; ppb: number }>(`SELECT count(*) AS n, r.bays, r.positions_per_bay AS ppb FROM locations l JOIN racks r ON r.id = l.rack_id WHERE l.rack_id = '${rackId}' AND l.is_active GROUP BY r.bays, r.positions_per_bay`);
    expect(after).toEqual(before);
    await sup.patch(`/racks/${rackId}`, { x_m: Number(rack[0]!.x_m) }); // restore
  });
});
