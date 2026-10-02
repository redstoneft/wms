// Scanning another position that holds the same product moves the pick line there instead of rejecting.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, expectReconciled, idem, makeFixture, sql, storedPallet, userWithRoles, type Client, type Fixture } from '../helpers.js';

let sup: Client;
let picker: Client;
let f: Fixture;
beforeAll(async () => {
  sup = await userWithRoles('relsup', ['SUPERVISOR']);
  picker = await userWithRoles('relpick', ['PICKER']);
  f = await makeFixture({ skus: 2 });
});
afterAll(closeApp);

describe('picking from the position the picker actually scanned', () => {
  it('another pallet of the same product at the scanned position: the line changes to it; a position without the product is still rejected', async () => {
    const a = await storedPallet(f, 0, f.reserve[0]!.id, 50n);
    const b = await storedPallet(f, 0, f.reserve[1]!.id, 50n);
    await storedPallet(f, 1, f.reserve[2]!.id, 50n);
    const o = await sup.post('/orders', { order_number: `REL-${f.tag}`, customer_code: f.customer.code, lines: [{ sku_code: f.skus[0]!.code, qty: 20, uom_code: 'PIECE' }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    await sup.post(`/orders/${o.body.id}/accept`);
    expect((await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: false, strategy: 'LPN' })).status).toBe(200);
    const t = await sup.post('/picking/tasks', { order_id: o.body.id });
    const v = await picker.post(`/picking/tasks/${t.body.task.id}/start`);
    const line = v.body.lines[0] as { id: string; lpn_code: string; location_code: string };
    const planned = line.lpn_code === a.code ? a : b;
    const other = planned.id === a.id ? b : a;
    const otherLoc = planned.id === a.id ? f.reserve[1]! : f.reserve[0]!;
    // a position that holds another product: rejected with the reason
    const wrong = await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: line.id, step: 'LOCATION', scanned: f.reserve[2]!.barcode }, idem());
    expect(wrong.status).toBe(422);
    expect(wrong.body.error).toBe('WRONG_LOCATION');
    expect(wrong.body.message).toContain('no hay');
    // the position of the other pallet with the same product: the line moves there
    const ok = await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: line.id, step: 'LOCATION', scanned: otherLoc.barcode }, idem());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ next: 'LPN', expected_lpn: other.code, relocated_from: planned.code });
    expect(ok.body.relocated).toMatchObject({ split: false, qty: '20', leftover: '0', to_lpn: other.code });
    const lineId = ok.body.line_id as string;
    expect((await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: lineId, step: 'LPN', scanned: other.code }, idem())).status).toBe(200);
    const q = await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: lineId, step: 'QTY', qty: '20', uom_code: 'PIECE' }, idem());
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    expect(q.body.task_completed).toBe(true);
    // the planned pallet is untouched and available again; the pieces left the other one
    const bal = await sql<{ lpn: string; status: string; qty: bigint }>(`SELECT l.code AS lpn, b.status, b.qty FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id WHERE l.id IN ('${a.id}','${b.id}') AND b.qty > 0 ORDER BY l.code, b.status`);
    expect(bal.find((x) => x.lpn === planned.code)).toMatchObject({ status: 'AVAILABLE', qty: 50n });
    expect(bal.find((x) => x.lpn === other.code)).toMatchObject({ status: 'AVAILABLE', qty: 30n });
    await expectReconciled();
  });
});

describe('pallet step scans', () => {
  it('an outbound pallet of another order sitting in the slot does not force an LPN scan; a location label gets a clear message', async () => {
    // own fixture: a single pallet of the product, so both orders are planned on it
    const g = await makeFixture({ skus: 1, reserveBays: 2, levels: 1 });
    const src = await storedPallet(g, 0, g.reserve[0]!.id, 40n);
    // order A picks 10 here: its outbound pallet is born in this slot
    const a = await sup.post('/orders', { order_number: `OA-${g.tag}`, customer_code: g.customer.code, lines: [{ sku_code: g.skus[0]!.code, qty: 10, uom_code: 'PIECE' }] });
    await sup.post(`/orders/${a.body.id}/accept`);
    expect((await sup.post('/orders/allocate', { order_id: a.body.id, allow_partial: false, strategy: 'LPN' })).status).toBe(200);
    const ta = await sup.post('/picking/tasks', { order_id: a.body.id });
    const va = await picker.post(`/picking/tasks/${ta.body.task.id}/start`);
    const la = va.body.lines[0] as { id: string };
    expect((await picker.post('/picking/scan', { pick_task_id: ta.body.task.id, line_id: la.id, step: 'LOCATION', scanned: g.reserve[0]!.barcode }, idem())).status).toBe(200);
    expect((await picker.post('/picking/scan', { pick_task_id: ta.body.task.id, line_id: la.id, step: 'LPN', scanned: src.code }, idem())).status).toBe(200);
    expect((await picker.post('/picking/scan', { pick_task_id: ta.body.task.id, line_id: la.id, step: 'QTY', qty: '10', uom_code: 'PIECE' }, idem())).status).toBe(200);
    // order B picks 5 of sku1 from the same slot: scanning the PRODUCT barcode must be enough (the outbound pallet of A does not count)
    const b = await sup.post('/orders', { order_number: `OB-${g.tag}`, customer_code: g.customer.code, lines: [{ sku_code: g.skus[0]!.code, qty: 5, uom_code: 'PIECE' }] });
    await sup.post(`/orders/${b.body.id}/accept`);
    expect((await sup.post('/orders/allocate', { order_id: b.body.id, allow_partial: false, strategy: 'LPN' })).status).toBe(200);
    const tb = await sup.post('/picking/tasks', { order_id: b.body.id });
    const vb = await picker.post(`/picking/tasks/${tb.body.task.id}/start`);
    const lb = vb.body.lines[0] as { id: string; lpn_code: string };
    expect(lb.lpn_code).toBe(src.code);
    expect((await picker.post('/picking/scan', { pick_task_id: tb.body.task.id, line_id: lb.id, step: 'LOCATION', scanned: g.reserve[0]!.barcode }, idem())).status).toBe(200);
    // a location label at the pallet step: clear message, nothing changes
    const loc = await picker.post('/picking/scan', { pick_task_id: tb.body.task.id, line_id: lb.id, step: 'LPN', scanned: g.reserve[0]!.barcode }, idem());
    expect(loc.status).toBe(422);
    expect(loc.body.error).toBe('SCAN_PALLET');
    expect(loc.body.message).toContain('escanea la tarima');
    const prod = await picker.post('/picking/scan', { pick_task_id: tb.body.task.id, line_id: lb.id, step: 'LPN', scanned: g.skus[0]!.case_barcode }, idem());
    expect(prod.status, JSON.stringify(prod.body)).toBe(200);
    expect(prod.body.next).toBe('QTY');
    expect((await picker.post('/picking/scan', { pick_task_id: tb.body.task.id, line_id: lb.id, step: 'QTY', qty: '5', uom_code: 'PIECE' }, idem())).status).toBe(200);
    await expectReconciled();
  });
});
