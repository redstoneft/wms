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

  it('editing and deleting a free pick: a line scanned by mistake goes back to its pallet; cancelling returns everything and cancels the floor-born order', async () => {
    const whole = await storedPallet(f, 0, f.reserve[4]!.id, 18n);
    const part = await storedPallet(f, 1, f.reserve[5]!.id, 30n);
    const number = `PED-EDIT-${f.tag}`;
    const r = await picker.post('/wm/tasks', { kind: 'PICK', reference: number, purpose: 'pedido de mostrador', new_order: { customer_code: f.customer.code } });
    expect(r.status).toBe(201);
    const s1 = await picker.post('/picking/free-scan', { pick_task_id: r.body.id, lpn_code: whole.code }, idem());
    const s2 = await picker.post('/picking/free-scan', { pick_task_id: r.body.id, lpn_code: part.code, qty: 10, uom_code: 'PIECE' }, idem());
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    const partLine = s2.body.view.lines.find((l: { lpn_code: string }) => l.lpn_code === part.code);
    // undo the partial line: 10 pieces go back from the outbound pallet to the source pallet
    const u = await picker.post(`/picking/tasks/${r.body.id}/lines/${partLine.id}/undo`, { reason: 'tarima equivocada' });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    expect((await sql<{ q: bigint }>(`SELECT COALESCE(sum(qty),0)::bigint AS q FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id WHERE l.code = '${part.code}' AND b.status = 'AVAILABLE'`))[0]!.q).toBe(30n);
    expect((await sql<{ n: bigint }>(`SELECT count(*) AS n FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE o.order_number = '${number}'`))[0]!.n).toBe(1n);
    expect(u.body.lines.filter((l: { status: string }) => l.status === 'PICKED')).toHaveLength(1);
    // delete the whole pick: the whole pallet flips back to stock, order cancelled, lane released
    const noReason = await picker.post(`/picking/tasks/${r.body.id}/cancel`, { reason: '' });
    expect(noReason.status).toBe(400);
    const c = await picker.post(`/picking/tasks/${r.body.id}/cancel`, { reason: 'el cliente canceló' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body).toMatchObject({ status: 'CANCELLED', order_status: 'CANCELLED', undone: 1 });
    const wholeRow = await sql<{ status: string; lpn_type: string; order_id: string | null; avail: bigint }>(`SELECT l.status, l.lpn_type, l.order_id, (SELECT COALESCE(sum(qty),0)::bigint FROM inventory_balances b WHERE b.lpn_id = l.id AND b.status = 'AVAILABLE') AS avail FROM lpns l WHERE l.code = '${whole.code}'`);
    expect(wholeRow[0]).toEqual({ status: 'STORED', lpn_type: 'STORAGE', order_id: null, avail: 18n });
    expect((await sql<{ status: string }>(`SELECT status FROM orders WHERE order_number = '${number}'`))[0]!.status).toBe('CANCELLED');
    expect((await sql<{ n: bigint }>(`SELECT count(*) AS n FROM staging_assignments sa JOIN orders o ON o.id = sa.order_id WHERE o.order_number = '${number}' AND sa.released_at IS NULL`))[0]!.n).toBe(0n);
    expect((await picker.get('/picking/tasks?mine=true')).body.some((t: { id: string }) => t.id === r.body.id)).toBe(false);
    await expectReconciled();
  });

  it('a manual order captured on the handheld (scanned aliases, cases and pieces) is accepted and can be picked right away', async () => {
    await storedPallet(f, 0, f.reserve[6]!.id, 60n);
    const number = `PED-CAP-${f.tag}`;
    const bad = await picker.post('/wm/orders', { order_number: number, customer_code: f.customer.code, purpose: 'mostrador', lines: [] });
    expect(bad.status).toBe(400); // no lines
    // order numbers as customers write them (spaces, #) are accepted; the failing field is named in the details
    const spaced = await picker.post('/wm/orders', { order_number: `OC ${f.tag} #1`, customer_code: f.customer.code, purpose: 'pedido con espacios', lines: [{ sku_code: f.skus[0]!.code, qty: 1 }] });
    expect(spaced.status, JSON.stringify(spaced.body)).toBe(201);
    const badChars = await picker.post('/wm/orders', { order_number: 'PED|MAL', customer_code: f.customer.code, purpose: 'mostrador', lines: [{ sku_code: f.skus[0]!.code, qty: 1 }] });
    expect(badChars.status).toBe(400);
    expect(badChars.body.details[0].path).toBe('order_number');
    const r = await picker.post('/wm/orders', {
      order_number: number.toLowerCase(),
      customer_code: f.customer.code,
      purpose: 'pedido de mostrador, pasa hoy',
      lines: [
        { sku_code: f.skus[0]!.case_barcode, qty: 2, uom_code: 'CASE' }, // scanned case barcode → 12 pieces
        { sku_code: f.skus[0]!.piece_barcode, qty: 3, uom_code: 'PIECE' },
        { sku_code: f.skus[1]!.code, qty: 4, uom_code: 'PIECE' },
      ],
      start_now: true,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ order_number: number, next: '/wm/pick' });
    expect(r.body.task_id).toBeTruthy();
    const lines = await sql<{ code: string; required_qty: bigint; allocated_qty: bigint }>(`SELECT s.code, ol.required_qty, ol.allocated_qty FROM order_lines ol JOIN skus s ON s.id = ol.sku_id JOIN orders o ON o.id = ol.order_id WHERE o.order_number = '${number}' ORDER BY ol.line_no`);
    expect(lines.map((l) => `${l.code}:${l.required_qty}/${l.allocated_qty}`)).toEqual([`${f.skus[0]!.code}:15/15`, `${f.skus[1]!.code}:4/4`]); // 2 cases × 6 + 3 pieces merge into one line; sku 1 stock left by the free-pick test above
    const order = await sql<{ status: string; source: string; notes: string }>(`SELECT status, source, notes FROM orders WHERE order_number = '${number}'`);
    expect(order[0]).toMatchObject({ status: 'ALLOCATED', source: 'MANUAL', notes: 'pedido de mostrador, pasa hoy' });
    const task = await sql<{ mode: string; purpose: string; assigned_to: string | null }>(`SELECT mode, purpose, assigned_to FROM pick_tasks WHERE id = '${r.body.task_id}'`);
    expect(task[0]!.mode).toBe('ALLOCATED');
    expect(task[0]!.purpose).toBe('pedido de mostrador, pasa hoy');
    const dup = await picker.post('/wm/orders', { order_number: number, customer_code: f.customer.code, purpose: 'otra vez', lines: [{ sku_code: f.skus[0]!.code, qty: 1 }] });
    expect(dup.status).toBe(422);
    // saved for later: accepted, no task
    const later = await picker.post('/wm/orders', { order_number: `${number}-B`, customer_code: f.customer.code, purpose: 'para mañana', lines: [{ sku_code: f.skus[0]!.code, qty: 1 }], start_now: false });
    expect(later.status).toBe(201);
    expect(later.body.task_id).toBeNull();
    expect((await sql<{ status: string }>(`SELECT status FROM orders WHERE order_number = '${number}-B'`))[0]!.status).toBe('ACCEPTED');
  });

  it('shared picking: a second picker sees and joins an order another picker started; each works a different line and the free pick accepts pallets from both', async () => {
    const picker2 = await userWithRoles('stpick2', ['PICKER']);
    // the fixture has 3 lanes and earlier orders of this file hold them: pretend those shipped
    await sql(`UPDATE staging_assignments SET released_at = now() WHERE released_at IS NULL AND order_id IN (SELECT id FROM orders WHERE customer_id = '${f.customer.id}')`);
    // free pick started by picker 1, continued by picker 2
    const whole = await storedPallet(f, 0, f.reserve[7]!.id, 6n);
    const number = `PED-SHARED-${f.tag}`;
    const r = await picker.post('/wm/tasks', { kind: 'PICK', reference: number, purpose: 'entre dos personas', new_order: { customer_code: f.customer.code } });
    expect(r.status).toBe(201);
    const list2 = await picker2.get('/picking/tasks?mine=false');
    expect(list2.body.some((t: { id: string }) => t.id === r.body.id)).toBe(true);
    const s2 = await picker2.post('/picking/free-scan', { pick_task_id: r.body.id, lpn_code: whole.code }, idem());
    expect(s2.status, JSON.stringify(s2.body)).toBe(200);
    expect(s2.body.view.lines[0].picker_username).toBe(picker2.username);
    expect(s2.body.view.task.assigned_username).toBe(picker.username);
    const closed = await picker2.post(`/picking/tasks/${r.body.id}/close`);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    // directed pick with two lines: picker 1 starts, picker 2 joins; the line picker 1 is on is refused to picker 2
    await storedPallet(f, 0, f.reserve[8]!.id, 10n);
    await storedPallet(f, 1, f.reserve[9]!.id, 10n);
    const number2 = `PED-SHARED2-${f.tag}`;
    const o = await sup.post('/orders', { order_number: number2, customer_code: f.customer.code, lines: [{ sku_code: f.skus[0]!.code, qty: 10 }, { sku_code: f.skus[1]!.code, qty: 10 }] });
    expect(o.status).toBe(201);
    const t = await picker.post('/wm/tasks', { kind: 'PICK', reference: number2, purpose: 'pedido grande, entre dos' });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const v1 = await picker.post(`/picking/tasks/${t.body.id}/start`);
    expect(v1.status).toBe(200);
    const [l1, l2] = v1.body.lines;
    const loc1 = await picker.post('/picking/scan', { pick_task_id: t.body.id, line_id: l1.id, step: 'LOCATION', scanned: l1.location_barcode }, idem());
    expect(loc1.status, JSON.stringify(loc1.body)).toBe(200);
    const v2 = await picker2.post(`/picking/tasks/${t.body.id}/start`); // joins, does not take over
    expect(v2.status, JSON.stringify(v2.body)).toBe(200);
    expect(v2.body.task.assigned_username).toBe(picker.username);
    expect(v2.body.lines.find((l: { id: string }) => l.id === l1.id).picker_username).toBe(picker.username);
    const taken = await picker2.post('/picking/scan', { pick_task_id: t.body.id, line_id: l1.id, step: 'LOCATION', scanned: l1.location_barcode }, idem());
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe('LINE_TAKEN');
    const ok2 = await picker2.post('/picking/scan', { pick_task_id: t.body.id, line_id: l2.id, step: 'LOCATION', scanned: l2.location_barcode }, idem());
    expect(ok2.status, JSON.stringify(ok2.body)).toBe(200);
  });

  it('no free staging lane never blocks picking: the task is created without a lane and the lane is taken when the pallet arrives', async () => {
    // occupy every lane of the fixture with other orders
    const lanes = await sql<{ id: string; code: string; barcode: string }>(`SELECT id, code, barcode FROM locations WHERE warehouse_id = '${f.warehouse_id}' AND location_type = 'STAGING' AND is_active ORDER BY code`);
    const blockers: string[] = [];
    for (const lane of lanes) {
      const o = await sup.post('/orders', { order_number: `BLK-${lane.code}`, customer_code: f.customer.code, lines: [{ sku_code: f.skus[0]!.code, qty: 1 }] });
      await sql(`UPDATE staging_assignments SET released_at = now() WHERE released_at IS NULL AND location_id = '${lane.id}'`);
      await sql(`INSERT INTO staging_assignments (order_id, location_id) VALUES ('${o.body.id}', '${lane.id}')`);
      blockers.push(o.body.id);
    }
    const pallet = await storedPallet(f, 0, f.reserve[10]!.id, 6n);
    const number = `PED-NOLANE-${f.tag}`;
    const r = await picker.post('/wm/tasks', { kind: 'PICK', reference: number, purpose: 'sin carril libre', new_order: { customer_code: f.customer.code } });
    expect(r.status).toBe(201);
    const s1 = await picker.post('/picking/free-scan', { pick_task_id: r.body.id, lpn_code: pallet.code }, idem());
    expect(s1.status, JSON.stringify(s1.body)).toBe(200);
    expect(s1.body.view.staging).toBeNull(); // picked anyway, no lane yet
    const c = await picker.post(`/picking/tasks/${r.body.id}/close`);
    expect(c.status).toBe(200);
    // arriving at a busy lane is refused with the owner's order; a freed lane is taken on arrival
    const busy = await picker.post('/staging/scan', { lpn_code: pallet.code, staging_location_barcode: lanes[0]!.barcode }, idem());
    expect(busy.status).toBe(422);
    expect(busy.body.error).toBe('LANE_BUSY');
    await sql(`UPDATE staging_assignments SET released_at = now() WHERE order_id = '${blockers[1]}'`);
    const ok = await picker.post('/staging/scan', { lpn_code: pallet.code, staging_location_barcode: lanes[1]!.barcode }, idem());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.location).toBe(lanes[1]!.code);
    const view = await picker.get(`/picking/tasks/${r.body.id}`);
    expect(view.body.staging.code).toBe(lanes[1]!.code);
  });

  it('RECEIPT kind opens a receipt at the scanned dock; re-receiving a pallet applies the real contents for a supervisor and leaves a finished count for a picker', async () => {
    const rc = await userWithRoles('strecv', ['RECEIVING']);
    const r = await rc.post('/wm/tasks', { kind: 'RECEIPT', reference: f.dock.barcode, purpose: 'llegó camión sin cita' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.kind).toBe('RECEIPT');
    expect(r.body.next).toBe(`/wm/receive?receipt=${r.body.id}`);
    expect((await sql<{ notes: string; status: string }>(`SELECT notes, status FROM receipts WHERE id = '${r.body.id}'`))[0]).toMatchObject({ notes: 'llegó camión sin cita', status: 'OPEN' });
    const notDock = await rc.post('/wm/tasks', { kind: 'RECEIPT', reference: f.reserve[0]!.barcode, purpose: 'andén equivocado' });
    expect(notDock.status).toBe(422);
    // no dock scanned: the warehouse's receiving dock is used
    await sql(`UPDATE warehouses SET is_default = false`);
    await sql(`UPDATE warehouses SET is_default = true WHERE id = '${f.warehouse_id}'`);
    const auto = await rc.post('/wm/tasks', { kind: 'RECEIPT', purpose: 'sin escanear andén' });
    expect(auto.status, JSON.stringify(auto.body)).toBe(201);
    expect(auto.body.dock).toBe(f.dock.code);
    const noRef = await rc.post('/wm/tasks', { kind: 'COUNT', purpose: 'sin referencia' });
    expect(noRef.status).toBe(422);

    // supervisor: the pallet really holds 50 of sku0 (system 60) and 5 of sku1 (system 0)
    const mixed = await storedPallet(f, 0, f.reserve[11]!.id, 60n);
    const sup2 = await userWithRoles('strsup', ['SUPERVISOR']);
    const a = await sup2.post('/wm/lpn-recount', { lpn_code: mixed.code, purpose: 'tarima revuelta al abrirla', lines: [{ sku_code: f.skus[0]!.piece_barcode, qty: 50 }, { sku_code: f.skus[1]!.code, qty: 5 }] });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.mode).toBe('APPLIED');
    const bal = await sql<{ code: string; qty: bigint }>(`SELECT s.code, b.qty FROM inventory_balances b JOIN skus s ON s.id = b.sku_id JOIN lpns l ON l.id = b.lpn_id WHERE l.code = '${mixed.code}' AND b.qty > 0 ORDER BY s.code`);
    expect(bal.map((b) => `${b.code}=${b.qty}`)).toEqual([`${f.skus[0]!.code}=50`, `${f.skus[1]!.code}=5`]);
    await expectReconciled();

    // picker: no adjustment rights → a finished count on the location awaiting recount/approval, inventory untouched
    const other = await storedPallet(f, 1, f.reserve[12]!.id, 30n);
    const c = await picker.post('/wm/lpn-recount', { lpn_code: other.code, purpose: 'faltan piezas al abrir', lines: [{ sku_code: f.skus[1]!.code, qty: 28 }] });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body.mode).toBe('COUNT');
    expect(c.body.status).toBe('RECOUNT');
    expect((await sql<{ q: bigint }>(`SELECT qty AS q FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id WHERE l.code = '${other.code}'`))[0]!.q).toBe(30n);
    const line = await sql<{ counted_qty: bigint; variance: bigint; status: string }>(`SELECT counted_qty, variance, status FROM count_lines WHERE count_task_id = '${c.body.task_id}'`);
    expect(line[0]).toMatchObject({ counted_qty: 28n, variance: -2n, status: 'RECOUNT' });
  });
});
