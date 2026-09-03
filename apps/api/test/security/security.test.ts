// SECURITY (OWASP-oriented): authz bypass, IDOR, privilege escalation, injection,
// CSRF, brute force / lockout, session handling, malicious imports.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, getApp, idem, makeFixture, sql, storedPallet, userWithRoles, type Client, type Fixture } from '../helpers.js';

let f: Fixture;
let picker: Client;
let sup: Client;

beforeAll(async () => {
  f = await makeFixture({ skus: 2 });
  picker = await userWithRoles('spick', ['PICKER']);
  sup = await userWithRoles('ssup', ['SUPERVISOR']);
});
afterAll(async () => {
  await closeApp();
});

describe('authentication', () => {
  it('rejects anonymous access to every non-public route', async () => {
    const a = await getApp();
    for (const url of ['/api/auth/me', '/api/dashboard', '/api/inventory/lpns', '/api/orders', '/api/users', '/api/map', '/api/audit', '/api/metrics']) {
      const r = await a.inject({ method: 'GET', url });
      expect([401, 403], url).toContain(r.statusCode);
    }
  });
  it('locks the account after repeated failures and does not reveal whether the user exists', async () => {
    const a = await getApp();
    const bad = (u: string) => a.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'wms-client', 'content-type': 'application/json' }, payload: JSON.stringify({ username: u, password: 'wrong-password-1!' }) });
    const r1 = await bad(picker.username);
    const r2 = await bad('does-not-exist');
    expect(r1.statusCode).toBe(401);
    expect(r2.statusCode).toBe(401);
    expect(JSON.parse(r1.body).message).toBe(JSON.parse(r2.body).message);
    for (let i = 0; i < 10; i++) await bad(picker.username);
    const locked = await bad(picker.username);
    expect(locked.statusCode).toBe(423);
    // unlock via supervisor? only users.manage → create tadmin via direct SQL reset for the rest of tests
    await sql(`UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE username = '${picker.username}'`);
  });
  it('a tampered or random cookie is not a session', async () => {
    const a = await getApp();
    const r = await a.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: 'wms_session=abc.def' } });
    expect(r.statusCode).toBe(401);
    const tampered = picker.cookie.slice(0, -3) + 'xyz';
    const r2 = await a.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: tampered } });
    expect(r2.statusCode).toBe(401);
  });
  it('logout revokes the session server-side', async () => {
    const c = await userWithRoles('slogout', ['PICKER']);
    expect((await c.get('/auth/me')).status).toBe(200);
    await c.post('/auth/logout');
    expect((await c.get('/auth/me')).status).toBe(401);
  });
  it('ADMIN role cannot operate without MFA (mfa pending blocks every permission)', async () => {
    const adminUser = await userWithRoles('sadmin', ['ADMIN']);
    const me = await adminUser.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.mfa_pending).toBe(true);
    expect(me.body.mfa_enrollment_required).toBe(true);
    const users = await adminUser.get('/users');
    expect(users.status).toBe(403);
    expect(users.body.details.code).toBe('MFA_REQUIRED');
    // enroll
    const enroll = await adminUser.post('/auth/mfa/enroll');
    expect(enroll.status).toBe(200);
    const { totp } = await import('../../src/lib/crypto.js');
    const bad = await adminUser.post('/auth/mfa/enroll/confirm', { code: '000000' });
    expect(bad.status).toBe(401);
    const ok = await adminUser.post('/auth/mfa/enroll/confirm', { code: totp(enroll.body.secret) });
    expect(ok.status).toBe(200);
    expect((await adminUser.get('/users')).status).toBe(200);
  });
});

describe('CSRF', () => {
  it('mutations without the custom header are rejected even with a valid session', async () => {
    const a = await getApp();
    const r = await a.inject({ method: 'POST', url: '/api/orders/allocate', headers: { cookie: sup.cookie, 'content-type': 'application/json' }, payload: '{}' });
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.body).details.code).toBe('CSRF');
  });
  it('mutations from a foreign Origin are rejected', async () => {
    const a = await getApp();
    const r = await a.inject({ method: 'POST', url: '/api/orders/allocate', headers: { cookie: sup.cookie, 'x-requested-with': 'wms-client', origin: 'https://evil.example', 'content-type': 'application/json' }, payload: '{}' });
    expect(r.statusCode).toBe(403);
  });
  it('session cookie is HttpOnly, SameSite=Strict and signed', async () => {
    const a = await getApp();
    const r = await a.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'wms-client', 'content-type': 'application/json' }, payload: JSON.stringify({ username: sup.username, password: `Pw-${sup.username}-Test-1!` }) });
    const sc = String(r.headers['set-cookie']);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Strict/i);
  });
});

