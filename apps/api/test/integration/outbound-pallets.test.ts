// Outbound pallets the way the floor works: several per order (closed one by one), a delivery destination on each,
// splitting after the pick, assemblies produced straight for an order, and the admin "delivered outside the flow".
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, expectReconciled, idem, makeFixture, skuTotal, sql, storedPallet, userWithRoles, type Client, type Fixture } from '../helpers.js';

let sup: Client;
let picker: Client;
let adminC: Client;
let f: Fixture;

beforeAll(async () => {
  sup = await userWithRoles('obsup', ['SUPERVISOR']);
  picker = await userWithRoles('obpick', ['PICKER']);
  adminC = await userWithRoles('obadm', ['ADMIN']);
  const enroll = await adminC.post('/auth/mfa/enroll');
  const { totp } = await import('../../src/lib/crypto.js');
  expect((await adminC.post('/auth/mfa/enroll/confirm', { code: totp(enroll.body.secret) })).status).toBe(200);
  f = await makeFixture({ skus: 3, reserveBays: 8 });
});
afterAll(closeApp);

async function acceptedOrder(lines: { sku: number; qty: number }[], destination?: string) {
  const o = await sup.post('/orders', { order_number: `OB-${f.tag}-${Math.random().toString(36).slice(2, 7)}`, customer_code: f.customer.code, destination, lines: lines.map((l) => ({ sku_code: f.skus[l.sku]!.code, qty: l.qty, uom_code: 'PIECE' })) });
  expect(o.status, JSON.stringify(o.body)).toBe(201);
  await sup.post(`/orders/${o.body.id}/accept`);
  return { id: o.body.id as string, number: o.body.order_number as string };
}
async function directedTask(orderId: string) {
  expect((await sup.post('/orders/allocate', { order_id: orderId, allow_partial: false, strategy: 'LPN' })).status).toBe(200);
  const t = await sup.post('/picking/tasks', { order_id: orderId });
  expect(t.status, JSON.stringify(t.body)).toBe(201);
  const v = await picker.post(`/picking/tasks/${t.body.task.id}/start`);
  return { taskId: t.body.task.id as string, lines: v.body.lines as { id: string; location_barcode: string; lpn_code: string; qty: string }[] };
}
async function pickLine(taskId: string, line: { id: string; location_barcode: string; lpn_code: string }, qty: number) {
  expect((await picker.post('/picking/scan', { pick_task_id: taskId, line_id: line.id, step: 'LOCATION', scanned: line.location_barcode }, idem())).status).toBe(200);
  expect((await picker.post('/picking/scan', { pick_task_id: taskId, line_id: line.id, step: 'LPN', scanned: line.lpn_code }, idem())).status).toBe(200);
  const r = await picker.post('/picking/scan', { pick_task_id: taskId, line_id: line.id, step: 'QTY', qty, uom_code: 'PIECE' }, idem());
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { outbound_lpn: string; task_completed: boolean };
}

