// Office "Solicitudes": a picker's pallet re-receipt waits for a decision; the approver applies or rejects it; a stale one is never applied.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, expectReconciled, idem, makeFixture, sql, storedPallet, userWithRoles, type Client, type Fixture } from '../helpers.js';

let sup: Client;
let picker: Client;
let f: Fixture;
beforeAll(async () => {
  sup = await userWithRoles('reqsup', ['SUPERVISOR']);
  picker = await userWithRoles('reqpick', ['PICKER']);
  f = await makeFixture({ skus: 1, reserveBays: 4, levels: 1 });
});
afterAll(closeApp);

const qtyOn = async (lpnCode: string) => (await sql<{ q: bigint }>(`SELECT COALESCE(sum(b.qty),0)::bigint AS q FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id WHERE l.code = $1`, [lpnCode]))[0]!.q;
const rereceive = async (lpnCode: string, qty: number, purpose: string) => {
  const r = await picker.post('/wm/lpn-recount', { lpn_code: lpnCode, purpose, lines: [{ sku_code: f.skus[0]!.code, qty }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect(r.body.mode).toBe('COUNT');
  return r.body.task_id as string;
};

describe('staff requests (solicitudes)', () => {
  it('lists the re-receipt with the operator figures; approving applies it; pickers cannot see or decide', async () => {
    const p = await storedPallet(f, 0, f.reserve[0]!.id, 30n);
    const id = await rereceive(p.code, 28, 'faltan piezas al abrir');
    expect((await picker.get('/requests')).status).toBe(403);
    expect((await picker.post(`/requests/${id}/decide`, { decision: 'APPROVE', reason: 'yo mismo' })).status).toBe(403);

    const list = await sup.get('/requests');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const req = list.body.requests.find((r: { id: string }) => r.id === id);
    expect(req).toMatchObject({ kind: 'RE_RECEIPT', lpn: p.code, purpose: 'faltan piezas al abrir', requested_by_username: expect.stringContaining('reqpick'), applicable: true });
    expect(req.lines).toHaveLength(1);
    expect(req.lines[0]).toMatchObject({ sku: f.skus[0]!.code, system_qty: '30', proposed_qty: '28', delta: '-2', current_qty: '30', applicable: true });
    expect((await sup.get('/requests/pending')).body.pending).toBeGreaterThanOrEqual(1);

    const ok = await sup.post(`/requests/${id}/decide`, { decision: 'APPROVE', reason: 'revisado en piso' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'APPROVED', adjusted: 1 });
    expect(await qtyOn(p.code)).toBe(28n);
    const t = await sql<{ status: string; notes: string }>(`SELECT status, notes FROM count_tasks WHERE id = $1::uuid`, [id]);
    expect(t[0]!.status).toBe('APPROVED');
    expect(t[0]!.notes).toContain('faltan piezas al abrir');
    expect(t[0]!.notes).toContain('APROBADA');
    expect((await sup.get('/requests')).body.requests.some((r: { id: string }) => r.id === id)).toBe(false);
    // deciding twice is refused
    expect((await sup.post(`/requests/${id}/decide`, { decision: 'REJECT', reason: 'otra vez' })).body.error).toBe('REQUEST_STATUS');
    await expectReconciled();
  });

  it('rejecting leaves the inventory untouched and closes the request', async () => {
    const p = await storedPallet(f, 0, f.reserve[1]!.id, 40n);
    const id = await rereceive(p.code, 35, 'creo que faltan');
    const no = await sup.post(`/requests/${id}/decide`, { decision: 'REJECT', reason: 'se contó de nuevo y está completa' });
    expect(no.status, JSON.stringify(no.body)).toBe(200);
    expect(no.body.status).toBe('REJECTED');
    expect(await qtyOn(p.code)).toBe(40n);
    expect((await sql<{ status: string }>(`SELECT status FROM count_tasks WHERE id = $1::uuid`, [id]))[0]!.status).toBe('REJECTED');
  });

  it('a request whose pallet moved after the count is flagged and never applied', async () => {
    const p = await storedPallet(f, 0, f.reserve[2]!.id, 50n);
    const id = await rereceive(p.code, 45, 'faltante');
    // the pallet is relocated after the operator counted it
    const mv = await sup.post('/transfers/relocate', { lpn_code: p.code, location: f.reserve[3]!.code }, idem());
    expect(mv.status, JSON.stringify(mv.body)).toBe(200);
    const req = (await sup.get('/requests')).body.requests.find((r: { id: string }) => r.id === id);
    expect(req.applicable).toBe(false);
    expect(req.lines[0].why).toBeTruthy();
    const tried = await sup.post(`/requests/${id}/decide`, { decision: 'APPROVE', reason: 'intento' });
    expect(tried.status, JSON.stringify(tried.body)).toBe(200);
    expect(tried.body.status).not.toBe('APPROVED');
    expect(tried.body.adjusted).toBe(0);
    expect(await qtyOn(p.code)).toBe(50n);
    // still listed (flagged) until someone rejects it
    expect((await sup.get('/requests')).body.requests.some((r: { id: string }) => r.id === id)).toBe(true);
    expect((await sup.post(`/requests/${id}/decide`, { decision: 'REJECT', reason: 'vencida' })).body.status).toBe('REJECTED');
    await expectReconciled();
  });
});
