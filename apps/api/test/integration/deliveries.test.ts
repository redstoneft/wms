// Delivery calendar: kept from the handheld by any operator; a read-only board link feeds the TV without a session.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, getApp, makeFixture, userWithRoles, type Client, type Fixture } from '../helpers.js';

let f: Fixture;
let picker: Client;
let sup: Client;

beforeAll(async () => {
  f = await makeFixture({ skus: 1 });
  picker = await userWithRoles('delpick', ['PICKER']);
  sup = await userWithRoles('delsup', ['SUPERVISOR']);
});
afterAll(closeApp);

const plus = (d: number) => new Date(Date.now() + d * 86400_000).toISOString().slice(0, 10);

describe('delivery calendar', () => {
  it('operators add, edit, finish and cancel deliveries; the list is the upcoming board', async () => {
    const c = await picker.post('/deliveries', { title: 'Coppel', customer_code: f.customer.code, delivery_date: plus(3), delivery_time: '09:00', notes: 'Nave 1 5:00pm · Sta. Bárbara 8:00am' });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const w = await picker.post('/deliveries', { title: 'Walmart', delivery_date: plus(3) });
    expect(w.status).toBe(201);
    const old = await picker.post('/deliveries', { title: 'Control', delivery_date: plus(-2) }); // overdue, still shown
    expect(old.status).toBe(201);
    const bad = await picker.post('/deliveries', { title: 'X', delivery_date: '2026-13-40' });
    expect(bad.status).toBe(400);
    const list = await picker.get('/deliveries?days=10');
    expect(list.status).toBe(200);
    const titles = list.body.map((d: { title: string }) => d.title);
    expect(titles).toEqual(expect.arrayContaining(['Coppel', 'Walmart', 'Control']));
    expect(list.body.find((d: { title: string }) => d.title === 'Control').overdue).toBe(true);
    const u = await picker.patch(`/deliveries/${c.body.id}`, { delivery_time: '10:30', status: 'DONE' });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    expect(u.body.delivery_time).toBe('10:30');
    const del = await picker.del(`/deliveries/${w.body.id}`);
    expect(del.status).toBe(200);
    const after = await picker.get('/deliveries?days=10');
    expect(after.body.some((d: { id: string }) => d.id === w.body.id)).toBe(false);
    expect(after.body.find((d: { id: string }) => d.id === c.body.id).status).toBe('DONE');
  });

  it('the TV board reads with its link token only (no session); a supervisor issues and revokes links', async () => {
    const denied = await picker.post('/deliveries/board-link', { name: 'TV' });
    expect(denied.status).toBe(403);
    const link = await sup.post('/deliveries/board-link', { name: 'TV bodega' });
    expect(link.status, JSON.stringify(link.body)).toBe(201);
    expect(link.body.token).toMatch(/^wmsb_/);
    const a = await getApp();
    const ok = await a.inject({ method: 'GET', url: `/api/board/deliveries?k=${link.body.token}&days=10` });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.board).toBe('TV bodega');
    expect(body.items.some((d: { title: string }) => d.title === 'Coppel')).toBe(true);
    const wrong = await a.inject({ method: 'GET', url: '/api/board/deliveries?k=wmsb_not-a-real-token-value' });
    expect(wrong.statusCode).toBe(403);
    await sup.del(`/deliveries/board-links/${link.body.id}`);
    const revoked = await a.inject({ method: 'GET', url: `/api/board/deliveries?k=${link.body.token}` });
    expect(revoked.statusCode).toBe(403);
  });
});
