// Unir tarimas: a small storage pallet onto another one of the same model; refused with picks planned or other models.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, expectReconciled, idem, makeFixture, skuTotal, sql, storedPallet, userWithRoles, type Client, type Fixture } from '../helpers.js';

let sup: Client;
let picker: Client;
let f: Fixture;

beforeAll(async () => {
  sup = await userWithRoles('mgsup', ['SUPERVISOR']);
  picker = await userWithRoles('mgpick', ['PICKER']);
  f = await makeFixture({ skus: 2, reserveBays: 6 });
});
afterAll(closeApp);

describe('merge pallets', () => {
  it('moves everything onto the destination, consumes the source and frees its spot', async () => {
    const small = await storedPallet(f, 0, f.reserve[0]!.id, 12n);
    const big = await storedPallet(f, 0, f.reserve[1]!.id, 200n);
    const before = await skuTotal(f.skus[0]!.id);
    const r = await picker.post('/picking/merge-pallet', { from_lpn_code: small.code, to_lpn_code: big.code }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ from_lpn: small.code, to_lpn: big.code, to_qty: '212', from_location: f.reserve[0]!.code, to_location: f.reserve[1]!.code });
    expect(r.body.moved).toEqual([{ sku: f.skus[0]!.code, qty: '12' }]);
    const src = (await sql<{ status: string; n: bigint }>(`SELECT l.status, (SELECT count(*) FROM inventory_balances b WHERE b.lpn_id = l.id AND b.qty > 0) AS n FROM lpns l WHERE l.id = $1`, [small.id]))[0]!;
    expect(src.status).toBe('CONSUMED');
    expect(src.n).toBe(0n);
    expect(await skuTotal(f.skus[0]!.id)).toBe(before);
    const mv = await sql<{ movement_type: string; to_location_id: string }>(`SELECT movement_type, to_location_id FROM inventory_movements WHERE from_lpn_id = $1 AND to_lpn_id = $2`, [small.id, big.id]);
    expect(mv).toHaveLength(1);
    expect(mv[0]).toMatchObject({ movement_type: 'LPN_CONSOLIDATE', to_location_id: f.reserve[1]!.id });
    // the spot of the small pallet holds nothing any more
    expect((await sql<{ n: bigint }>(`SELECT count(*) AS n FROM lpns WHERE current_location_id = $1 AND status NOT IN ('CONSUMED','SHIPPED','CANCELLED')`, [f.reserve[0]!.id]))[0]!.n).toBe(0n);
    // replay is idempotent
    await expectReconciled();
  });

  it('mixes models when asked, and refuses same-pallet or pallets with picks planned', async () => {
    const a = await storedPallet(f, 0, f.reserve[2]!.id, 5n);
    const other = await storedPallet(f, 1, f.reserve[3]!.id, 50n);
    const same = await picker.post('/picking/merge-pallet', { from_lpn_code: a.code, to_lpn_code: a.code }, idem());
    expect(same.status).toBe(422);
    // picks planned on the source: refused
    const big = await storedPallet(f, 0, f.reserve[4]!.id, 100n);
    const o = await sup.post('/orders', { order_number: `MG-${f.tag}-${Math.random().toString(36).slice(2, 7)}`, customer_code: f.customer.code, lines: [{ sku_code: f.skus[0]!.code, qty: 5, uom_code: 'PIECE' }] });
    expect(o.status).toBe(201);
    await sup.post(`/orders/${o.body.id}/accept`);
    expect((await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: false, strategy: 'LPN' })).status).toBe(200);
    const planned = (await sql<{ code: string }>(`SELECT l.code FROM allocations al JOIN lpns l ON l.id = al.lpn_id JOIN order_lines ol ON ol.id = al.order_line_id WHERE ol.order_id = $1 AND al.status = 'ACTIVE'`, [o.body.id])).map((x) => x.code);
    expect(planned.length).toBeGreaterThan(0);
    const srcCode = planned[0]!; // whichever pallet the planner chose: it now has picks planned
    const dstCode = srcCode === big.code ? a.code : big.code;
    const busy = await picker.post('/picking/merge-pallet', { from_lpn_code: srcCode, to_lpn_code: dstCode }, idem());
    expect(busy.status).toBe(422);
    expect(JSON.stringify(busy.body)).toMatch(/LPN_ALLOCATED/);
    // a different model goes onto the destination: the pallet becomes mixed
    const small2 = await storedPallet(f, 0, f.reserve[5]!.id, 7n);
    const mixed = await picker.post('/picking/merge-pallet', { from_lpn_code: small2.code, to_lpn_code: other.code }, idem());
    expect(mixed.status, JSON.stringify(mixed.body)).toBe(200);
    expect(mixed.body.mixed_in).toEqual([f.skus[0]!.code]);
    expect(mixed.body.to_qty).toBe('57');
    const skus = await sql<{ n: bigint }>(`SELECT count(DISTINCT sku_id) AS n FROM inventory_balances WHERE lpn_id = $1 AND qty > 0`, [other.id]);
    expect(skus[0]!.n).toBe(2n);
    await expectReconciled();
  });
});
