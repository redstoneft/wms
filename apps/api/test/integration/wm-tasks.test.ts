// Tasks an operator creates for themself from the handheld: the purpose is mandatory and audited.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeFixture, sql, storedPallet, userWithRoles, type Client, type Fixture } from '../helpers.js';

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
});
