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

  it('no station scanned: the warehouse assembly area is used (zone ARM, else its first floor area)', async () => {
    const body = await storedPallet(f, BODY, f.reserve[4]!.id, 24n);
    const r = await sup.post('/assembly/start', { inputs: [{ lpn_code: body.code, sku_code: f.skus[BODY]!.code, qty: 24 }], output_sku_code: f.skus[PAN]!.code, notes: 'sin escanear estación' }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.station.code).toBe(f.staging[0]!.code); // the fixture has no ARM zone → first floor area
    const where = await sql<{ loc: string }>(`SELECT loc.code AS loc FROM lpns l JOIN locations loc ON loc.id = l.current_location_id WHERE l.code = '${body.code}'`);
    expect(where[0]!.loc).toBe(f.staging[0]!.code);
    const done = await sup.post(`/assembly/${r.body.id}/complete`, { pallets: [{ cases: 2, pieces_per_case: 12 }] }, idem());
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    await expectReconciled();
  });

  it('confirm with an incomplete last case and defective pieces per pallet: 59 × 12 + 1 case of 10 + 2 defective = 720 consumed', async () => {
    const body = await storedPallet(f, BODY, f.reserve[5]!.id, 720n);
    const r = await sup.post('/assembly/start', { inputs: [{ lpn_code: body.code, sku_code: f.skus[BODY]!.code, qty: 720 }], output_sku_code: f.skus[PAN]!.code, notes: 'caja incompleta' }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const before = await skuTotal(f.skus[PAN]!.id);
    const done = await sup.post(`/assembly/${r.body.id}/complete`, { pallets: [{ cases: 59, pieces_per_case: 12, partial_pieces: 10, defective: 2 }] }, idem());
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.produced[0]).toMatchObject({ cases: 59, partial_pieces: 10, defective: 2, qty: '718' });
    expect(done.body.scrap_qty).toBe('2');
    expect(done.body.incident_id).toBeTruthy();
    expect((await skuTotal(f.skus[PAN]!.id)) - before).toBe(718n);
    const lpn = await sql<{ cases_count: number }>(`SELECT cases_count FROM lpns WHERE code = '${done.body.produced[0].lpn}'`);
    expect(lpn[0]!.cases_count).toBe(60); // 59 full + the incomplete one
    await expectReconciled();
  });

  it('after the assembly the operator changes a pallet destination from the list and the reprinted label shows it', async () => {
    const body = await storedPallet(f, BODY, f.reserve[6]!.id, 24n);
    const r = await sup.post('/assembly/start', { inputs: [{ lpn_code: body.code, sku_code: f.skus[BODY]!.code, qty: 24 }], output_sku_code: f.skus[PAN]!.code, notes: 'cambiar destino' }, idem());
    const done = await sup.post(`/assembly/${r.body.id}/complete`, { pallets: [{ cases: 2, pieces_per_case: 12 }] }, idem());
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const detail = await sup.get(`/assembly/${r.body.id}`);
    expect(detail.status).toBe(200);
    const out = detail.body.outputs[0];
    expect(out.putaway_task_id).toBeTruthy();
    expect(out.suggested_location).toBeTruthy();
    const first: string = out.suggested_location;
    const opts = await sup.get(`/putaway/tasks/${out.putaway_task_id}/options`);
    const pick = opts.body.options.find((o: { code: string }) => o.code !== first);
    expect(pick).toBeTruthy();
    const ch = await sup.post(`/putaway/tasks/${out.putaway_task_id}/choose`, { location_code: pick.code });
    expect(ch.status, JSON.stringify(ch.body)).toBe(200);
    const again = await sup.get(`/assembly/${r.body.id}`);
    expect(again.body.outputs[0].suggested_location).toBe(pick.code);
    // the label carries the destination
    const prev = await sup.post('/labels/preview', { label_type: 'LPN', entity_id: out.lpn.code });
    expect(prev.status, JSON.stringify(prev.body).slice(0, 200)).toBe(200);
    expect(prev.body.zpl).toContain('DESTINO');
    expect(prev.body.zpl).toContain(pick.code);
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
