// Boxes (compatibility group CAJAS) never share an outbound pallet with other merchandise: the picker gets a new pallet.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, expectReconciled, idem, makeFixture, sql, storedPallet, userWithRoles, type Client, type Fixture } from '../helpers.js';

let sup: Client;
let picker: Client;
let f: Fixture;
beforeAll(async () => {
  sup = await userWithRoles('bxsup', ['SUPERVISOR']);
  picker = await userWithRoles('bxpick', ['PICKER']);
  f = await makeFixture({ skus: 3 });
  await sql(`UPDATE skus SET compatibility_group = 'CAJAS' WHERE id = '${f.skus[0]!.id}'`);
});
afterAll(closeApp);

type Line = { id: string; lpn_code: string; sku_code: string };
const pickLine = async (taskId: string, l: Line, locBarcode: string, qty: string) => {
  expect((await picker.post('/picking/scan', { pick_task_id: taskId, line_id: l.id, step: 'LOCATION', scanned: locBarcode }, idem())).status).toBe(200);
  expect((await picker.post('/picking/scan', { pick_task_id: taskId, line_id: l.id, step: 'LPN', scanned: l.lpn_code }, idem())).status).toBe(200);
  const r = await picker.post('/picking/scan', { pick_task_id: taskId, line_id: l.id, step: 'QTY', qty, uom_code: 'PIECE' }, idem());
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { outbound_lpn: string; pallet_switched: boolean };
};

describe('boxes travel alone', () => {
  it('a box line after other merchandise opens a new outbound pallet, and the other way round', async () => {
    const box = await storedPallet(f, 0, f.reserve[0]!.id, 50n);
    const pan = await storedPallet(f, 1, f.reserve[1]!.id, 50n);
    const pot = await storedPallet(f, 2, f.reserve[2]!.id, 50n);
    const o = await sup.post('/orders', { order_number: `BOX-${f.tag}`, customer_code: f.customer.code, lines: [{ sku_code: f.skus[1]!.code, qty: 5, uom_code: 'PIECE' }, { sku_code: f.skus[0]!.code, qty: 5, uom_code: 'PIECE' }, { sku_code: f.skus[2]!.code, qty: 5, uom_code: 'PIECE' }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    await sup.post(`/orders/${o.body.id}/accept`);
    expect((await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: false, strategy: 'LPN' })).status).toBe(200);
    const t = await sup.post('/picking/tasks', { order_id: o.body.id });
    const v = await picker.post(`/picking/tasks/${t.body.task.id}/start`);
    const lines = v.body.lines as Line[];
    const lPan = lines.find((l) => l.lpn_code === pan.code)!;
    const lBox = lines.find((l) => l.lpn_code === box.code)!;
    const lPot = lines.find((l) => l.lpn_code === pot.code)!;
    const r1 = await pickLine(t.body.task.id, lPan, f.reserve[1]!.barcode, '5');
    expect(r1.pallet_switched).toBe(false);
    const r2 = await pickLine(t.body.task.id, lBox, f.reserve[0]!.barcode, '5');
    expect(r2.pallet_switched).toBe(true);
    expect(r2.outbound_lpn).not.toBe(r1.outbound_lpn);
    const r3 = await pickLine(t.body.task.id, lPot, f.reserve[2]!.barcode, '5');
    expect(r3.pallet_switched).toBe(true);
    expect(r3.outbound_lpn).not.toBe(r2.outbound_lpn);
    const pallets = await sql<{ code: string; skus: bigint }>(`SELECT l.code, count(DISTINCT b.sku_id)::bigint AS skus FROM lpns l JOIN inventory_balances b ON b.lpn_id = l.id AND b.qty > 0 WHERE l.order_id = '${o.body.id}' GROUP BY l.code ORDER BY l.code`);
    expect(pallets.length).toBe(3);
    expect(pallets.every((p) => p.skus === 1n)).toBe(true);
    await expectReconciled();
  });
});
