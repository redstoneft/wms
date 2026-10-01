// Put-away planned per receipt: every pallet of the receipt with its destination, chosen from the office or the handheld.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, idem, makeFixture, sql, userWithRoles, type Client, type Fixture } from '../helpers.js';

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
    const batches = await fork.get('/putaway/batches');
    expect(batches.body.find((x: { kind: string; id: string }) => x.kind === 'RECEIPT' && x.id === r.body.id)).toMatchObject({ pending: '2', total: '2' });
    const generic = await fork.get(`/putaway/batches/receipt/${r.body.id}`);
    expect(generic.status).toBe(200);
    expect(generic.body.batch).toMatchObject({ kind: 'RECEIPT', id: r.body.id });
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

describe('engine suggestions do not block slots while the receipt is being planned', () => {
  it('a slot suggested for pallet A can be chosen for pallet B; A is re-suggested elsewhere; a chosen slot is reserved', async () => {
    const c = await recv.post('/containers', { container_number: `CONT2-${f.tag}`, supplier_id: f.supplier.id, carrier_id: f.carrier.id, seal_number: 'S2', plates: 'ABC-2' });
    let v = 1;
    for (const st of ['ARRIVED', 'UNLOADING']) expect((await recv.post(`/containers/${c.body.id}/transition`, { status: st, version: v++ })).status).toBe(200);
    const r = await recv.post('/receipts', { container_id: c.body.id, receiving_location_id: f.dock.id, expected: [{ sku_code: f.skus[0]!.code, qty: 20, uom_code: 'CASE' }, { sku_code: f.skus[1]!.code, qty: 20, uom_code: 'CASE' }] });
    expect((await recv.post('/receipts/scan', { receipt_id: r.body.id, barcode: f.skus[0]!.case_barcode, qty: 20, cases_count: 20 }, idem())).status).toBe(201);
    expect((await recv.post('/receipts/scan', { receipt_id: r.body.id, barcode: f.skus[1]!.case_barcode, qty: 20, cases_count: 20 }, idem())).status).toBe(201);
    expect((await recv.post('/receipts/complete', { receipt_id: r.body.id, accept_differences: true })).status).toBe(200);
    const plan = await fork.get(`/receipts/${r.body.id}/putaway`);
    const [a, b] = plan.body.pallets as { lpn_code: string; task_id: string; target: string; planned: boolean }[];
    expect(a!.target).toBeTruthy();
    expect(b!.target).toBeTruthy();
    expect(a!.target).not.toBe(b!.target); // automatic suggestions still spread out
    expect(a!.planned).toBe(false);
    // planning B: A's suggested slot is offered (capacity 1, only softly reserved)
    const opts = await fork.get(`/putaway/tasks/${b!.task_id}/options`);
    expect(opts.body.options.map((o: { code: string }) => o.code)).toContain(a!.target);
    expect((await fork.post(`/putaway/tasks/${b!.task_id}/choose`, { location_code: a!.target })).status).toBe(200);
    const plan2 = await fork.get(`/receipts/${r.body.id}/putaway`);
    const a2 = plan2.body.pallets.find((p: { lpn_code: string }) => p.lpn_code === a!.lpn_code);
    const b2 = plan2.body.pallets.find((p: { lpn_code: string }) => p.lpn_code === b!.lpn_code);
    expect(b2.target).toBe(a!.target);
    expect(b2.planned).toBe(true);
    expect(a2.target).toBeTruthy();
    expect(a2.target).not.toBe(a!.target); // bumped to another slot
    // a chosen slot IS reserved: it is no longer offered to A, and choosing it for A is refused
    const optsA = await fork.get(`/putaway/tasks/${a!.task_id}/options`);
    expect(optsA.body.options.map((o: { code: string }) => o.code)).not.toContain(a!.target);
    const refused = await fork.post(`/putaway/tasks/${a!.task_id}/choose`, { location_code: a!.target });
    expect(refused.status).toBe(422);
    // the forklift starts A: its (re-suggested) target still holds
    const start = await fork.post('/putaway/start', { lpn_code: a!.lpn_code });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    expect(start.body.target.code).toBe(a2.target);
  });
});

describe('closing the plan', () => {
  it('refuses while a pallet has no destination, then fixes every destination (planned) and reports the labels', async () => {
    const c = await recv.post('/containers', { container_number: `CONT3-${f.tag}`, supplier_id: f.supplier.id, carrier_id: f.carrier.id, seal_number: 'S3', plates: 'ABC-3' });
    let v = 1;
    for (const st of ['ARRIVED', 'UNLOADING']) expect((await recv.post(`/containers/${c.body.id}/transition`, { status: st, version: v++ })).status).toBe(200);
    const r = await recv.post('/receipts', { container_id: c.body.id, receiving_location_id: f.dock.id, expected: [{ sku_code: f.skus[0]!.code, qty: 10, uom_code: 'CASE' }] });
    expect((await recv.post('/receipts/scan', { receipt_id: r.body.id, barcode: f.skus[0]!.case_barcode, qty: 10, cases_count: 10 }, idem())).status).toBe(201);
    expect((await recv.post('/receipts/complete', { receipt_id: r.body.id, accept_differences: true })).status).toBe(200);
    const plan = await fork.get(`/receipts/${r.body.id}/putaway`);
    const p = plan.body.pallets[0] as { lpn_code: string; task_id: string; target: string | null };
    // simulate a pallet without destination
    await sql(`UPDATE putaway_tasks SET suggested_location_id = NULL WHERE id = '${p.task_id}'`);
    const incomplete = await fork.post(`/receipts/${r.body.id}/putaway/close`, {});
    expect(incomplete.status).toBe(422);
    expect(incomplete.body.error).toBe('PLAN_INCOMPLETE');
    expect(incomplete.body.details.missing).toEqual([p.lpn_code]);
    // give it one and close
    const opts = await fork.get(`/putaway/tasks/${p.task_id}/options`);
    expect((await fork.post(`/putaway/tasks/${p.task_id}/choose`, { location_code: opts.body.options[0].code })).status).toBe(200);
    // labels only when asked (never automatically); no printer in the test database → reported as not printed
    const pr = await fork.post(`/receipts/${r.body.id}/putaway/print`, {});
    expect(pr.status, JSON.stringify(pr.body)).toBe(200);
    expect(pr.body.printed.length + pr.body.failed.length).toBe(1);
    // closing puts the pallet away at its destination without scanning
    const closed = await fork.post(`/receipts/${r.body.id}/putaway/close`, {});
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body).toEqual({ placed: [{ lpn: p.lpn_code, location: opts.body.options[0].code }], failed: [] });
    const task = await sql<{ status: string; planned: boolean }>(`SELECT status, planned FROM putaway_tasks WHERE id = '${p.task_id}'`);
    expect(task[0]).toMatchObject({ status: 'COMPLETED', planned: true });
    const after = await fork.get(`/receipts/${r.body.id}/putaway`);
    expect(after.body.pallets[0]).toMatchObject({ pending: false, current_location: opts.body.options[0].code });
    const pendingList = await fork.get('/receipts/pending-putaway');
    expect(pendingList.body.find((x: { id: string }) => x.id === r.body.id)).toBeUndefined();
    expect((await fork.post(`/receipts/${r.body.id}/putaway/close`, {})).status).toBe(422); // nothing pending any more
  });
});
