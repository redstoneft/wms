// Picking finished: outbound pallets leave their rack positions (to the staging lane, or the outbound dock when no lane is free).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, closeApp, expectReconciled, idem, makeFixture, sql, storedPallet, userWithRoles, type Client, type Fixture } from '../helpers.js';

let sup: Client;
let picker: Client;
let adm: Client;
let f: Fixture;
beforeAll(async () => {
  sup = await userWithRoles('prlsup', ['SUPERVISOR']);
  picker = await userWithRoles('prlpick', ['PICKER']);
  adm = await admin();
  f = await makeFixture({ skus: 1, reserveBays: 4, levels: 1 });
});
afterAll(closeApp);

async function pickWhole(locationIdx: number, qty: bigint, tag: string) {
  const src = f.reserve[locationIdx]!;
  const pallet = await storedPallet(f, 0, src.id, qty);
  const o = await sup.post('/orders', { order_number: `PRL-${f.tag}-${tag}`, customer_code: f.customer.code, lines: [{ sku_code: f.skus[0]!.code, qty: Number(qty), uom_code: 'PIECE' }] });
  expect(o.status, JSON.stringify(o.body)).toBe(201);
  await sup.post(`/orders/${o.body.id}/accept`);
  const al = await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: false, strategy: 'FINISH_PALLET' });
  expect(al.status, JSON.stringify(al.body)).toBe(200);
  const t = await sup.post('/picking/tasks', { order_id: o.body.id });
  const v = await picker.post(`/picking/tasks/${t.body.task.id}/start`);
  const line = v.body.lines[0];
  expect((await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: line.id, step: 'LOCATION', scanned: src.barcode }, idem())).status).toBe(200);
  expect((await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: line.id, step: 'LPN', scanned: pallet.code }, idem())).status).toBe(200);
  const q = await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: line.id, step: 'QTY', qty: qty.toString(), uom_code: 'PIECE' }, idem());
  expect(q.status, JSON.stringify(q.body)).toBe(200);
  return { orderId: o.body.id as string, pallet, src };
}
const occ = async (code: string) => (await sql<{ status: string }>(`SELECT status FROM v_location_occupancy WHERE code = $1`, [code]))[0]!.status;
const where = async (lpnId: string) => (await sql<{ status: string; loc: string; type: string }>(`SELECT l.status, loc.code AS loc, loc.location_type AS type FROM lpns l JOIN locations loc ON loc.id = l.current_location_id WHERE l.id = $1`, [lpnId]))[0]!;

describe('picked pallets free their rack positions', () => {
  it('on PICKED the outbound pallet moves to the order lane, the position is FREE, and the staging scan still works', async () => {
    const { orderId, pallet, src } = await pickWhole(0, 120n, 'A');
    expect((await sup.get(`/orders/${orderId}`)).body.status).toBe('PICKED');
    const w = await where(pallet.id);
    expect(w.status).toBe('PICKING');
    expect(w.type).toBe('STAGING');
    expect(await occ(src.code)).toBe('FREE');
    const lane = await sql<{ code: string; barcode: string }>(`SELECT loc.code, loc.barcode FROM staging_assignments sa JOIN locations loc ON loc.id = sa.location_id WHERE sa.order_id = $1::uuid AND sa.released_at IS NULL`, [orderId]);
    expect(lane[0]!.code).toBe(w.loc);
    const mv = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM inventory_movements WHERE movement_type = 'PICK_RELEASE' AND order_id = $1::uuid`, [orderId]);
    expect(Number(mv[0]!.n)).toBe(1);
    // the operator's staging scan confirms the lane: STAGED, order STAGED
    const st = await picker.post('/staging/scan', { lpn_code: pallet.code, staging_location_barcode: lane[0]!.barcode }, idem());
    expect(st.status, JSON.stringify(st.body)).toBe(200);
    expect((await where(pallet.id)).status).toBe('STAGED');
    expect((await sup.get(`/orders/${orderId}`)).body.status).toBe('STAGED');
    await expectReconciled();
  });

  it('with every lane busy the pallet goes to the outbound dock instead, and the position is still FREE', async () => {
    for (const lane of f.staging) expect((await adm.patch(`/locations/${lane.id}`, { admin_status: 'BLOCKED', reason: 'test: carriles llenos' })).status).toBe(200);
    try {
      const { pallet, src } = await pickWhole(1, 60n, 'B');
      const w = await where(pallet.id);
      expect(w).toMatchObject({ status: 'PICKING', loc: f.ship_dock.code, type: 'SHIPPING' });
      expect(await occ(src.code)).toBe('FREE');
    } finally {
      for (const lane of f.staging) await adm.patch(`/locations/${lane.id}`, { admin_status: 'ACTIVE' });
    }
    await expectReconciled();
  });
});
