// Receiving corrections (a scan registered by mistake) and choosing the put-away destination.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, expectReconciled, idem, makeFixture, sql, storedPallet, userWithRoles, type Client, type Fixture } from '../helpers.js';

let f: Fixture;
let recv: Client;
let fork: Client;

beforeAll(async () => {
  f = await makeFixture({ skus: 2 });
  recv = await userWithRoles('undorecv', ['RECEIVING']);
  fork = await userWithRoles('undofork', ['FORKLIFT']);
});
afterAll(closeApp);

const sku0 = () => f.skus[0]!;

describe('receiving corrections and put-away destination choice', () => {
  let receiptId: string;
  let lpn: string;

  it('a product scanned twice is undone: the pallet and the receipt line go back down, an emptied pallet is cancelled', async () => {
    const r = await recv.post('/receipts', { receiving_location_id: f.dock.id, expected: [{ sku_code: sku0().code, qty: 36, uom_code: 'CASE' }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    receiptId = r.body.id;
    const s1 = await recv.post('/receipts/scan', { receipt_id: receiptId, barcode: sku0().case_barcode, qty: 36, cases_count: 36 }, idem());
    expect(s1.status, JSON.stringify(s1.body)).toBe(201);
    lpn = s1.body.lpn.code;
    // the mistake: the same 36 cases registered again on the same pallet
    const s2 = await recv.post('/receipts/scan', { receipt_id: receiptId, barcode: sku0().case_barcode, qty: 36, lpn_code: lpn }, idem());
    expect(s2.status).toBe(201);
    expect(s2.body.line.received_qty).toBe((72n * sku0().case_qty).toString());
    expect(s2.body.line.status).toBe('OVER');
    // undo 36 cases
    const u = await recv.post('/receipts/undo', { receipt_id: receiptId, lpn_code: lpn, sku_code: sku0().code, qty: 36, uom_code: 'CASE' }, idem());
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    expect(u.body.qty_base).toBe((36n * sku0().case_qty).toString());
    expect(u.body.line.received_qty).toBe((36n * sku0().case_qty).toString());
    expect(u.body.line.status).toBe('COMPLETE');
    expect(u.body.lpn.empty).toBe(false);
    const bal = await sql<{ qty: bigint }>(`SELECT COALESCE(sum(b.qty),0)::bigint AS qty FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id WHERE l.code = '${lpn}'`);
    expect(bal[0]!.qty).toBe(36n * sku0().case_qty);
    const mv = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM inventory_movements WHERE movement_type = 'RECEIPT_UNDO' AND receipt_id = '${receiptId}'`);
    expect(mv[0]!.n).toBe(1n);
    // more than the pallet holds → refused
    const too = await recv.post('/receipts/undo', { receipt_id: receiptId, lpn_code: lpn, sku_code: sku0().code, qty: 40, uom_code: 'CASE' }, idem());
    expect(too.status).toBe(422);
    expect(too.body.error).toBe('INSUFFICIENT_INVENTORY');
    // a second pallet created by mistake, fully undone → cancelled, line unchanged
    const s3 = await recv.post('/receipts/scan', { receipt_id: receiptId, barcode: sku0().piece_barcode, qty: 5 }, idem());
    expect(s3.status).toBe(201);
    const u2 = await recv.post('/receipts/undo', { receipt_id: receiptId, lpn_code: s3.body.lpn.code, sku_code: sku0().code, qty: 5, uom_code: 'PIECE' }, idem());
    expect(u2.status, JSON.stringify(u2.body)).toBe(200);
    expect(u2.body.lpn).toMatchObject({ empty: true, status: 'CANCELLED' });
    expect(u2.body.line.received_qty).toBe((36n * sku0().case_qty).toString());
    await expectReconciled();
  });

  it('a closed pallet still at the dock can be corrected; once put away it cannot (count/adjustment instead)', async () => {
    const c = await recv.post('/receipts/lpn/close', { lpn_code: lpn }, idem());
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const u = await recv.post('/receipts/undo', { receipt_id: receiptId, lpn_code: lpn, sku_code: sku0().code, qty: 1, uom_code: 'CASE' }, idem());
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    expect(u.body.lpn.status).toBe('STORED');
    await expectReconciled();
  });

  it('put-away: the operator sees the destinations the engine accepts, asks for another one, or picks one from the list', async () => {
    // a pallet of the same product already stored: locations holding it are listed first (consolidation)
    await storedPallet(f, 0, f.reserve[3]!.id, 12n);
    const start = await fork.post('/putaway/start', { lpn_code: lpn });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const taskId: string = start.body.task.id;
    const first: string = start.body.target.code;
    const opt = await fork.get(`/putaway/tasks/${taskId}/options`);
    expect(opt.status, JSON.stringify(opt.body)).toBe(200);
    expect(opt.body.current).toBe(first);
    expect(opt.body.options.length).toBeGreaterThan(1);
    expect(opt.body.options.some((o: { is_current: boolean }) => o.is_current)).toBe(true);
    // "another one": a different location
    const other = await fork.post(`/putaway/tasks/${taskId}/choose`, { other: true });
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    expect(other.body.target.code).not.toBe(first);
    // pick a specific one from the list
    const pick = opt.body.options.find((o: { code: string }) => o.code !== first && o.code !== other.body.target.code) ?? opt.body.options.find((o: { code: string }) => o.code !== other.body.target.code);
    const chosen = await fork.post(`/putaway/tasks/${taskId}/choose`, { location_code: pick.code });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
    expect(chosen.body.target.code).toBe(pick.code);
    // a location that is not storage is refused; the chosen one is confirmed by scanning it (no supervisor override needed)
    const bad = await fork.post(`/putaway/tasks/${taskId}/choose`, { location_code: f.dock.code });
    expect(bad.status).toBe(422);
    const ok = await fork.post('/putaway/confirm', { task_id: taskId, lpn_code: lpn, location_barcode: chosen.body.target.barcode }, idem());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.overridden).toBe(false);
    expect(ok.body.location).toBe(pick.code);
    // now the pallet left the dock: receiving corrections are over
    const late = await recv.post('/receipts/undo', { receipt_id: receiptId, lpn_code: lpn, sku_code: sku0().code, qty: 1, uom_code: 'CASE' }, idem());
    expect(late.status).toBe(422);
    expect(late.body.error).toBe('LPN_LEFT_DOCK');
    await expectReconciled();
  });
});