describe('authorization / IDOR / privilege escalation', () => {
  it('a picker cannot release shipments, adjust inventory, manage users or read audit', async () => {
    expect((await picker.post('/shipments/release', { shipment_id: '00000000-0000-0000-0000-000000000000', version: 1 })).status).toBe(403);
    expect((await picker.post('/inventory/adjust', { lpn_code: 'PLT-2026-00000001', sku_code: 'X', direction: 'IN', qty: 1, uom_code: 'PIECE', reason: 'hack attempt' })).status).toBe(403);
    expect((await picker.get('/users')).status).toBe(403);
    expect((await picker.get('/audit')).status).toBe(403);
    expect((await picker.post('/users', { username: 'evil', full_name: 'e', password: 'Password-123456!', roles: ['ADMIN'] })).status).toBe(403);
    expect((await picker.post('/authorizations', { exception_type: 'SAME_USER_VERIFICATION', entity_type: 'order', entity_id: 'x', reason: 'self-approve' })).status).toBe(403);
    expect((await picker.put('/settings', { allocation_strategy: 'LPN' })).status).toBe(403);
  });
  it('a picker cannot act on another picker\'s task (IDOR on task ids)', async () => {
    const other = await userWithRoles('spick2', ['PICKER']);
    await storedPallet(f, 0, f.reserve[0]!.id, 60n);
    const o = await sup.post('/orders', { order_number: `S-${f.tag}-1`, customer_code: f.customer.code, lines: [{ sku_code: f.skus[0]!.code, qty: 1, uom_code: 'CASE' }] });
    await sup.post(`/orders/${o.body.id}/accept`);
    await sup.post('/orders/allocate', { order_id: o.body.id, allow_partial: false });
    const t = await sup.post('/picking/tasks', { order_id: o.body.id });
    await other.post(`/picking/tasks/${t.body.task.id}/start`);
    const view = await other.get(`/picking/tasks/${t.body.task.id}`);
    const r = await picker.post('/picking/scan', { pick_task_id: t.body.task.id, line_id: view.body.lines[0].id, step: 'LOCATION', scanned: view.body.lines[0].location_barcode }, idem());
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('NOT_YOUR_TASK');
  });
  it('a user cannot deactivate themselves or grant unknown roles', async () => {
    const adminUser = await userWithRoles('sadmin2', ['ADMIN']);
    const enroll = await adminUser.post('/auth/mfa/enroll');
    const { totp } = await import('../../src/lib/crypto.js');
    await adminUser.post('/auth/mfa/enroll/confirm', { code: totp(enroll.body.secret) });
    const me = await adminUser.get('/auth/me');
    expect((await adminUser.patch(`/users/${me.body.id}`, { is_active: false })).status).toBe(422);
    expect((await adminUser.post('/users', { username: 'x1', full_name: 'x', password: 'Password-123456!', roles: ['SUPERUSER'] })).status).toBe(400);
  });
});

