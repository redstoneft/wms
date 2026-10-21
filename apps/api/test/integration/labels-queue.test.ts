// The print queue can be seen and emptied from any device (any role that prints).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeFixture, sql, storedPallet, userWithRoles, type Client, type Fixture } from '../helpers.js';

let f: Fixture;
let sup: Client;
let picker: Client;
beforeAll(async () => {
  f = await makeFixture({ skus: 1 });
  sup = await userWithRoles('lqsup', ['SUPERVISOR']);
  picker = await userWithRoles('lqpick', ['PICKER']);
});
afterAll(closeApp);

describe('print queue', () => {
  it('shows what waits per printer and empties it (cancelled, audited)', async () => {
    const pr = await sup.post('/printers', { code: `Q${f.tag}`.slice(0, 20), name: `Cola ${f.tag}`, host: 'estacion-cola', mode: 'AGENT' });
    expect(pr.status, JSON.stringify(pr.body)).toBe(201);
    const lpn = await storedPallet(f, 0, f.reserve[0]!.id, 10n);
    for (let i = 0; i < 2; i++) {
      const p = await sup.post('/labels/print', { label_type: 'LPN', entity_id: lpn.code, printer_id: pr.body.id, reprint_reason: 'prueba de cola', force: i > 0 });
      expect(p.status, JSON.stringify(p.body)).toBe(200);
    }
    const q1 = await picker.get('/labels/queue');
    expect(q1.status).toBe(200);
    expect(q1.body.printers.find((p: { printer_id: string }) => p.printer_id === pr.body.id)).toMatchObject({ queued: 2, printing: 0 });
    const c = await picker.post('/labels/queue/clear', { printer_id: pr.body.id });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.cancelled).toBe(2);
    expect((await picker.get('/labels/queue')).body.printers.find((p: { printer_id: string }) => p.printer_id === pr.body.id)).toBeUndefined();
    const st = await sql<{ status: string }>(`SELECT status FROM label_prints WHERE printer_id = '${pr.body.id}'`);
    expect(st.map((r) => r.status)).toEqual(['CANCELLED', 'CANCELLED']);
    const au = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM audit_logs WHERE action = 'labels.queue_cleared' AND entity_id = '${pr.body.id}'`);
    expect(Number(au[0]!.n)).toBe(1);
  });

  it('the same label is not queued twice within the window unless the caller insists', async () => {
    const pr = await sup.post('/printers', { code: `D${f.tag}`.slice(0, 20), name: `Dup ${f.tag}`, host: 'estacion-dup', mode: 'AGENT' });
    expect(pr.status).toBe(201);
    const lpn = await storedPallet(f, 0, f.reserve[3]!.id, 5n);
    const first = await sup.post('/labels/print', { label_type: 'LPN', entity_id: lpn.code, printer_id: pr.body.id });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.status).toBe('QUEUED');
    const again = await sup.post('/labels/print', { label_type: 'LPN', entity_id: lpn.code, printer_id: pr.body.id });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ duplicate: true, pending: true, print_id: first.body.print_id });
    expect((await sql<{ n: bigint }>(`SELECT count(*) AS n FROM label_prints WHERE entity_id = $1 AND status = 'QUEUED'`, [lpn.code]))[0]!.n).toBe(1n);
    const forced = await sup.post('/labels/print', { label_type: 'LPN', entity_id: lpn.code, printer_id: pr.body.id, force: true });
    expect(forced.status).toBe(200);
    expect(forced.body.duplicate).toBeUndefined();
    expect((await sql<{ n: bigint }>(`SELECT count(*) AS n FROM label_prints WHERE entity_id = $1 AND status = 'QUEUED'`, [lpn.code]))[0]!.n).toBe(2n);
  });
});
