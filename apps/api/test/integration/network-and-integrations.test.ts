// NETWORK FAILURE SIMULATION + INTEGRATION LAYER
// - request duplicated after a timeout (sequential replay)
// - server "restart" between the original request and the retry (replay comes from the DB, not memory)
// - reconnection storms (many stale retries) never duplicate inventory
// - warehouse → warehouse transfer
// - SAE integration endpoint (API key, idempotent by order number)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, expectReconciled, getApp, idem, makeFixture, skuTotal, sql, storedPallet, userWithRoles, clientFor, type Client, type Fixture } from '../helpers.js';

let f: Fixture;
let recv: Client;
let sup: Client;

beforeAll(async () => {
  f = await makeFixture({ skus: 2 });
  recv = await userWithRoles('nrecv', ['RECEIVING']);
  sup = await userWithRoles('nsup', ['SUPERVISOR']);
});
afterAll(async () => {
  await closeApp();
});

describe('network failures', () => {
  it('a delayed duplicate (client timed out, server had committed) is replayed, not re-executed', async () => {
    const rcp = await recv.post('/receipts', { receiving_location_id: f.dock.id });
    const key = idem();
    const body = { receipt_id: rcp.body.id, barcode: f.skus[0]!.case_barcode, qty: 3 };
    const before = await skuTotal(f.skus[0]!.id);
    const r1 = await recv.post('/receipts/scan', body, key);
    expect(r1.status).toBe(201);
    await new Promise((r) => setTimeout(r, 300)); // "reconnect"
    const r2 = await recv.post('/receipts/scan', body, key);
    expect(r2.status).toBe(201);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(r2.body.lpn.code).toBe(r1.body.lpn.code);
    expect(await skuTotal(f.skus[0]!.id)).toBe(before + 18n);
  });

  it('server restart between original and retry: the replay survives because the key lives in the database', async () => {
    const rcp = await recv.post('/receipts', { receiving_location_id: f.dock.id });
    const key = idem();
    const body = { receipt_id: rcp.body.id, barcode: f.skus[1]!.case_barcode, qty: 2 };
    const before = await skuTotal(f.skus[1]!.id);
    const r1 = await recv.post('/receipts/scan', body, key);
    expect(r1.status).toBe(201);
    // simulate restart: close the app and build a fresh one; session cookie is also DB-backed so it survives
    await closeApp();
    await getApp();
    const again = await clientFor(recv.username, `Pw-${recv.username}-Test-1!`);
    const r2 = await recv.post('/receipts/scan', body, key); // old client object, new app instance
    expect(r2.status).toBe(201);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(await skuTotal(f.skus[1]!.id)).toBe(before + 12n);
    expect(again.username).toBe(recv.username);
  });

  it('a reconnection storm replaying 30 stale requests with 3 distinct keys produces exactly 3 movements', async () => {
    const rcp = await recv.post('/receipts', { receiving_location_id: f.dock.id });
    const keys = [idem(), idem(), idem()];
    const before = await skuTotal(f.skus[0]!.id);
    const reqs = Array.from({ length: 30 }, (_, i) => recv.post('/receipts/scan', { receipt_id: rcp.body.id, barcode: f.skus[0]!.piece_barcode, qty: 1 }, keys[i % 3]!));
    const rs = await Promise.all(reqs);
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(new Set(rs.map((r) => r.body.movement_id)).size).toBe(3);
    expect(await skuTotal(f.skus[0]!.id)).toBe(before + 3n);
    await expectReconciled();
  });

  it('a request WITHOUT Idempotency-Key is executed every time (the client must always send one for scans)', async () => {
    const rcp = await recv.post('/receipts', { receiving_location_id: f.dock.id });
    const before = await skuTotal(f.skus[0]!.id);
    await recv.post('/receipts/scan', { receipt_id: rcp.body.id, barcode: f.skus[0]!.piece_barcode, qty: 1 });
    await recv.post('/receipts/scan', { receipt_id: rcp.body.id, barcode: f.skus[0]!.piece_barcode, qty: 1 });
    expect(await skuTotal(f.skus[0]!.id)).toBe(before + 2n);
  });

  it('the idempotency key is scoped per user: two users with the same key do not collide', async () => {
    const other = await userWithRoles('nrecv2', ['RECEIVING']);
    const rcp = await recv.post('/receipts', { receiving_location_id: f.dock.id });
    const key = idem();
    const a = await recv.post('/receipts/scan', { receipt_id: rcp.body.id, barcode: f.skus[0]!.piece_barcode, qty: 1 }, key);
    const b = await other.post('/receipts/scan', { receipt_id: rcp.body.id, barcode: f.skus[0]!.piece_barcode, qty: 1 }, key);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replayed']).toBeUndefined();
    expect(a.body.movement_id).not.toBe(b.body.movement_id);
  });
});