describe('injection & malformed input', () => {
  it('SQL injection attempts in search parameters are harmless', async () => {
    for (const q of [`' OR 1=1 --`, `"; DROP TABLE skus; --`, `%' UNION SELECT password_hash FROM users --`, `\\`, `'; select pg_sleep(1); --`]) {
      const r = await sup.get(`/skus?q=${encodeURIComponent(q)}`);
      expect(r.status).toBe(200);
      const r2 = await sup.get(`/inventory/lpns?q=${encodeURIComponent(q)}`);
      expect(r2.status).toBe(200);
      const r3 = await sup.get(`/locations?q=${encodeURIComponent(q)}`);
      expect(r3.status).toBe(200);
    }
    const tables = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 'skus'`);
    expect(tables[0]!.n).toBe(1n);
  });
  it('injection in scanned barcodes / LPN codes is rejected or not found, never executed', async () => {
    const recv = await userWithRoles('srecv', ['RECEIVING']);
    const rcp = await recv.post('/receipts', { receiving_location_id: f.dock.id });
    for (const bc of [`'; DROP TABLE lpns; --`, `PLT-2026-00000001' OR '1'='1`, `<script>alert(1)</script>`, `${'A'.repeat(500)}`]) {
      const r = await recv.post('/receipts/scan', { receipt_id: rcp.body.id, barcode: bc, qty: 1 }, idem());
      expect([400, 404]).toContain(r.status);
    }
    const fk = await userWithRoles('sfork', ['FORKLIFT']);
    const r = await fk.post('/putaway/start', { lpn_code: `' OR 1=1 --` });
    expect(r.status).toBe(404);
  });
  it('rejects negative / zero / huge / non-integer quantities and unknown fields', async () => {
    const recv = await userWithRoles('srecv2', ['RECEIVING']);
    const rcp = await recv.post('/receipts', { receiving_location_id: f.dock.id });
    for (const qty of [0, -1, 1.5, '1e3', 'abc', 10 ** 15, null]) {
      const r = await recv.post('/receipts/scan', { receipt_id: rcp.body.id, barcode: f.skus[0]!.case_barcode, qty }, idem());
      expect(r.status, `qty=${qty}`).toBe(400);
    }
  });
  it('oversized bodies and invalid JSON are rejected', async () => {
    const a = await getApp();
    const r = await a.inject({ method: 'POST', url: '/api/orders', headers: { cookie: sup.cookie, 'x-requested-with': 'wms-client', 'content-type': 'application/json' }, payload: '{ not json' });
    expect(r.statusCode).toBe(400);
    const big = JSON.stringify({ order_number: 'X', customer_code: 'Y', lines: Array.from({ length: 200000 }, () => ({ sku_code: 'A', qty: 1 })) });
    const r2 = await a.inject({ method: 'POST', url: '/api/orders', headers: { cookie: sup.cookie, 'x-requested-with': 'wms-client', 'content-type': 'application/json' }, payload: big });
    expect([400, 413]).toContain(r2.statusCode);
  });
  it('malicious import files: formulas, injection, wrong types, duplicate rows → rejected with row errors, nothing applied', async () => {
    const a = await getApp();
    const csv = `sku,description,case_qty,pallet_cases\n=cmd|' /C calc'!A0,desc,6,40\nSKU-OK-${f.tag},'; DROP TABLE skus;--,abc,40\nSKU-DUP,dup,6,40\nSKU-DUP,dup,6,40\n`;
    const boundary = 'xxB';
    const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skus.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`;
    const r = await a.inject({ method: 'POST', url: '/api/imports?type=SKUS&mode=APPLY', headers: { cookie: sup.cookie, 'x-requested-with': 'wms-client', 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.status).toBe('REJECTED');
    expect(body.errors.length).toBeGreaterThanOrEqual(2); // structural errors reported first (per row), then referential
    const created = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM skus WHERE code IN ('SKU-DUP', 'SKU-OK-${f.tag}')`);
    expect(created[0]!.n).toBe(0n);
  });
  it('unsupported upload types are rejected (photo endpoint)', async () => {
    const a = await getApp();
    const inc = await sup.post('/incidents', { incident_type: 'OTHER', title: 'security test incident' });
    const boundary = 'xxC';
    const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="evil.php"\r\nContent-Type: application/x-php\r\n\r\n<?php echo 1; ?>\r\n--${boundary}--\r\n`;
    const r = await a.inject({ method: 'POST', url: `/api/incidents/${inc.body.id}/photos`, headers: { cookie: sup.cookie, 'x-requested-with': 'wms-client', 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    expect(r.statusCode).toBe(422);
    // declared png but not a png
    const payload2 = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\nContent-Type: image/png\r\n\r\nnot really a png\r\n--${boundary}--\r\n`;
    const r2 = await a.inject({ method: 'POST', url: `/api/incidents/${inc.body.id}/photos`, headers: { cookie: sup.cookie, 'x-requested-with': 'wms-client', 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: payload2 });
    expect(r2.statusCode).toBe(422);
  });
});

