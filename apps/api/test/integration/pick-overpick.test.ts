// Taking the whole pallet when the line asks for less: the extra is absorbed from the order's other lines of the product.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, expectReconciled, idem, makeFixture, sql, storedPallet, userWithRoles, type Client, type Fixture } from '../helpers.js';

let sup: Client;
let picker: Client;
let f: Fixture;
beforeAll(async () => {
  sup = await userWithRoles('ovpsup', ['SUPERVISOR']);
  picker = await userWithRoles('ovppick', ['PICKER']);
  f = await makeFixture({ skus: 2 });
});
afterAll(closeApp);

type Line = { id: string; lpn_code: string; location_barcode: string; qty: string; status: string };

describe('registering more than the line asks', () => {
  it('the whole pallet is accepted when the order needs it (other lines shrink); a real excess is still rejected', async () => {
    const a = await storedPallet(f, 0, f.reserve[0]!.id, 30n);
    const b = await storedPallet(f, 0, f.reserve[1]!.id, 30n);
    const o = await sup.post('/orders', { order_number: `OVP-${f.tag}`, customer_code: f.customer.code, lines: [{ sku_code: f.skus[0]!.code, qty: 40, uom_code: 'PIECE' }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    await sup.post(`/orders/${o.body.id}/accept`);
    // LPN order: 30 from A (whole) + 10 from B
    expect((await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: false, strategy: 'LPN' })).status).toBe(200);
    const t = await sup.post('/picking/tasks', { order_id: o.body.id });
    const v = await picker.post(`/picking/tasks/${t.body.task.id}/start`);
    const lines = v.body.lines as Line[];
    const lineB = lines.find((l) => l.lpn_code === b.code)!;
    const lineA = lines.find((l) => l.lpn_code === a.code)!;
    expect([lineA.qty, lineB.qty]).toEqual(['30', '10']);
    // the picker goes to B first and takes the whole pallet (30): 20 more than the line, but the order needs 40
    expect((await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: lineB.id, step: 'LOCATION', scanned: f.reserve[1]!.barcode }, idem())).status).toBe(200);
    expect((await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: lineB.id, step: 'LPN', scanned: b.code }, idem())).status).toBe(200);
    const tooMany = await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: lineB.id, step: 'QTY', qty: '45', uom_code: 'PIECE' }, idem());
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error).toBe('QTY_EXCEEDED');
    const whole = await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: lineB.id, step: 'QTY', qty: '30', uom_code: 'PIECE' }, idem());
    expect(whole.status, JSON.stringify(whole.body)).toBe(200);
    expect(whole.body).toMatchObject({ next: 'NEXT_LINE', picked: '30', absorbed: '20', outbound_lpn: b.code });
    // line A now asks for the remaining 10 only; pallet A keeps 20 available
    const after = await sql<{ lpn: string; qty: bigint; status: string; picked: bigint }>(`SELECT l.code AS lpn, ptl.qty, ptl.status, ptl.picked_qty AS picked FROM pick_task_lines ptl JOIN lpns l ON l.id = ptl.lpn_id WHERE ptl.pick_task_id = '${t.body.task.id}' ORDER BY l.code`);
    expect(after.find((x) => x.lpn === a.code)).toMatchObject({ qty: 10n, status: 'PENDING', picked: 0n });
    expect(after.find((x) => x.lpn === b.code)).toMatchObject({ qty: 30n, status: 'PICKED', picked: 30n });
    const balA = await sql<{ status: string; qty: bigint }>(`SELECT status, qty FROM inventory_balances WHERE lpn_id = '${a.id}' AND qty > 0 ORDER BY status`);
    expect(balA).toEqual([{ status: 'ALLOCATED', qty: 10n }, { status: 'AVAILABLE', qty: 20n }]);
    // finish A with 10 and the order is picked with exactly 40
    expect((await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: lineA.id, step: 'LOCATION', scanned: f.reserve[0]!.barcode }, idem())).status).toBe(200);
    expect((await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: lineA.id, step: 'LPN', scanned: a.code }, idem())).status).toBe(200);
    const last = await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: lineA.id, step: 'QTY', qty: '10', uom_code: 'PIECE' }, idem());
    expect(last.status, JSON.stringify(last.body)).toBe(200);
    expect(last.body.task_completed).toBe(true);
    const od = await sup.get(`/orders/${o.body.id}`);
    expect(od.body.status).toBe('PICKED');
    expect(od.body.lines[0]).toMatchObject({ required_qty: '40', picked_qty: '40', allocated_qty: '0' });
    await expectReconciled();
  });

  it('FULL_PALLET takes whole pallets first and the remainder from the smallest pallet that covers it', async () => {
    const big = await storedPallet(f, 1, f.reserve[2]!.id, 100n);
    const mid = await storedPallet(f, 1, f.reserve[3]!.id, 60n);
    const small = await storedPallet(f, 1, f.reserve[4]!.id, 25n);
    const o = await sup.post('/orders', { order_number: `FP-${f.tag}`, customer_code: f.customer.code, lines: [{ sku_code: f.skus[1]!.code, qty: 120, uom_code: 'PIECE' }] });
    await sup.post(`/orders/${o.body.id}/accept`);
    const r = await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: false, strategy: 'FULL_PALLET' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const al = await sql<{ lpn: string; qty: bigint }>(`SELECT l.code AS lpn, a.qty FROM allocations a JOIN lpns l ON l.id = a.lpn_id JOIN order_lines ol ON ol.id = a.order_line_id WHERE ol.order_id = '${o.body.id}' AND a.status = 'ACTIVE' ORDER BY a.qty DESC`);
    // 100 whole + 20 from the 25-pallet (not from the 60): the 60 stays whole
    expect(al).toEqual([{ lpn: big.code, qty: 100n }, { lpn: small.code, qty: 20n }]);
    expect(mid.code).toBeTruthy();
  });
});
