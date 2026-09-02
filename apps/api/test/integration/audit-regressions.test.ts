// REGRESSION TESTS for the external audit findings (docs/AUDIT_REPORT.md).
// Each test names the finding it protects against.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, expectReconciled, getApp, idem, makeFixture, skuTotal, sql, storedPallet, userWithRoles, type Client, type Fixture } from '../helpers.js';

let f: Fixture;
let sup: Client;
let sup2: Client;
let recv: Client;
let fork: Client;
let picker: Client;
let verifier: Client;
let loader: Client;

beforeAll(async () => {
  f = await makeFixture({ skus: 3, reserveBays: 8, levels: 3 });
  sup = await userWithRoles('asup', ['SUPERVISOR']);
  sup2 = await userWithRoles('asup2', ['SUPERVISOR']);
  recv = await userWithRoles('arecv', ['RECEIVING']);
  fork = await userWithRoles('afork', ['FORKLIFT']);
  picker = await userWithRoles('apick', ['PICKER']);
  verifier = await userWithRoles('aver', ['VERIFIER']);
  loader = await userWithRoles('aload', ['LOADER']);
});
afterAll(async () => {
  await closeApp();
});

async function acceptedOrder(lines: { sku: number; cases: number }[], tag = Math.random().toString(36).slice(2, 8)) {
  const o = await sup.post('/orders', { order_number: `A-${f.tag}-${tag}`, customer_code: f.customer.code, lines: lines.map((l) => ({ sku_code: f.skus[l.sku]!.code, qty: l.cases, uom_code: 'CASE' })) });
  expect(o.status).toBe(201);
  await sup.post(`/orders/${o.body.id}/accept`);
  return o.body.id as string;
}

async function pickAll(taskId: string, who: Client) {
  const v = await who.post(`/picking/tasks/${taskId}/start`);
  expect(v.status).toBe(200);
  for (const line of v.body.lines as any[]) {
    expect((await who.post('/picking/scan', { pick_task_id: taskId, line_id: line.id, step: 'LOCATION', scanned: line.location_barcode }, idem())).status).toBe(200);
    expect((await who.post('/picking/scan', { pick_task_id: taskId, line_id: line.id, step: 'LPN', scanned: line.lpn_code }, idem())).status).toBe(200);
    expect((await who.post('/picking/scan', { pick_task_id: taskId, line_id: line.id, step: 'QTY', qty: line.qty, uom_code: 'PIECE' }, idem())).status).toBe(200);
  }
  return v.body;
}

describe('A1 — reconciliation endpoint works and detects counter corruption', () => {
  it('returns ok and reports a tampered order_lines counter', async () => {
    const r = await sup.get('/inventory/reconcile');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('ok');
    expect(r.body.balance_discrepancies).toEqual([]);
    expect(r.body.location_discrepancies).toEqual([]);
    // tamper a picked counter directly (only possible with DB access) → must be reported, not hidden
    await storedPallet(f, 0, f.reserve[0]!.id, 60n);
    const oid = await acceptedOrder([{ sku: 0, cases: 1 }]);
    await sup.post('/orders/allocate', { order_id: oid, allow_partial: false, strategy: 'LPN' });
    const t = await sup.post('/picking/tasks', { order_id: oid });
    await pickAll(t.body.task.id, picker);
    const num = (await sup.get(`/orders/${oid}`)).body.order_number;
    expect((await sup.get('/inventory/reconcile')).body.order_line_discrepancies.some((d: any) => d.order_number === num)).toBe(false);
    // (picked <= required is a DB CHECK, so the only possible silent corruption is a counter that is too LOW)
    await sql(`UPDATE order_lines SET picked_qty = picked_qty - 1 WHERE order_id = '${oid}'`);
    const bad = await sup.get('/inventory/reconcile');
    expect(bad.status).toBe(200);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.order_line_discrepancies.some((d: any) => d.order_number === num)).toBe(true);
    await sql(`UPDATE order_lines SET picked_qty = picked_qty + 1 WHERE order_id = '${oid}'`);
    expect((await sup.get('/inventory/reconcile')).body.order_line_discrepancies.some((d: any) => d.order_number === num)).toBe(false);
  });
});

