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
});
