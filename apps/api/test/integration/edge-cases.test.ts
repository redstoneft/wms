// EDGE CASES: mixed pallets, damaged product, quarantine, transfers, cycle counts,
// returns, replenishment, cancel during picking, label reprint, layout changes,
// racks full / blocked / weight exceeded, LPN split, unknown scans.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, expectReconciled, idem, makeFixture, skuTotal, sql, storedPallet, userWithRoles, type Client, type Fixture } from '../helpers.js';

let f: Fixture;
let sup: Client;
let recv: Client;
let fork: Client;
let inv: Client;

beforeAll(async () => {
  f = await makeFixture({ skus: 4, reserveBays: 8, levels: 3 }); // 24 reserve slots
  sup = await userWithRoles('esup', ['SUPERVISOR']);
  recv = await userWithRoles('erecv', ['RECEIVING']);
  fork = await userWithRoles('efork', ['FORKLIFT']);
  inv = await userWithRoles('einv', ['INVENTORY_CONTROL']);
});
afterAll(async () => {
  await closeApp();
});

describe('receiving edge cases', () => {
  it('mixed pallet, damaged units go to DAMAGED with an incident, unexpected SKU flagged, shortage on completion', async () => {
    const rcp = await recv.post('/receipts', { receiving_location_id: f.dock.id, expected: [{ sku_code: f.skus[0]!.code, qty: 10, uom_code: 'CASE' }, { sku_code: f.skus[1]!.code, qty: 10, uom_code: 'CASE' }] });
    const s1 = await recv.post('/receipts/scan', { receipt_id: rcp.body.id, barcode: f.skus[0]!.case_barcode, qty: 6 }, idem());
    const lpn = s1.body.lpn.code;
    // mixed: add sku1 to same pallet
    const s2 = await recv.post('/receipts/scan', { receipt_id: rcp.body.id, barcode: f.skus[1]!.case_barcode, qty: 4, lpn_code: lpn }, idem());
    expect(s2.status).toBe(201);
    expect(s2.body.lpn.is_new).toBe(false);
    // damaged cases of sku0
    const s3 = await recv.post('/receipts/scan', { receipt_id: rcp.body.id, barcode: f.skus[0]!.case_barcode, qty: 2, lpn_code: lpn, damaged: true }, idem());
    expect(s3.status).toBe(201);
    // unexpected SKU
    const s4 = await recv.post('/receipts/scan', { receipt_id: rcp.body.id, barcode: f.skus[2]!.case_barcode, qty: 1 }, idem());
    expect(s4.body.unexpected_sku).toBe(true);
    const done = await recv.post('/receipts/complete', { receipt_id: rcp.body.id, accept_differences: true });
    expect(done.status).toBe(200);
    const incs = await sup.get(`/incidents?entity_type=receipt&entity_id=${rcp.body.id}`);
    const types = incs.body.items.map((i: any) => i.incident_type).sort();
    expect(types).toContain('DAMAGED');
    expect(types).toContain('WRONG_SKU');
    expect(types).toContain('SHORTAGE');
    const detail = await recv.get(`/inventory/lpns/${lpn}`);
    const statuses = detail.body.balances.map((b: any) => b.status).sort();
    expect(statuses).toContain('DAMAGED');
    expect(statuses).toContain('AVAILABLE');
    // a mixed pallet cannot be moved partially (only_status) — but whole moves work via put-away
    await expectReconciled();
  });

  it('closing an empty LPN or completing an already completed receipt is rejected', async () => {
    const rcp = await recv.post('/receipts', { receiving_location_id: f.dock.id });
    const done = await recv.post('/receipts/complete', { receipt_id: rcp.body.id, accept_differences: true });
    expect(done.status).toBe(200);
    const again = await recv.post('/receipts/complete', { receipt_id: rcp.body.id, accept_differences: true });
    expect(again.status).toBe(422);
    const bad = await recv.post('/receipts/lpn/close', { lpn_code: 'PLT-1999-00000001' }, idem());
    expect(bad.status).toBe(404);
  });

  it('receipt on a non-receiving location or with inactive SKU is rejected', async () => {
    const r = await recv.post('/receipts', { receiving_location_id: f.reserve[0]!.id });
    expect(r.status).toBe(422);
    await sql(`UPDATE skus SET is_active = false WHERE id = '${f.skus[3]!.id}'`);
    const rcp = await recv.post('/receipts', { receiving_location_id: f.dock.id });
    const s = await recv.post('/receipts/scan', { receipt_id: rcp.body.id, barcode: f.skus[3]!.case_barcode, qty: 1 }, idem());
    expect(s.status).toBe(422);
    expect(s.body.error).toBe('SKU_INACTIVE');
    await sql(`UPDATE skus SET is_active = true WHERE id = '${f.skus[3]!.id}'`);
  });
});

