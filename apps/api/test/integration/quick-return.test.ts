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

describe('whole pallets returned, and reopening a closed return (admin)', () => {
  it('N new pallets are born at the returns area, available with put-away; a closed return can be reopened by an admin only', async () => {
    const adminC = await userWithRoles('qradm', ['ADMIN']);
    const enroll = await adminC.post('/auth/mfa/enroll');
    const { totp } = await import('../../src/lib/crypto.js');
    expect((await adminC.post('/auth/mfa/enroll/confirm', { code: totp(enroll.body.secret) })).status).toBe(200);
    const r = await recv.post('/returns/quick', { sku_code: f.skus[1]!.code, qty: 100, new_pallets: 3, note: 'regresaron 3 tarimas' }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.pallets.map((p: { qty: string }) => p.qty)).toEqual(['34', '33', '33']);
    expect(r.body.pallets.every((p: { putaway_task: string | null }) => !!p.putaway_task), JSON.stringify(r.body.pallets)).toBe(true);
    const lpns = await sql<{ status: string; lpn_type: string; loc: string; bst: string; qty: bigint }>(`SELECT l.status, l.lpn_type, loc.location_type AS loc, b.status AS bst, b.qty FROM lpns l JOIN locations loc ON loc.id = l.current_location_id JOIN inventory_balances b ON b.lpn_id = l.id AND b.qty > 0 WHERE l.code IN (${r.body.pallets.map((p: { code: string }) => `'${p.code}'`).join(',')}) ORDER BY b.qty DESC`);
    expect(lpns.length).toBe(3);
    expect(lpns.every((l) => l.status === 'STORED' && l.lpn_type === 'STORAGE' && l.loc === 'RETURNS' && l.bst === 'AVAILABLE'), JSON.stringify(lpns, (k, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(true); // the returns area of the default warehouse, like damaged quick returns
    const ret = await sql<{ id: string; status: string }>(`SELECT id, status FROM returns WHERE return_number = '${r.body.return_number}'`);
    expect(ret[0]!.status).toBe('CLOSED');
    expect((await sup.post(`/returns/${ret[0]!.id}/reopen`, { reason: 'prueba' })).status).toBe(403);
    const ro = await adminC.post(`/returns/${ret[0]!.id}/reopen`, { reason: 'faltó una tarima' });
    expect(ro.status, JSON.stringify(ro.body)).toBe(200);
    expect(ro.body.status).toBe('INSPECTING');
    // too few pieces for the pallets is refused
    const bad = await recv.post('/returns/quick', { sku_code: f.skus[1]!.code, qty: 2, new_pallets: 3 }, idem());
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe('QTY_LT_PALLETS');
    await expectReconciled();
  });
  it('a formal return line received on 2 pallets is split into 2 lines with one pallet each', async () => {
    const c = await sup.post('/returns', { customer_code: f.customer.code, lines: [{ sku_code: f.skus[0]!.code, qty: 50, uom_code: 'PIECE' }] });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const line = c.body.lines[0];
    const rc = await sup.post('/returns/receive', { return_id: c.body.id, line_id: line.id, qty: 50, uom_code: 'PIECE', returns_location_barcode: f.returns.barcode, pallets: 2 }, idem());
    expect(rc.status, JSON.stringify(rc.body)).toBe(200);
    expect(rc.body.pallets.length).toBe(2);
    const lines = await sql<{ expected_qty: bigint; received_qty: bigint; lpn_id: string | null }>(`SELECT expected_qty, received_qty, lpn_id FROM return_lines WHERE return_id = '${c.body.id}' ORDER BY received_qty DESC`);
    expect(lines.map((l) => [l.expected_qty, l.received_qty])).toEqual([[25n, 25n], [25n, 25n]]);
    expect(lines.every((l) => !!l.lpn_id)).toBe(true);
    await expectReconciled();
  });
});

describe('receiving onto an open return from the handheld', () => {
  it('lists open returns and adds a line to the chosen one instead of creating a new closed return', async () => {
    const c = await sup.post('/returns', { customer_code: f.customer.code, reason: 'reabierta', lines: [{ sku_code: f.skus[0]!.code, qty: 10, uom_code: 'PIECE' }] });
    expect(c.status).toBe(201);
    const open = await recv.get('/returns/open');
    expect(open.status).toBe(200);
    expect(open.body.some((r: { id: string }) => r.id === c.body.id)).toBe(true);
    const r = await recv.post('/returns/quick', { sku_code: f.skus[1]!.code, qty: 40, new_pallets: 2, return_id: c.body.id, note: 'dos tarimas más' }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.return_number).toBe(c.body.return_number);
    expect(r.body.return_status).toBe('INSPECTING');
    const lines = await sql<{ n: bigint }>(`SELECT count(*)::bigint AS n FROM return_lines WHERE return_id = '${c.body.id}' AND lpn_id IS NOT NULL`);
    expect(Number(lines[0]!.n)).toBe(2);
    expect((await sql<{ n: bigint }>(`SELECT count(*)::bigint AS n FROM returns WHERE return_number = '${c.body.return_number}'`))[0]!.n).toBe(1n);
    await expectReconciled();
  });
});

describe('splitting a pallet of an open return into several, each with its own put-away', () => {
  it('the pallet is split evenly, one line per pallet, every pallet gets a put-away task to choose its spot', async () => {
    const p = await storedPallet(f, 0, f.reserve[6]!.id, 90n);
    const c = await sup.post('/returns', { customer_code: f.customer.code, lines: [{ sku_code: f.skus[0]!.code, qty: 90, uom_code: 'PIECE' }] });
    expect(c.status).toBe(201);
    // bind the pallet to the return line as if the pieces had been received onto it
    await sql(`UPDATE return_lines SET lpn_id = '${p.id}', received_qty = 90, disposition = 'RESTOCK', disposition_qty = 90 WHERE return_id = '${c.body.id}'`);
    await sql(`UPDATE returns SET status = 'INSPECTING' WHERE id = '${c.body.id}'`);
    const bad = await recv.post('/returns/split-pallet', { return_id: c.body.id, lpn_code: p.code, parts: ['50', '50'] }, idem());
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe('PARTS_SUM');
    const r = await recv.post('/returns/split-pallet', { return_id: c.body.id, lpn_code: p.code, parts: ['40', '30', '20'] }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.pallets.map((x: { qty: string }) => x.qty)).toEqual(['40', '30', '20']);
    expect(r.body.pallets.every((x: { putaway_task_id: string | null }) => !!x.putaway_task_id)).toBe(true);
    const lines = await sql<{ received_qty: bigint; lpn_id: string }>(`SELECT received_qty, lpn_id FROM return_lines WHERE return_id = '${c.body.id}'`);
    expect(lines.length).toBe(3);
    expect(new Set(lines.map((l) => l.lpn_id)).size).toBe(3);
    const open = await recv.get('/returns/open');
    const mine = open.body.find((x: { id: string }) => x.id === c.body.id);
    expect(mine.lines.filter((l: { lpn: { putaway_task_id: string | null } | null }) => l.lpn?.putaway_task_id).length).toBe(3);
    // choose a spot for one of them through the put-away chooser
    const t = r.body.pallets[1].putaway_task_id;
    const opts = await recv.get(`/putaway/tasks/${t}/options`);
    expect(opts.status).toBe(200);
    const target = opts.body.options.find((o: { is_current: boolean }) => !o.is_current);
    if (target) expect((await recv.post(`/putaway/tasks/${t}/choose`, { location_code: target.code })).status).toBe(200);
    await expectReconciled();
  });
});
