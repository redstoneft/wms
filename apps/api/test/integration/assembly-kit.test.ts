// Sets and batteries: a kit definition on the finished SKU makes the assembly check every component against the sets produced.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, expectReconciled, idem, makeFixture, skuTotal, sql, storedPallet, userWithRoles, type Client, type Fixture } from '../helpers.js';

let sup: Client;
let f: Fixture;
beforeAll(async () => {
  sup = await userWithRoles('kitsup', ['SUPERVISOR']);
  f = await makeFixture({ skus: 4, reserveBays: 4 });
});
afterAll(closeApp);

const A = 0, B = 1, C = 2, SET = 3;

describe('kits (sets / baterías)', () => {
  it('defines the components, reports the sets the stock allows, and refuses self, duplicates and nested kits', async () => {
    const skuId = (await sql<{ id: string }>(`SELECT id FROM skus WHERE code = $1`, [f.skus[SET]!.code]))[0]!.id;
    const bad = await sup.put(`/skus/${skuId}/kit`, { components: [{ sku_code: f.skus[SET]!.code, qty_per_kit: 1 }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe('KIT_SELF');
    const dup = await sup.put(`/skus/${skuId}/kit`, { components: [{ sku_code: f.skus[A]!.code, qty_per_kit: 1 }, { sku_code: f.skus[A]!.code, qty_per_kit: 2 }] });
    expect(dup.body.error).toBe('KIT_DUPLICATE');
    const ok = await sup.put(`/skus/${skuId}/kit`, { components: [{ sku_code: f.skus[A]!.code, qty_per_kit: 1 }, { sku_code: f.skus[B]!.code, qty_per_kit: 2 }, { sku_code: f.skus[C]!.code, qty_per_kit: 1 }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    await storedPallet(f, A, f.reserve[0]!.id, 50n);
    await storedPallet(f, B, f.reserve[1]!.id, 60n); // 2 per set → 30 sets
    await storedPallet(f, C, f.reserve[2]!.id, 45n);
    const spec = await sup.get(`/skus/${f.skus[SET]!.code}/kit`);
    expect(spec.status).toBe(200);
    expect(spec.body.is_kit).toBe(true);
    expect(spec.body.components.map((c: { sku_code: string; qty_per_kit: string }) => [c.sku_code, c.qty_per_kit])).toEqual([[f.skus[A]!.code, '1'], [f.skus[B]!.code, '2'], [f.skus[C]!.code, '1']]);
    expect(spec.body.max_sets).toBe('30');
    // a kit cannot be a component of another kit
    const otherId = (await sql<{ id: string }>(`SELECT id FROM skus WHERE code = $1`, [f.skus[A]!.code]))[0]!.id;
    const nested = await sup.put(`/skus/${otherId}/kit`, { components: [{ sku_code: f.skus[SET]!.code, qty_per_kit: 1 }] });
    expect(nested.body.error).toBe('KIT_NESTED');
  });

  it('assembles sets only when every component matches sets × pieces-per-set (surplus must be declared defective)', async () => {
    const a = await storedPallet(f, A, f.reserve[3]!.id, 20n);
    const b = await storedPallet(f, B, f.reserve[4]!.id, 40n);
    const c = await storedPallet(f, C, f.reserve[5]!.id, 22n);
    const body = (sets: number, cQty: number, defective = 0) => ({
      station_barcode: f.staging[0]!.barcode,
      inputs: [{ lpn_code: a.code, sku_code: f.skus[A]!.code, qty: 20 }, { lpn_code: b.code, sku_code: f.skus[B]!.code, qty: 40 }, { lpn_code: c.code, sku_code: f.skus[C]!.code, qty: cQty }],
      output: { sku_code: f.skus[SET]!.code, pallets: [{ cases: sets, pieces_per_case: 1, defective }] },
      notes: 'armar sets de prueba',
    });
    // 22 of C consumed for 20 sets without declaring the 2 extra as defective → unbalanced, with the per-component detail
    const unbalanced = await sup.post('/assembly', body(20, 22), idem());
    expect(unbalanced.status).toBe(422);
    expect(unbalanced.body.error).toBe('KIT_UNBALANCED');
    expect(unbalanced.body.details.components.find((d: { sku: string }) => d.sku === f.skus[C]!.code).surplus).toBe('2');
    // a product that is not part of the set is refused
    const foreign = await sup.post('/assembly', { ...body(20, 20), inputs: [...body(20, 20).inputs, { lpn_code: a.code, sku_code: f.skus[SET]!.code, qty: 1 }] }, idem());
    expect(['KIT_COMPONENT_UNKNOWN', 'MIXED_SAME_SKU']).toContain(foreign.body.error);
    // 20 sets, the 2 extra pieces of C declared defective → balanced; stock moves component → set
    const setBefore = await skuTotal(f.skus[SET]!.id);
    const r = await sup.post('/assembly', body(20, 22, 2), idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.mode).toBe('KIT');
    expect(r.body.output_qty).toBe('20');
    expect(r.body.consumed.map((x: { lpn_status: string }) => x.lpn_status)).toEqual(['CONSUMED', 'CONSUMED', 'CONSUMED']);
    expect(await skuTotal(f.skus[SET]!.id)).toBe(setBefore + 20n);
    await expectReconciled();
  });

  it('two-phase: start reports the sets the components allow; finish applies the same balance', async () => {
    const a = await storedPallet(f, A, f.reserve[6]!.id, 10n);
    const b = await storedPallet(f, B, f.reserve[7]!.id, 20n);
    const c = await storedPallet(f, C, f.reserve[8]!.id, 10n);
    const st = await sup.post('/assembly/start', { inputs: [{ lpn_code: a.code, sku_code: f.skus[A]!.code, qty: 10 }, { lpn_code: b.code, sku_code: f.skus[B]!.code, qty: 20 }, { lpn_code: c.code, sku_code: f.skus[C]!.code, qty: 10 }], output_sku_code: f.skus[SET]!.code, notes: 'sets para mañana' }, idem());
    expect(st.status, JSON.stringify(st.body)).toBe(201);
    expect(st.body.kit_sets).toBe('10');
    expect(st.body.mode).toBe('KIT');
    const short = await sup.post(`/assembly/${st.body.id}/complete`, { pallets: [{ cases: 11, pieces_per_case: 1 }] }, idem());
    expect(short.status).toBe(422);
    expect(short.body.error).toBe('KIT_UNBALANCED');
    const done = await sup.post(`/assembly/${st.body.id}/complete`, { pallets: [{ cases: 10, pieces_per_case: 1 }] }, idem());
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.output_qty).toBe('10');
    await expectReconciled();
  });
});