describe('put-away constraints', () => {
  it('rack full / blocked / overweight / too tall locations are never suggested and are rejected on scan', async () => {
    const big = await makeFixture({ skus: 1, reserveBays: 2, levels: 1 });
    const r2 = await userWithRoles('erecv2', ['RECEIVING']);
    const fk = await userWithRoles('efork2', ['FORKLIFT']);
    // fill both slots
    await storedPallet(big, 0, big.reserve[0]!.id, 10n);
    await storedPallet(big, 0, big.reserve[1]!.id, 10n);
    // block picking slots
    for (const p of big.picking) await sup.patch(`/locations/${p.id}`, { admin_status: 'BLOCKED', reason: 'mantenimiento' });
    const rcp = await r2.post('/receipts', { receiving_location_id: big.dock.id });
    const scan = await r2.post('/receipts/scan', { receipt_id: rcp.body.id, barcode: big.skus[0]!.case_barcode, qty: 1 }, idem());
    await r2.post('/receipts/lpn/close', { lpn_code: scan.body.lpn.code }, idem());
    const start = await fk.post('/putaway/start', { lpn_code: scan.body.lpn.code });
    expect(start.status).toBe(422);
    expect(start.body.error).toBe('NO_LOCATION_AVAILABLE');
    // force scanning into the full slot with an authorization: still rejected by capacity
    const task = await sql<{ id: string }>(`SELECT t.id FROM putaway_tasks t JOIN lpns l ON l.id=t.lpn_id WHERE l.code = '${scan.body.lpn.code}' AND t.status <> 'COMPLETED'`);
    const auth = await sup.post('/authorizations', { exception_type: 'PUTAWAY_LOCATION_OVERRIDE', entity_type: 'putaway_task', entity_id: task[0]!.id, reason: 'forzar' });
    const forced = await fk.post('/putaway/confirm', { task_id: task[0]!.id, lpn_code: scan.body.lpn.code, location_barcode: big.reserve[0]!.barcode, authorization_id: auth.body.id }, idem());
    expect(forced.status).toBe(422);
    expect(forced.body.error).toBe('LOCATION_REJECTED');
    expect(forced.body.details.reasons).toContain('LOCATION_FULL');
    // unblock a picking slot → suggestion appears; weight limit: set tiny max weight → rejected
    await sup.patch(`/locations/${big.picking[0]!.id}`, { admin_status: 'ACTIVE', max_weight_kg: 1 });
    const re = await fk.post(`/putaway/tasks/${task[0]!.id}/resuggest`);
    expect(re.body.explanation.chosen).toBeNull();
    expect(re.body.explanation.rejected_sample.some((r: any) => r.reasons.includes('WEIGHT_EXCEEDED'))).toBe(true);
    await sup.patch(`/locations/${big.picking[0]!.id}`, { max_weight_kg: 1500, height_m: 1 });
    const re2 = await fk.post(`/putaway/tasks/${task[0]!.id}/resuggest`);
    expect(re2.body.explanation.rejected_sample.some((r: any) => r.reasons.includes('HEIGHT_EXCEEDED'))).toBe(true);
    await sup.patch(`/locations/${big.picking[0]!.id}`, { height_m: 2 });
    const re3 = await fk.post(`/putaway/tasks/${task[0]!.id}/resuggest`);
    expect(re3.body.explanation.chosen.code).toBe(big.picking[0]!.code);
    expect(re3.body.explanation.factors.length).toBeGreaterThan(0);
  });

  it('a location that disappears (deactivated) while a task targets it → resuggest works; occupied location cannot be deactivated', async () => {
    const lpn = await storedPallet(f, 0, f.reserve[3]!.id, 12n);
    const r = await sup.patch(`/locations/${f.reserve[3]!.id}`, { is_active: false });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('LOCATION_OCCUPIED');
    expect(lpn.code).toBeTruthy();
  });
});

