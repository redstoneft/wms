// USB print station: AGENT printers queue labels; the agent pulls them with its token and reports the result.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, getApp, makeFixture, sql, storedPallet, userWithRoles, type Client, type Fixture } from '../helpers.js';

let sup: Client;
let f: Fixture;
let printerId: string;
let token: string;
let lpn: string;

beforeAll(async () => {
  sup = await userWithRoles('agentsup', ['SUPERVISOR']);
  f = await makeFixture({ skus: 1 });
  const p = await storedPallet(f, 0, f.reserve[0]!.id, 12n);
  lpn = p.code;
});
afterAll(closeApp);

const agent = async (method: 'GET' | 'POST', url: string, tok: string, body?: unknown) => {
  const a = await getApp();
  const r = await a.inject({ method, url: `/api${url}`, headers: { 'x-agent-token': tok, 'x-agent-host': 'PC-ETIQUETAS', ...(body ? { 'content-type': 'application/json' } : {}) }, payload: body ? JSON.stringify(body) : undefined });
  return { status: r.statusCode, body: r.json() };
};

describe('USB print station (print agent)', () => {
  it('an AGENT printer gets a one-time token; printing to it queues the label instead of opening TCP', async () => {
    const c = await sup.post('/printers', { code: `USB-${f.tag}`, name: 'Zebra GK420T en PC etiquetas', host: 'estacion-usb', mode: 'AGENT', is_default: false });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    printerId = c.body.id;
    const t = await sup.post(`/printers/${printerId}/agent-token`);
    expect(t.status).toBe(200);
    token = t.body.token;
    expect(token).toMatch(/^wmsp_/);
    const hash = await sql<{ h: string | null }>(`SELECT agent_token_hash AS h FROM printers WHERE id = '${printerId}'`);
    expect(hash[0]!.h).not.toBe(token); // only the hash is stored
    const p = await sup.post('/labels/print', { label_type: 'LPN', entity_id: lpn, printer_id: printerId });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.status).toBe('QUEUED');
  });

  it('the agent authenticates with the token (never a cookie), claims the job and reports it printed', async () => {
    expect((await agent('GET', '/print-agent/ping', 'wmsp_wrong-token-xxxxxxxx')).status).toBe(401);
    const ping = await agent('GET', '/print-agent/ping', token);
    expect(ping.status).toBe(200);
    expect(ping.body.queued).toBe(1);
    const jobs = await agent('GET', '/print-agent/jobs?limit=5', token);
    expect(jobs.status).toBe(200);
    expect(jobs.body.jobs).toHaveLength(1);
    const job = jobs.body.jobs[0];
    expect(job.zpl).toContain('^XA');
    expect(job.entity).toBe(lpn);
    // claimed: not handed out twice
    expect((await agent('GET', '/print-agent/jobs', token)).body.jobs).toHaveLength(0);
    const res = await agent('POST', `/print-agent/jobs/${job.id}/result`, token, { ok: true });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SENT');
    const row = await sql<{ status: string; sent_at: Date | null }>(`SELECT status, sent_at FROM label_prints WHERE id = '${job.id}'`);
    expect(row[0]!.status).toBe('SENT');
    expect(row[0]!.sent_at).not.toBeNull();
    const pr = await sup.get('/printers');
    const mine = pr.body.find((x: { id: string }) => x.id === printerId);
    expect(mine.agent_host).toBe('PC-ETIQUETAS');
    expect(mine.agent_last_seen_at).toBeTruthy();
  });

  it('a claimed job the station never confirmed goes back to the queue; a failure is recorded with its error', async () => {
    const p = await sup.post('/labels/print', { label_type: 'LPN', entity_id: lpn, printer_id: printerId, reprint_reason: 'prueba de estación' });
    expect(p.status).toBe(200);
    const jobs = await agent('GET', '/print-agent/jobs', token);
    expect(jobs.body.jobs).toHaveLength(1);
    const id = jobs.body.jobs[0].id;
    await sql(`UPDATE label_prints SET claimed_at = now() - interval '5 minutes' WHERE id = '${id}'`);
    const again = await agent('GET', '/print-agent/jobs', token);
    expect(again.body.jobs.map((j: { id: string }) => j.id)).toEqual([id]);
    const fail = await agent('POST', `/print-agent/jobs/${id}/result`, token, { ok: false, error: 'Zebra sin papel' });
    expect(fail.body.status).toBe('FAILED');
    const row = await sql<{ status: string; error: string | null }>(`SELECT status, error FROM label_prints WHERE id = '${id}'`);
    expect(row[0]).toEqual({ status: 'FAILED', error: 'Zebra sin papel' });
  });
});
