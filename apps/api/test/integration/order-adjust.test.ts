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
    // the 6 more of sku1 were allocated at once and a new pick task holds them; sku2 has no stock yet → short, still pending
    expect(lines).toEqual([{ required_qty: 18n, picked_qty: 18n, allocated_qty: 0n }, { required_qty: 26n, picked_qty: 20n, allocated_qty: 6n }, { required_qty: 5n, picked_qty: 0n, allocated_qty: 0n }]);
    expect(r.body.picking).toMatchObject({ allocated: true, added: 1 });
    expect(r.body.picking.task_id).toBeTruthy();
    expect(r.body.picking.short).toEqual([`${f.skus[2]!.code}: faltan 5`]);
    // stock for sku2 arrives: allocating appends its line to the open task; the order ends PICKED and stages normally
    await storedPallet(f, 2, f.reserve[2]!.id, 50n);
    const more = await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: false, strategy: 'LPN' });
    expect(more.status, JSON.stringify(more.body)).toBe(200);
    expect(more.body.appended).toMatchObject({ task_id: r.body.picking.task_id, added: 1 });
    await pickAll(r.body.picking.task_id);
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
    const act = await sql<{ n: bigint }>(`SELECT count(*)::bigint AS n FROM allocations a JOIN order_lines ol ON ol.id = a.order_line_id WHERE ol.order_id = '${o.body.id}' AND a.sku_id = '${f.skus[1]!.id}' AND a.status = 'ACTIVE'`);
    expect(act[0]!.n).toBe(0n);
    // the picker can finish the trimmed task and the order ends PICKED with 10
    await pickAll(t.body.task.id);
    const od = await sup.get(`/orders/${o.body.id}`);
    expect(od.body.status).toBe('PICKED');
    expect(od.body.lines.map((l: { required_qty: string; picked_qty: string }) => [l.required_qty, l.picked_qty])).toEqual([['10', '10']]);
    await expectReconciled();
  });
});

