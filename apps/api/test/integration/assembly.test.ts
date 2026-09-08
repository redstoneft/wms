// Assembly orders: components on one pallet become finished product on several new pallets; the ledger stays balanced per SKU.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, expectReconciled, idem, makeFixture, skuTotal, sql, storedPallet, userWithRoles, type Client, type Fixture } from '../helpers.js';

let sup: Client;
let forklift: Client;
let f: Fixture;

beforeAll(async () => {
  sup = await userWithRoles('asmsup', ['SUPERVISOR']);
  forklift = await userWithRoles('asmfk', ['FORKLIFT']);
  f = await makeFixture({ skus: 3 });
});
afterAll(closeApp);

const BODY = 0; // component: pan bodies (masters of 24)
const PAN = 1; // finished: assembled pans (cases of 12)

describe('assembly orders (armado)', () => {
  it('288 bodies on one pallet → 288 pans on three pallets of 8 cases × 12; source pallet CONSUMED, put-away tasks created', async () => {
    const body = await storedPallet(f, BODY, f.reserve[0]!.id, 288n); // 12 masters × 24
    const before = await skuTotal(f.skus[PAN]!.id);
    const r = await sup.post(
      '/assembly',
      {
        station_barcode: f.staging[0]!.barcode,
        inputs: [{ lpn_code: body.code, sku_code: f.skus[BODY]!.code, qty: 288 }],
        output: { sku_code: f.skus[PAN]!.code, pallets: [{ cases: 8, pieces_per_case: 12 }, { cases: 8, pieces_per_case: 12 }, { cases: 8, pieces_per_case: 12 }] },
        notes: 'prueba',
      },
      idem(),
    );
    expect(r.status).toBe(201);
    expect(r.body.code).toMatch(/^ASM-\d{4}-\d{6}$/);
    expect(r.body.produced).toHaveLength(3);
    expect(r.body.produced.every((p: { qty: string }) => p.qty === '96')).toBe(true);
    expect(r.body.consumed[0].lpn_status).toBe('CONSUMED');
    expect(r.body.warnings).toEqual([]);

    // ledger: bodies gone from the source pallet, pans present on three new pallets, each at the station
    const left = await sql<{ t: bigint | null }>(`SELECT COALESCE(sum(qty),0)::bigint AS t FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id WHERE l.code = '${body.code}'`);
    expect(left[0]!.t).toBe(0n);
    expect((await skuTotal(f.skus[PAN]!.id)) - before).toBe(288n);
    const outLpns = await sql<{ code: string; status: string; loc: string; cases_count: number }>(
      `SELECT l.code, l.status, loc.code AS loc, l.cases_count FROM lpns l JOIN locations loc ON loc.id = l.current_location_id WHERE l.code = ANY($1::text[])`,
      [r.body.produced.map((p: { lpn: string }) => p.lpn)],
    );
    expect(outLpns).toHaveLength(3);
    expect(outLpns.every((l) => l.loc === f.staging[0]!.code && l.cases_count === 8)).toBe(true);
    // movements: one ASSEMBLY_OUT, three ASSEMBLY_IN (recorded in cases with the row packing factor)
    const mv = await sql<{ movement_type: string; n: bigint }>(`SELECT movement_type, count(*) AS n FROM inventory_movements WHERE reference_id = '${r.body.id}' GROUP BY movement_type`);
    expect(Object.fromEntries(mv.map((m) => [m.movement_type, Number(m.n)]))).toEqual({ ASSEMBLY_OUT: 1, ASSEMBLY_IN: 3 });
    const inMv = await sql<{ uom_code: string; uom_qty: bigint }>(`SELECT uom_code, uom_qty FROM inventory_movements WHERE reference_id = '${r.body.id}' AND movement_type = 'ASSEMBLY_IN' LIMIT 1`);
    expect(inMv[0]).toEqual({ uom_code: 'CASE', uom_qty: 8n });
    // one put-away task per new pallet
    const tasks = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM putaway_tasks t JOIN lpns l ON l.id = t.lpn_id WHERE l.code = ANY($1::text[]) AND t.status = 'PENDING'`, [outLpns.map((l) => l.code)]);
    expect(tasks[0]!.n).toBe(3n);
    const aud = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM audit_logs WHERE action = 'assembly.completed' AND entity_id = '${r.body.id}'`);
    expect(aud[0]!.n).toBe(1n);
    await expectReconciled();

    // history
    const list = await sup.get('/assembly?limit=5');
    expect(list.status).toBe(200);
    expect(list.body[0].code).toBe(r.body.code);
    expect(list.body[0].outputs).toHaveLength(3);
  });

  it('a 1:1 conversion must balance: the difference has to be declared as scrap (which opens an incident)', async () => {
    const body = await storedPallet(f, BODY, f.reserve[1]!.id, 48n);
    const base = { station_barcode: f.staging[0]!.barcode, inputs: [{ lpn_code: body.code, sku_code: f.skus[BODY]!.code, qty: 48 }] };
    const bad = await sup.post('/assembly', { ...base, output: { sku_code: f.skus[PAN]!.code, pallets: [{ cases: 3, pieces_per_case: 12 }] } }, idem());
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe('ASSEMBLY_UNBALANCED');
    // nothing moved
    const still = await sql<{ t: bigint | null }>(`SELECT COALESCE(sum(qty),0)::bigint AS t FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id WHERE l.code = '${body.code}'`);
    expect(still[0]!.t).toBe(48n);

    const ok = await sup.post('/assembly', { ...base, output: { sku_code: f.skus[PAN]!.code, pallets: [{ cases: 3, pieces_per_case: 12 }] }, scrap: { qty: 12, reason: 'cuerpos con golpe, no se pudieron armar' } }, idem());
    expect(ok.status).toBe(201);
    expect(ok.body.scrap_qty).toBe('12');
    expect(ok.body.incident_id).toBeTruthy();
    const inc = await sql<{ incident_type: string; qty: bigint }>(`SELECT incident_type, qty FROM incidents WHERE id = '${ok.body.incident_id}'`);
    expect(inc[0]).toEqual({ incident_type: 'DAMAGED', qty: 12n });
    await expectReconciled();
  });

  it('partial consumption leaves the rest on the source pallet; the same request twice is replayed, not repeated', async () => {
    const body = await storedPallet(f, BODY, f.reserve[2]!.id, 240n);
    const req = { station_barcode: f.staging[0]!.barcode, inputs: [{ lpn_code: body.code, sku_code: f.skus[BODY]!.code, qty: 96 }], output: { sku_code: f.skus[PAN]!.code, pallets: [{ cases: 8, pieces_per_case: 12 }] } };
    const key = idem();
    const a = await sup.post('/assembly', req, key);
    const b = await sup.post('/assembly', req, key);
    expect(a.status).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.code).toBe(a.body.code);
    expect(a.body.consumed[0].lpn_status).toBe('STORED');
    const left = await sql<{ t: bigint | null }>(`SELECT COALESCE(sum(qty),0)::bigint AS t FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id WHERE l.code = '${body.code}'`);
    expect(left[0]!.t).toBe(144n);
  });

  it('rejects: more than available, a rack position as station, and roles without the permission', async () => {
    const body = await storedPallet(f, BODY, f.reserve[3]!.id, 24n);
    const tooMany = await sup.post('/assembly', { station_barcode: f.staging[0]!.barcode, inputs: [{ lpn_code: body.code, sku_code: f.skus[BODY]!.code, qty: 48 }], output: { sku_code: f.skus[PAN]!.code, pallets: [{ cases: 4, pieces_per_case: 12 }] } }, idem());
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error).toBe('INSUFFICIENT_INVENTORY');
    const rack = await sup.post('/assembly', { station_barcode: f.reserve[4]!.barcode, inputs: [{ lpn_code: body.code, sku_code: f.skus[BODY]!.code, qty: 24 }], output: { sku_code: f.skus[PAN]!.code, pallets: [{ cases: 2, pieces_per_case: 12 }] } }, idem());
    expect(rack.status).toBe(422);
    expect(rack.body.error).toBe('STATION_IS_RACK');
    const forbidden = await forklift.post('/assembly', { station_barcode: f.staging[0]!.barcode, inputs: [{ lpn_code: body.code, sku_code: f.skus[BODY]!.code, qty: 24 }], output: { sku_code: f.skus[PAN]!.code, pallets: [{ cases: 2, pieces_per_case: 12 }] } }, idem());
    expect(forbidden.status).toBe(403);
    const untouched = await sql<{ t: bigint | null }>(`SELECT COALESCE(sum(qty),0)::bigint AS t FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id WHERE l.code = '${body.code}'`);
    expect(untouched[0]!.t).toBe(24n);
  });

  it('REPACK: bodies and assembled pans share the SKU — blocked bodies (so picking never takes them) become 2 available pallets of cases of 12; stock unchanged', async () => {
    const bodies = await storedPallet(f, 2, f.reserve[5]!.id, 24n); // one master of 24, same SAE key as the finished pan
    const before = await skuTotal(f.skus[2]!.id);
    const blk = await sup.post('/inventory/status', { lpn_code: bodies.code, action: 'BLOCK', reason: 'cuerpos sin armar: no surtir' }, idem());
    expect(blk.status).toBe(200);
    const r = await sup.post(
      '/assembly',
      { station_barcode: f.staging[0]!.barcode, inputs: [{ lpn_code: bodies.code, sku_code: f.skus[2]!.code, qty: 24 }], output: { sku_code: f.skus[2]!.code, pallets: [{ cases: 1, pieces_per_case: 12 }, { cases: 1, pieces_per_case: 12 }] } },
      idem(),
    );
    expect(r.status).toBe(201);
    expect(r.body.mode).toBe('REPACK');
    expect(r.body.produced).toHaveLength(2);
    expect(r.body.consumed[0].lpn_status).toBe('CONSUMED');
    expect(await skuTotal(f.skus[2]!.id)).toBe(before); // same SKU: nothing created or lost
    const avail = await sql<{ t: bigint | null }>(`SELECT COALESCE(sum(b.qty),0)::bigint AS t FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id WHERE l.code = ANY($1::text[]) AND b.status = 'AVAILABLE'`, [r.body.produced.map((p: { lpn: string }) => p.lpn)]);
    expect(avail[0]!.t).toBe(24n);
    const outMv = await sql<{ from_status: string; qty: bigint }>(`SELECT from_status, qty FROM inventory_movements WHERE reference_id = '${r.body.id}' AND movement_type = 'ASSEMBLY_OUT'`);
    expect(outMv).toEqual([{ from_status: 'BLOCKED', qty: 24n }]);
    await expectReconciled();
  });
});
