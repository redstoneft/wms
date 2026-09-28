// Cancelling a receipt that already has pallets: admin only, every pallet intact, inventory reverted.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, expectReconciled, idem, makeFixture, skuTotal, sql, userWithRoles, type Client, type Fixture } from '../helpers.js';

let recv: Client;
let fork: Client;
let sup: Client;
let adminC: Client;
let f: Fixture;
beforeAll(async () => {
  recv = await userWithRoles('rcrecv', ['RECEIVING']);
  fork = await userWithRoles('rcfork', ['FORKLIFT']);
  sup = await userWithRoles('rcsup', ['SUPERVISOR']);
  adminC = await userWithRoles('rcadm', ['ADMIN']);
  const enroll = await adminC.post('/auth/mfa/enroll');
  const { totp } = await import('../../src/lib/crypto.js');
  expect((await adminC.post('/auth/mfa/enroll/confirm', { code: totp(enroll.body.secret) })).status).toBe(200);
  f = await makeFixture({ skus: 2 });
});
afterAll(closeApp);

describe('cancel a receipt with pallets', () => {
  it('reverts every pallet (at the dock or already stored), cancels put-aways, opens an incident; supervisors cannot', async () => {
    const r = await recv.post('/receipts', { receiving_location_id: f.dock.id, expected: [{ sku_code: f.skus[0]!.code, qty: 20, uom_code: 'CASE' }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const receiptId = r.body.id as string;
    const s1 = await recv.post('/receipts/scan', { receipt_id: receiptId, barcode: f.skus[0]!.case_barcode, qty: 10, cases_count: 10 }, idem());
    expect(s1.status, JSON.stringify(s1.body)).toBe(201);
    const lpnA = s1.body.lpn.code as string;
    const s2 = await recv.post('/receipts/scan', { receipt_id: receiptId, barcode: f.skus[0]!.case_barcode, qty: 10, cases_count: 10 }, idem());
    const lpnB = s2.body.lpn.code as string;
    // pallet A closed and put away into the rack; B stays open at the dock
    expect((await recv.post('/receipts/lpn/close', { lpn_code: lpnA }, idem())).status).toBe(200);
    const start = await fork.post('/putaway/start', { lpn_code: lpnA });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const target = await sql<{ barcode: string }>(`SELECT barcode FROM locations WHERE id = (SELECT suggested_location_id FROM putaway_tasks WHERE id = '${start.body.task.id}')`);
    expect((await fork.post('/putaway/confirm', { task_id: start.body.task.id, lpn_code: lpnA, location_barcode: target[0]!.barcode }, idem())).status).toBe(200);
    const before = await skuTotal(f.skus[0]!.id);
    expect(before).toBeGreaterThanOrEqual(120n);
    // a supervisor may only cancel empty receipts
    const supNo = await sup.post(`/receipts/${receiptId}/cancel`, { reason: 'llegó mal' });
    expect(supNo.status).toBe(422);
    expect(supNo.body.error).toBe('RECEIPT_HAS_LPNS');
    // a pallet allocated to an order blocks the cancellation
    const o = await sup.post('/orders', { order_number: `RC-${f.tag}`, customer_code: f.customer.code, lines: [{ sku_code: f.skus[0]!.code, qty: 12, uom_code: 'PIECE' }] });
    await sup.post(`/orders/${o.body.id}/accept`);
    expect((await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: false, strategy: 'LPN' })).status).toBe(200);
    const busy = await adminC.post(`/receipts/${receiptId}/cancel`, { reason: 'el proveedor se llevó la mercancía' });
    expect(busy.status).toBe(422);
    expect(busy.body.error).toBe('RECEIPT_LPNS_IN_USE');
    expect((await sup.post('/orders/cancel', { order_id: o.body.id, reason: 'prueba' })).status).toBe(200);
    // admin cancels: both pallets reverted
    const ok = await adminC.post(`/receipts/${receiptId}/cancel`, { reason: 'el proveedor se llevó la mercancía' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('CANCELLED');
    expect(ok.body.reverted.map((x: { lpn: string; qty: string }) => [x.lpn, x.qty]).sort()).toEqual([[lpnA, '60'], [lpnB, '60']].sort());
    expect(ok.body.incident_id).toBeTruthy();
    expect(before - (await skuTotal(f.skus[0]!.id))).toBe(120n);
    const lp = await sql<{ code: string; status: string }>(`SELECT code, status FROM lpns WHERE code IN ('${lpnA}','${lpnB}') ORDER BY code`);
    expect(lp.every((l) => l.status === 'CANCELLED')).toBe(true);
    expect((await sql<{ n: bigint }>(`SELECT count(*)::bigint AS n FROM putaway_tasks t JOIN lpns l ON l.id = t.lpn_id WHERE l.code = '${lpnB}' AND t.status IN ('PENDING','ASSIGNED','IN_PROGRESS')`))[0]!.n).toBe(0n);
    expect((await sql<{ received_qty: bigint }>(`SELECT received_qty FROM receipt_lines WHERE receipt_id = '${receiptId}'`))[0]!.received_qty).toBe(0n);
    expect((await adminC.post(`/receipts/${receiptId}/cancel`, { reason: 'otra vez' })).status).toBe(422);
    await expectReconciled();
  });
});
