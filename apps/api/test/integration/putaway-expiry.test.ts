// An abandoned put-away (started, never confirmed) stops reserving its slot after 4 hours: back to PENDING, slot FREE again.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, idem, makeFixture, sql, userWithRoles, type Client, type Fixture } from '../helpers.js';
import { expireStalePutaways } from '../../src/modules/putaway/service.js';
import { SYSTEM_ACTOR } from '../../src/lib/context.js';

let recv: Client;
let fork: Client;
let f: Fixture;
beforeAll(async () => {
  recv = await userWithRoles('pexsup', ['SUPERVISOR']);
  fork = await userWithRoles('pexfork', ['FORKLIFT']);
  f = await makeFixture({ skus: 1, reserveBays: 3 });
});
afterAll(closeApp);

describe('stale put-away expiry', () => {
  it('releases the reserved slot after 4 h and lets the pallet be started again', async () => {
    const c = await recv.post('/containers', { container_number: `CONT-${f.tag}`, supplier_id: f.supplier.id, carrier_id: f.carrier.id, seal_number: 'S1', plates: 'EXP-1' });
    let v = 1;
    for (const st of ['ARRIVED', 'UNLOADING']) expect((await recv.post(`/containers/${c.body.id}/transition`, { status: st, version: v++ })).status).toBe(200);
    const r = await recv.post('/receipts', { container_id: c.body.id, receiving_location_id: f.dock.id, expected: [{ sku_code: f.skus[0]!.code, qty: 10, uom_code: 'CASE' }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await recv.post('/receipts/scan', { receipt_id: r.body.id, barcode: f.skus[0]!.case_barcode, qty: 10, cases_count: 10 }, idem())).status).toBe(201);
    const done = await recv.post('/receipts/complete', { receipt_id: r.body.id, accept_differences: true });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const taskId = done.body.putaway_tasks[0] as string;
    const task = { id: taskId };
    const lpn = await sql<{ code: string }>(`SELECT l.code FROM lpns l JOIN putaway_tasks t ON t.lpn_id = l.id WHERE t.id = $1::uuid`, [taskId]);
    const started = await fork.post('/putaway/start', { lpn_code: lpn[0]!.code });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const target = started.body.target.code as string;
    const occ = () => sql<{ status: string }>(`SELECT status FROM v_location_occupancy WHERE code = $1`, [target]);
    expect((await occ())[0]!.status).toBe('RESERVED');

    // fresh: nothing expires
    expect((await expireStalePutaways(SYSTEM_ACTOR)).expired).not.toContain(lpn[0]!.code);
    expect((await occ())[0]!.status).toBe('RESERVED');

    // 5 hours later without confirmation: the task goes back to PENDING and the slot is free
    await sql(`UPDATE putaway_tasks SET started_at = now() - interval '5 hours' WHERE id = $1::uuid`, [task.id]);
    const res = await expireStalePutaways(SYSTEM_ACTOR);
    expect(res.expired).toContain(lpn[0]!.code);
    const t = await sql<{ status: string; assigned_to: string | null; planned: boolean }>(`SELECT status, assigned_to, planned FROM putaway_tasks WHERE id = $1::uuid`, [task.id]);
    expect(t[0]).toMatchObject({ status: 'PENDING', assigned_to: null, planned: false });
    expect((await occ())[0]!.status).toBe('FREE');
    const aud = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM audit_logs WHERE action = 'putaway.expired' AND entity_id = $1`, [task.id]);
    expect(Number(aud[0]!.n)).toBe(1);

    // the operator scans it again: same task resumes, the clock restarts, the slot is reserved anew
    const again = await fork.post('/putaway/start', { lpn_code: lpn[0]!.code });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.task.id).toBe(task.id);
    expect(again.body.task.status).toBe('IN_PROGRESS');
    expect((await occ())[0]!.status).toBe('RESERVED');
    const ok = await fork.post('/putaway/confirm', { task_id: task.id, lpn_code: lpn[0]!.code, location_barcode: again.body.target.barcode }, idem());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });
});