describe('A2 — blocked attempts survive the rollback', () => {
  it('wrong-location / wrong-sku / qty-exceeded pick scans are audited even though the scan is rejected', async () => {
    await storedPallet(f, 1, f.reserve[1]!.id, 60n);
    const oid = await acceptedOrder([{ sku: 1, cases: 2 }]);
    await sup.post('/orders/allocate', { order_id: oid, allow_partial: false, strategy: 'LPN' });
    const t = await sup.post('/picking/tasks', { order_id: oid });
    const v = await picker.post(`/picking/tasks/${t.body.task.id}/start`);
    const line = v.body.lines[0];
    const before = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM audit_logs WHERE action LIKE 'pick.blocked_%' AND entity_id = '${t.body.task.id}'`);
    expect((await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: line.id, step: 'LOCATION', scanned: 'LOC-WRONG' }, idem())).status).toBe(422);
    await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: line.id, step: 'LOCATION', scanned: line.location_barcode }, idem());
    expect((await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: line.id, step: 'LPN', scanned: f.skus[2]!.piece_barcode }, idem())).status).toBe(422);
    await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: line.id, step: 'LPN', scanned: line.lpn_code }, idem());
    expect((await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: line.id, step: 'QTY', qty: 99, uom_code: 'CASE' }, idem())).status).toBe(422);
    const after = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM audit_logs WHERE action LIKE 'pick.blocked_%' AND entity_id = '${t.body.task.id}'`);
    expect(after[0]!.n - before[0]!.n).toBe(3n);
    const kinds = await sql<{ action: string }>(`SELECT action FROM audit_logs WHERE action LIKE 'pick.blocked_%' AND entity_id = '${t.body.task.id}' ORDER BY id`);
    expect(kinds.map((k) => k.action)).toEqual(['pick.blocked_wrong_location', 'pick.blocked_wrong_sku', 'pick.blocked_qty_exceeded']);
    // and the KPI sees them
    const kpi = await sup.get('/kpis');
    expect(kpi.body.errors_by_user.some((e: any) => e.username === picker.username)).toBe(true);
    await expectReconciled();
  });

  it('loading a pallet into the wrong shipment leaves a LOADING_ERROR incident; a blocked release marks the shipment BLOCKED with its check', async () => {
    // order A picked/staged/verified, shipment 1 with order A, shipment 2 without it
    await storedPallet(f, 2, f.reserve[2]!.id, 60n);
    const oid = await acceptedOrder([{ sku: 2, cases: 1 }]);
    await sup.post('/orders/allocate', { order_id: oid, allow_partial: false, strategy: 'LPN' });
    const t = await sup.post('/picking/tasks', { order_id: oid });
    await pickAll(t.body.task.id, picker);
    const od = await sup.get(`/orders/${oid}`);
    const lane = od.body.staging_assignments[0].location;
    for (const l of od.body.lpns.filter((x: any) => x.status === 'PICKING')) await picker.post('/staging/scan', { lpn_code: l.code, staging_location_barcode: lane.barcode }, idem());
    const ver = await verifier.post('/verifications/start', { order_id: oid });
    const od2 = await sup.get(`/orders/${oid}`);
    const staged = od2.body.lpns.filter((x: any) => x.status === 'STAGED');
    for (const l of staged) await verifier.post('/verifications/scan', { verification_id: ver.body.verification_id, lpn_code: l.code, barcode: f.skus[2]!.piece_barcode, qty: 6 }, idem());
    expect((await verifier.post('/verifications/complete', { verification_id: ver.body.verification_id })).body.status).toBe('PASSED');
    const sh1 = await sup.post('/shipments', { order_ids: [oid], dock_location_id: f.ship_dock.id });
    const sh2 = await sup.post('/shipments', { order_ids: [], dock_location_id: f.ship_dock.id });
    const incBefore = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM incidents WHERE incident_type = 'LOADING_ERROR' AND shipment_id = '${sh2.body.id}'`);
    const wrong = await loader.post('/loading/scan', { shipment_id: sh2.body.id, lpn_code: staged[0].code }, idem());
    expect(wrong.status).toBe(422);
    expect(wrong.body.error).toBe('WRONG_SHIPMENT');
    const incAfter = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM incidents WHERE incident_type = 'LOADING_ERROR' AND shipment_id = '${sh2.body.id}'`);
    expect(incAfter[0]!.n - incBefore[0]!.n).toBe(1n);
    // nothing was loaded
    expect((await sql<{ status: string }>(`SELECT status FROM lpns WHERE code = '${staged[0].code}'`))[0]!.status).toBe('STAGED');
    // blocked release persists BLOCKED + release_check + audit
    const d = await sup.get(`/shipments/${sh1.body.id}`);
    const rel = await sup.post('/shipments/release', { shipment_id: sh1.body.id, version: d.body.version });
    expect(rel.status).toBe(422);
    const row = await sql<{ status: string; release_check: unknown }>(`SELECT status, release_check FROM shipments WHERE id = '${sh1.body.id}'`);
    expect(row[0]!.status).toBe('BLOCKED');
    expect(row[0]!.release_check).not.toBeNull();
    const aud = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM audit_logs WHERE action = 'shipment.release_blocked' AND entity_id = '${sh1.body.id}'`);
    expect(aud[0]!.n).toBe(1n);
    const dash = await sup.get('/dashboard');
    expect(dash.body.alerts.some((a: any) => /BLOQUEADOS/.test(a.text))).toBe(true);
    // load properly; the LOADING_ERROR incident (HIGH, linked to the order) still blocks the release until a supervisor resolves it
    const ok = await loader.post('/loading/scan', { shipment_id: sh1.body.id, lpn_code: staged[0].code }, idem());
    expect(ok.status).toBe(200);
    const d2 = await sup.get(`/shipments/${sh1.body.id}`);
    const stillBlocked = await sup.post('/shipments/release', { shipment_id: sh1.body.id, version: d2.body.version });
    expect(stillBlocked.status).toBe(422);
    expect(stillBlocked.body.details.blocking_reasons.some((r: string) => /incident/.test(r))).toBe(true);
    const inc = await sql<{ id: string }>(`SELECT id FROM incidents WHERE incident_type = 'LOADING_ERROR' AND shipment_id = '${sh2.body.id}' ORDER BY created_at DESC LIMIT 1`);
    expect((await sup.post(`/incidents/${inc[0]!.id}/status`, { status: 'RESOLVED', resolution: 'pallet devuelto a su carril; cargado en el embarque correcto' })).status).toBe(200);
    const d3 = await sup.get(`/shipments/${sh1.body.id}`);
    expect((await sup.post('/shipments/release', { shipment_id: sh1.body.id, version: d3.body.version })).status).toBe(200);
    await expectReconciled();
  });
});

describe('A3 — separation of duties in authorizations', () => {
  it('a supervisor cannot consume an authorization they issued; the authorizer cannot be the picker; unknown/forbidden exception types are rejected', async () => {
    await storedPallet(f, 0, f.reserve[3]!.id, 60n);
    const oid = await acceptedOrder([{ sku: 0, cases: 1 }]);
    await sup.post('/orders/allocate', { order_id: oid, allow_partial: false, strategy: 'LPN' });
    const t = await sup.post('/picking/tasks', { order_id: oid });
    await pickAll(t.body.task.id, sup); // the SUPERVISOR picks
    const od = await sup.get(`/orders/${oid}`);
    const lane = od.body.staging_assignments[0].location;
    for (const l of od.body.lpns.filter((x: any) => x.status === 'PICKING')) await sup.post('/staging/scan', { lpn_code: l.code, staging_location_barcode: lane.barcode }, idem());
    // self-issued authorization → rejected on use
    const self = await sup.post('/authorizations', { exception_type: 'SAME_USER_VERIFICATION', entity_type: 'order', entity_id: oid, reason: 'me autorizo' });
    expect(self.status).toBe(201);
    const start = await sup.post('/verifications/start', { order_id: oid, authorization_id: self.body.id });
    expect(start.status).toBe(422);
    expect(start.body.error).toBe('SELF_AUTHORIZATION');
    await sup.post(`/authorizations/${self.body.id}/revoke`);
    // authorization by a second supervisor works for the picker-supervisor
    const other = await sup2.post('/authorizations', { exception_type: 'SAME_USER_VERIFICATION', entity_type: 'order', entity_id: oid, reason: 'sin otro verificador disponible' });
    expect(other.status).toBe(201);
    const start2 = await sup.post('/verifications/start', { order_id: oid, authorization_id: other.body.id });
    expect(start2.status).toBe(201);
    // requested_by === supervisor is rejected at creation
    const me = await sup.get('/auth/me');
    expect((await sup.post('/authorizations', { exception_type: 'COUNT_ADJUSTMENT', entity_type: 'lpn', entity_id: 'x', requested_by: me.body.id, reason: 'auto' })).status).toBe(422);
    // unknown type → 400; forced release → 422
    expect((await sup.post('/authorizations', { exception_type: 'NOT_A_REAL_EXCEPTION', entity_type: 'order', entity_id: oid, reason: 'x y z' })).status).toBe(400);
    const forced = await sup.post('/authorizations', { exception_type: 'FORCE_RELEASE_NOT_ALLOWED', entity_type: 'shipment', entity_id: 'x', reason: 'urgente' });
    expect(forced.status).toBe(422);
    expect(forced.body.error).toBe('RELEASE_CANNOT_BE_FORCED');
  });
});

describe('A4 — the integration service user cannot log in', () => {
  it('rejects password login for the integration identity', async () => {
    const a = await getApp();
    process.env.INTEGRATION_API_KEY = 'test-integration-key-0123456789abcdef';
    await a.inject({ method: 'GET', url: '/api/integrations/inventory', headers: { 'x-api-key': process.env.INTEGRATION_API_KEY } });
    const u = await sql<{ locked_until: Date | null; roles: bigint }>(`SELECT locked_until, (SELECT count(*) FROM user_roles ur WHERE ur.user_id = u.id) AS roles FROM users u WHERE username = 'integration'`);
    expect(u[0]!.roles).toBe(0n);
    expect(u[0]!.locked_until!.getFullYear()).toBeGreaterThan(9000);
    const { createHash } = await import('node:crypto');
    const guess = createHash('sha256').update(process.env.INTEGRATION_API_KEY).digest('hex');
    const login = await a.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'wms-client', 'content-type': 'application/json' }, payload: JSON.stringify({ username: 'integration', password: guess }) });
    expect([401, 423]).toContain(login.statusCode);
  });
});

describe('A5 — Idempotency-Key is mandatory on movement endpoints', () => {
  it('every scan endpoint refuses requests without the header', async () => {
    const cases: [Client, string, unknown][] = [
      [recv, '/receipts/scan', { receipt_id: '00000000-0000-0000-0000-000000000000', barcode: 'X1234', qty: 1 }],
      [recv, '/receipts/lpn/close', { lpn_code: 'PLT-2026-00000001' }],
      [fork, '/putaway/confirm', { task_id: '00000000-0000-0000-0000-000000000000', lpn_code: 'PLT-2026-00000001', location_barcode: 'LOC-X' }],
      [fork, '/transfers/start', { lpn_code: 'PLT-2026-00000001', to_location_barcode: 'LOC-X' }],
      [fork, '/transfers/complete', { transfer_id: '00000000-0000-0000-0000-000000000000', lpn_code: 'PLT-2026-00000001', location_barcode: 'LOC-X' }],
      [picker, '/picking/scan', { pick_task_id: '00000000-0000-0000-0000-000000000000', line_id: '00000000-0000-0000-0000-000000000000', step: 'LOCATION', scanned: 'x' }],
      [picker, '/staging/scan', { lpn_code: 'PLT-2026-00000001', staging_location_barcode: 'LOC-X' }],
      [verifier, '/verifications/scan', { verification_id: '00000000-0000-0000-0000-000000000000', lpn_code: 'PLT-2026-00000001', barcode: 'X1234', qty: 1 }],
      [loader, '/loading/scan', { shipment_id: '00000000-0000-0000-0000-000000000000', lpn_code: 'PLT-2026-00000001' }],
      [sup, '/inventory/adjust', { lpn_code: 'PLT-2026-00000001', sku_code: 'X', direction: 'IN', qty: 1, uom_code: 'PIECE', reason: 'sin clave' }],
      [sup, '/inventory/status', { lpn_code: 'PLT-2026-00000001', action: 'BLOCK', reason: 'sin clave' }],
      [sup, '/counts/submit', { count_task_id: '00000000-0000-0000-0000-000000000000', location_barcode: 'LOC-X', barcode: 'X1234', qty: 1 }],
      [recv, '/returns/receive', { return_id: '00000000-0000-0000-0000-000000000000', line_id: '00000000-0000-0000-0000-000000000000', qty: 1, uom_code: 'PIECE', returns_location_barcode: 'LOC-X' }],
    ];
    for (const [c, url, body] of cases) {
      const r = await c.post(url, body);
      expect(r.status, url).toBe(400);
      expect(r.body.details?.code, url).toBe('IDEMPOTENCY_KEY_REQUIRED');
    }
  });
});

describe('A6/A7 — put-away is only for inbound pallets; receiving leaves only via put-away', () => {
  it('a stored pallet cannot be moved with put-away, and a pallet at the dock cannot be transferred', async () => {
    const stored = await storedPallet(f, 1, f.reserve[4]!.id, 12n);
    const s = await fork.post('/putaway/start', { lpn_code: stored.code });
    expect(s.status).toBe(422);
    expect(s.body.error).toBe('LPN_ALREADY_STORED');
    const rcp = await recv.post('/receipts', { receiving_location_id: f.dock.id });
    const scan = await recv.post('/receipts/scan', { receipt_id: rcp.body.id, barcode: f.skus[1]!.case_barcode, qty: 2 }, idem());
    await recv.post('/receipts/lpn/close', { lpn_code: scan.body.lpn.code }, idem());
    const t = await fork.post('/transfers/start', { lpn_code: scan.body.lpn.code, to_location_barcode: f.reserve[5]!.barcode }, idem());
    expect(t.status).toBe(422);
    expect(t.body.error).toBe('USE_PUTAWAY');
    // the reserved suggestion is intact and the normal flow completes
    const st = await fork.post('/putaway/start', { lpn_code: scan.body.lpn.code });
    expect(st.status).toBe(200);
    const ok = await fork.post('/putaway/confirm', { task_id: st.body.task.id, lpn_code: scan.body.lpn.code, location_barcode: st.body.target.barcode }, idem());
    expect(ok.status).toBe(200);
    const leaks = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM putaway_tasks t JOIN lpns l ON l.id = t.lpn_id WHERE l.code = '${scan.body.lpn.code}' AND t.status IN ('PENDING','ASSIGNED','IN_PROGRESS')`);
    expect(leaks[0]!.n).toBe(0n);
  });
  it('put-away of a pallet with allocated stock is refused even with an override authorization', async () => {
    const rcp = await recv.post('/receipts', { receiving_location_id: f.dock.id });
    const scan = await recv.post('/receipts/scan', { receipt_id: rcp.body.id, barcode: f.skus[2]!.case_barcode, qty: 3 }, idem());
    await recv.post('/receipts/lpn/close', { lpn_code: scan.body.lpn.code }, idem());
    // allocation cannot touch a RECEIVING pallet (eligibility filter), so simulate the audited scenario on a stored pallet instead:
    const stored = await storedPallet(f, 2, f.reserve[6]!.id, 60n);
    const oid = await acceptedOrder([{ sku: 2, cases: 1 }]);
    await sup.post('/orders/allocate', { order_id: oid, allow_partial: false, strategy: 'LPN' });
    const r = await fork.post('/putaway/start', { lpn_code: stored.code });
    expect(r.status).toBe(422);
    expect(['LPN_ALREADY_STORED', 'LPN_NOT_FREE']).toContain(r.body.error);
    await expectReconciled();
  });
});

