// Guided training: the server prepares every exercise in the school warehouse and verifies the trainee did it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, closeApp, expectReconciled, idem, sql, userWithRoles, type Client } from '../helpers.js';

let t: Client; // trainee with every floor operation
let adm: Client;
type Codes = { label: string; value: string }[];
const code = (codes: Codes, label: string) => codes.find((c) => c.label.startsWith(label))!.value;

beforeAll(async () => {
  adm = await admin(); // SUPERVISOR: manages training; gated itself
  const reset = await adm.post('/training/school/reset', { reason: 'inicio de prueba' });
  expect(reset.status, JSON.stringify(reset.body)).toBe(200);
  t = await userWithRoles('trainee', ['RECEIVING', 'FORKLIFT', 'PICKER', 'VERIFIER', 'LOADER', 'INVENTORY_CONTROL']);
});
afterAll(closeApp);

async function prep(step: string) {
  const r = await t.post(`/training/steps/${step}/prepare`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.codes as Codes;
}
async function pass(step: string) {
  const r = await t.post(`/training/steps/${step}/check`);
  expect(r.status).toBe(200);
  expect(r.body.ok, r.body.hint).toBe(true);
  return r.body;
}
async function notYet(step: string) {
  const r = await t.post(`/training/steps/${step}/check`);
  expect(r.status).toBe(200);
  expect(r.body.ok).toBe(false);
  expect(r.body.hint.length).toBeGreaterThan(10);
}

describe('guided warehouse-mode training', () => {
  it('a new operator is gated: training required, first step current, admin is exempt', async () => {
    const me = await t.get('/auth/me');
    expect(me.body.training).toMatchObject({ required: true, completed: false, current_page: '/wm/receive' });
    const sup = await adm.get('/auth/me');
    expect(sup.body.training.required).toBe(true); // supervisors train too; only ADMIN is exempt
    const realAdmin = await userWithRoles('tradm', ['ADMIN']);
    const a = await realAdmin.get('/auth/me');
    expect(a.body.training.required).toBe(false);
    const tr = await t.get('/training');
    expect(tr.body.steps.map((s: { key: string }) => s.key)).toEqual(['RECEIVE', 'PUTAWAY', 'TRANSFER', 'REPLENISH', 'COUNT', 'ASSEMBLY', 'PICK', 'STAGE', 'VERIFY', 'LOAD']);
    expect(tr.body.steps[0].status).toBe('CURRENT');
    expect(tr.body.steps[1].status).toBe('LOCKED');
    expect(tr.body.school.warehouse).toBe('ESCUELA');
    const labels = await t.raw('GET', '/training/labels.html');
    expect(labels.status).toBe(200);
    expect(labels.text).toContain('LOC-ESC-DOCK-01');
    expect((labels.text.match(/data:image\/png/g) ?? []).length).toBeGreaterThan(10);
  });

  it('RECEIVE: receipt prepared for the trainee; verified only after the trainee received and completed it', async () => {
    const codes = await prep('receive');
    const receiptNumber = code(codes, 'Recepción');
    await notYet('receive');
    const rec = await sql<{ id: string }>(`SELECT id FROM receipts WHERE receipt_number = '${receiptNumber}'`);
    const s1 = await t.post('/receipts/scan', { receipt_id: rec[0]!.id, barcode: 'CAP001C', qty: 4, cases_count: 4 }, idem());
    expect(s1.status).toBe(201);
    await t.post('/receipts/lpn/close', { lpn_code: s1.body.lpn.code }, idem());
    await notYet('receive'); // second product missing
    const s2 = await t.post('/receipts/scan', { receipt_id: rec[0]!.id, barcode: 'CAP002C', qty: 2, cases_count: 2 }, idem());
    expect(s2.status).toBe(201);
    await t.post('/receipts/lpn/close', { lpn_code: s2.body.lpn.code }, idem());
    await notYet('receive'); // not completed yet
    expect((await t.post('/receipts/complete', { receipt_id: rec[0]!.id, accept_differences: true })).status).toBe(200);
    const r = await pass('receive');
    expect(r.evidence.lpns).toHaveLength(2);
  });

  it('PUTAWAY: reuses the pallets the trainee received; verified when the trainee put one away', async () => {
    const codes = await prep('putaway');
    const lpn = code(codes, 'Pallet 1');
    await notYet('putaway');
    const start = await t.post('/putaway/start', { lpn_code: lpn });
    expect(start.status).toBe(200);
    const ok = await t.post('/putaway/confirm', { task_id: start.body.task.id, lpn_code: lpn, location_barcode: start.body.target.barcode }, idem());
    expect(ok.status).toBe(200);
    await pass('putaway');
  });

  it('TRANSFER: start + complete by the trainee', async () => {
    const codes = await prep('transfer');
    const lpn = code(codes, 'Pallet');
    const dest = code(codes, 'Destino sugerido');
    const st = await t.post('/transfers/start', { lpn_code: lpn, to_location_barcode: dest }, idem());
    expect(st.status, JSON.stringify(st.body)).toBe(201);
    await notYet('transfer'); // in transit
    const done = await t.post('/transfers/complete', { transfer_id: st.body.id ?? st.body.transfer_id ?? st.body.transfer?.id, lpn_code: lpn, location_barcode: dest }, idem());
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    await pass('transfer');
  });

  it('REPLENISH: task prepared; trainee starts and completes the replenishment transfer', async () => {
    const codes = await prep('replenish');
    const pick = code(codes, 'Cara de picking');
    const tasks = await t.get('/replenishment/tasks?status=PENDING');
    const task = tasks.body.find((x: { to_code?: string; to_location_code?: string; sku_code?: string }) => JSON.stringify(x).includes('CAP-001'));
    expect(task, JSON.stringify(tasks.body).slice(0, 300)).toBeTruthy();
    const started = await t.post(`/replenishment/tasks/${task.id}/start`);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const done = await t.post('/transfers/complete', { transfer_id: started.body.transfer.id, lpn_code: started.body.lpn_code, location_barcode: pick }, idem());
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    await pass('replenish');
  });

  it('COUNT: blind count of the prepared location, then finish', async () => {
    const codes = await prep('count');
    const loc = code(codes, 'Ubicación');
    const lpn = code(codes, 'Pallet');
    const p = await sql<{ id: string }>(`SELECT count_task_id AS id FROM count_lines cl JOIN lpns l ON l.id = cl.lpn_id WHERE l.code = '${lpn}' ORDER BY cl.id DESC LIMIT 1`);
    const bal = await sql<{ qty: bigint }>(`SELECT b.qty FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id WHERE l.code = '${lpn}' AND b.status = 'AVAILABLE'`);
    await notYet('count');
    const sub = await t.post('/counts/submit', { count_task_id: p[0]!.id, location_barcode: loc, lpn_code: lpn, barcode: 'CAP002', qty: bal[0]!.qty.toString() }, idem());
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    await notYet('count'); // must finish
    expect((await t.post(`/counts/${p[0]!.id}/finish`)).status).toBe(200);
    await pass('count');
  });

  it('ASSEMBLY: bodies pallet at the school station → two pallets of finished product', async () => {
    const codes = await prep('assembly');
    const lpn = code(codes, 'Pallet de cuerpos');
    await notYet('assembly');
    const r = await t.post('/assembly', { station_barcode: code(codes, 'Estación'), inputs: [{ lpn_code: lpn, sku_code: 'CAP-003', qty: 24 }], output: { sku_code: 'CAP-003', pallets: [{ cases: 1, pieces_per_case: 12 }, { cases: 1, pieces_per_case: 12 }] } }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await pass('assembly');
  });

  it('PICK + STAGE: the trainee picks the prepared order and stages it in its lane', async () => {
    const codes = await prep('pick');
    const orderNumber = code(codes, 'Pedido');
    const tasks = await t.get('/picking/tasks?mine=true');
    const task = tasks.body.find((x: { order_number: string }) => x.order_number === orderNumber);
    expect(task).toBeTruthy();
    const view = await t.post(`/picking/tasks/${task.id}/start`);
    expect(view.status).toBe(200);
    await notYet('pick');
    for (const line of view.body.lines) {
      expect((await t.post('/picking/scan', { pick_task_id: task.id, line_id: line.id, step: 'LOCATION', scanned: line.location_barcode }, idem())).status).toBe(200);
      expect((await t.post('/picking/scan', { pick_task_id: task.id, line_id: line.id, step: 'LPN', scanned: line.lpn_code }, idem())).status).toBe(200);
      expect((await t.post('/picking/scan', { pick_task_id: task.id, line_id: line.id, step: 'QTY', qty: line.qty, uom_code: 'PIECE' }, idem())).status).toBe(200);
    }
    await pass('pick');

    const sCodes = await prep('stage');
    expect(code(sCodes, 'Carril')).toMatch(/^LOC-ESC-STG-0[1-3]$/);
    const lpns = sCodes.filter((c) => c.label.startsWith('Pallet')).map((c) => c.value);
    expect(lpns.length).toBeGreaterThan(0);
    await notYet('stage');
    for (const l of lpns) expect((await t.post('/staging/scan', { lpn_code: l, staging_location_barcode: code(sCodes, 'Carril') }, idem())).status).toBe(200);
    await pass('stage');
  });

  it('VERIFY: an order picked by the trainer; the trainee verifies blind', async () => {
    const codes = await prep('verify');
    const orderNumber = code(codes, 'Pedido');
    const pending = await t.get('/verifications/pending-orders');
    const o = pending.body.find((x: { order_number: string }) => x.order_number === orderNumber);
    expect(o).toBeTruthy();
    const v = await t.post('/verifications/start', { order_id: o.id });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    await notYet('verify');
    const staged = await sql<{ code: string; barcode: string; qty: bigint }>(`SELECT l.code, bc.barcode, b.qty FROM lpns l JOIN inventory_balances b ON b.lpn_id = l.id AND b.qty > 0 JOIN sku_barcodes bc ON bc.sku_id = b.sku_id AND bc.uom_code = 'PIECE' WHERE l.order_id = '${o.id}' AND l.status = 'STAGED'`);
    for (const s of staged) expect((await t.post('/verifications/scan', { verification_id: v.body.verification_id, lpn_code: s.code, barcode: s.barcode, qty: s.qty.toString() }, idem())).status).toBe(200);
    expect((await t.post('/verifications/complete', { verification_id: v.body.verification_id })).body.status).toBe('PASSED');
    await pass('verify');
  });

  it('LOAD: a verified shipment prepared by the trainer; loading every pallet completes the whole training', async () => {
    const codes = await prep('load');
    const shipmentNumber = code(codes, 'Embarque');
    const lpns = codes.filter((c) => c.label.startsWith('Pallet')).map((c) => c.value);
    const sh = await sql<{ id: string }>(`SELECT id FROM shipments WHERE shipment_number = '${shipmentNumber}'`);
    await notYet('load');
    for (const l of lpns) expect((await t.post('/loading/scan', { shipment_id: sh[0]!.id, lpn_code: l }, idem())).status).toBe(200);
    const r = await pass('load');
    expect(r.training_completed).toBe(true);
    const me = await t.get('/auth/me');
    expect(me.body.training).toMatchObject({ required: false, completed: true });
    await expectReconciled();
  });

  it('admin sees progress, can reset and waive; a waived user is not gated', async () => {
    const list = await adm.get('/training/users');
    expect(list.status, JSON.stringify(list.body).slice(0, 200)).toBe(200);
    const row = list.body.find((u: { username: string }) => u.username === t.username);
    expect(row, `trainee ${t.username} not in ${JSON.stringify(list.body.map((u: { username: string }) => u.username)).slice(0, 300)}`).toBeTruthy();
    expect(row.completed_at).toBeTruthy();
    expect(row.steps.filter((s: { status: string }) => s.status === 'COMPLETED')).toHaveLength(10);
    expect((await adm.post(`/training/users/${row.id}/reset`)).status).toBe(200);
    expect((await t.get('/auth/me')).body.training.required).toBe(true);
    expect((await adm.post(`/training/users/${row.id}/waive`, { reason: 'operador con experiencia previa' })).status).toBe(200);
    expect((await t.get('/auth/me')).body.training).toMatchObject({ required: false, completed: true });
    expect((await t.post('/training/users/x/reset')).status).toBe(403);
  });
});
