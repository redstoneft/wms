// Admin changes the quantities of an order that was already picked: excess back to stock, shortfall picked again.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, expectReconciled, idem, makeFixture, skuTotal, sql, storedPallet, userWithRoles, type Client, type Fixture } from '../helpers.js';

let sup: Client;
let picker: Client;
let adminC: Client;
let f: Fixture;
beforeAll(async () => {
  sup = await userWithRoles('oadjsup', ['SUPERVISOR']);
  picker = await userWithRoles('oadjpick', ['PICKER']);
  adminC = await userWithRoles('oadjadm', ['ADMIN']);
  const enroll = await adminC.post('/auth/mfa/enroll');
  const { totp } = await import('../../src/lib/crypto.js');
  expect((await adminC.post('/auth/mfa/enroll/confirm', { code: totp(enroll.body.secret) })).status).toBe(200);
  f = await makeFixture({ skus: 3 });
});
afterAll(closeApp);

async function pickAll(taskId: string) {
  const v = await picker.post(`/picking/tasks/${taskId}/start`);
  for (const line of v.body.lines as { id: string; location_barcode: string; lpn_code: string; qty: string }[]) {
    expect((await picker.post('/picking/scan', { pick_task_id: taskId, line_id: line.id, step: 'LOCATION', scanned: line.location_barcode }, idem())).status).toBe(200);
    expect((await picker.post('/picking/scan', { pick_task_id: taskId, line_id: line.id, step: 'LPN', scanned: line.lpn_code }, idem())).status).toBe(200);
    expect((await picker.post('/picking/scan', { pick_task_id: taskId, line_id: line.id, step: 'QTY', qty: line.qty, uom_code: 'PIECE' }, idem())).status).toBe(200);
  }
}