describe('closing outbound pallets while picking', () => {
  it('a closed pallet keeps its destination on the label and the next pieces start a new pallet', async () => {
    await storedPallet(f, 0, f.reserve[0]!.id, 100n);
    await storedPallet(f, 1, f.reserve[1]!.id, 100n);
    const o = await acceptedOrder([{ sku: 0, qty: 30 }, { sku: 1, qty: 20 }], 'CEDIS 7494');
    const { taskId, lines } = await directedTask(o.id);
    // nothing picked yet: nothing to close
    const early = await picker.post('/picking/close-pallet', { pick_task_id: taskId });
    expect(early.status).toBe(422);
    expect(early.body.error).toBe('NO_OPEN_PALLET');
    const first = await pickLine(taskId, lines[0]!, 30);
    const view1 = await picker.get(`/picking/tasks/${taskId}`);
    expect(view1.body.pallets).toHaveLength(1);
    expect(view1.body.pallets[0]).toMatchObject({ lpn_code: first.outbound_lpn, qty: '30', open: true, destination: null });
    // full: close it for CEDIS 7471
    const closed = await picker.post('/picking/close-pallet', { pick_task_id: taskId, destination: 'CEDIS 7471' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body).toMatchObject({ lpn_code: first.outbound_lpn, qty: '30', destination: 'CEDIS 7471' });
    expect(closed.body.pallets[0].open).toBe(false);
    // the label carries the order and the pallet's own destination
    const label = await picker.post('/labels/preview', { label_type: 'LPN', entity_id: first.outbound_lpn });
    expect(label.status, JSON.stringify(label.body)).toBe(200);
    const lines1 = JSON.stringify(label.body);
    expect(lines1).toContain('CEDIS 7471');
    expect(lines1).toContain(o.number);
    // the second line goes onto a NEW pallet
    const second = await pickLine(taskId, lines[1]!, 20);
    expect(second.outbound_lpn).not.toBe(first.outbound_lpn);
    expect(second.task_completed).toBe(true);
    const view2 = await picker.get(`/picking/tasks/${taskId}`);
    expect(view2.body.pallets.map((p: { lpn_code: string; qty: string; destination: string | null }) => [p.lpn_code, p.qty, p.destination])).toEqual([[first.outbound_lpn, '30', 'CEDIS 7471'], [second.outbound_lpn, '20', null]]);
    // a whole pallet / closed pallet takes its destination directly; the order's destination is the default on the label
    const dest = await picker.post('/picking/pallet-destination', { lpn_code: second.outbound_lpn, destination: 'Tienda 1166' });
    expect(dest.status).toBe(200);
    expect(dest.body.destination).toBe('Tienda 1166');
    const clear = await picker.post('/picking/pallet-destination', { lpn_code: second.outbound_lpn, destination: '' });
    expect(clear.body.destination).toBeNull();
    const label2 = JSON.stringify((await picker.post('/labels/preview', { label_type: 'LPN', entity_id: second.outbound_lpn })).body);
    expect(label2).toContain('CEDIS 7494');
    // both pallets stage normally and the order is STAGED
    for (const code of [first.outbound_lpn, second.outbound_lpn]) {
      const st = await picker.post('/staging/scan', { lpn_code: code, staging_location_barcode: f.staging[0]!.barcode }, idem());
      expect(st.status, JSON.stringify(st.body)).toBe(200);
    }
    expect((await sup.get(`/orders/${o.id}`)).body.status).toBe('STAGED');
    await expectReconciled();
  });
});

describe('splitting an outbound pallet', () => {
  it('part of a picked pallet moves to a new pallet (with destination) or to another pallet of the order; quantities of the order do not change', async () => {
    await storedPallet(f, 0, f.reserve[2]!.id, 100n);
    const o = await acceptedOrder([{ sku: 0, qty: 60 }]);
    const { taskId, lines } = await directedTask(o.id);
    const r = await pickLine(taskId, lines[0]!, 60);
    const src = r.outbound_lpn;
    const look = await picker.get(`/picking/pallets/${src}`);
    expect(look.body.found).toBe(true);
    expect(look.body.contents).toEqual([{ sku_code: f.skus[0]!.code, description: 'Test sku 1', status: 'PICKING', qty: '60' }]);
    const tooMuch = await picker.post('/picking/split-pallet', { from_lpn_code: src, sku_code: f.skus[0]!.code, qty: 61 }, idem());
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error).toBe('QTY_EXCEEDED');
    const wrongSku = await picker.post('/picking/split-pallet', { from_lpn_code: src, sku_code: f.skus[1]!.code, qty: 1 }, idem());
    expect(wrongSku.body.error).toBe('WRONG_SKU');
    // 20 pieces (by the piece barcode) to a new pallet for another store
    const s1 = await picker.post('/picking/split-pallet', { from_lpn_code: src, sku_code: f.skus[0]!.piece_barcode, qty: 20, destination: 'Tienda 1166' }, idem());
    expect(s1.status, JSON.stringify(s1.body)).toBe(200);
    expect(s1.body).toMatchObject({ from_lpn: src, from_left: '40', to_qty: '20', created: true, destination: 'Tienda 1166' });
    const newLpn = s1.body.to_lpn as string;
    const st = await sql<{ status: string; lpn_type: string; destination: string; parent: string | null }>(`SELECT l.status, l.lpn_type, l.destination, p.code AS parent FROM lpns l LEFT JOIN lpns p ON p.id = l.parent_lpn_id WHERE l.code = '${newLpn}'`);
    expect(st[0]).toEqual({ status: 'PICKING', lpn_type: 'OUTBOUND', destination: 'Tienda 1166', parent: src });
    // 2 cases (12) more onto that same pallet
    const s2 = await picker.post('/picking/split-pallet', { from_lpn_code: src, sku_code: f.skus[0]!.code, qty: 2, uom_code: 'CASE', to_lpn_code: newLpn }, idem());
    expect(s2.status, JSON.stringify(s2.body)).toBe(200);
    expect(s2.body).toMatchObject({ from_left: '28', to_qty: '32', created: false });
    // the order still has 60 picked; both pallets stage; the order is STAGED
    const ol = await sql<{ picked_qty: bigint }>(`SELECT picked_qty FROM order_lines WHERE order_id = '${o.id}'`);
    expect(ol[0]!.picked_qty).toBe(60n);
    for (const code of [src, newLpn]) expect((await picker.post('/staging/scan', { lpn_code: code, staging_location_barcode: f.staging[1]!.barcode }, idem())).status).toBe(200);
    expect((await sup.get(`/orders/${o.id}`)).body.status).toBe('STAGED');
    // splitting also works in staging (status STAGING), and emptying the source consumes it
    const s3 = await picker.post('/picking/split-pallet', { from_lpn_code: src, sku_code: f.skus[0]!.code, qty: 28 }, idem());
    expect(s3.status, JSON.stringify(s3.body)).toBe(200);
    expect(s3.body.from_left).toBe('0');
    expect((await sql<{ status: string }>(`SELECT status FROM lpns WHERE code = '${src}'`))[0]!.status).toBe('CONSUMED');
    expect((await sql<{ status: string }>(`SELECT status FROM lpns WHERE code = '${s3.body.to_lpn}'`))[0]!.status).toBe('STAGED');
    await expectReconciled();
  });
});

