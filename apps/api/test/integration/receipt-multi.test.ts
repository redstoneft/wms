// Receiving one product on several pallets at once, and reopening a completed receipt (admin).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, expectReconciled, idem, makeFixture, sql, userWithRoles, type Client, type Fixture } from '../helpers.js';

let recv: Client;
let sup: Client;
let adminC: Client;
let f: Fixture;
beforeAll(async () => {
  recv = await userWithRoles('rmrecv', ['RECEIVING']);
  sup = await userWithRoles('rmsup', ['SUPERVISOR']);
  adminC = await userWithRoles('rmadm', ['ADMIN']);
  const enroll = await adminC.post('/auth/mfa/enroll');
  const { totp } = await import('../../src/lib/crypto.js');
  expect((await adminC.post('/auth/mfa/enroll/confirm', { code: totp(enroll.body.secret) })).status).toBe(200);
  f = await makeFixture({ skus: 2 });
});
afterAll(closeApp);

describe('receiving on several pallets', () => {
  it('splits the quantity evenly, each pallet is born closed with its put-away, and the line sums the total', async () => {
    const r = await recv.post('/receipts', { receiving_location_id: f.dock.id, expected: [{ sku_code: f.skus[0]!.code, qty: 1000, uom_code: 'PIECE' }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const s = await recv.post('/receipts/scan', { receipt_id: r.body.id, barcode: f.skus[0]!.piece_barcode ?? f.skus[0]!.code, qty: 1000, uom_code: 'PIECE', pallets: 3, cases_count: 100 }, idem());
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    expect(s.body.pallets.length).toBe(3);
    expect(s.body.pallets.map((p: { qty: string }) => p.qty)).toEqual(['334', '333', '333']);
    expect(s.body.qty_base).toBe('1000');
    expect(s.body.line).toMatchObject({ expected_qty: '1000', received_qty: '1000' });
    const lpns = await sql<{ code: string; status: string; cases_count: number; tasks: bigint }>(`SELECT l.code, l.status, l.cases_count, (SELECT count(*) FROM putaway_tasks p WHERE p.lpn_id = l.id AND p.status IN ('PENDING','ASSIGNED'))::bigint AS tasks FROM lpns l WHERE l.receipt_id = '${r.body.id}' ORDER BY l.code`);
    expect(lpns.length).toBe(3);
    expect(lpns.every((l) => l.status === 'STORED' && l.tasks === 1n)).toBe(true);
    expect(lpns.map((l) => l.cases_count).sort()).toEqual([33, 33, 34]);
    // fewer pieces than pallets is refused; adding to an existing pallet ignores the pallet count
    const bad = await recv.post('/receipts/scan', { receipt_id: r.body.id, barcode: f.skus[1]!.code, qty: 2, uom_code: 'PIECE', pallets: 3 }, idem());
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe('QTY_LT_PALLETS');
    const done = await recv.post('/receipts/complete', { receipt_id: r.body.id, accept_differences: true });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.receipt.status).toBe('COMPLETED');
    // reopen (admin only), receive one more pallet, complete again
    expect((await sup.post(`/receipts/${r.body.id}/reopen`, { reason: 'faltó una tarima' })).status).toBe(403);
    const ro = await adminC.post(`/receipts/${r.body.id}/reopen`, { reason: 'faltó una tarima' });
    expect(ro.status, JSON.stringify(ro.body)).toBe(200);
    expect(ro.body.status).toBe('IN_PROGRESS');
    const s2 = await recv.post('/receipts/scan', { receipt_id: r.body.id, barcode: f.skus[0]!.code, qty: 50, uom_code: 'PIECE' }, idem());
    expect(s2.status, JSON.stringify(s2.body)).toBe(201);
    const done2 = await recv.post('/receipts/complete', { receipt_id: r.body.id, accept_differences: true });
    expect(done2.status).toBe(200);
    expect(done2.body.receipt.status).toBe('WITH_INCIDENT'); // 1,050 received vs 1,000 expected
    await expectReconciled();
  });

  it('pallet_qtys: each pallet gets the pieces the floor says; closed pallets at the dock can still take product', async () => {
    const r = await recv.post('/receipts', { receiving_location_id: f.dock.id, expected: [{ sku_code: f.skus[0]!.code, qty: 1000, uom_code: 'PIECE' }, { sku_code: f.skus[1]!.code, qty: 50, uom_code: 'PIECE' }] });
    expect(r.status).toBe(201);
    const s = await recv.post('/receipts/scan', { receipt_id: r.body.id, barcode: f.skus[0]!.code, qty: 1000, uom_code: 'PIECE', pallet_qtys: [500, 300, 200], cases_count: 100 }, idem());
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    expect(s.body.pallets.map((p: { qty: string }) => p.qty)).toEqual(['500', '300', '200']);
    const lpns = await sql<{ code: string; status: string; cases_count: number }>(`SELECT code, status, cases_count FROM lpns WHERE receipt_id = '${r.body.id}' ORDER BY code`);
    expect(lpns.map((l) => l.cases_count)).toEqual([50, 30, 20]);
    expect(lpns.every((l) => l.status === 'STORED')).toBe(true);
    // the sum must match the declared total
    const bad = await recv.post('/receipts/scan', { receipt_id: r.body.id, barcode: f.skus[0]!.code, qty: 100, uom_code: 'PIECE', pallet_qtys: [60, 50] }, idem());
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe('PALLET_QTYS_SUM');
    // a closed pallet still at the dock takes more product (a short capture is corrected by adding)
    const more = await recv.post('/receipts/scan', { receipt_id: r.body.id, barcode: f.skus[1]!.code, qty: 50, uom_code: 'PIECE', lpn_code: lpns[0]!.code }, idem());
    expect(more.status, JSON.stringify(more.body)).toBe(201);
    expect(more.body.lpn.code).toBe(lpns[0]!.code);
    expect(more.body.line).toMatchObject({ expected_qty: '50', received_qty: '50' });
    // once the pallet is put away it no longer takes product from the receipt
    const task = (await sql<{ id: string }>(`SELECT p.id FROM putaway_tasks p JOIN lpns l ON l.id = p.lpn_id WHERE l.code = $1 AND p.status IN ('PENDING','ASSIGNED')`, [lpns[0]!.code]))[0]!;
    const put = await sup.post('/putaway/confirm', { task_id: task.id, lpn_code: lpns[0]!.code, location_barcode: f.reserve[5]!.barcode, override_reason: 'prueba: otra posicion' }, idem());
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const late = await recv.post('/receipts/scan', { receipt_id: r.body.id, barcode: f.skus[1]!.code, qty: 1, uom_code: 'PIECE', lpn_code: lpns[0]!.code }, idem());
    expect(late.status).toBe(422);
    expect(late.body.error).toBe('LPN_NOT_OPEN');
    await expectReconciled();
  });
});
