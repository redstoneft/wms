// Reabrir surtido: a closed pick with pending quantities goes back to the pickers without touching the order.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, expectReconciled, idem, makeFixture, sql, storedPallet, userWithRoles, type Client, type Fixture } from '../helpers.js';

let sup: Client;
let picker: Client;
let f: Fixture;

beforeAll(async () => {
  sup = await userWithRoles('rpsup', ['SUPERVISOR']);
  picker = await userWithRoles('rppick', ['PICKER']);
  f = await makeFixture({ skus: 2, reserveBays: 6 });
});
afterAll(closeApp);

async function pickAll(taskId: string) {
  const v = await picker.post(`/picking/tasks/${taskId}/start`);
  for (const line of v.body.lines as { id: string; location_barcode: string; lpn_code: string; qty: string }[]) {
    expect((await picker.post('/picking/scan', { pick_task_id: taskId, line_id: line.id, step: 'LOCATION', scanned: line.location_barcode }, idem())).status).toBe(200);
    expect((await picker.post('/picking/scan', { pick_task_id: taskId, line_id: line.id, step: 'LPN', scanned: line.lpn_code }, idem())).status).toBe(200);
    expect((await picker.post('/picking/scan', { pick_task_id: taskId, line_id: line.id, step: 'QTY', qty: line.qty, uom_code: 'PIECE' }, idem())).status).toBe(200);
  }
}

describe('reopen picking', () => {
  it('plans what arrived after the pick closed short and hands it to the pickers; reports what is still missing', async () => {
    await storedPallet(f, 0, f.reserve[0]!.id, 10n); // only 10 of the 30 required exist today
    const o = await sup.post('/orders', { order_number: `RP-${f.tag}`, customer_code: f.customer.code, lines: [{ sku_code: f.skus[0]!.code, qty: 30, uom_code: 'PIECE' }, { sku_code: f.skus[1]!.code, qty: 5, uom_code: 'PIECE' }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    await sup.post(`/orders/${o.body.id}/accept`);
    expect((await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: true, strategy: 'LPN' })).status).toBe(200);
    const t = await sup.post('/picking/tasks', { order_id: o.body.id });
    expect(t.status).toBe(201);
    await pickAll(t.body.task.id);
    const after = await sup.get(`/orders/${o.body.id}`);
    expect(after.body.pick_tasks.every((x: any) => x.status === 'COMPLETED')).toBe(true);
    // nothing new in stock yet: nothing can be planned, and the answer says what is missing
    const dry = await sup.post(`/orders/${o.body.id}/reopen-picking`);
    expect(dry.status, JSON.stringify(dry.body)).toBe(200);
    expect(dry.body.task_id).toBeNull();
    expect(dry.body.short.join(' ')).toMatch(new RegExp(`${f.skus[0]!.code}: faltan 20`));
    expect(dry.body.pending).toEqual(expect.arrayContaining([{ sku: f.skus[0]!.code, qty: '20' }, { sku: f.skus[1]!.code, qty: '5' }]));
    // stock arrives for both: reopen puts a fresh task in front of the pickers, quantities untouched
    await storedPallet(f, 0, f.reserve[1]!.id, 50n);
    await storedPallet(f, 1, f.reserve[2]!.id, 50n);
    const r = await sup.post(`/orders/${o.body.id}/reopen-picking`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.task_id).toBeTruthy();
    expect(r.body.short).toEqual([]);
    expect(['ALLOCATED', 'PARTIALLY_ALLOCATED', 'PICKING']).toContain(r.body.status); // the task waits for a picker to start it
    const lines = await sql<{ qty: bigint; status: string }>(`SELECT qty, status FROM pick_task_lines WHERE pick_task_id = $1 ORDER BY qty`, [r.body.task_id]);
    expect(lines.map((l) => [Number(l.qty), l.status])).toEqual([[5, 'PENDING'], [20, 'PENDING']]);
    const req = await sql<{ required_qty: bigint }>(`SELECT required_qty FROM order_lines WHERE order_id = $1 ORDER BY line_no`, [o.body.id]);
    expect(req.map((x) => Number(x.required_qty))).toEqual([30, 5]);
    // an active task blocks a second reopen; a fully picked order has nothing to reopen
    expect((await sup.post(`/orders/${o.body.id}/reopen-picking`)).status).toBe(422);
    await pickAll(r.body.task_id);
    const done = await sup.post(`/orders/${o.body.id}/reopen-picking`);
    expect(done.status).toBe(422);
    expect(JSON.stringify(done.body)).toMatch(/NOTHING_PENDING/);
    expect((await picker.post(`/orders/${o.body.id}/reopen-picking`)).status).toBe(403);
    await expectReconciled();
  });
});