describe('swapping the model of a picked line', () => {
  it('old line to 0 (pieces back to their pallet) and the new model added in the same call; the new model is then picked', async () => {
    await storedPallet(f, 0, f.reserve[3]!.id, 40n);
    await storedPallet(f, 2, f.reserve[4]!.id, 40n);
    const o = await sup.post('/orders', { order_number: `SWAP-${f.tag}`, customer_code: f.customer.code, lines: [{ sku_code: f.skus[0]!.code, qty: 12, uom_code: 'PIECE' }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    await sup.post(`/orders/${o.body.id}/accept`);
    expect((await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: false, strategy: 'LPN' })).status).toBe(200);
    const t = await sup.post('/picking/tasks', { order_id: o.body.id });
    await pickAll(t.body.task.id);
    expect((await sup.get(`/orders/${o.body.id}`)).body.status).toBe('PICKED');
    const total0 = await skuTotal(f.skus[0]!.id);
    const r = await adminC.post('/orders/adjust', { order_id: o.body.id, reason: 'el cliente cambió el modelo', lines: [{ sku_code: f.skus[0]!.code, qty: 0 }, { sku_code: f.skus[2]!.code, qty: 12 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('ALLOCATED'); // the new model was allocated at once and its pick task created
    expect(r.body.picking).toMatchObject({ allocated: true, added: 1, short: [] });
    expect(r.body.changes.find((c: { sku: string }) => c.sku === f.skus[0]!.code)).toMatchObject({ before: '12', after: '0', returned_to_stock: '12' });
    expect(r.body.changes.find((c: { sku: string }) => c.sku === f.skus[2]!.code)).toMatchObject({ before: '0', after: '12', to_pick: '12' });
    expect(await skuTotal(f.skus[0]!.id)).toBe(total0);
    const od = await sup.get(`/orders/${o.body.id}`);
    expect(od.body.lines.map((l: { sku: { code: string }; required_qty: string; picked_qty: string }) => [l.sku.code, l.required_qty, l.picked_qty])).toEqual([[f.skus[2]!.code, '12', '0']]);
    await pickAll(r.body.picking.task_id);
    expect((await sup.get(`/orders/${o.body.id}`)).body.status).toBe('PICKED');
    await expectReconciled();
  });
});

describe('reopening a closed order (admin)', () => {
  it('a cancelled order comes back as ACCEPTED; a force-delivered picked order gets its pallets and stock back', async () => {
    await storedPallet(f, 1, f.reserve[5]!.id, 60n);
    const o = await sup.post('/orders', { order_number: `REO-${f.tag}`, customer_code: f.customer.code, lines: [{ sku_code: f.skus[1]!.code, qty: 20, uom_code: 'PIECE' }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    await sup.post(`/orders/${o.body.id}/accept`);
    expect((await sup.post('/orders/cancel', { order_id: o.body.id, reason: 'cancelado por error' })).status).toBe(200);
    expect((await sup.post('/orders/reopen', { order_id: o.body.id, reason: 'no debía cancelarse' })).status).toBe(403);
    const r1 = await adminC.post('/orders/reopen', { order_id: o.body.id, reason: 'no debía cancelarse' });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body.status).toBe('ACCEPTED');
    // pick it, deliver it out of flow, then reopen: inventory comes back onto the outbound pallet, order is PICKED again
    expect((await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: false, strategy: 'LPN' })).status).toBe(200);
    const t = await sup.post('/picking/tasks', { order_id: o.body.id });
    await pickAll(t.body.task.id);
    const total1 = await skuTotal(f.skus[1]!.id);
    const fd = await adminC.post('/orders/force-deliver', { order_id: o.body.id, reason: 'se fue sin flujo' });
    expect(fd.status, JSON.stringify(fd.body)).toBe(200);
    expect(await skuTotal(f.skus[1]!.id)).toBe(total1 - 20n);
    const r2 = await adminC.post('/orders/reopen', { order_id: o.body.id, reason: 'el cliente lo regresó al andén' });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body.status).toBe('PICKED');
    expect(r2.body.restored).toHaveLength(1);
    expect(r2.body.restored[0]).toMatchObject({ sku: f.skus[1]!.code, qty: '20', status: 'PICKING' });
    expect(await skuTotal(f.skus[1]!.id)).toBe(total1);
    const od = await sup.get(`/orders/${o.body.id}`);
    expect(od.body.lines[0]).toMatchObject({ required_qty: '20', picked_qty: '20', allocated_qty: '0', verified_qty: '0' });
    expect(od.body.lpns.map((l: { code: string; status: string }) => l.status)).toEqual(['PICKING']);
    // reopening twice does nothing (nothing left to bring back)
    expect((await adminC.post('/orders/reopen', { order_id: o.body.id, reason: 'otra vez' })).status).toBe(422);
    await expectReconciled();
  });
});

describe('adjusting while the picker is on the order', () => {
  it('new and raised lines are allocated at once and appended to the open pick task', async () => {
    await storedPallet(f, 0, f.reserve[6]!.id, 50n);
    await storedPallet(f, 2, f.reserve[7]!.id, 50n);
    const o = await sup.post('/orders', { order_number: `ADJT-${f.tag}`, customer_code: f.customer.code, lines: [{ sku_code: f.skus[0]!.code, qty: 10, uom_code: 'PIECE' }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    await sup.post(`/orders/${o.body.id}/accept`);
    expect((await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: false, strategy: 'LPN' })).status).toBe(200);
    const t = await sup.post('/picking/tasks', { order_id: o.body.id });
    const v = await picker.post(`/picking/tasks/${t.body.task.id}/start`);
    expect(v.body.lines).toHaveLength(1);
    // office raises sku0 to 15 and adds sku2 × 7 while the task is open
    const r = await adminC.post('/orders/adjust', { order_id: o.body.id, reason: 'el cliente agregó modelo', lines: [{ sku_code: f.skus[0]!.code, qty: 15 }, { sku_code: f.skus[2]!.code, qty: 7 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('PICKING');
    expect(r.body.picking).toMatchObject({ allocated: true, task_id: t.body.task.id, added: 2, short: [] });
    const v2 = await picker.get(`/picking/tasks/${t.body.task.id}`);
    const open = (v2.body.lines as { sku_code: string; qty: string; status: string }[]).filter((l) => l.status === 'PENDING' || l.status === 'IN_PROGRESS');
    expect(open.map((l) => [l.sku_code, l.qty]).sort()).toEqual([[f.skus[0]!.code, '10'], [f.skus[0]!.code, '5'], [f.skus[2]!.code, '7']].sort());
    await pickAll(t.body.task.id);
    const od = await sup.get(`/orders/${o.body.id}`);
    expect(od.body.status).toBe('PICKED');
    expect(od.body.lines.map((l: { sku: { code: string }; required_qty: string; picked_qty: string }) => [l.sku.code, l.required_qty, l.picked_qty])).toEqual([[f.skus[0]!.code, '15', '15'], [f.skus[2]!.code, '7', '7']]);
    await expectReconciled();
  });
});

describe('delivered without touching stock', () => {
  it('a picked order closes as SHIPPED, its pieces go back to the pallet and nothing leaves the inventory', async () => {
    const src = await storedPallet(f, 1, f.reserve[8]!.id, 30n);
    const o = await sup.post('/orders', { order_number: `KEEP-${f.tag}`, customer_code: f.customer.code, lines: [{ sku_code: f.skus[1]!.code, qty: 10, uom_code: 'PIECE' }] });
    await sup.post(`/orders/${o.body.id}/accept`);
    expect((await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: false, strategy: 'LPN' })).status).toBe(200);
    const t = await sup.post('/picking/tasks', { order_id: o.body.id });
    await pickAll(t.body.task.id);
    const total = await skuTotal(f.skus[1]!.id);
    const r = await adminC.post('/orders/force-deliver', { order_id: o.body.id, reason: 'se entregó con otra mercancía', keep_stock: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'SHIPPED', kept_stock: true, shipped: [] });
    expect(await skuTotal(f.skus[1]!.id)).toBe(total);
    // the pallet it was picked from holds its 30 again, all available (nothing picked, nothing reserved)
    const bal = await sql<{ status: string; qty: bigint }>(`SELECT status, qty FROM inventory_balances WHERE lpn_id = '${src.id}' AND qty > 0 ORDER BY status`);
    expect(bal).toEqual([{ status: 'AVAILABLE', qty: 30n }]);
    const od = await sup.get(`/orders/${o.body.id}`);
    expect(od.body.status).toBe('SHIPPED');
    expect(od.body.lines[0]).toMatchObject({ required_qty: '10', picked_qty: '0', allocated_qty: '0' });
    await expectReconciled();
  });
});

describe('re-receiving an outbound pallet (short box)', () => {
  it('the missing pieces leave the outbound pallet, the line is short again and gets planned into the open task', async () => {
    const src = await storedPallet(f, 2, f.reserve[9]!.id, 60n);
    const o = await sup.post('/orders', { order_number: `BOX-${f.tag}`, customer_code: f.customer.code, lines: [{ sku_code: f.skus[2]!.code, qty: 24, uom_code: 'PIECE' }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    await sup.post(`/orders/${o.body.id}/accept`);
    expect((await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: false, strategy: 'LPN' })).status).toBe(200);
    const t = await sup.post('/picking/tasks', { order_id: o.body.id });
    await pickAll(t.body.task.id);
    const od = await sup.get(`/orders/${o.body.id}`);
    expect(od.body.status).toBe('PICKED');
    const outbound = od.body.lpns[0].code as string;
    const total = await skuTotal(f.skus[2]!.id);
    // the loader finds 4 pieces missing in a box: the picker re-receives the outbound pallet with 20
    const r = await picker.post('/wm/lpn-recount', { lpn_code: outbound, purpose: 'caja venía con 4 piezas de menos', lines: [{ sku_code: f.skus[2]!.code, qty: 20, uom_code: 'PIECE' }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.mode).toBe('OUTBOUND');
    expect(r.body.deltas[0]).toMatchObject({ system: '24', counted: '20', delta: '-4' });
    expect(r.body.replanned.added).toBe(1);
    expect(r.body.replanned.task_id).toBeTruthy();
    expect(await skuTotal(f.skus[2]!.id)).toBe(total - 4n); // the 4 never existed
    const od2 = await sup.get(`/orders/${o.body.id}`);
    expect(od2.body.lines[0]).toMatchObject({ required_qty: '24', picked_qty: '20' });
    const bal = await sql<{ status: string; qty: bigint }>(`SELECT b.status, b.qty FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id WHERE l.code = '${outbound}' AND b.qty > 0`);
    expect(bal).toEqual([{ status: 'PICKING', qty: 20n }]);
    // the picker goes for the 4 from the source pallet and the order is picked again
    await pickAll(r.body.replanned.task_id);
    const od3 = await sup.get(`/orders/${o.body.id}`);
    expect(od3.body.status).toBe('PICKED');
    expect(od3.body.lines[0]).toMatchObject({ picked_qty: '24' });
    expect(src.code).toBeTruthy();
    // more pieces than registered are not accepted here
    const more = await picker.post('/wm/lpn-recount', { lpn_code: outbound, purpose: 'trae más', lines: [{ sku_code: f.skus[2]!.code, qty: 30, uom_code: 'PIECE' }] });
    expect(more.status).toBe(422);
    expect(more.body.error).toBe('MORE_THAN_PICKED');
    await expectReconciled();
  });
});

describe('merma (damaged pieces) from the handheld', () => {
  it('on a stored pallet the pieces stay as DAMAGED; on an outbound pallet they leave the order and get planned again', async () => {
    const src = await storedPallet(f, 1, f.reserve[10]!.id, 50n);
    // stored pallet: 3 broken pieces
    const d1 = await picker.post('/wm/damage', { lpn_code: src.code, sku_code: f.skus[1]!.code, qty: 3, uom_code: 'PIECE', reason: 'se cayó al surtir' });
    expect(d1.status, JSON.stringify(d1.body)).toBe(201);
    expect(d1.body).toMatchObject({ mode: 'STORAGE', qty: '3', damaged_lpn: src.code });
    const bal1 = await sql<{ status: string; qty: bigint }>(`SELECT status, qty FROM inventory_balances WHERE lpn_id = '${src.id}' AND qty > 0 ORDER BY status`);
    expect(bal1).toEqual([{ status: 'AVAILABLE', qty: 47n }, { status: 'DAMAGED', qty: 3n }]);
    // outbound pallet: an order picks 10, the loader drops 2
    const o = await sup.post('/orders', { order_number: `DMG-${f.tag}`, customer_code: f.customer.code, lines: [{ sku_code: f.skus[1]!.code, qty: 10, uom_code: 'PIECE' }] });
    await sup.post(`/orders/${o.body.id}/accept`);
    expect((await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: false, strategy: 'LPN' })).status).toBe(200);
    const t = await sup.post('/picking/tasks', { order_id: o.body.id });
    await pickAll(t.body.task.id);
    const od = await sup.get(`/orders/${o.body.id}`);
    const outbound = od.body.lpns[0].code as string;
    const total = await skuTotal(f.skus[1]!.id);
    const d2 = await picker.post('/wm/damage', { lpn_code: outbound, sku_code: f.skus[1]!.code, qty: 2, uom_code: 'PIECE', reason: 'se cayó al cargar' });
    expect(d2.status, JSON.stringify(d2.body)).toBe(201);
    expect(d2.body.mode).toBe('OUTBOUND');
    expect(d2.body.damaged_lpn).not.toBe(outbound);
    expect(d2.body.replanned.added).toBe(1);
    expect(await skuTotal(f.skus[1]!.id)).toBe(total); // nothing lost: 2 pieces now DAMAGED on their own pallet
    const dmg = await sql<{ status: string; qty: bigint }>(`SELECT b.status, b.qty FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id WHERE l.code = '${d2.body.damaged_lpn}' AND b.qty > 0`);
    expect(dmg).toEqual([{ status: 'DAMAGED', qty: 2n }]);
    const od2 = await sup.get(`/orders/${o.body.id}`);
    expect(od2.body.lines[0]).toMatchObject({ required_qty: '10', picked_qty: '8' });
    await pickAll(d2.body.replanned.task_id);
    expect((await sup.get(`/orders/${o.body.id}`)).body.status).toBe('PICKED');
    // the picker scans the storage pallet by mistake, then charges the merma to the order afterwards
    const cand = await picker.get(`/wm/damage/orders?sku=${f.skus[1]!.code}`);
    expect(cand.body.orders.map((x: { order_number: string }) => x.order_number)).toContain(o.body.order_number);
    const before = await sql<{ status: string; qty: bigint }>(`SELECT status, qty FROM inventory_balances WHERE lpn_id = '${src.id}' AND qty > 0 ORDER BY status`);
    const d3 = await picker.post('/wm/damage', { lpn_code: src.code, sku_code: f.skus[1]!.code, qty: 1, uom_code: 'PIECE', reason: 'se cayó armando la tarima' });
    expect(d3.status, JSON.stringify(d3.body)).toBe(201);
    const mine = await picker.get('/wm/damage/mine');
    expect(mine.body.reports[0]).toMatchObject({ id: d3.body.report_id, sku: f.skus[1]!.code, qty: '1', order_number: null });
    expect(mine.body.reports.find((r: { id: string }) => r.id === d2.body.report_id)).toMatchObject({ order_number: o.body.order_number, task_id: d2.body.replanned.task_id });
    const l3 = await picker.post('/wm/damage/link-order', { order_number: o.body.order_number, sku_code: f.skus[1]!.code, qty: 1, uom_code: 'PIECE', lpn_code: src.code, reason: 'se cayó armando la tarima', report_id: d3.body.report_id });
    expect(l3.status, JSON.stringify(l3.body)).toBe(201);
    expect(l3.body).toMatchObject({ mode: 'OUTBOUND', order_number: o.body.order_number, damaged_lpn: src.code });
    expect(l3.body.replanned.added).toBe(1);
    expect((await picker.get('/wm/damage/mine')).body.reports[0]).toMatchObject({ id: d3.body.report_id, order_number: o.body.order_number, task_id: l3.body.replanned.task_id });
    expect((await picker.post('/wm/damage/link-order', { order_number: o.body.order_number, sku_code: f.skus[1]!.code, qty: 1, uom_code: 'PIECE', lpn_code: src.code, reason: 'otra vez', report_id: d3.body.report_id })).status).toBe(422);
    expect((await sup.get(`/orders/${o.body.id}`)).body.lines[0]).toMatchObject({ required_qty: '10', picked_qty: '9' });
    const bal3 = await sql<{ status: string; qty: bigint }>(`SELECT status, qty FROM inventory_balances WHERE lpn_id = '${src.id}' AND qty > 0 ORDER BY status`);
    const q = (rows: { status: string; qty: bigint }[], st: string) => rows.find((r) => r.status === st)?.qty ?? 0n;
    // the order gave 1 piece back (compensates the 1 that went DAMAGED), minus whatever the re-pick took from this pallet
    const repicked = await sql<{ qty: bigint }>(`SELECT COALESCE(SUM(qty), 0)::bigint AS qty FROM inventory_movements WHERE movement_type = 'PICK' AND from_lpn_id = '${src.id}' AND occurred_at > (SELECT occurred_at FROM inventory_movements WHERE movement_type = 'UNPICK' AND to_lpn_id = '${src.id}' ORDER BY id DESC LIMIT 1)`);
    expect(q(bal3, 'DAMAGED')).toBe(q(before, 'DAMAGED') + 1n);
    expect(q(bal3, 'AVAILABLE')).toBe(q(before, 'AVAILABLE') - repicked[0]!.qty);
    expect(await skuTotal(f.skus[1]!.id)).toBe(total);
    await expectReconciled();
  });
});
