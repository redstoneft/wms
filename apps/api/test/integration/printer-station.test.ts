// The station launcher is downloadable from the WMS with the current token; downloading again does not rotate it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, getApp, makeFixture, userWithRoles, type Client, type Fixture } from '../helpers.js';

let sup: Client;
let picker: Client;
let f: Fixture;
beforeAll(async () => {
  sup = await userWithRoles('stsup', ['SUPERVISOR']);
  picker = await userWithRoles('stpick', ['PICKER']);
  f = await makeFixture({ skus: 1 });
});
afterAll(closeApp);

describe('print station launcher download', () => {
  it('serves estacion_wms.bat with a working token, keeps the token across downloads, and only rotates when the office asks', async () => {
    const pr = await sup.post('/printers', { code: `S${f.tag}`.slice(0, 20), name: `Estacion ${f.tag}`, host: 'pc-zebra', mode: 'AGENT' });
    expect(pr.status, JSON.stringify(pr.body)).toBe(201);
    const a = await getApp();
    const dl = async (c: Client) => a.inject({ method: 'GET', url: `/api/printers/${pr.body.id}/station.bat`, headers: { cookie: c.cookie, 'x-requested-with': 'wms-client' } });
    const first = await dl(picker);
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-disposition']).toContain('estacion_wms.bat');
    const token = /WMS_PRINT_TOKEN=(wmsp_[A-Za-z0-9_-]+)/.exec(first.body)?.[1];
    expect(token).toBeTruthy();
    expect(first.body).toContain('pythonw wms_print_agent.py');
    // the token in the file is the one the station uses
    const ping = await a.inject({ method: 'GET', url: '/api/print-agent/ping', headers: { 'x-agent-token': token!, 'x-agent-host': 'pc-test', 'x-requested-with': 'wms-agent' } });
    expect(ping.statusCode, ping.body).toBe(200);
    // a second download keeps the same token (the running station is not killed)
    const second = await dl(sup);
    expect(/WMS_PRINT_TOKEN=(wmsp_[A-Za-z0-9_-]+)/.exec(second.body)?.[1]).toBe(token);
    // an explicit rotation from the office changes it, and the download follows
    const rot = await sup.post(`/printers/${pr.body.id}/agent-token`);
    expect(rot.status).toBe(200);
    expect(rot.body.token).not.toBe(token);
    const third = await dl(picker);
    expect(/WMS_PRINT_TOKEN=(wmsp_[A-Za-z0-9_-]+)/.exec(third.body)?.[1]).toBe(rot.body.token);
    const old = await a.inject({ method: 'GET', url: '/api/print-agent/ping', headers: { 'x-agent-token': token!, 'x-agent-host': 'pc-test', 'x-requested-with': 'wms-agent' } });
    expect(old.statusCode).toBe(401);
  });
});
