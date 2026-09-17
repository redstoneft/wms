// Tasks an operator creates for themself from the handheld: the purpose is mandatory and audited.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, expectReconciled, idem, makeFixture, sql, storedPallet, userWithRoles, type Client, type Fixture } from '../helpers.js';

let sup: Client;
let picker: Client;
let forklift: Client;
let f: Fixture;

beforeAll(async () => {
  sup = await userWithRoles('stsup', ['SUPERVISOR']);
  picker = await userWithRoles('stpick', ['PICKER']);
  forklift = await userWithRoles('stfork', ['FORKLIFT']);
  f = await makeFixture({ skus: 2 });
});
afterAll(closeApp);

describe('self-created handheld tasks (para qué obligatorio)', () => {
  it('a picker creates the pick task of an accepted order for themself; the order gets allocated and the purpose is stored and audited', async () => {
    await storedPallet(f, 0, f.reserve[0]!.id, 60n);
    const number = `PED-ST-${f.tag}`;
    const o = await sup.post('/orders', { order_number: number, customer_code: f.customer.code, lines: [{ sku_code: f.skus[0]!.code, qty: 12, uom_code: 'PIECE' }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    const short = await picker.post('/wm/tasks', { kind: 'PICK', reference: number, purpose: 'ya' });
    expect(short.status).toBe(400); // purpose too short
    const r = await picker.post('/wm/tasks', { kind: 'PICK', reference: number.toLowerCase(), purpose: 'el cliente pasa por el pedido hoy a las 4' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ kind: 'PICK', order_number: number, lines: 1, next: '/wm/pick' });
    const task = await sql<{ assigned_to: string; purpose: string; status: string }>(`SELECT assigned_to, purpose, status FROM pick_tasks WHERE id = '${r.body.id}'`);
    const me = await sql<{ id: string }>(`SELECT id FROM users WHERE username = '${picker.username}'`);
    expect(task[0]).toMatchObject({ assigned_to: me[0]!.id, purpose: 'el cliente pasa por el pedido hoy a las 4', status: 'PENDING' });
    const aud = await sql<{ reason: string }>(`SELECT reason FROM audit_logs WHERE action = 'task.self_created' AND entity_id = '${r.body.id}'`);
    expect(aud[0]!.reason).toContain('cliente pasa');
    // the task shows up in the picker's own list
    const mine = await picker.get('/picking/tasks?mine=true');
    expect(mine.body.some((t: { id: string }) => t.id === r.body.id)).toBe(true);
  });

  it('COUNT and PUTAWAY kinds, and a role cannot create a kind it cannot execute', async () => {
    const c = await forklift.post('/wm/tasks', { kind: 'COUNT', reference: f.reserve[1]!.barcode, purpose: 'diferencia detectada al surtir' });
    expect(c.status).toBe(403); // forklift cannot count
    const inv = await userWithRoles('stinv', ['INVENTORY_CONTROL']);
    const c2 = await inv.post('/wm/tasks', { kind: 'COUNT', reference: f.reserve[1]!.barcode, purpose: 'diferencia detectada al surtir' });
    expect(c2.status, JSON.stringify(c2.body)).toBe(201);
    const ct = await sql<{ notes: string; assigned_to: string | null }>(`SELECT notes, assigned_to FROM count_tasks WHERE id = '${c2.body.id}'`);
    expect(ct[0]!.notes).toBe('diferencia detectada al surtir');
    expect(ct[0]!.assigned_to).not.toBeNull();
    const dockPallet = await storedPallet(f, 1, f.dock.id, 6n); // left at the dock without a put-away task
    await sql(`UPDATE lpns SET status = 'OPEN' WHERE id = '${dockPallet.id}'`);
    const p = await forklift.post('/wm/tasks', { kind: 'PUTAWAY', reference: dockPallet.code, purpose: 'tarima quedó en andén sin tarea' });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const pt = await sql<{ purpose: string; status: string }>(`SELECT purpose, status FROM putaway_tasks WHERE id = '${p.body.id}'`);
    expect(pt[0]).toMatchObject({ purpose: 'tarima quedó en andén sin tarea', status: 'PENDING' });
  });

  it('free picking: a NEW order created on the handheld is built by scanning pallets over time and closed explicitly', async () => {
    const whole = await storedPallet(f, 0, f.reserve[2]!.id, 24n);
    const part = await storedPallet(f, 1, f.reserve[3]!.id, 40n);
    const number = `PED-LIBRE-${f.tag}`;
    const noCustomer = await picker.post('/wm/tasks', { kind: 'PICK', reference: number, purpose: 'cliente recoge el viernes' });
    expect(noCustomer.status).toBe(404); // unknown order and no customer given
    const r = await picker.post('/wm/tasks', { kind: 'PICK', reference: number, purpose: 'cliente recoge el viernes', new_order: { customer_code: f.customer.code, destination: 'Mostrador' } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ kind: 'PICK', mode: 'FREE', order_number: number, next: '/wm/pick' });
    const order = await sql<{ status: string; source: string; is_training: boolean }>(`SELECT status, source, is_training FROM orders WHERE order_number = '${number}'`);
    expect(order[0]).toMatchObject({ status: 'ACCEPTED', source: 'MANUAL', is_training: false });
    // day 1: a whole pallet
    const s1 = await picker.post('/picking/free-scan', { pick_task_id: r.body.id, lpn_code: whole.code }, idem());
    expect(s1.status, JSON.stringify(s1.body)).toBe(200);
    expect(s1.body.whole_pallet).toBe(true);
    expect(s1.body.view.task.status).toBe('IN_PROGRESS'); // not auto-completed
    expect(s1.body.view.staging).toBeTruthy(); // lane assigned from the first pallet
    const wholeRow = await sql<{ status: string; lpn_type: string }>(`SELECT status, lpn_type FROM lpns WHERE code = '${whole.code}'`);
    expect(wholeRow[0]).toEqual({ status: 'PICKING', lpn_type: 'OUTBOUND' });
    // "day 2": pause is implicit (task stays open in my list), then a quantity from another pallet
    const mine = await picker.get('/picking/tasks?mine=true');
    expect(mine.body.find((t: { id: string }) => t.id === r.body.id)?.mode).toBe('FREE');
    const tooMuch = await picker.post('/picking/free-scan', { pick_task_id: r.body.id, lpn_code: part.code, qty: 41, uom_code: 'PIECE' }, idem());
    expect(tooMuch.status).toBe(422);
    const s2 = await picker.post('/picking/free-scan', { pick_task_id: r.body.id, lpn_code: part.code, qty: 2, uom_code: 'CASE' }, idem()); // 2 cases × 6
    expect(s2.status, JSON.stringify(s2.body)).toBe(200);
    expect(s2.body.added).toEqual([{ sku: f.skus[1]!.code, qty: '12' }]);
    expect(s2.body.outbound_lpn).toBeTruthy();
    const lines = await sql<{ code: string; required_qty: bigint; picked_qty: bigint; allocated_qty: bigint }>(`SELECT s.code, ol.required_qty, ol.picked_qty, ol.allocated_qty FROM order_lines ol JOIN skus s ON s.id = ol.sku_id JOIN orders o ON o.id = ol.order_id WHERE o.order_number = '${number}' ORDER BY ol.line_no`);
    expect(lines.map((l) => `${l.code}:${l.required_qty}/${l.picked_qty}/${l.allocated_qty}`)).toEqual([`${f.skus[0]!.code}:24/24/0`, `${f.skus[1]!.code}:12/12/0`]);
    expect((await sql<{ q: bigint }>(`SELECT qty AS q FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id WHERE l.code = '${part.code}' AND b.status = 'AVAILABLE'`))[0]!.q).toBe(28n);
    // close: task completed, order picked, ready for staging
    const c = await picker.post(`/picking/tasks/${r.body.id}/close`);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.task.status).toBe('COMPLETED');
    expect((await sql<{ status: string }>(`SELECT status FROM orders WHERE order_number = '${number}'`))[0]!.status).toBe('PICKED');
    await expectReconciled();
    // re-entering the same order number later continues nothing (closed) → a directed task would need allocations
    const again = await picker.post('/wm/tasks', { kind: 'PICK', reference: number, purpose: 'continuar el pedido' });
    expect(again.status).toBe(422);
  });
});
