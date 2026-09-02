// END-TO-END through the HTTP API:
// CONTAINER → RECEIPT → LPN → PUT-AWAY → ORDER → ALLOCATION → PICKING → STAGING
// → VERIFICATION → SHIPMENT → LOADING → RELEASE → DEPARTURE → reconciliation.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, expectReconciled, idem, makeFixture, skuTotal, sql, userWithRoles, type Client, type Fixture } from '../helpers.js';

let f: Fixture;
let sup: Client;
let recv: Client;
let fork: Client;
let picker: Client;
let verifier: Client;
let loader: Client;

beforeAll(async () => {
  f = await makeFixture({ skus: 3 });
  sup = await userWithRoles('sup', ['SUPERVISOR']);
  recv = await userWithRoles('recv', ['RECEIVING']);
  fork = await userWithRoles('fork', ['FORKLIFT']);
  picker = await userWithRoles('pick', ['PICKER', 'VERIFIER']); // has both roles so the SAME_USER rule (not RBAC) is what blocks
  verifier = await userWithRoles('ver', ['VERIFIER']);
  loader = await userWithRoles('load', ['LOADER']);
});
afterAll(async () => {
  await closeApp();
});

describe('full outbound/inbound flow', () => {
  let containerId: string;
  let receiptId: string;
  let lpnA: string;
  let lpnB: string;
  let orderId: string;
  let shipmentId: string;
  const sku0 = () => f.skus[0]!;
  const sku1 = () => f.skus[1]!;

  it('creates and checks in a container', async () => {
    const c = await recv.post('/containers', { container_number: `CONT-${f.tag}`, supplier_id: f.supplier.id, carrier_id: f.carrier.id, seal_number: 'S1', plates: 'ABC-1' });
    expect(c.status).toBe(201);
    containerId = c.body.id;
    let r = await recv.post(`/containers/${containerId}/transition`, { status: 'ARRIVED', version: 1 });
    expect(r.status).toBe(200);
    r = await recv.post(`/containers/${containerId}/transition`, { status: 'UNLOADING', version: 2 });
    expect(r.status).toBe(200);
    // invalid transition is rejected
    const bad = await recv.post(`/containers/${containerId}/transition`, { status: 'CLOSED', version: 3 });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe('INVALID_TRANSITION');
    // stale version is rejected
    const stale = await recv.post(`/containers/${containerId}/transition`, { status: 'UNLOADED', version: 1 });
    expect(stale.status).toBe(409);
    r = await recv.post(`/containers/${containerId}/transition`, { status: 'UNLOADED', version: 3 });
    expect(r.status).toBe(200);
  });

  it('opens a receipt with expected quantities and receives by scanning', async () => {
    const r = await recv.post('/receipts', { container_id: containerId, receiving_location_id: f.dock.id, expected: [{ sku_code: sku0().code, qty: 40, uom_code: 'CASE' }, { sku_code: sku1().code, qty: 20, uom_code: 'CASE' }] });
    expect(r.status).toBe(201);
    receiptId = r.body.id;
    // pallet A: 40 cases of sku0 (= 240 pieces = full pallet)
    const s1 = await recv.post('/receipts/scan', { receipt_id: receiptId, barcode: sku0().case_barcode, qty: 40, cases_count: 40 }, idem());
    expect(s1.status).toBe(201);
    expect(s1.body.lpn.code).toMatch(/^PLT-\d{4}-\d{8}$/);
    expect(s1.body.qty_base).toBe('240');
    expect(s1.body.line.status).toBe('COMPLETE');
    lpnA = s1.body.lpn.code;
    // pallet B: 20 cases sku1 (complete)
    const s2 = await recv.post('/receipts/scan', { receipt_id: receiptId, barcode: sku1().case_barcode, qty: 20, cases_count: 20 }, idem());
    expect(s2.status).toBe(201);
    lpnB = s2.body.lpn.code;
    expect(lpnB).not.toBe(lpnA);
    // unknown barcode is rejected
    const bad = await recv.post('/receipts/scan', { receipt_id: receiptId, barcode: 'NOPE-123', qty: 1 }, idem());
    expect(bad.status).toBe(404);
    expect(await skuTotal(sku0().id)).toBe(240n);
    expect(await skuTotal(sku1().id)).toBe(120n);
  });

  it('a retried scan with the same Idempotency-Key does not double receive', async () => {
    const key = idem();
    const body = { receipt_id: receiptId, barcode: sku0().piece_barcode, qty: 3, lpn_code: lpnA };
    const before = await skuTotal(sku0().id);
    const r1 = await recv.post('/receipts/scan', body, key);
    const r2 = await recv.post('/receipts/scan', body, key);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(r2.body.movement_id).toBe(r1.body.movement_id);
    expect(await skuTotal(sku0().id)).toBe(before + 3n);
    // same key, different payload → rejected
    const r3 = await recv.post('/receipts/scan', { ...body, qty: 4 }, key);
    expect(r3.status).toBe(409);
    expect(r3.body.error).toBe('IDEMPOTENCY_KEY_REUSED');
    // remove the 3 extra pieces via adjustment later; the pallet now has 243 → line OVER
    const rec = await recv.get(`/receipts/${receiptId}`);
    expect(rec.body.lines.find((l: any) => l.sku.code === sku0().code).status).toBe('OVER');
  });

  it('completes the receipt: overage creates an incident, LPNs get put-away tasks', async () => {
    const noAccept = await recv.post('/receipts/complete', { receipt_id: receiptId, accept_differences: false });
    expect(noAccept.status).toBe(422);
    expect(noAccept.body.error).toBe('RECEIPT_DIFFERENCES');
    const done = await recv.post('/receipts/complete', { receipt_id: receiptId, accept_differences: true });
    expect(done.status).toBe(200);
    expect(done.body.incidents.length).toBe(1);
    expect(done.body.putaway_tasks.length).toBe(2);
    const inc = await sup.get(`/incidents?entity_type=receipt&entity_id=${receiptId}`);
    expect(inc.body.items[0].incident_type).toBe('OVERAGE');
    const closed = await recv.post(`/receipts/${receiptId}/close`);
    expect(closed.status).toBe(200);
    const c = await recv.get(`/containers/${containerId}`);
    expect(c.body.status).toBe('WITH_INCIDENT');
  });

  it('directed put-away: wrong location is blocked, right location moves the pallet', async () => {
    const start = await fork.post('/putaway/start', { lpn_code: lpnA });
    expect(start.status).toBe(200);
    expect(start.body.target).not.toBeNull();
    const taskId = start.body.task.id;
    const targetBarcode = start.body.target.barcode;
    const wrongLoc = f.reserve.find((l) => l.barcode !== targetBarcode)!;
    const wrong = await fork.post('/putaway/confirm', { task_id: taskId, lpn_code: lpnA, location_barcode: wrongLoc.barcode }, idem());
    expect(wrong.status).toBe(422);
    expect(wrong.body.error).toBe('WRONG_LOCATION');
    // pallet did not move
    const still = await fork.get(`/inventory/lpns/${lpnA}`);
    expect(still.body.current_location.id).toBe(f.dock.id);
    const ok = await fork.post('/putaway/confirm', { task_id: taskId, lpn_code: lpnA, location_barcode: targetBarcode }, idem());
    expect(ok.status).toBe(200);
    const moved = await fork.get(`/inventory/lpns/${lpnA}`);
    expect(moved.body.current_location.barcode).toBe(targetBarcode);
    expect(moved.body.status).toBe('STORED');
    // second confirm of same task → already completed
    const again = await fork.post('/putaway/confirm', { task_id: taskId, lpn_code: lpnA, location_barcode: targetBarcode }, idem());
    expect(again.status).toBe(409);
    // put away pallet B too
    const sB = await fork.post('/putaway/start', { lpn_code: lpnB });
    const okB = await fork.post('/putaway/confirm', { task_id: sB.body.task.id, lpn_code: lpnB, location_barcode: sB.body.target.barcode }, idem());
    expect(okB.status).toBe(200);
    await expectReconciled();
  });

  it('supervisor override stores the pallet elsewhere with a recorded reason', async () => {
    // move B with a transfer to test override: create a 3rd pallet through adjustment? simpler: use the override path on a new inbound
    const rcp = await recv.post('/receipts', { receiving_location_id: f.dock.id });
    const scan = await recv.post('/receipts/scan', { receipt_id: rcp.body.id, barcode: sku1().case_barcode, qty: 5 }, idem());
    const lpnC = scan.body.lpn.code;
    await recv.post('/receipts/lpn/close', { lpn_code: lpnC }, idem());
    const start = await fork.post('/putaway/start', { lpn_code: lpnC });
    const other = f.reserve.filter((l) => l.barcode !== start.body.target.barcode);
    // find a free one
    const locs = await fork.get(`/locations?warehouse_id=${f.warehouse_id}&type=RESERVE&status=FREE`);
    const free = locs.body.items.find((l: any) => other.some((o) => o.id === l.id));
    const auth = await sup.post('/authorizations', { exception_type: 'PUTAWAY_LOCATION_OVERRIDE', entity_type: 'putaway_task', entity_id: start.body.task.id, reason: 'Rack de sugerencia obstruido' });
    expect(auth.status).toBe(201);
    // second supervisor authorization for the same exception is impossible
    const dup = await sup.post('/authorizations', { exception_type: 'PUTAWAY_LOCATION_OVERRIDE', entity_type: 'putaway_task', entity_id: start.body.task.id, reason: 'otra' });
    expect(dup.status).toBe(409);
    const ok = await fork.post('/putaway/confirm', { task_id: start.body.task.id, lpn_code: lpnC, location_barcode: free.barcode, authorization_id: auth.body.id }, idem());
    expect(ok.status).toBe(200);
    expect(ok.body.overridden).toBe(true);
    const audit = await sup.get(`/audit?entity_type=lpn&action=putaway.confirm_override`);
    expect(audit.body.items.length).toBeGreaterThan(0);
    await recv.post('/receipts/complete', { receipt_id: rcp.body.id, accept_differences: true });
  });

  it('creates an order, allocates FIFO, and refuses double allocation', async () => {
    const o = await sup.post('/orders', { order_number: `PED-${f.tag}-1`, customer_code: f.customer.code, priority: 1, lines: [{ sku_code: sku0().code, qty: 10, uom_code: 'CASE' }, { sku_code: sku1().code, qty: 20, uom_code: 'CASE' }] });
    expect(o.status).toBe(201);
    orderId = o.body.id;
    await sup.post(`/orders/${orderId}/accept`);
    const a = await sup.post('/orders/allocate', { order_id: orderId, allow_partial: false });
    expect(a.status).toBe(200);
    expect(a.body.status).toBe('ALLOCATED');
    // a second order for the remaining sku1 stock must fail (only 30 cases existed: 20 + 5 + ... allocated 20)
    const o2 = await sup.post('/orders', { order_number: `PED-${f.tag}-2`, customer_code: f.customer.code, lines: [{ sku_code: sku1().code, qty: 20, uom_code: 'CASE' }] });
    await sup.post(`/orders/${o2.body.id}/accept`);
    const a2 = await sup.post('/orders/allocate', { order_id: o2.body.id, allow_partial: false });
    expect(a2.status).toBe(422);
    expect(a2.body.error).toBe('INSUFFICIENT_INVENTORY');
    // nothing was allocated for o2 (transaction rolled back)
    const d2 = await sup.get(`/orders/${o2.body.id}`);
    expect(d2.body.lines[0].allocated_qty).toBe('0');
    await expectReconciled();
  });

  it('directed picking blocks wrong location / wrong sku / excess qty and picks correctly', async () => {
    const t = await sup.post('/picking/tasks', { order_id: orderId });
    expect(t.status).toBe(201);
    const taskId = t.body.task.id;
    const view = await picker.post(`/picking/tasks/${taskId}/start`);
    expect(view.status).toBe(200);
    expect(view.body.staging).not.toBeNull();
    const lines = view.body.lines as any[];
    expect(lines.length).toBe(2);
    const l0 = lines.find((l) => l.sku_code === sku0().code);
    // wrong location
    const wl = await picker.post('/picking/scan', { pick_task_id: taskId, line_id: l0.id, step: 'LOCATION', scanned: 'LOC-NOPE' }, idem());
    expect(wl.status).toBe(422);
    expect(wl.body.error).toBe('WRONG_LOCATION');
    // right location
    const rl = await picker.post('/picking/scan', { pick_task_id: taskId, line_id: l0.id, step: 'LOCATION', scanned: l0.location_barcode }, idem());
    expect(rl.status).toBe(200);
    // wrong sku
    const ws = await picker.post('/picking/scan', { pick_task_id: taskId, line_id: l0.id, step: 'LPN', scanned: sku1().piece_barcode }, idem());
    expect(ws.status).toBe(422);
    expect(ws.body.error).toBe('WRONG_SKU');
    const rs = await picker.post('/picking/scan', { pick_task_id: taskId, line_id: l0.id, step: 'LPN', scanned: l0.lpn_code }, idem());
    expect(rs.status).toBe(200);
    // excess qty (line = 10 cases = 60 pieces)
    const wq = await picker.post('/picking/scan', { pick_task_id: taskId, line_id: l0.id, step: 'QTY', qty: 11, uom_code: 'CASE' }, idem());
    expect(wq.status).toBe(422);
    expect(wq.body.error).toBe('QTY_EXCEEDED');
    // partial pick 4 cases then 6 cases
    const p1 = await picker.post('/picking/scan', { pick_task_id: taskId, line_id: l0.id, step: 'QTY', qty: 4, uom_code: 'CASE' }, idem());
    expect(p1.status).toBe(200);
    expect(p1.body.remaining).toBe('36');
    const p2 = await picker.post('/picking/scan', { pick_task_id: taskId, line_id: l0.id, step: 'QTY', qty: 6, uom_code: 'CASE' }, idem());
    expect(p2.status).toBe(200);
    expect(p2.body.next).toBe('NEXT_LINE');
    // second line: full pallet of sku1 (20 cases = whole LPN B)
    const l1 = lines.find((l) => l.sku_code === sku1().code);
    expect(l1.full_pallet).toBe(true);
    await picker.post('/picking/scan', { pick_task_id: taskId, line_id: l1.id, step: 'LOCATION', scanned: l1.location_barcode }, idem());
    await picker.post('/picking/scan', { pick_task_id: taskId, line_id: l1.id, step: 'LPN', scanned: l1.lpn_code }, idem());
    const p3 = await picker.post('/picking/scan', { pick_task_id: taskId, line_id: l1.id, step: 'QTY', qty: 20, uom_code: 'CASE' }, idem());
    expect(p3.status).toBe(200);
    expect(p3.body.task_completed).toBe(true);
    const od = await sup.get(`/orders/${orderId}`);
    expect(od.body.status).toBe('PICKED');
    expect(od.body.lines.every((l: any) => l.picked_qty === l.required_qty)).toBe(true);
    await expectReconciled();
  });

  it('stages outbound pallets in the assigned lane only', async () => {
    const od = await sup.get(`/orders/${orderId}`);
    const lane = od.body.staging_assignments[0].location;
    const outbound = od.body.lpns.filter((l: any) => l.status === 'PICKING');
    expect(outbound.length).toBe(2); // pick pallet + full pallet B
    const wrongLane = f.staging.find((s) => s.barcode !== lane.barcode)!;
    const bad = await picker.post('/staging/scan', { lpn_code: outbound[0].code, staging_location_barcode: wrongLane.barcode }, idem());
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe('WRONG_LOCATION');
    for (const l of outbound) {
      const ok = await picker.post('/staging/scan', { lpn_code: l.code, staging_location_barcode: lane.barcode }, idem());
      expect(ok.status).toBe(200);
    }
    const od2 = await sup.get(`/orders/${orderId}`);
    expect(od2.body.status).toBe('STAGED');
  });

  it('verification: picker cannot verify own order; verifier scans blind and passes', async () => {
    const same = await picker.post('/verifications/start', { order_id: orderId });
    expect(same.status).toBe(422);
    expect(same.body.error).toBe('SAME_USER');
    const v = await verifier.post('/verifications/start', { order_id: orderId });
    expect(v.status).toBe(201);
    const vid = v.body.verification_id;
    const view = await verifier.get(`/verifications/${vid}`);
    expect(view.body.lines[0].expected_qty).toBeNull(); // blind
    const od = await sup.get(`/orders/${orderId}`);
    const staged = od.body.lpns.filter((l: any) => l.status === 'STAGED');
    // wrong sku in an LPN
    const pickLpn = staged.find((l: any) => l.code !== lpnB);
    const bad = await verifier.post('/verifications/scan', { verification_id: vid, lpn_code: pickLpn.code, barcode: sku1().piece_barcode, qty: 1 }, idem());
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe('WRONG_SKU');
    // incomplete verification fails
    const s1 = await verifier.post('/verifications/scan', { verification_id: vid, lpn_code: pickLpn.code, barcode: sku0().case_barcode, qty: 10 }, idem());
    expect(s1.status).toBe(200);
    const s2 = await verifier.post('/verifications/scan', { verification_id: vid, lpn_code: lpnB, barcode: sku1().case_barcode, qty: 20 }, idem());
    expect(s2.status).toBe(200);
    const over = await verifier.post('/verifications/scan', { verification_id: vid, lpn_code: lpnB, barcode: sku1().case_barcode, qty: 1 }, idem());
    expect(over.status).toBe(422);
    const done = await verifier.post('/verifications/complete', { verification_id: vid });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('PASSED');
    const od2 = await sup.get(`/orders/${orderId}`);
    expect(od2.body.status).toBe('VERIFIED');
    expect(od2.body.verifier.username).toBe(verifier.username);
    expect(od2.body.picker.username).toBe(picker.username);
  });

  it('loading: every pallet rescanned; release blocked until all SKUs match exactly', async () => {
    const sh = await sup.post('/shipments', { carrier_id: f.carrier.id, vehicle: 'Torton', plates: 'XYZ-99', driver_name: 'Juan', order_ids: [orderId], dock_location_id: f.ship_dock.id });
    expect(sh.status).toBe(201);
    shipmentId = sh.body.id;
    const od = await sup.get(`/orders/${orderId}`);
    const staged = od.body.lpns.filter((l: any) => l.status === 'STAGED');
    // release before loading: blocked, every line SKU_OMITTED
    const pre = await sup.get(`/shipments/${shipmentId}/release-check`);
    expect(pre.body.can_release).toBe(false);
    expect(pre.body.lines.every((l: any) => l.problems.includes('SKU_OMITTED'))).toBe(true);
    const l1 = await loader.post('/loading/scan', { shipment_id: shipmentId, lpn_code: staged[0].code }, idem());
    expect(l1.status).toBe(200);
    // duplicate scan of the same pallet
    const dup = await loader.post('/loading/scan', { shipment_id: shipmentId, lpn_code: staged[0].code }, idem());
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('ALREADY_LOADED');
    // partial load → release blocked
    const mid = await sup.post('/shipments/release', { shipment_id: shipmentId, version: (await sup.get(`/shipments/${shipmentId}`)).body.version });
    expect(mid.status).toBe(422);
    expect(mid.body.error).toBe('RELEASE_BLOCKED');
    const l2 = await loader.post('/loading/scan', { shipment_id: shipmentId, lpn_code: staged[1].code }, idem());
    expect(l2.status).toBe(200);
    expect(l2.body.release.can_release).toBe(true);
    const detail = await sup.get(`/shipments/${shipmentId}`);
    const rel = await sup.post('/shipments/release', { shipment_id: shipmentId, version: detail.body.version });
    expect(rel.status).toBe(200);
    expect(rel.body.status).toBe('RELEASED');
    const dep = await sup.post(`/shipments/${shipmentId}/depart`);
    expect(dep.status).toBe(200);
    const od2 = await sup.get(`/orders/${orderId}`);
    expect(od2.body.status).toBe('SHIPPED');
    expect(od2.body.lines.every((l: any) => l.loaded_qty === l.required_qty && l.verified_qty === l.required_qty)).toBe(true);
    // inventory left the building: sku1 total = 30 cases originally (20+5+...)  minus 20 shipped
    expect(await skuTotal(sku1().id)).toBe(30n); // 5 cases pallet C
    await expectReconciled();
  });

  it('LPN timeline reconstructs the whole story', async () => {
    const t = await sup.get(`/inventory/lpns/${lpnB}/timeline`);
    expect(t.status).toBe(200);
    const events = (t.body.events as any[]).map((e) => e.event);
    for (const ev of ['RECEIPT', 'PUTAWAY', 'ALLOCATE', 'PICK', 'STAGE', 'LOAD', 'SHIP']) expect(events).toContain(ev);
    expect(t.body.orders[0].picker).toBe(picker.username);
    expect(t.body.orders[0].verifier).toBe(verifier.username);
    expect(t.body.orders[0].plates).toBe('XYZ-99');
  });

  it('ledger is append-only and shipped LPNs are frozen', async () => {
    await expect(sql('UPDATE inventory_movements SET qty = 1 WHERE id = (SELECT min(id) FROM inventory_movements)')).rejects.toThrow(/append-only/);
    await expect(sql('DELETE FROM inventory_movements WHERE id = (SELECT min(id) FROM inventory_movements)')).rejects.toThrow(/append-only/);
    await expect(sql('DELETE FROM audit_logs WHERE id = (SELECT min(id) FROM audit_logs)')).rejects.toThrow(/append-only/);
    await expect(sql(`DELETE FROM lpns WHERE code = '${lpnB}'`)).rejects.toThrow(/append-only/);
    const lpnRow = await sql<{ id: string }>(`SELECT id FROM lpns WHERE code = '${lpnB}'`);
    const sku = f.skus[1]!.id;
    await expect(sql(`INSERT INTO inventory_movements (movement_type, sku_id, qty, to_lpn_id, to_status) VALUES ('ADJUST_IN', '${sku}', 5, '${lpnRow[0]!.id}', 'AVAILABLE')`)).rejects.toThrow(/LPN_FROZEN/);
  });
});