describe('adjusting a picked order', () => {
  it('less than picked returns the excess to stock with a put-away task; more than picked reopens picking; only admin', async () => {
    await storedPallet(f, 0, f.reserve[0]!.id, 100n);
    await storedPallet(f, 1, f.reserve[1]!.id, 100n);
    const o = await sup.post('/orders', { order_number: `ADJ-${f.tag}`, customer_code: f.customer.code, lines: [{ sku_code: f.skus[0]!.code, qty: 30, uom_code: 'PIECE' }, { sku_code: f.skus[1]!.code, qty: 20, uom_code: 'PIECE' }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    await sup.post(`/orders/${o.body.id}/accept`);
    expect((await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: false, strategy: 'LPN' })).status).toBe(200);
    const t = await sup.post('/picking/tasks', { order_id: o.body.id });
    await pickAll(t.body.task.id);
    expect((await sup.get(`/orders/${o.body.id}`)).body.status).toBe('PICKED');
    const total0 = await skuTotal(f.skus[0]!.id);
    // supervisor cannot
    expect((await sup.post('/orders/adjust', { order_id: o.body.id, reason: 'el cliente bajó el pedido', lines: [{ sku_code: f.skus[0]!.code, qty: 18 }] })).status).toBe(403);
    // sku0: 30 → 18 (12 back to stock) · sku1: 20 → 26 (6 more to pick) · sku2: new line of 5
    const r = await adminC.post('/orders/adjust', { order_id: o.body.id, reason: 'el cliente cambió cantidades', lines: [{ sku_code: f.skus[0]!.code, qty: 18 }, { sku_code: f.skus[1]!.code, qty: 26 }, { sku_code: f.skus[2]!.code, qty: 5 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('PARTIALLY_ALLOCATED');
    const c0 = r.body.changes.find((c: { sku: string }) => c.sku === f.skus[0]!.code);
    expect(c0).toMatchObject({ before: '30', after: '18', returned_to_stock: '12', to_pick: '0' });
    expect(c0.new_lpns).toHaveLength(1);
    const c1 = r.body.changes.find((c: { sku: string }) => c.sku === f.skus[1]!.code);
    expect(c1).toMatchObject({ before: '20', after: '26', returned_to_stock: '0', to_pick: '6' });
    expect(r.body.changes.find((c: { sku: string }) => c.sku === f.skus[2]!.code)).toMatchObject({ before: '0', after: '5', to_pick: '5' });
    // the returned pieces go back to the pallet they were picked from, in its position (no new pallet, no put-away); stock unchanged
    const src = await sql<{ code: string; status: string; loc: string; qty: bigint; tasks: bigint }>(`SELECT l.code, l.status, loc.code AS loc, (SELECT sum(qty)::bigint FROM inventory_balances b WHERE b.lpn_id = l.id AND b.status = 'AVAILABLE') AS qty, (SELECT count(*)::bigint FROM putaway_tasks t WHERE t.lpn_id = l.id AND t.status IN ('PENDING','ASSIGNED','IN_PROGRESS')) AS tasks FROM lpns l JOIN locations loc ON loc.id = l.current_location_id WHERE l.code = '${c0.new_lpns[0]}'`);
    expect(src[0]).toMatchObject({ status: 'STORED', loc: f.reserve[0]!.code, qty: 82n, tasks: 0n });
    expect(await skuTotal(f.skus[0]!.id)).toBe(total0);
    const lines = await sql<{ required_qty: bigint; picked_qty: bigint; allocated_qty: bigint }>(`SELECT required_qty, picked_qty, allocated_qty FROM order_lines WHERE order_id = '${o.body.id}' ORDER BY line_no`);
    expect(lines).toEqual([{ required_qty: 18n, picked_qty: 18n, allocated_qty: 0n }, { required_qty: 26n, picked_qty: 20n, allocated_qty: 0n }, { required_qty: 5n, picked_qty: 0n, allocated_qty: 0n }]);
    // the rest is allocated and picked like any order; the order ends PICKED and stages normally
    await storedPallet(f, 2, f.reserve[2]!.id, 50n);
    expect((await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: false, strategy: 'LPN' })).status).toBe(200);
    const t2 = await sup.post('/picking/tasks', { order_id: o.body.id });
    expect(t2.status, JSON.stringify(t2.body)).toBe(201);
    await pickAll(t2.body.task.id);
    const od = await sup.get(`/orders/${o.body.id}`);
    expect(od.body.status).toBe('PICKED');
    expect(od.body.lines.map((l: { picked_qty: string; required_qty: string }) => [l.required_qty, l.picked_qty])).toEqual([['18', '18'], ['26', '26'], ['5', '5']]);
    expect(od.body.notes).toContain('AJUSTE DE CANTIDADES');
    // qty 0 on a line with history keeps the line at 0 and returns everything
    const z = await adminC.post('/orders/adjust', { order_id: o.body.id, reason: 'ya no quiere el tercero', lines: [{ sku_code: f.skus[2]!.code, qty: 0 }] });
    expect(z.status, JSON.stringify(z.body)).toBe(200);
    expect(z.body.changes[0]).toMatchObject({ before: '5', after: '0', returned_to_stock: '5' });
    expect(z.body.status).toBe('PICKED');
    await expectReconciled();
  });
});

describe('adjusting an order that is not picked yet', () => {
  it('a captured order (imported) accepts a lower quantity and 0', async () => {
    const o = await sup.post('/orders', { order_number: `ADJ0-${f.tag}`, customer_code: f.customer.code, lines: [{ sku_code: f.skus[0]!.code, qty: 30, uom_code: 'PIECE' }, { sku_code: f.skus[1]!.code, qty: 20, uom_code: 'PIECE' }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    const r = await adminC.post('/orders/adjust', { order_id: o.body.id, reason: 'no hay producto', lines: [{ sku_code: f.skus[0]!.code, qty: 12 }, { sku_code: f.skus[1]!.code, qty: 0 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('IMPORTED');
    const od = await sup.get(`/orders/${o.body.id}`);
    expect(od.body.lines.map((l: { required_qty: string }) => l.required_qty)).toEqual(['12']);
  });

  it('an order in picking with nothing picked yet: lower quantities release the allocation and trim the pick task; 0 removes the line', async () => {
    await storedPallet(f, 0, f.reserve[0]!.id, 100n);
    await storedPallet(f, 1, f.reserve[1]!.id, 100n);
    const o = await sup.post('/orders', { order_number: `ADJP-${f.tag}`, customer_code: f.customer.code, lines: [{ sku_code: f.skus[0]!.code, qty: 30, uom_code: 'PIECE' }, { sku_code: f.skus[1]!.code, qty: 20, uom_code: 'PIECE' }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    await sup.post(`/orders/${o.body.id}/accept`);
    expect((await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: false, strategy: 'LPN' })).status).toBe(200);
    const t = await sup.post('/picking/tasks', { order_id: o.body.id });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const r = await adminC.post('/orders/adjust', { order_id: o.body.id, reason: 'el cliente redujo el pedido', lines: [{ sku_code: f.skus[0]!.code, qty: 10 }, { sku_code: f.skus[1]!.code, qty: 0 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.changes.find((c: { sku: string }) => c.sku === f.skus[0]!.code)).toMatchObject({ before: '30', after: '10', released_allocation: '20', to_pick: '0' });
    expect(r.body.changes.find((c: { sku: string }) => c.sku === f.skus[1]!.code)).toMatchObject({ before: '20', after: '0', released_allocation: '20' });
    const lines = await sql<{ required_qty: bigint; allocated_qty: bigint }>(`SELECT required_qty, allocated_qty FROM order_lines WHERE order_id = '${o.body.id}' ORDER BY line_no`);
    expect(lines).toEqual([{ required_qty: 10n, allocated_qty: 10n }]);
    const tl = await sql<{ qty: bigint; status: string }>(`SELECT qty, status FROM pick_task_lines WHERE pick_task_id = '${t.body.task.id}' ORDER BY qty`);
    expect(tl).toEqual([{ qty: 10n, status: 'PENDING' }]);
    // the released pieces are available again
    const bal = await sql<{ status: string; qty: bigint }>(`SELECT status, sum(qty)::bigint AS qty FROM inventory_balances WHERE sku_id = '${f.skus[1]!.id}' GROUP BY status`);
    expect(bal.find((b) => b.status === 'ALLOCATED')?.qty ?? 0n).toBe(0n);
    // the picker can finish the trimmed task and the order ends PICKED with 10
    await pickAll(t.body.task.id);
    const od = await sup.get(`/orders/${o.body.id}`);
    expect(od.body.status).toBe('PICKED');
    expect(od.body.lines.map((l: { required_qty: string; picked_qty: string }) => [l.required_qty, l.picked_qty])).toEqual([['10', '10']]);
    await expectReconciled();
  });
});