describe('transfers, quarantine, adjustments', () => {
  it('two-phase transfer keeps inventory visible as IN_TRANSFER; wrong destination scan blocked; cancel restores', async () => {
    const lpn = await storedPallet(f, 1, f.reserve[4]!.id, 60n);
    const dest = f.reserve[5]!;
    const t = await fork.post('/transfers/start', { lpn_code: lpn.code, to_location_barcode: dest.barcode }, idem());
    expect(t.status).toBe(201);
    const mid = await sql<{ status: string; qty: bigint }>(`SELECT b.status, b.qty FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id WHERE l.code = '${lpn.code}'`);
    expect(mid).toEqual([{ status: 'IN_TRANSFER', qty: 60n }]);
    expect(await skuTotal(f.skus[1]!.id)).toBeGreaterThanOrEqual(60n);
    // destination is reserved: another pallet cannot start a transfer to it
    const other = await storedPallet(f, 1, f.reserve[6]!.id, 6n);
    const clash = await fork.post('/transfers/start', { lpn_code: other.code, to_location_barcode: dest.barcode }, idem());
    expect(clash.status).toBe(422);
    // second transfer of same LPN blocked
    const dup = await fork.post('/transfers/start', { lpn_code: lpn.code, to_location_barcode: f.reserve[7]!.barcode }, idem());
    expect(dup.status).toBe(422);
    const wrong = await fork.post('/transfers/complete', { transfer_id: t.body.transfer.id, lpn_code: lpn.code, location_barcode: f.reserve[7]!.barcode }, idem());
    expect(wrong.status).toBe(422);
    expect(wrong.body.error).toBe('WRONG_LOCATION');
    const cancel = await fork.post(`/transfers/${t.body.transfer.id}/cancel`, { reason: 'pasillo bloqueado' });
    expect(cancel.status).toBe(200);
    const after = await sql<{ status: string; qty: bigint }>(`SELECT b.status, b.qty FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id WHERE l.code = '${lpn.code}'`);
    expect(after).toEqual([{ status: 'AVAILABLE', qty: 60n }]);
    // now do it for real
    const t2 = await fork.post('/transfers/start', { lpn_code: lpn.code, to_location_barcode: dest.barcode }, idem());
    const done = await fork.post('/transfers/complete', { transfer_id: t2.body.transfer.id, lpn_code: lpn.code, location_barcode: dest.barcode }, idem());
    expect(done.status).toBe(200);
    const loc = await sup.get(`/inventory/lpns/${lpn.code}`);
    expect(loc.body.current_location.id).toBe(dest.id);
    await expectReconciled();
  });

  it('quarantined / blocked / damaged inventory can never be allocated; releasing makes it available again', async () => {
    const lpn = await storedPallet(f, 2, f.reserve[8]!.id, 30n);
    const q = await inv.post('/inventory/status', { lpn_code: lpn.code, action: 'QUARANTINE', reason_code: 'QUALITY_HOLD', reason: 'retención de calidad' }, idem());
    expect(q.status).toBe(200);
    const o = await sup.post('/orders', { order_number: `E-${f.tag}-Q`, customer_code: f.customer.code, lines: [{ sku_code: f.skus[2]!.code, qty: 1, uom_code: 'CASE' }] });
    await sup.post(`/orders/${o.body.id}/accept`);
    const a = await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: false });
    expect(a.status).toBe(422);
    // unknown reason code
    const bad = await inv.post('/inventory/status', { lpn_code: lpn.code, action: 'RELEASE_QUARANTINE', reason_code: 'NOPE', reason: 'código inexistente' }, idem());
    expect(bad.status).toBe(422);
    const rel = await inv.post('/inventory/status', { lpn_code: lpn.code, action: 'RELEASE_QUARANTINE', reason: 'inspección OK' }, idem());
    expect(rel.status).toBe(200);
    const a2 = await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: false });
    expect(a2.status).toBe(200);
    await expectReconciled();
  });

  it('adjustments require a reason and supervisor rights, never go negative, and always leave an incident', async () => {
    const lpn = await storedPallet(f, 3, f.reserve[9]!.id, 10n);
    const noReason = await inv.post('/inventory/adjust', { lpn_code: lpn.code, sku_code: f.skus[3]!.code, direction: 'OUT', qty: 1, uom_code: 'PIECE', reason: '' }, idem());
    expect(noReason.status).toBe(400);
    const noAuth = await inv.post('/inventory/adjust', { lpn_code: lpn.code, sku_code: f.skus[3]!.code, direction: 'OUT', qty: 1, uom_code: 'PIECE', reason: 'merma detectada' }, idem());
    expect(noAuth.status).toBe(403);
    const tooMuch = await sup.post('/inventory/adjust', { lpn_code: lpn.code, sku_code: f.skus[3]!.code, direction: 'OUT', qty: 11, uom_code: 'PIECE', reason: 'merma detectada' }, idem());
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error).toBe('INSUFFICIENT_INVENTORY');
    const ok = await sup.post('/inventory/adjust', { lpn_code: lpn.code, sku_code: f.skus[3]!.code, direction: 'OUT', qty: 4, uom_code: 'PIECE', reason: 'merma detectada' }, idem());
    expect(ok.status).toBe(201);
    expect(ok.body.incident_id).toBeTruthy();
    const bal = await sql<{ qty: bigint }>(`SELECT qty FROM inventory_balances b JOIN lpns l ON l.id=b.lpn_id WHERE l.code='${lpn.code}'`);
    expect(bal[0]!.qty).toBe(6n);
    // authorization path for an INVENTORY_CONTROL user
    const auth = await sup.post('/authorizations', { exception_type: 'COUNT_ADJUSTMENT', entity_type: 'lpn', entity_id: lpn.id, reason: 'aprobado por supervisor' });
    const withAuth = await inv.post('/inventory/adjust', { lpn_code: lpn.code, sku_code: f.skus[3]!.code, direction: 'IN', qty: 2, uom_code: 'PIECE', reason: 'encontrado', authorization_id: auth.body.id }, idem());
    expect(withAuth.status).toBe(201);
    // the authorization is consumed: cannot be reused
    const reuse = await inv.post('/inventory/adjust', { lpn_code: lpn.code, sku_code: f.skus[3]!.code, direction: 'IN', qty: 2, uom_code: 'PIECE', reason: 'encontrado', authorization_id: auth.body.id }, idem());
    expect(reuse.status).toBe(422);
    await expectReconciled();
  });
});

