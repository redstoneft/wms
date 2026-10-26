// Stock closed at the receiving dock (waiting for a rack spot) is plannable and pickable; a whole-pallet pick cancels its put-away.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, expectReconciled, idem, makeFixture, sql, storedPallet, userWithRoles, type Client, type Fixture } from '../helpers.js';
import { withTx } from '../../src/db.js';
import { createPutawayTask } from '../../src/modules/putaway/service.js';
import { lockLpn } from '../../src/inventory/ledger.js';
import { SYSTEM_ACTOR } from '../../src/lib/context.js';

let sup: Client;
let picker: Client;
let f: Fixture;
beforeAll(async () => {
  sup = await userWithRoles('dksup', ['SUPERVISOR']);
  picker = await userWithRoles('dkpick', ['PICKER']);
  f = await makeFixture({ skus: 1, reserveBays: 4 });
});
afterAll(closeApp);

describe('picking from the dock', () => {
  it('plans a pallet still at the dock, the picker takes it whole there, and its put-away task is cancelled', async () => {
    const dockPallet = await storedPallet(f, 0, f.dock.id, 120n); // received, closed, waiting for a spot
    const taskId = await withTx(async (tx) => (await createPutawayTask(tx, SYSTEM_ACTOR, await lockLpn(tx, dockPallet.id), { allowStoredLocation: true })).id);
    const o = await sup.post('/orders', { order_number: `DK-${f.tag}`, customer_code: f.customer.code, lines: [{ sku_code: f.skus[0]!.code, qty: 120, uom_code: 'PIECE' }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    await sup.post(`/orders/${o.body.id}/accept`);
    const al = await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: false, strategy: 'FINISH_PALLET' });
    expect(al.status, JSON.stringify(al.body)).toBe(200);
    expect(al.body.lines[0].lpns).toEqual([dockPallet.code]);
    const t = await sup.post('/picking/tasks', { order_id: o.body.id });
    expect(t.status).toBe(201);
    const v = await picker.post(`/picking/tasks/${t.body.task.id}/start`);
    const line = v.body.lines[0];
    expect(line.location_barcode).toBe(f.dock.barcode);
    expect((await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: line.id, step: 'LOCATION', scanned: f.dock.barcode }, idem())).status).toBe(200);
    expect((await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: line.id, step: 'LPN', scanned: dockPallet.code }, idem())).status).toBe(200);
    const q = await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: line.id, step: 'QTY', qty: '120', uom_code: 'PIECE' }, idem());
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    const lpn = (await sql<{ status: string; lpn_type: string }>(`SELECT status, lpn_type FROM lpns WHERE id = $1`, [dockPallet.id]))[0]!;
    expect(lpn).toMatchObject({ status: 'PICKING', lpn_type: 'OUTBOUND' });
    expect((await sql<{ status: string }>(`SELECT status FROM putaway_tasks WHERE id = $1`, [taskId]))[0]!.status).toBe('CANCELLED');
    await expectReconciled();
  });
});