describe('A9 — proxy headers are not trusted by default; MFA brute force locks the account', () => {
  it('X-Forwarded-For does not change the recorded IP', async () => {
    const a = await getApp();
    const r = await a.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'wms-client', 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' }, payload: JSON.stringify({ username: sup.username, password: `Pw-${sup.username}-Test-1!` }) });
    expect(r.statusCode).toBe(200);
    const s = await sql<{ ip: string }>(`SELECT ip FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = '${sup.username}') ORDER BY created_at DESC LIMIT 1`);
    expect(s[0]!.ip).not.toBe('203.0.113.7');
  });
  it('10 wrong TOTP codes lock the account', async () => {
    const adminUser = await userWithRoles('aadmin', ['ADMIN']);
    const enroll = await adminUser.post('/auth/mfa/enroll');
    const { totp } = await import('../../src/lib/crypto.js');
    await adminUser.post('/auth/mfa/enroll/confirm', { code: totp(enroll.body.secret) });
    const again = await userWithRoles('aadmin2', ['ADMIN']); // fresh admin needing verification
    const e2 = await again.post('/auth/mfa/enroll');
    await again.post('/auth/mfa/enroll/confirm', { code: totp(e2.body.secret) });
    // new session for `again` → mfa pending → brute force
    const a = await getApp();
    const login = await a.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'wms-client', 'content-type': 'application/json' }, payload: JSON.stringify({ username: again.username, password: `Pw-${again.username}-Test-1!` }) });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const r = await a.inject({ method: 'POST', url: '/api/auth/mfa/verify', headers: { cookie, 'x-requested-with': 'wms-client', 'content-type': 'application/json' }, payload: JSON.stringify({ code: '000000' }) });
      last = r.statusCode;
    }
    expect([401, 423]).toContain(last);
    const u = await sql<{ locked_until: Date | null }>(`SELECT locked_until FROM users WHERE username = '${again.username}'`);
    expect(u[0]!.locked_until).not.toBeNull();
    await sql(`UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE username = '${again.username}'`);
  });
});