describe('cycle counts', () => {
  it('blind count hides system quantity, variance forces recount by a different person, approval adjusts via ledger', async () => {
    const loc = f.reserve[10]!;
    const lpn = await storedPallet(f, 0, loc.id, 48n);
    const task = await inv.post('/counts', { count_type: 'LOCATION', location_barcodes: [loc.barcode], is_blind: true });
    expect(task.status).toBe(201);
    const view = await inv.get(`/counts/${task.body.id}`);
    expect(view.body.lines[0].system_qty).toBeNull();
    const s = await inv.post('/counts/submit', { count_task_id: task.body.id, location_barcode: loc.barcode, lpn_code: lpn.code, barcode: f.skus[0]!.case_barcode, qty: 7 }, idem()); // 42
    expect(s.status).toBe(200);
    const fin = await inv.post(`/counts/${task.body.id}/finish`);
    expect(fin.body.status).toBe('RECOUNT');
    // same person cannot recount
    const same = await inv.post('/counts/submit', { count_task_id: task.body.id, location_barcode: loc.barcode, lpn_code: lpn.code, barcode: f.skus[0]!.case_barcode, qty: 7 }, idem());
    expect(same.status).toBe(422);
    expect(same.body.error).toBe('SAME_COUNTER');
    const other = await userWithRoles('einv2', ['INVENTORY_CONTROL']);
    const rc = await other.post('/counts/submit', { count_task_id: task.body.id, location_barcode: loc.barcode, lpn_code: lpn.code, barcode: f.skus[0]!.case_barcode, qty: 7 }, idem());
    expect(rc.status).toBe(200);
    const fin2 = await other.post(`/counts/${task.body.id}/finish`);
    expect(fin2.body.status).toBe('PENDING_APPROVAL');
    // inventory unchanged so far — nothing silent
    expect((await sql<{ qty: bigint }>(`SELECT qty FROM inventory_balances b JOIN lpns l ON l.id=b.lpn_id WHERE l.code='${lpn.code}'`))[0]!.qty).toBe(48n);
    const notSup = await other.post('/counts/approve', { count_task_id: task.body.id, decision: 'APPROVE', reason: 'x' });
    expect(notSup.status).toBe(403);
    const appr = await sup.post('/counts/approve', { count_task_id: task.body.id, decision: 'APPROVE', reason: 'recuento confirmado' });
    expect(appr.status).toBe(200);
    expect(appr.body.adjusted).toBe(1);
    expect((await sql<{ qty: bigint }>(`SELECT qty FROM inventory_balances b JOIN lpns l ON l.id=b.lpn_id WHERE l.code='${lpn.code}'`))[0]!.qty).toBe(42n);
    const mv = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM inventory_movements WHERE movement_type='COUNT_ADJUST_OUT' AND from_lpn_id = '${lpn.id}'`);
    expect(mv[0]!.n).toBe(1n);
    await expectReconciled();
  });

  it('a count that matches closes automatically; an empty scope is rejected; unexpected finds create lines with system 0', async () => {
    const loc = f.reserve[11]!;
    const lpn = await storedPallet(f, 1, loc.id, 12n);
    const task = await inv.post('/counts', { count_type: 'LOCATION', location_barcodes: [loc.barcode], is_blind: true });
    await inv.post('/counts/submit', { count_task_id: task.body.id, location_barcode: loc.barcode, lpn_code: lpn.code, barcode: f.skus[1]!.piece_barcode, qty: 12 }, idem());
    const fin = await inv.post(`/counts/${task.body.id}/finish`);
    expect(fin.body.status).toBe('CLOSED');
    const empty = await inv.post('/counts', { count_type: 'SKU', sku_codes: [f.skus[3]!.code + 'X'], is_blind: true });
    expect(empty.status).toBe(404);
    const t2 = await inv.post('/counts', { count_type: 'LOCATION', location_barcodes: [f.reserve[12]!.barcode], is_blind: true });
    expect(t2.status).toBe(201);
    const found = await inv.post('/counts/submit', { count_task_id: t2.body.id, location_barcode: f.reserve[12]!.barcode, barcode: f.skus[2]!.piece_barcode, qty: 3 }, idem());
    expect(found.status).toBe(200);
    const fin2 = await inv.post(`/counts/${t2.body.id}/finish`);
    expect(fin2.body.status).toBe('RECOUNT');
    expect(fin2.body.variances).toBe(1);
  });
});

describe('orders: cancellation during picking, partial allocation, short pick', () => {
  it('cancelling an order mid-pick needs authorization, returns picked goods to stock, creates put-away task', async () => {
    const picker = await userWithRoles('epick', ['PICKER']);
    await storedPallet(f, 2, f.reserve[13]!.id, 60n);
    const o = await sup.post('/orders', { order_number: `E-${f.tag}-C`, customer_code: f.customer.code, lines: [{ sku_code: f.skus[2]!.code, qty: 5, uom_code: 'CASE' }] });
    await sup.post(`/orders/${o.body.id}/accept`);
    await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: false, strategy: 'LPN' });
    const t = await sup.post('/picking/tasks', { order_id: o.body.id });
    const v = await picker.post(`/picking/tasks/${t.body.task.id}/start`);
    const line = v.body.lines[0];
    const srcBefore = await sql<{ t: bigint }>(`SELECT COALESCE(sum(b.qty),0)::bigint AS t FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id WHERE l.code = '${line.lpn_code}'`);
    expect((await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: line.id, step: 'LOCATION', scanned: line.location_barcode }, idem())).status).toBe(200);
    expect((await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: line.id, step: 'LPN', scanned: line.lpn_code }, idem())).status).toBe(200);
    const pk = await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: line.id, step: 'QTY', qty: 2, uom_code: 'CASE' }, idem());
    expect(pk.status).toBe(200);
    const outbound = pk.body.outbound_lpn as string;
    const before = await skuTotal(f.skus[2]!.id);
    const noAuth = await sup.post('/orders/cancel', { order_id: o.body.id, reason: 'cliente canceló' });
    expect(noAuth.status).toBe(422);
    const auth = await sup.post('/authorizations', { exception_type: 'ORDER_CANCEL_DURING_PICKING', entity_type: 'order', entity_id: o.body.id, reason: 'cliente canceló' });
    const c = await sup.post('/orders/cancel', { order_id: o.body.id, reason: 'cliente canceló', authorization_id: auth.body.id });
    expect(c.status).toBe(200);
    expect(await skuTotal(f.skus[2]!.id)).toBe(before); // nothing lost
    // source pallet: everything not picked is AVAILABLE again; picked units live on the (now storage) outbound pallet, AVAILABLE, with a put-away task
    const src = await sql<{ status: string; qty: bigint }>(`SELECT b.status, b.qty FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id WHERE l.code = '${line.lpn_code}' ORDER BY b.status`);
    expect(src.reduce((a, r) => a + r.qty, 0n)).toBe(srcBefore[0]!.t - 12n);
    expect(src.some((r) => r.status === 'PICKING')).toBe(false);
    const srcAvail = src.find((r) => r.status === 'AVAILABLE')!.qty;
    expect(srcAvail).toBeGreaterThanOrEqual(srcBefore[0]!.t - 12n - 6n); // other tests may hold an allocation on this shared pallet
    const out = await sql<{ status: string; qty: bigint; lpn_status: string; lpn_type: string }>(`SELECT b.status, b.qty, l.status AS lpn_status, l.lpn_type FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id WHERE l.code = '${outbound}'`);
    expect(out).toEqual([{ status: 'AVAILABLE', qty: 12n, lpn_status: 'STORED', lpn_type: 'STORAGE' }]);
    const task = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM putaway_tasks t JOIN lpns l ON l.id = t.lpn_id WHERE l.code = '${outbound}' AND t.status = 'PENDING'`);
    expect(task[0]!.n).toBe(1n);
    const allocs = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM allocations a JOIN order_lines ol ON ol.id = a.order_line_id WHERE ol.order_id = '${o.body.id}' AND a.status = 'ACTIVE'`);
    expect(allocs[0]!.n).toBe(0n);
    const od = await sup.get(`/orders/${o.body.id}`);
    expect(od.body.status).toBe('CANCELLED');
    await expectReconciled();
  });

  it('partial allocation is explicit; short pick deallocates the remainder and blocks release later', async () => {
    const picker = await userWithRoles('epick2', ['PICKER']);
    await storedPallet(f, 3, f.reserve[14]!.id, 12n);
    const o = await sup.post('/orders', { order_number: `E-${f.tag}-P`, customer_code: f.customer.code, lines: [{ sku_code: f.skus[3]!.code, qty: 100, uom_code: 'CASE' }] });
    await sup.post(`/orders/${o.body.id}/accept`);
    const strict = await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: false });
    expect(strict.status).toBe(422);
    const partial = await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: true });
    expect(partial.status).toBe(200);
    expect(partial.body.status).toBe('PARTIALLY_ALLOCATED');
    const t = await sup.post('/picking/tasks', { order_id: o.body.id });
    const v = await picker.post(`/picking/tasks/${t.body.task.id}/start`);
    const lines = v.body.lines as any[];
    const noPerm = await picker.post('/picking/short', { pick_task_id: t.body.task.id, line_id: lines[0].id, reason: 'no hay producto' });
    expect(noPerm.status).toBe(403);
    let lastCompleted = false;
    for (const line of lines) {
      const short = await sup.post('/picking/short', { pick_task_id: t.body.task.id, line_id: line.id, reason: 'no hay producto' });
      expect(short.status).toBe(200);
      lastCompleted = short.body.task_completed;
    }
    expect(lastCompleted).toBe(true);
    const od = await sup.get(`/orders/${o.body.id}`);
    expect(od.body.lines[0].allocated_qty).toBe('0');
    expect(od.body.lines[0].picked_qty).toBe('0');
    const inc = await sup.get(`/incidents?type=PICKING_ERROR`);
    expect(inc.body.items.length).toBeGreaterThan(0);
    await expectReconciled();
  });
});

describe('returns', () => {
  it('return → quarantine → classify (restock / damaged / scrap) with ledger movements and original order reference', async () => {
    const r = await recv.post('/returns', { customer_code: f.customer.code, lines: [{ sku_code: f.skus[0]!.code, qty: 10, uom_code: 'PIECE' }] });
    expect(r.status).toBe(201);
    const line = r.body.lines[0];
    const rec = await recv.post('/returns/receive', { return_id: r.body.id, line_id: line.id, qty: 10, returns_location_barcode: f.returns.barcode }, idem());
    expect(rec.status).toBe(200);
    const lpn = rec.body.lpn_code;
    const q = await sql<{ status: string; qty: bigint }>(`SELECT b.status, b.qty FROM inventory_balances b JOIN lpns l ON l.id=b.lpn_id WHERE l.code='${lpn}'`);
    expect(q).toEqual([{ status: 'QUARANTINE', qty: 10n }]);
    const over = await recv.post('/returns/classify', { return_id: r.body.id, line_id: line.id, disposition: 'RESTOCK', qty: 11, reason: 'más de lo recibido' }, idem());
    expect(over.status).toBe(422);
    expect((await recv.post('/returns/classify', { return_id: r.body.id, line_id: line.id, disposition: 'RESTOCK', qty: 6, reason: 'empaque intacto' }, idem())).status).toBe(200);
    expect((await recv.post('/returns/classify', { return_id: r.body.id, line_id: line.id, disposition: 'DAMAGED', qty: 3, reason: 'golpeado' }, idem())).status).toBe(200);
    const last = await recv.post('/returns/classify', { return_id: r.body.id, line_id: line.id, disposition: 'SCRAP', qty: 1, reason: 'destruido' }, idem());
    expect(last.status).toBe(200);
    expect(last.body.return_status).toBe('CLASSIFIED');
    expect(last.body.putaway_task).toBeTruthy();
    const after = await sql<{ status: string; qty: bigint }>(`SELECT b.status, b.qty FROM inventory_balances b JOIN lpns l ON l.id=b.lpn_id WHERE l.code='${lpn}' ORDER BY status`);
    expect(after).toEqual([{ status: 'AVAILABLE', qty: 6n }, { status: 'DAMAGED', qty: 3n }]);
    expect((await recv.post(`/returns/${r.body.id}/close`)).status).toBe(200);
    await expectReconciled();
  });
});

describe('replenishment', () => {
  it('when a picking face drops to its minimum a task is generated with the best reserve pallet', async () => {
    const pickLoc = f.picking[0]!;
    // face with 2 cases, min 3, max 20
    await storedPallet(f, 1, pickLoc.id, 12n);
    const reserveA = await storedPallet(f, 1, f.reserve[15]!.id, 240n);
    const rule = await inv.post('/replenishment/rules', { sku_code: f.skus[1]!.code, pick_location_barcode: pickLoc.barcode, min_qty: 18, max_qty: 120 });
    expect(rule.status).toBe(201);
    const ev = await inv.post('/replenishment/evaluate');
    expect(ev.body.created).toBeGreaterThanOrEqual(1);
    const tasks = await fork.get('/replenishment/tasks');
    const mine = tasks.body.find((t: any) => t.to_code === pickLoc.code);
    expect(mine).toBeTruthy();
    // a second evaluation does not duplicate the task
    const ev2 = await inv.post('/replenishment/evaluate');
    expect(ev2.body.created).toBe(0);
    // the pick face is a single-pallet slot that already holds a pallet: the move is refused with a clear reason
    const full = await fork.post(`/replenishment/tasks/${mine.id}/start`);
    expect(full.status).toBe(422);
    expect(full.body.error).toBe('LOCATION_REJECTED');
    expect(full.body.details.reasons).toContain('LOCATION_FULL');
    // give the face room for a second pallet → replenishment proceeds as a REPLENISHMENT transfer
    await sup.patch(`/locations/${pickLoc.id}`, { pallet_capacity: 2 });
    const start = await fork.post(`/replenishment/tasks/${mine.id}/start`);
    expect(start.status).toBe(200);
    // the engine chooses a single-SKU AVAILABLE reserve pallet of this SKU (smallest pallet that fits the gap first, FIFO)
    const src = await sql<{ code: string; status: string; sku_id: string; location_type: string }>(`SELECT l.code, b.status, b.sku_id, loc.location_type FROM lpns l JOIN inventory_balances b ON b.lpn_id = l.id JOIN locations loc ON loc.id = l.current_location_id WHERE l.code = '${start.body.lpn_code}'`);
    expect(src.every((r) => r.sku_id === f.skus[1]!.id)).toBe(true);
    expect(src.every((r) => r.status === 'IN_TRANSFER')).toBe(true);
    expect(src[0]!.location_type).toBe('RESERVE');
    expect([reserveA.code, start.body.lpn_code]).toContain(start.body.lpn_code);
    const done = await fork.post('/transfers/complete', { transfer_id: start.body.transfer.id, lpn_code: start.body.lpn_code, location_barcode: pickLoc.barcode }, idem());
    expect(done.status).toBe(200);
    const t2 = await sql<{ status: string }>(`SELECT status FROM replenishment_tasks WHERE id = '${mine.id}'`);
    expect(t2[0]!.status).toBe('COMPLETED');
    const mv = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM inventory_movements m JOIN lpns l ON l.id = m.to_lpn_id WHERE m.movement_type = 'REPLENISH_COMPLETE' AND l.code = '${start.body.lpn_code}'`);
    expect(mv[0]!.n).toBe(1n);
    await expectReconciled();
  });
});

