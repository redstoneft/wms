// Assembly in two phases: components taken to the station and blocked (open order), confirmed later with the pallets
// produced and the defective pieces; an open order can be cancelled (inputs unblocked, put-away back to racks).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, expectReconciled, idem, makeFixture, skuTotal, sql, storedPallet, userWithRoles, type Client, type Fixture } from '../helpers.js';

let sup: Client;
let f: Fixture;
const BODY = 0;
const PAN = 1;

beforeAll(async () => {
  sup = await userWithRoles('asm2sup', ['SUPERVISOR']);
  f = await makeFixture({ skus: 3 });
});
afterAll(closeApp);

describe('assembly in two phases', () => {
  it('start: pallets move to the station and are blocked; the order is listed as open; the same pallet cannot be taken twice', async () => {
    const body = await storedPallet(f, BODY, f.reserve[0]!.id, 240n);
    const r = await sup.post('/assembly/start', { station_barcode: f.staging[0]!.barcode, inputs: [{ lpn_code: body.code, sku_code: f.skus[BODY]!.code, qty: 240 }], output_sku_code: f.skus[PAN]!.code, notes: 'armar sartenes rojas' }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.status).toBe('IN_PROGRESS');
    expect(r.body.moved[0]).toMatchObject({ lpn: body.code, blocked: '240', from: f.reserve[0]!.code });
    const where = await sql<{ loc: string; status: string; qty: bigint }>(`SELECT loc.code AS loc, b.status, b.qty FROM lpns l JOIN locations loc ON loc.id = l.current_location_id JOIN inventory_balances b ON b.lpn_id = l.id WHERE l.code = '${body.code}' AND b.qty > 0`);
    expect(where).toEqual([{ loc: f.staging[0]!.code, status: 'BLOCKED', qty: 240n }]);
    const again = await sup.post('/assembly/start', { station_barcode: f.staging[0]!.barcode, inputs: [{ lpn_code: body.code, sku_code: f.skus[BODY]!.code, qty: 10 }], output_sku_code: f.skus[PAN]!.code, notes: 'otra vez' }, idem());
    expect(again.status).toBe(422);
    expect(again.body.error).toBe('ASSEMBLY_LPN_BUSY');
    const open = await sup.get('/assembly?status=IN_PROGRESS');
    expect(open.body.some((o: { id: string }) => o.id === r.body.id)).toBe(true);
    await expectReconciled();

    // finish: 2 pallets of 9 cases × 12 (216) + 24 defective = 240 consumed
    const before = await skuTotal(f.skus[PAN]!.id);
    const short = await sup.post(`/assembly/${r.body.id}/complete`, { pallets: [{ cases: 9, pieces_per_case: 12 }, { cases: 9, pieces_per_case: 12 }] }, idem());
    expect(short.status).toBe(422);
    expect(short.body.error).toBe('ASSEMBLY_UNBALANCED');
    const done = await sup.post(`/assembly/${r.body.id}/complete`, { pallets: [{ cases: 9, pieces_per_case: 12 }, { cases: 9, pieces_per_case: 12 }], scrap: { qty: 24, reason: 'mangos rotos' } }, idem());
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.status).toBe('COMPLETED');
    expect(done.body.produced).toHaveLength(2);
    expect(done.body.produced.every((p: { putaway_task_id: string | null }) => !!p.putaway_task_id)).toBe(true);
    expect(done.body.consumed[0].lpn_status).toBe('CONSUMED');
    expect(done.body.scrap_qty).toBe('24');
    expect(done.body.incident_id).toBeTruthy();
    expect((await skuTotal(f.skus[PAN]!.id)) - before).toBe(216n);
    expect((await sup.post(`/assembly/${r.body.id}/complete`, { pallets: [{ cases: 1, pieces_per_case: 1 }] }, idem())).status).toBe(422); // already completed
    await expectReconciled();
  });

  it('cancel: the reserved pallet is unblocked and gets a put-away task back to the racks', async () => {
    const body = await storedPallet(f, BODY, f.reserve[2]!.id, 48n);
    const r = await sup.post('/assembly/start', { station_barcode: f.staging[1]!.barcode, inputs: [{ lpn_code: body.code, sku_code: f.skus[BODY]!.code, qty: 48 }], output_sku_code: f.skus[PAN]!.code, notes: 'se cancela' }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const c = await sup.post(`/assembly/${r.body.id}/cancel`, { reason: 'no llegó la línea' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.released[0].lpn).toBe(body.code);
    expect(c.body.released[0].putaway_task_id).toBeTruthy();
    const bal = await sql<{ status: string; qty: bigint }>(`SELECT b.status, b.qty FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id WHERE l.code = '${body.code}' AND b.qty > 0`);
    expect(bal).toEqual([{ status: 'AVAILABLE', qty: 48n }]);
    await expectReconciled();
  });
});