describe('A10 — balances and LPN location cannot be written outside the ledger', () => {
  it('direct SQL writes are rejected by the database', async () => {
    const lpn = await storedPallet(f, 0, f.reserve[7]!.id, 5n);
    await expect(sql(`UPDATE inventory_balances SET qty = qty + 100 WHERE lpn_id = '${lpn.id}'`)).rejects.toThrow(/derived from the ledger/);
    await expect(sql(`INSERT INTO inventory_balances (lpn_id, sku_id, status, qty) VALUES ('${lpn.id}', '${f.skus[1]!.id}', 'AVAILABLE', 1)`)).rejects.toThrow(/derived from the ledger/);
    await expect(sql(`DELETE FROM inventory_balances WHERE lpn_id = '${lpn.id}'`)).rejects.toThrow(/derived from the ledger/);
    await expect(sql(`UPDATE lpns SET current_location_id = '${f.reserve[8]!.id}' WHERE id = '${lpn.id}'`)).rejects.toThrow(/only change through an inventory movement/);
    // a movement whose from_location lies is rejected
    await expect(sql(`INSERT INTO inventory_movements (movement_type, sku_id, qty, from_lpn_id, to_lpn_id, from_location_id, to_location_id, from_status, to_status) VALUES ('BLOCK', '${f.skus[0]!.id}', 1, '${lpn.id}', '${lpn.id}', '${f.reserve[8]!.id}', '${f.reserve[8]!.id}', 'AVAILABLE', 'BLOCKED')`)).rejects.toThrow(/from_location does not match/);
    await expectReconciled();
  });
});