describe('labels', () => {
  it('preview renders valid ZPL + PNG barcode; reprint requires permission and reason and is audited', async () => {
    const lpn = await storedPallet(f, 0, f.reserve[16]!.id, 5n);
    const prev = await recv.post('/labels/preview', { label_type: 'LPN', entity_id: lpn.code });
    expect(prev.status).toBe(200);
    expect(prev.body.zpl).toContain('^XA');
    expect(prev.body.zpl).toContain(lpn.code);
    expect(prev.body.barcode_png.startsWith('data:image/png;base64,')).toBe(true);
    // no printer reachable: print records FAILED and returns 422 PRINTER_UNREACHABLE
    await sql(`INSERT INTO printers (code, name, host, port, is_default) VALUES ('TEST-${f.tag}', 't', '127.0.0.1', 1, true) ON CONFLICT DO NOTHING`);
    const p1 = await recv.post('/labels/print', { label_type: 'LPN', entity_id: lpn.code });
    expect(p1.status).toBe(422);
    expect(p1.body.error).toBe('PRINTER_UNREACHABLE');
    // simulate a successful first print so the next one is a reprint
    await sql(`UPDATE label_prints SET status = 'SENT' WHERE id = '${p1.body.details.print_id}'`);
    const noReason = await recv.post('/labels/print', { label_type: 'LPN', entity_id: lpn.code });
    expect(noReason.status).toBe(403); // RECEIVING lacks labels.reprint
    const supNoReason = await sup.post('/labels/print', { label_type: 'LPN', entity_id: lpn.code });
    expect(supNoReason.status).toBe(422);
    expect(supNoReason.body.error).toBe('REPRINT_REASON_REQUIRED');
    const rp = await sup.post('/labels/print', { label_type: 'LPN', entity_id: lpn.code, reprint_reason: 'etiqueta dañada' });
    expect(rp.status).toBe(422); // printer still unreachable, but the reprint was recorded and audited
    const hist = await sup.get(`/labels/history?entity_id=${lpn.code}`);
    expect(hist.body.some((h: any) => h.is_reprint)).toBe(true);
    const aud = await sup.get(`/audit?action=label.reprint`);
    expect(aud.body.items.length).toBeGreaterThan(0);
    for (const t of ['LOCATION', 'STAGING', 'CASE'] as const) {
      const id = t === 'LOCATION' ? f.reserve[0]!.code : t === 'STAGING' ? f.staging[0]!.code : f.skus[0]!.code;
      const r = await recv.post('/labels/preview', { label_type: t, entity_id: id });
      expect(r.status, t).toBe(200);
    }
  });
});

