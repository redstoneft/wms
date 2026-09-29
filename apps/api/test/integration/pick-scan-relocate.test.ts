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