describe('warehouse → warehouse transfer', () => {
  it('moves the pallet and reassigns its warehouse', async () => {
    const fork = await userWithRoles('nfork', ['FORKLIFT']);
    const other = await makeFixture({ skus: 1 });
    const lpn = await storedPallet(f, 0, f.reserve[0]!.id, 12n);
    const t = await fork.post('/transfers/start', { lpn_code: lpn.code, to_location_barcode: other.reserve[0]!.barcode }, idem());
    expect(t.status).toBe(201);
    expect(t.body.transfer.transfer_type).toBe('WAREHOUSE');
    const done = await fork.post('/transfers/complete', { transfer_id: t.body.transfer.id, lpn_code: lpn.code, location_barcode: other.reserve[0]!.barcode }, idem());
    expect(done.status).toBe(200);
    const row = await sql<{ warehouse_id: string }>(`SELECT warehouse_id FROM lpns WHERE code = '${lpn.code}'`);
    expect(row[0]!.warehouse_id).toBe(other.warehouse_id);
    const map = await sup.get(`/map?warehouse_id=${other.warehouse_id}`);
    expect(map.body.locations.find((l: any) => l.id === other.reserve[0]!.id).status).toBe('OCCUPIED');
    await expectReconciled();
  });
});

describe('integration layer (SAE)', () => {
  it('rejects calls without a valid API key and is disabled when not configured', async () => {
    const a = await getApp();
    const prev = process.env.INTEGRATION_API_KEY;
    delete process.env.INTEGRATION_API_KEY;
    let r = await a.inject({ method: 'POST', url: '/api/integrations/sae/orders', headers: { 'x-api-key': 'whatever-whatever-whatever', 'content-type': 'application/json' }, payload: '{"orders":[]}' });
    expect(r.statusCode).toBe(403);
    process.env.INTEGRATION_API_KEY = 'test-integration-key-0123456789abcdef';
    r = await a.inject({ method: 'POST', url: '/api/integrations/sae/orders', headers: { 'x-api-key': 'wrong-key-wrong-key-wrong-key', 'content-type': 'application/json' }, payload: '{"orders":[]}' });
    expect(r.statusCode).toBe(401);
    r = await a.inject({ method: 'POST', url: '/api/integrations/sae/orders', headers: { 'content-type': 'application/json' }, payload: '{"orders":[]}' });
    expect([401, 403]).toContain(r.statusCode);
    if (prev) process.env.INTEGRATION_API_KEY = prev;
  });

  it('imports SAE orders idempotently by order number and exposes status + inventory', async () => {
    const a = await getApp();
    process.env.INTEGRATION_API_KEY = 'test-integration-key-0123456789abcdef';
    const headers = { 'x-api-key': 'test-integration-key-0123456789abcdef', 'content-type': 'application/json' };
    const payload = JSON.stringify({ orders: [{ order_number: `SAE-${f.tag}-1`, customer_code: f.customer.code, external_ref: 'FACT-001', lines: [{ sku_code: f.skus[0]!.code, qty: 2, uom_code: 'CASE' }] }, { order_number: `SAE-${f.tag}-2`, customer_code: 'NOPE', lines: [{ sku_code: f.skus[0]!.code, qty: 1 }] }] });
    const r1 = await a.inject({ method: 'POST', url: '/api/integrations/sae/orders', headers, payload });
    expect(r1.statusCode).toBe(200);
    const b1 = JSON.parse(r1.body);
    expect(b1.created).toEqual([`SAE-${f.tag}-1`]);
    expect(b1.errors[0].order_number).toBe(`SAE-${f.tag}-2`);
    const r2 = await a.inject({ method: 'POST', url: '/api/integrations/sae/orders', headers, payload });
    const b2 = JSON.parse(r2.body);
    expect(b2.created).toEqual([]);
    expect(b2.skipped).toEqual([`SAE-${f.tag}-1`]);
    const st = await a.inject({ method: 'GET', url: `/api/integrations/sae/orders/SAE-${f.tag}-1/status`, headers });
    expect(JSON.parse(st.body)).toMatchObject({ found: true, status: 'IMPORTED' });
    const inv = await a.inject({ method: 'GET', url: '/api/integrations/inventory', headers });
    expect(inv.statusCode).toBe(200);
    const o = await sql<{ source: string }>(`SELECT source FROM orders WHERE order_number = 'SAE-${f.tag}-1'`);
    expect(o[0]!.source).toBe('SAE');
    // the integration user cannot do anything outside its scope with a cookie (it has none) and the API key cannot release shipments
    const rel = await a.inject({ method: 'POST', url: '/api/shipments/release', headers, payload: '{}' });
    expect([401, 403]).toContain(rel.statusCode);
  });
});