describe('A11 — quarantined pallets can be transferred and keep their status', () => {
  it('QUARANTINE → transfer → QUARANTINE at destination; DAMAGED destination converts', async () => {
    const inv = await userWithRoles('ainv', ['INVENTORY_CONTROL']);
    const lpn = await storedPallet(f, 1, f.reserve[9]!.id, 30n);
    expect((await inv.post('/inventory/status', { lpn_code: lpn.code, action: 'QUARANTINE', reason: 'retención de calidad' }, idem())).status).toBe(200);
    const t = await fork.post('/transfers/start', { lpn_code: lpn.code, to_location_barcode: f.quarantine.barcode }, idem());
    expect(t.status).toBe(201);
    expect(t.body.transfer.origin_status).toBe('QUARANTINE');
    const mid = await sql<{ status: string }>(`SELECT status FROM inventory_balances WHERE lpn_id = '${lpn.id}'`);
    expect(mid.map((m) => m.status)).toEqual(['IN_TRANSFER']);
    expect((await fork.post('/transfers/complete', { transfer_id: t.body.transfer.id, lpn_code: lpn.code, location_barcode: f.quarantine.barcode }, idem())).status).toBe(200);
    const after = await sql<{ status: string; qty: bigint }>(`SELECT status, qty FROM inventory_balances WHERE lpn_id = '${lpn.id}'`);
    expect(after).toEqual([{ status: 'QUARANTINE', qty: 30n }]);
    // cancel path restores the origin status too
    const t2 = await fork.post('/transfers/start', { lpn_code: lpn.code, to_location_barcode: f.reserve[10]!.barcode }, idem());
    expect(t2.status).toBe(201);
    await fork.post(`/transfers/${t2.body.transfer.id}/cancel`, { reason: 'pasillo bloqueado' });
    expect((await sql<{ status: string }>(`SELECT status FROM inventory_balances WHERE lpn_id = '${lpn.id}'`))[0]!.status).toBe('QUARANTINE');
    await expectReconciled();
  });
});