describe('assembly straight for an order', () => {
  let g: Fixture;
  beforeAll(async () => {
    g = await makeFixture({ skus: 3 });
  });
  async function gOrder(qty: number) {
    const o = await sup.post('/orders', { order_number: `AO-${g.tag}-${Math.random().toString(36).slice(2, 7)}`, customer_code: g.customer.code, lines: [{ sku_code: g.skus[2]!.code, qty, uom_code: 'PIECE' }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    await sup.post(`/orders/${o.body.id}/accept`);
    return { id: o.body.id as string, number: o.body.order_number as string };
  }
  it('the finished pallets are outbound pallets of the order (no put-away), booked as picked, and stage normally', async () => {
    const BODY = 1;
    const PAN = 2;
    const f = g;
    const body = await storedPallet(f, BODY, f.reserve[3]!.id, 48n);
    const o = await gOrder(48);
    const notFound = await sup.post('/assembly', { station_barcode: f.staging[2]!.barcode, inputs: [{ lpn_code: body.code, sku_code: f.skus[BODY]!.code, qty: 48 }], output: { sku_code: f.skus[PAN]!.code, pallets: [{ cases: 4, pieces_per_case: 12 }] }, notes: 'para pedido', for_order_number: 'NOPE-123' }, idem());
    expect(notFound.status).toBe(422);
    expect(notFound.body.error).toBe('ORDER_NOT_FOUND');
    const small = await gOrder(36);
    const tooMany = await sup.post('/assembly', { station_barcode: f.staging[2]!.barcode, inputs: [{ lpn_code: body.code, sku_code: f.skus[BODY]!.code, qty: 48 }], output: { sku_code: f.skus[PAN]!.code, pallets: [{ cases: 4, pieces_per_case: 12 }] }, notes: 'para pedido', for_order_number: small.number }, idem());
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error).toBe('EXCEEDS_ORDER');
    const before = await skuTotal(f.skus[PAN]!.id);
    const r = await sup.post('/assembly', { station_barcode: f.staging[2]!.barcode, inputs: [{ lpn_code: body.code, sku_code: f.skus[BODY]!.code, qty: 48 }], output: { sku_code: f.skus[PAN]!.code, pallets: [{ cases: 2, pieces_per_case: 12 }, { cases: 2, pieces_per_case: 12 }] }, notes: 'para pedido', for_order_number: o.number.toLowerCase() }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.produced).toHaveLength(2);
    expect(r.body.produced.every((p: { putaway_task_id: string | null }) => p.putaway_task_id === null)).toBe(true);
    expect(r.body.for_order.order_number).toBe(o.number);
    expect(typeof r.body.for_order.staging).toBe('string');
    const lane = r.body.for_order.staging as string;
    const laneBarcode = f.staging.find((l) => l.code === lane)!.barcode;
    expect((await skuTotal(f.skus[PAN]!.id)) - before).toBe(48n);
    const lpns = await sql<{ code: string; status: string; lpn_type: string; order_id: string }>(`SELECT code, status, lpn_type, order_id FROM lpns WHERE code IN ('${r.body.produced[0].lpn}','${r.body.produced[1].lpn}')`);
    expect(lpns.every((l) => l.status === 'PICKING' && l.lpn_type === 'OUTBOUND' && l.order_id === o.id)).toBe(true);
    const od = await sup.get(`/orders/${o.id}`);
    expect(od.body.status).toBe('PICKED');
    const ol = await sql<{ picked_qty: bigint; required_qty: bigint }>(`SELECT picked_qty, required_qty FROM order_lines WHERE order_id = '${o.id}'`);
    expect(ol[0]).toEqual({ picked_qty: 48n, required_qty: 48n });
    // the label of a produced pallet names the order and its lane
    const label = JSON.stringify((await sup.post('/labels/preview', { label_type: 'LPN', entity_id: r.body.produced[0].lpn })).body);
    expect(label).toContain(o.number);
    for (const p of r.body.produced) expect((await picker.post('/staging/scan', { lpn_code: p.lpn, staging_location_barcode: laneBarcode }, idem())).status).toBe(200);
    expect((await sup.get(`/orders/${o.id}`)).body.status).toBe('STAGED');
    // the assembly remembers the order it was made for
    const asm = await sup.get(`/assembly/${r.body.id}`);
    expect(asm.body.for_order.order_number).toBe(o.number);
    await expectReconciled();
  });

  it('two-phase: the order can be given at the start and the finish books the pallets on it', async () => {
    const f = g;
    const body = await storedPallet(f, 1, f.reserve[4]!.id, 24n);
    const o = await gOrder(24);
    const start = await sup.post('/assembly/start', { station_barcode: f.staging[2]!.barcode, inputs: [{ lpn_code: body.code, sku_code: f.skus[1]!.code, qty: 24 }], output_sku_code: f.skus[2]!.code, notes: 'armado para pedido', for_order_number: o.number }, idem());
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const done = await sup.post(`/assembly/${start.body.id}/complete`, { pallets: [{ cases: 2, pieces_per_case: 12 }] }, idem());
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.for_order.order_number).toBe(o.number);
    expect((await sup.get(`/orders/${o.id}`)).body.status).toBe('PICKED');
    await expectReconciled();
  });
});

describe('admin marks an order as delivered outside the flow', () => {
  it('ships what was picked, what was allocated and what is only in stock; records missing stock on an incident', async () => {
    // own fixture: the stock must be exactly known
    const g = await makeFixture({ skus: 3 });
    const p0 = await storedPallet(g, 0, g.reserve[0]!.id, 50n);
    await storedPallet(g, 1, g.reserve[1]!.id, 10n);
    const o = await sup.post('/orders', { order_number: `FD-${g.tag}`, customer_code: g.customer.code, lines: [{ sku_code: g.skus[0]!.code, qty: 30, uom_code: 'PIECE' }, { sku_code: g.skus[1]!.code, qty: 25, uom_code: 'PIECE' }, { sku_code: g.skus[2]!.code, qty: 5, uom_code: 'PIECE' }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    await sup.post(`/orders/${o.body.id}/accept`);
    // sku 0: allocated 30, picked 20 · sku 1: allocated 10 (all there is) of 25 · sku 2: stock arrives after the allocation (never allocated)
    expect((await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: true, strategy: 'LPN' })).status).toBe(200);
    await storedPallet(g, 2, g.reserve[2]!.id, 8n);
    const t = await sup.post('/picking/tasks', { order_id: o.body.id });
    const v = await picker.post(`/picking/tasks/${t.body.task.id}/start`);
    const l0 = (v.body.lines as { id: string; location_barcode: string; lpn_code: string; sku_code: string }[]).find((l) => l.sku_code === g.skus[0]!.code)!;
    await pickLine(t.body.task.id, l0, 20);
    const denied = await picker.post('/orders/force-deliver', { order_id: o.body.id, reason: 'se fue en la camioneta' });
    expect(denied.status).toBe(403);
    const supNo = await sup.post('/orders/force-deliver', { order_id: o.body.id, reason: 'se fue en la camioneta' });
    expect(supNo.status).toBe(403);
    const before = await Promise.all(g.skus.map((s) => skuTotal(s.id)));
    const r = await adminC.post('/orders/force-deliver', { order_id: o.body.id, reason: 'se fue en la camioneta sin pasar por staging' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('SHIPPED');
    expect(r.body.missing).toEqual([{ sku: g.skus[1]!.code, qty: '15' }]);
    expect(r.body.shipped.map((s: { from: string; qty: string }) => [s.from, s.qty]).sort()).toEqual([['asignado', '10'], ['asignado', '10'], ['existencia', '5'], ['surtido', '20']]);
    const after = await Promise.all(g.skus.map((s) => skuTotal(s.id)));
    expect(before.map((b, i) => b - after[i]!)).toEqual([30n, 10n, 5n]);
    const od = await sup.get(`/orders/${o.body.id}`);
    expect(od.body.status).toBe('SHIPPED');
    expect(od.body.notes).toContain('ENTREGADO FUERA DE FLUJO');
    const lines = await sql<{ picked_qty: bigint; loaded_qty: bigint }>(`SELECT picked_qty, loaded_qty FROM order_lines WHERE order_id = '${o.body.id}' ORDER BY line_no`);
    expect(lines).toEqual([{ picked_qty: 30n, loaded_qty: 30n }, { picked_qty: 10n, loaded_qty: 10n }, { picked_qty: 5n, loaded_qty: 5n }]);
    expect((await sql<{ status: string }>(`SELECT status FROM pick_tasks WHERE id = '${t.body.task.id}'`))[0]!.status).toBe('COMPLETED');
    expect((await sql<{ n: bigint }>(`SELECT count(*)::bigint AS n FROM staging_assignments WHERE order_id = '${o.body.id}' AND released_at IS NULL`))[0]!.n).toBe(0n);
    const inc = await sql<{ severity: string; title: string }>(`SELECT severity, title FROM incidents WHERE id = '${r.body.incident_id}'`);
    expect(inc[0]!.severity).toBe('HIGH');
    expect(inc[0]!.title).toContain('fuera de flujo');
    // the source pallet still holds what was not taken (50 - 20 picked - 10 allocated = 20)
    expect((await sql<{ q: bigint }>(`SELECT COALESCE(sum(qty),0)::bigint AS q FROM inventory_balances WHERE lpn_id = '${p0.id}' AND qty > 0`))[0]!.q).toBe(20n);
    expect((await adminC.post('/orders/force-deliver', { order_id: o.body.id, reason: 'otra vez' })).status).toBe(422);
    await expectReconciled();
  });
});
