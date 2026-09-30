// Put-away planned per receipt: every pallet of the receipt with its destination, chosen from the office or the handheld.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, idem, makeFixture, userWithRoles, type Client, type Fixture } from '../helpers.js';

let recv: Client;
let fork: Client;
let f: Fixture;
beforeAll(async () => {
  recv = await userWithRoles('rppsup', ['SUPERVISOR']);
  fork = await userWithRoles('rppfork', ['FORKLIFT']);
  f = await makeFixture({ skus: 2, reserveBays: 4 });
});
afterAll(closeApp);

describe('put-away plan per receipt', () => {
  it('lists the receipt pallets with their destinations, lets one be changed, and drops it once put away', async () => {
    const c = await recv.post('/containers', { container_number: `CONT-${f.tag}`, supplier_id: f.supplier.id, carrier_id: f.carrier.id, seal_number: 'S1', plates: 'ABC-1' });
    expect(c.status).toBe(201);
    let v = 1;
    for (const st of ['ARRIVED', 'UNLOADING']) expect((await recv.post(`/containers/${c.body.id}/transition`, { status: st, version: v++ })).status).toBe(200);
    const r = await recv.post('/receipts', { container_id: c.body.id, receiving_location_id: f.dock.id, expected: [{ sku_code: f.skus[0]!.code, qty: 40, uom_code: 'CASE' }, { sku_code: f.skus[1]!.code, qty: 20, uom_code: 'CASE' }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await recv.post('/receipts/scan', { receipt_id: r.body.id, barcode: f.skus[0]!.case_barcode, qty: 40, cases_count: 40 }, idem())).status).toBe(201);
    expect((await recv.post('/receipts/scan', { receipt_id: r.body.id, barcode: f.skus[1]!.case_barcode, qty: 20, cases_count: 20 }, idem())).status).toBe(201);
    const done = await recv.post('/receipts/complete', { receipt_id: r.body.id, accept_differences: true });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.putaway_tasks.length).toBe(2);
    // the receipt shows up for the handheld, with both pallets pending
    const list = await fork.get('/receipts/pending-putaway');
    expect(list.status).toBe(200);
    expect(list.body.find((x: { id: string }) => x.id === r.body.id)).toMatchObject({ pending: '2', total: '2' });
    const plan = await fork.get(`/receipts/${r.body.id}/putaway`);
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    expect(plan.body.pallets).toHaveLength(2);
    const p0 = plan.body.pallets[0];
    expect(p0.pending).toBe(true);
    expect(p0.target).toBeTruthy();
    expect(p0.contents[0]).toMatchObject({ sku: expect.any(String) });
    // change its destination to another valid option
    const opts = await fork.get(`/putaway/tasks/${p0.task_id}/options`);
    const other = opts.body.options.find((o: { is_current: boolean }) => !o.is_current);
    expect(other).toBeTruthy();
    expect((await fork.post(`/putaway/tasks/${p0.task_id}/choose`, { location_code: other.code })).status).toBe(200);
    const plan2 = await fork.get(`/receipts/${r.body.id}/putaway`);
    expect(plan2.body.pallets.find((p: { lpn_id: string }) => p.lpn_id === p0.lpn_id).target).toBe(other.code);
    // put it away: the plan marks it placed and the receipt's pending count drops
    expect((await fork.post('/putaway/start', { lpn_code: p0.lpn_code })).status).toBe(200);
    const target = await fork.get(`/putaway/tasks/${p0.task_id}`);
    const ok = await fork.post('/putaway/confirm', { task_id: p0.task_id, lpn_code: p0.lpn_code, location_barcode: target.body.suggested_location.barcode }, idem());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const plan3 = await fork.get(`/receipts/${r.body.id}/putaway`);
    expect(plan3.body.pallets.find((p: { lpn_id: string }) => p.lpn_id === p0.lpn_id)).toMatchObject({ pending: false, current_location: other.code });
    const list2 = await fork.get('/receipts/pending-putaway');
    expect(list2.body.find((x: { id: string }) => x.id === r.body.id)).toMatchObject({ pending: '1', total: '2' });
  });
});