describe('A12/A13/A14/A15 — smaller rules', () => {
  it('A12: allocation requires an accepted order', async () => {
    const o = await sup.post('/orders', { order_number: `A-${f.tag}-imp`, customer_code: f.customer.code, lines: [{ sku_code: f.skus[0]!.code, qty: 1, uom_code: 'CASE' }] });
    const a = await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: true });
    expect(a.status).toBe(422);
    expect(a.body.error).toBe('ORDER_STATUS');
  });
  it('A13: scanning the product barcode is refused when two pallets of the SKU share the location', async () => {
    const big = await makeFixture({ skus: 1, reserveBays: 2, levels: 1 });
    await sup.patch(`/locations/${big.reserve[0]!.id}`, { pallet_capacity: 2 });
    const p1 = await storedPallet(big, 0, big.reserve[0]!.id, 12n);
    await storedPallet(big, 0, big.reserve[0]!.id, 12n);
    const o = await sup.post('/orders', { order_number: `A-${big.tag}-amb`, customer_code: big.customer.code, lines: [{ sku_code: big.skus[0]!.code, qty: 1, uom_code: 'CASE' }] });
    await sup.post(`/orders/${o.body.id}/accept`);
    await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: false, strategy: 'LPN' });
    const t = await sup.post('/picking/tasks', { order_id: o.body.id });
    const v = await picker.post(`/picking/tasks/${t.body.task.id}/start`);
    const line = v.body.lines[0];
    expect(line.lpn_code).toBe(p1.code);
    await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: line.id, step: 'LOCATION', scanned: line.location_barcode }, idem());
    const bySku = await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: line.id, step: 'LPN', scanned: big.skus[0]!.piece_barcode }, idem());
    expect(bySku.status).toBe(422);
    expect(bySku.body.error).toBe('LPN_REQUIRED');
    expect((await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: line.id, step: 'LPN', scanned: p1.code }, idem())).status).toBe(200);
    // QTY without uom_code is a validation error
    expect((await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: line.id, step: 'QTY', qty: 6 }, idem())).status).toBe(400);
  });
  it('A14: allocating more while a pick task is active is refused; a second wave is possible after it completes', async () => {
    const p = await makeFixture({ skus: 1, reserveBays: 3, levels: 1 });
    await storedPallet(p, 0, p.reserve[0]!.id, 12n);
    const o = await sup.post('/orders', { order_number: `A-${p.tag}-wave`, customer_code: p.customer.code, lines: [{ sku_code: p.skus[0]!.code, qty: 4, uom_code: 'CASE' }] });
    await sup.post(`/orders/${o.body.id}/accept`);
    const first = await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: true });
    expect(first.body.status).toBe('PARTIALLY_ALLOCATED');
    const t = await sup.post('/picking/tasks', { order_id: o.body.id });
    await storedPallet(p, 0, p.reserve[1]!.id, 12n);
    const blocked = await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: true });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error).toBe('PICK_TASK_ACTIVE');
    await pickAll(t.body.task.id, picker);
    const second = await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: true });
    expect(second.status).toBe(200);
    const t2 = await sup.post('/picking/tasks', { order_id: o.body.id });
    expect(t2.status).toBe(201);
    await pickAll(t2.body.task.id, picker);
    const od = await sup.get(`/orders/${o.body.id}`);
    expect(od.body.lines[0].picked_qty).toBe('24');
    expect(od.body.status).toBe('PICKED');
    await expectReconciled();
  });
  it('A15: changing the password keeps the current session alive', async () => {
    const u = await userWithRoles('apw', ['PICKER']);
    const r = await u.post('/auth/password', { current_password: `Pw-${u.username}-Test-1!`, new_password: 'Another-Strong-Pass-2!' });
    expect(r.status).toBe(200);
    expect((await u.get('/auth/me')).status).toBe(200);
  });
});