describe('audit & secrets', () => {
  it('audit log never stores passwords or secrets', async () => {
    const rows = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM audit_logs WHERE (before::text ILIKE '%password_hash%' AND before::text NOT ILIKE '%REDACTED%') OR (after::text ILIKE '%Pw-%Test-1!%')`);
    expect(rows[0]!.n).toBe(0n);
  });
  it('error responses never leak stack traces', async () => {
    const r = await sup.get('/inventory/lpns/PLT-0000-00000000');
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toMatch(/at .*\.ts:\d+/);
  });
});

describe('MFA: dispositivo de confianza (recordar 30 días)', () => {
  it('a remembered browser skips the second factor; revocation and other users restore it', async () => {
    const { getApp, sql, userWithRoles } = await import('../helpers.js');
    const { totp } = await import('../../src/lib/crypto.js');
    const app = await getApp();
    const admin = await userWithRoles('tdadmin', ['ADMIN']);
    // enrol MFA (ADMIN requires it)
    const enroll = await admin.post('/auth/mfa/enroll');
    await admin.post('/auth/mfa/enroll/confirm', { code: totp(enroll.body.secret) });
    const secret: string = enroll.body.secret;
    const uname = admin.username;
    const pw = `Pw-${uname}-Test-1!`;
    const H = { 'x-requested-with': 'wms-client', 'content-type': 'application/json' };
    const cookiesOf = (r: { headers: Record<string, unknown> }) => ([] as string[]).concat((r.headers['set-cookie'] as string[] | string | undefined) ?? []).map((c) => c.split(';')[0]!);

    // 1) fresh login → MFA required
    const l1 = await app.inject({ method: 'POST', url: '/api/auth/login', headers: H, payload: JSON.stringify({ username: uname, password: pw }) });
    expect(l1.statusCode).toBe(200);
    expect(l1.json().mfa_required).toBe(true);
    const sess1 = cookiesOf(l1).find((c) => c.startsWith('wms_session='))!;
    // 2) verify with remember_device → trusted cookie issued
    const v = await app.inject({ method: 'POST', url: '/api/auth/mfa/verify', headers: { ...H, cookie: sess1 }, payload: JSON.stringify({ code: totp(secret), remember_device: true }) });
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ device_remembered: true, trusted_days: 30 });
    const trusted = cookiesOf(v).find((c) => c.startsWith('wms_trusted='))!;
    expect(trusted).toBeTruthy();
    const rawSetCookie = String(([] as string[]).concat(v.headers['set-cookie'] as string[]).find((c) => c.startsWith('wms_trusted=')));
    expect(rawSetCookie).toMatch(/HttpOnly/i);
    expect(rawSetCookie).toMatch(/Max-Age=2592000/); // 30 days
    // 3) login again WITH the trusted cookie → no MFA, permissions granted immediately
    const l2 = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...H, cookie: trusted }, payload: JSON.stringify({ username: uname, password: pw }) });
    expect(l2.json()).toMatchObject({ mfa_required: false, mfa_via_trusted_device: true });
    expect(l2.json().user.permissions.length).toBeGreaterThan(0);
    const sess2 = cookiesOf(l2).find((c) => c.startsWith('wms_session='))!;
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { ...H, cookie: sess2 } });
    expect(me.json().mfa_pending).toBe(false);
    // 4) the trusted cookie is bound to the user: another MFA user cannot use it
    const other = await userWithRoles('tdadmin2', ['ADMIN']);
    const e2 = await other.post('/auth/mfa/enroll');
    await other.post('/auth/mfa/enroll/confirm', { code: totp(e2.body.secret) });
    const l3 = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...H, cookie: trusted }, payload: JSON.stringify({ username: other.username, password: `Pw-${other.username}-Test-1!` }) });
    expect(l3.json().mfa_required).toBe(true);
    // 5) the device is listed and can be revoked → MFA required again
    const list = await app.inject({ method: 'GET', url: '/api/auth/devices', headers: { ...H, cookie: sess2 } });
    expect(list.json()).toHaveLength(1);
    const del = await app.inject({ method: 'DELETE', url: `/api/auth/devices/${list.json()[0].id}`, headers: { ...H, cookie: `${sess2}; ${trusted}` } });
    expect(del.json().revoked).toBe(1);
    const l4 = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...H, cookie: trusted }, payload: JSON.stringify({ username: uname, password: pw }) });
    expect(l4.json().mfa_required).toBe(true);
    // 6) an expired trust is ignored
    const v2 = await app.inject({ method: 'POST', url: '/api/auth/mfa/verify', headers: { ...H, cookie: cookiesOf(l4).find((c) => c.startsWith('wms_session='))! }, payload: JSON.stringify({ code: totp(secret), remember_device: true }) });
    const trusted2 = cookiesOf(v2).find((c) => c.startsWith('wms_trusted='))!;
    await sql(`UPDATE trusted_devices SET expires_at = now() - interval '1 minute' WHERE revoked_at IS NULL`);
    const l5 = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...H, cookie: trusted2 }, payload: JSON.stringify({ username: uname, password: pw }) });
    expect(l5.json().mfa_required).toBe(true);
    // 7) changing the password wipes remembered devices
    const l6s = cookiesOf(l5).find((c) => c.startsWith('wms_session='))!;
    await app.inject({ method: 'POST', url: '/api/auth/mfa/verify', headers: { ...H, cookie: l6s }, payload: JSON.stringify({ code: totp(secret), remember_device: true }) });
    const before = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM trusted_devices WHERE revoked_at IS NULL AND expires_at > now()`);
    expect(before[0]!.n).toBeGreaterThanOrEqual(1n);
    const pc = await app.inject({ method: 'POST', url: '/api/auth/password', headers: { ...H, cookie: l6s }, payload: JSON.stringify({ current_password: pw, new_password: `Pw-${uname}-Test-2!` }) });
    expect(pc.statusCode).toBe(200);
    const after = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM trusted_devices t JOIN users u ON u.id = t.user_id WHERE u.username = '${uname}' AND t.revoked_at IS NULL`);
    expect(after[0]!.n).toBe(0n);
  });
});
