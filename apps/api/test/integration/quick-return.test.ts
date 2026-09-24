// Quick return from the handheld: a couple of pieces straight onto the pallet that holds the product; damaged → returns area.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, expectReconciled, idem, makeFixture, sql, storedPallet, userWithRoles, type Client, type Fixture } from '../helpers.js';

let f: Fixture;
let recv: Client;
let fork: Client;
let sup: Client;

beforeAll(async () => {
  f = await makeFixture({ skus: 2 });
  recv = await userWithRoles('qrrecv', ['RECEIVING']);
  fork = await userWithRoles('qrfork', ['FORKLIFT']); // every operator role may register a quick return
  sup = await userWithRoles('qrsup', ['SUPERVISOR']);
});
afterAll(closeApp);

describe('quick return', () => {
  it('good pieces land on the chosen pallet after scanning it (or its location) at the rack; wrong pallet/product/scan are refused', async () => {
    const p = await storedPallet(f, 0, f.reserve[0]!.id, 12n);
    const other = await storedPallet(f, 1, f.reserve[1]!.id, 5n);
    // must hold the product
    const bad = await recv.post('/returns/quick', { sku_code: f.skus[0]!.code, qty: 2, to_lpn_code: other.code, scanned: other.code }, idem());
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe('LPN_OTHER_PRODUCT');
    // the scan must be the pallet or its location
    const wrong = await recv.post('/returns/quick', { sku_code: f.skus[0]!.code, qty: 2, to_lpn_code: p.code, scanned: f.reserve[5]!.barcode }, idem());
    expect(wrong.status).toBe(422);
    expect(wrong.body.error).toBe('WRONG_PALLET');
    const ok = await fork.post('/returns/quick', { sku_code: f.skus[0]!.piece_barcode, qty: 2, to_lpn_code: p.code, scanned: f.reserve[0]!.barcode, note: 'cliente regresó 2 piezas' }, idem());
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ lpn: p.code, location: f.reserve[0]!.code, damaged: false, qty_base: '2' });
    expect(ok.body.return_number).toMatch(/^RET-/);
    const bal = await sql<{ qty: bigint; status: string }>(`SELECT b.qty, b.status FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id JOIN skus s ON s.id = b.sku_id WHERE l.code = '${p.code}' AND s.code = '${f.skus[0]!.code}'`);
    expect(bal).toEqual([{ qty: 14n, status: 'AVAILABLE' }]);
    const ret = await sql<{ status: string; customer_id: string | null; disposition: string; received_qty: bigint }>(`SELECT r.status, r.customer_id, rl.disposition, rl.received_qty FROM returns r JOIN return_lines rl ON rl.return_id = r.id WHERE r.return_number = '${ok.body.return_number}'`);
    expect(ret[0]).toMatchObject({ status: 'CLOSED', customer_id: null, disposition: 'RESTOCK', received_qty: 2n });
    // scanning the LPN itself also confirms
    const ok2 = await recv.post('/returns/quick', { sku_code: f.skus[0]!.code, qty: 1, to_lpn_code: p.code, scanned: p.code }, idem());
    expect(ok2.status, JSON.stringify(ok2.body)).toBe(201);
    // the office sees it
    const list = await sup.get('/returns?status=CLOSED');
    expect(list.body.some((r: { return_number: string }) => r.return_number === ok.body.return_number)).toBe(true);
    await expectReconciled();
  });

  it('damaged pieces go to the returns area as DAMAGED on a new pallet, with an incident', async () => {
    const r = await recv.post('/returns/quick', { sku_code: f.skus[1]!.code, qty: 1, damaged: true, note: 'llegó rota' }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.damaged).toBe(true);
    expect(r.body.incident).toMatch(/^INC-/);
    const bal = await sql<{ status: string; qty: bigint; loc: string }>(`SELECT b.status, b.qty, loc.code AS loc FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id JOIN locations loc ON loc.id = l.current_location_id WHERE l.code = '${r.body.lpn}'`);
    expect(bal[0]!.status).toBe('DAMAGED');
    expect(bal[0]!.qty).toBe(1n);
    await expectReconciled();
  });
});