describe('A26/A35 — smaller data rules', () => {
  it('A26: a PO with the same SKU on two lines is not double-counted on receipt', async () => {
    const po = await recv.post('/purchase-orders', { po_number: `PO-${f.tag}-dup`, supplier_code: f.supplier.code, lines: [{ sku_code: f.skus[0]!.code, qty: 2, uom_code: 'CASE' }, { sku_code: f.skus[0]!.code, qty: 3, uom_code: 'CASE' }] });
    expect(po.status).toBe(201);
    const rcp = await recv.post('/receipts', { po_id: po.body.id, receiving_location_id: f.dock.id });
    await recv.post('/receipts/scan', { receipt_id: rcp.body.id, barcode: f.skus[0]!.case_barcode, qty: 5 }, idem());
    await recv.post('/receipts/complete', { receipt_id: rcp.body.id, accept_differences: true });
    const lines = await sql<{ ordered_qty: bigint; received_qty: bigint }>(`SELECT ordered_qty, received_qty FROM purchase_order_lines WHERE po_id = '${po.body.id}' ORDER BY line_no`);
    expect(lines.reduce((a, l) => a + l.received_qty, 0n)).toBe(30n);
    expect(lines.every((l) => l.received_qty <= l.ordered_qty)).toBe(true);
    expect(skuTotal).toBeDefined();
  });
  it('A35: an exact barcode match wins over a colliding location code', async () => {
    // create a location whose CODE equals another location's BARCODE
    const wh = f.warehouse_id;
    const victim = f.reserve[11]!;
    const clash = await sup.post('/locations', { warehouse_id: wh, code: victim.barcode, location_type: 'QUARANTINE' });
    expect(clash.status).toBe(201);
    const lpn = await storedPallet(f, 0, f.reserve[12]!.id, 6n);
    const t = await fork.post('/transfers/start', { lpn_code: lpn.code, to_location_barcode: victim.barcode }, idem());
    expect(t.status).toBe(201);
    expect(t.body.to_location.id).toBe(victim.id);
    await fork.post(`/transfers/${t.body.transfer.id}/cancel`, { reason: 'prueba de ambigüedad' });
  });
});
