// FINISH_PALLET: finish small pallets first, break only one pallet, prefer leaving whole cases on it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeFixture, sql, storedPallet, userWithRoles, type Client, type Fixture } from '../helpers.js';
import { finishPalletsFirst } from '../../src/modules/orders/service.js';

let sup: Client;
let f: Fixture;

beforeAll(async () => {
  sup = await userWithRoles('fpsup', ['SUPERVISOR']);
  f = await makeFixture({ skus: 1, reserveBays: 8 });
});
afterAll(closeApp);

const c = (code: string, qty: number, planned = 0) => ({ code, qty: BigInt(qty), planned_others: BigInt(planned) });

describe('FINISH_PALLET ordering', () => {
  it('empties the small pallets first and breaks only the smallest pallet that covers the rest', () => {
    const order = finishPalletsFirst([c('A', 840), c('B', 300), c('C', 50), c('D', 100)], 300n, 12n).map((x) => x.code);
    expect(order.slice(0, 3)).toEqual(['C', 'D', 'B']); // 50 + 100 emptied, then 150 taken from the 300
  });
  it('among pallets that cover the rest, prefers the one whose leftover is whole cases', () => {
    // need 100 with cases of 12: 340 leaves 240 (20 cases), 200 leaves 100 (not whole) → 340 even though 200 is smaller
    expect(finishPalletsFirst([c('P200', 200), c('P340', 340)], 100n, 12n)[0]!.code).toBe('P340');
    // without a case unit the smallest covering pallet wins
    expect(finishPalletsFirst([c('P200', 200), c('P340', 340)], 100n, 1n)[0]!.code).toBe('P200');
  });
  it('ignores what other orders already plan and skips pallets with nothing free', () => {
    const order = finishPalletsFirst([c('A', 100, 100), c('B', 60, 10), c('C', 500)], 60n, 6n).map((x) => x.code);
    expect(order[0]).toBe('B'); // 50 free, emptied first
    expect(order[1]).toBe('C'); // 10 more from the big one
    expect(order).not.toContain('A');
  });
});

describe('FINISH_PALLET end to end', () => {
  it('allocates whole small pallets and breaks one', async () => {
    const big = await storedPallet(f, 0, f.reserve[0]!.id, 840n);
    const mid = await storedPallet(f, 0, f.reserve[1]!.id, 300n);
    const small = await storedPallet(f, 0, f.reserve[2]!.id, 50n);
    const small2 = await storedPallet(f, 0, f.reserve[3]!.id, 100n);
    const o = await sup.post('/orders', { order_number: `FP-${f.tag}`, customer_code: f.customer.code, lines: [{ sku_code: f.skus[0]!.code, qty: 300, uom_code: 'PIECE' }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    await sup.post(`/orders/${o.body.id}/accept`);
    const r = await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: false, strategy: 'FINISH_PALLET' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const allocs = await sql<{ code: string; qty: bigint }>(`SELECT l.code, a.qty FROM allocations a JOIN lpns l ON l.id = a.lpn_id JOIN order_lines ol ON ol.id = a.order_line_id WHERE ol.order_id = $1 AND a.status = 'ACTIVE' ORDER BY a.qty`, [o.body.id]);
    expect(allocs.map((a) => [a.code, Number(a.qty)])).toEqual([[small.code, 50], [small2.code, 100], [mid.code, 150]]);
    expect(allocs.some((a) => a.code === big.code)).toBe(false);
  });
});