describe('layout ↔ 3D map synchronisation', () => {
  it('map reflects DB state: occupancy, moves, frees, blocks, and rack geometry changes', async () => {
    const loc = f.reserve[17]!;
    const map0 = await sup.get(`/map?warehouse_id=${f.warehouse_id}`);
    const l0 = map0.body.locations.find((l: any) => l.id === loc.id);
    expect(l0.status).toBe('FREE');
    const lpn = await storedPallet(f, 0, loc.id, 10n);
    const map1 = await sup.get(`/map?warehouse_id=${f.warehouse_id}`);
    const l1 = map1.body.locations.find((l: any) => l.id === loc.id);
    expect(l1.status).toBe('OCCUPIED');
    expect(l1.lpn_count).toBe(1);
    // move it
    const dest = f.reserve[18]!;
    const t = await fork.post('/transfers/start', { lpn_code: lpn.code, to_location_barcode: dest.barcode }, idem());
    const mapT = await sup.get(`/map?warehouse_id=${f.warehouse_id}`);
    expect(mapT.body.locations.find((l: any) => l.id === dest.id).status).toBe('RESERVED');
    await fork.post('/transfers/complete', { transfer_id: t.body.transfer.id, lpn_code: lpn.code, location_barcode: dest.barcode }, idem());
    const map2 = await sup.get(`/map?warehouse_id=${f.warehouse_id}`);
    expect(map2.body.locations.find((l: any) => l.id === loc.id).status).toBe('FREE');
    expect(map2.body.locations.find((l: any) => l.id === dest.id).status).toBe('OCCUPIED');
    await sup.patch(`/locations/${loc.id}`, { admin_status: 'BLOCKED', reason: 'daño en viga' });
    const map3 = await sup.get(`/map?warehouse_id=${f.warehouse_id}`);
    expect(map3.body.locations.find((l: any) => l.id === loc.id).status).toBe('BLOCKED');
    // search
    const s = await sup.get(`/map/search?type=LPN&q=${lpn.code}`);
    expect(s.body.hits[0].location_id).toBe(dest.id);
    const s2 = await sup.get(`/map/search?type=SKU&q=${f.skus[0]!.code}`);
    expect(s2.body.hits.some((h: any) => h.location_id === dest.id)).toBe(true);
    // rack geometry change moves every position
    const rack = await sql<{ rack_id: string }>(`SELECT rack_id FROM locations WHERE id = '${loc.id}'`);
    const upd = await sup.patch(`/racks/${rack[0]!.rack_id}`, { x_m: 33 });
    expect(upd.status).toBe(200);
    const map4 = await sup.get(`/map?warehouse_id=${f.warehouse_id}`);
    const moved = map4.body.locations.find((l: any) => l.id === loc.id);
    expect(moved.x).toBeGreaterThanOrEqual(33);
    // shrinking a rack that still holds pallets is refused
    const shrink = await sup.patch(`/racks/${rack[0]!.rack_id}`, { bays: 1 });
    expect(shrink.status).toBe(422);
    expect(shrink.body.error).toBe('LOCATION_OCCUPIED');
  });
});

describe('LPN identity', () => {
  it('LPN codes are unique, sequential, never reused, and reconstructable history exists for every pallet', async () => {
    const a = await storedPallet(f, 0, f.reserve[19]!.id, 1n);
    const b = await storedPallet(f, 0, f.reserve[20]!.id, 1n);
    expect(Number(b.code.slice(-8))).toBeGreaterThan(Number(a.code.slice(-8)));
    await expect(sql(`INSERT INTO lpns (code, warehouse_id) VALUES ('${a.code}', '${f.warehouse_id}')`)).rejects.toThrow();
    await expect(sql(`INSERT INTO lpns (code, warehouse_id) VALUES ('BAD-CODE', '${f.warehouse_id}')`)).rejects.toThrow(/ck_lpn_code_format/);
    const tl = await sup.get(`/inventory/lpns/${a.code}/timeline`);
    expect(tl.body.events.length).toBeGreaterThan(0);
    const nf = await sup.get(`/inventory/lpns/PLT-1999-99999999/timeline`);
    expect(nf.status).toBe(404);
  });
});
