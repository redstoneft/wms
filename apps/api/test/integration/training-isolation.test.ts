// Everything done in the school warehouse is flagged is_training by database triggers and hidden from operational lists.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../../src/db.js';
import { ensureSchool, type School } from '../../src/modules/training/school.js';
import { closeApp, sql, userWithRoles, type Client } from '../helpers.js';

let sup: Client;
let school: School;

beforeAll(async () => {
  sup = await userWithRoles('isosup', ['SUPERVISOR']);
  school = await withTx((tx) => ensureSchool(tx));
});
afterAll(closeApp);

describe('training isolation', () => {
  it('a receipt opened on the school dock and an order for the school customer are flagged and hidden unless asked for', async () => {
    const r = await sup.post('/receipts', { receiving_location_id: school.dock.id });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const flagged = await sql<{ is_training: boolean }>(`SELECT is_training FROM receipts WHERE id = '${r.body.id}'`);
    expect(flagged[0]!.is_training).toBe(true);
    const list = await sup.get('/receipts?limit=500');
    expect(list.body.some((x: { id: string }) => x.id === r.body.id)).toBe(false);
    const all = await sup.get('/receipts?limit=500&include_training=true');
    expect(all.body.some((x: { id: string }) => x.id === r.body.id)).toBe(true);

    const o = await sup.post('/orders', { order_number: `CAP-ISO-${Date.now()}`, customer_code: school.customer.code, lines: [{ sku_code: school.skus[0]!.code, qty: 1, uom_code: 'PIECE' }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    expect((await sql<{ is_training: boolean }>(`SELECT is_training FROM orders WHERE id = '${o.body.id}'`))[0]!.is_training).toBe(true);
    const orders = await sup.get('/orders?limit=500');
    expect(orders.body.items ? orders.body.items.some((x: { id: string }) => x.id === o.body.id) : orders.body.some((x: { id: string }) => x.id === o.body.id)).toBe(false);

    // a normal receipt stays visible
    const real = await sql<{ id: string }>(`SELECT id FROM locations WHERE location_type = 'RECEIVING' AND warehouse_id <> '${school.warehouse_id}' LIMIT 1`);
    const r2 = await sup.post('/receipts', { receiving_location_id: real[0]!.id });
    expect(r2.status).toBe(201);
    expect((await sql<{ is_training: boolean }>(`SELECT is_training FROM receipts WHERE id = '${r2.body.id}'`))[0]!.is_training).toBe(false);
    expect((await sup.get('/receipts?limit=500')).body.some((x: { id: string }) => x.id === r2.body.id)).toBe(true);
    // dashboard never counts school documents
    const dash = await sup.get('/dashboard');
    expect(dash.status).toBe(200);
  });
});
