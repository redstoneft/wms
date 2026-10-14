import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, expectReconciled, getApp, makeFixture, sql, storedPallet, userWithRoles, type Client, type Fixture } from '../helpers.js';
import { withTx } from '../../src/db.js';
import { createInventory, lockLpn } from '../../src/inventory/ledger.js';
import { SYSTEM_ACTOR } from '../../src/lib/context.js';

let f: Fixture;
let sup: Client;

async function upload(csv: string, q: Record<string, string>) {
  const a = await getApp();
  const boundary = `----wms${Date.now()}`;
  const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="conteo-${Date.now()}-${Math.random()}.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`;
  const qs = new URLSearchParams(q).toString();
  const r = await a.inject({ method: 'POST', url: `/api/counts/import?${qs}`, headers: { cookie: sup.cookie, 'x-requested-with': 'wms-client', 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
  return { status: r.statusCode, body: r.json() };
}

beforeAll(async () => {
  f = await makeFixture({ skus: 3, reserveBays: 6, levels: 1 });
  sup = await userWithRoles('cntimp', ['SUPERVISOR']);
});
afterAll(closeApp);

describe('physical count imported from a spreadsheet', () => {
  it('previews, creates a task for approval, and never adjusts what moved after the count', async () => {
    const [A, B, C] = [f.reserve[0]!, f.reserve[1]!, f.reserve[2]!];
    const pa = await storedPallet(f, 0, A.id, 100n);
    const pb = await storedPallet(f, 1, B.id, 50n);
    await storedPallet(f, 0, C.id, 30n);
    const countedAt = new Date();
    await new Promise((r) => setTimeout(r, 20));
    // AFTER the count: 5 more pieces arrive on pallet B (a put-away, a split, anything in the ledger)
    await withTx(async (tx) => {
      const lpn = await lockLpn(tx, pb.id);
      await createInventory(tx, SYSTEM_ACTOR, { movement_type: 'ADJUST_IN', to_lpn: lpn, sku_id: f.skus[1]!.id, qty: 5n, status: 'AVAILABLE', location_id: B.id, reason: 'after count' });
    });
    const csv = `ubicacion,sku,cantidad\n${A.code},${f.skus[0]!.code},90\n${B.code},${f.skus[1]!.code},50\n${f.reserve[3]!.code},${f.skus[2]!.code},12\n`;
    const v = await upload(csv, { mode: 'VALIDATE', counted_at: countedAt.toISOString() });
    expect(v.status).toBe(200);
    expect(v.body.task_id).toBeNull();
    expect(v.body.errors).toEqual([]);
    const byKey = (loc: string, sku: string) => v.body.lines.find((l: any) => l.location === loc && l.sku === sku);
    expect(byKey(A.code, f.skus[0]!.code)).toMatchObject({ lpn: pa.code, system: '100', counted: '90', variance: '-10', moved_since_count: false });
    expect(byKey(B.code, f.skus[1]!.code)).toMatchObject({ lpn: pb.code, system: '55', counted: '50', moved_since_count: true });
    expect(byKey(f.reserve[3]!.code, f.skus[2]!.code)).toMatchObject({ lpn: null, system: '0', counted: '12' });
    expect(byKey(C.code, f.skus[0]!.code)).toBeUndefined(); // not listed, not a full count: out of scope
    expect(v.body.summary).toMatchObject({ lines: 3, variances: 3, moved_since_count: 1, new_pallets: 1, not_found: 0 });
    // nothing was written by the preview
    expect((await sql<{ n: bigint }>(`SELECT count(*) AS n FROM count_tasks WHERE count_type = 'IMPORT' AND scope->'location_ids' ? $1`, [A.id]))[0]!.n).toBe(0n);

    const ap = await upload(csv, { mode: 'APPLY', counted_at: countedAt.toISOString() });
    expect(ap.status).toBe(201);
    expect(ap.body.status).toBe('PENDING_APPROVAL');
    const taskId = ap.body.task_id as string;
    const view = await sup.get(`/counts/${taskId}`);
    expect(view.body.task.count_type).toBe('IMPORT');
    expect(view.body.lines).toHaveLength(3);

    const ok = await sup.post('/counts/approve', { count_task_id: taskId, decision: 'APPROVE', reason: 'conteo de prueba' });
    expect(ok.status).toBe(200);
    expect(ok.body.adjusted).toBe(2); // A down to 90, new pallet with 12
    expect(ok.body.skipped.map((s: any) => s.reason)).toEqual(['INVENTORY_MOVED_SINCE_COUNT']);
    expect(ok.body.created_lpns).toHaveLength(1);
    expect(ok.body.created_lpns[0]).toMatchObject({ location: f.reserve[3]!.code, sku: f.skus[2]!.code, qty: '12' });
    const bal = async (lpnId: string) => Number((await sql<{ q: unknown }>(`SELECT sum(qty) AS q FROM inventory_balances WHERE lpn_id = $1`, [lpnId]))[0]!.q);
    expect(await bal(pa.id)).toBe(90);
    expect(await bal(pb.id)).toBe(55); // untouched: it moved after the count
    expect(ok.body.status).toBe('RECOUNT');
    const born = (await sql<{ status: string; q: unknown }>(`SELECT l.status, (SELECT sum(qty) FROM inventory_balances b WHERE b.lpn_id = l.id) AS q FROM lpns l WHERE l.code = $1`, [ok.body.created_lpns[0].lpn]))[0]!;
    expect(born.status).toBe('STORED');
    expect(Number(born.q)).toBe(12);
    await expectReconciled();
  });

  it('full count: a stored pallet in the zone that is not in the file counts as not found; errors block APPLY', async () => {
    const D = f.reserve[4]!;
    const pd = await storedPallet(f, 2, D.id, 40n);
    const countedAt = new Date().toISOString();
    const csv = `ubicacion,sku,cantidad\n${f.reserve[5]!.code},${f.skus[2]!.code},7\n`;
    const v = await upload(csv, { mode: 'VALIDATE', counted_at: countedAt, full: 'true' });
    expect(v.status).toBe(200);
    const line = v.body.lines.find((l: any) => l.lpn === pd.code);
    expect(line).toMatchObject({ system: '40', counted: '0', variance: '-40' });
    expect(v.body.summary.not_found).toBeGreaterThanOrEqual(1);
    // unknown sku → error, APPLY refused
    const bad = await upload(`ubicacion,sku,cantidad\n${D.code},NO-EXISTE-XYZ,3\n`, { mode: 'VALIDATE', counted_at: countedAt });
    expect(bad.body.errors[0].message).toMatch(/SKU desconocido/);
    const refused = await upload(`ubicacion,sku,cantidad\n${D.code},NO-EXISTE-XYZ,3\n`, { mode: 'APPLY', counted_at: countedAt });
    expect(refused.status).toBe(422);
    // a count dated in the future is refused
    const future = await upload(csv, { mode: 'VALIDATE', counted_at: new Date(Date.now() + 3_600_000).toISOString() });
    expect(future.status).toBe(422);
    // missing columns
    const cols = await upload(`loc_x,producto_x,n\n${D.code},${f.skus[2]!.code},1\n`, { mode: 'VALIDATE', counted_at: countedAt });
    expect(cols.status).toBe(422);
  });
});
