// A SKU merged into another one is only a pointer: code, barcode and SAE-key lookups land on the survivor.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeFixture, sql, userWithRoles, type Client, type Fixture } from '../helpers.js';
import { withTx } from '../../src/db.js';
import { getSkuByCode, resolveSkuBarcode } from '../../src/lib/lookup.js';
import { resolveSaeKey } from '../../src/modules/sae/sync.js';

let sup: Client;
let f: Fixture;
beforeAll(async () => {
  sup = await userWithRoles('mrgsup', ['SUPERVISOR']);
  f = await makeFixture({ skus: 2 });
});
afterAll(closeApp);

describe('merged SKUs', () => {
  it('code, barcode and SAE-key lookups of the merged SKU answer with the survivor; orders use the survivor', async () => {
    const dup = f.skus[1]!;
    const keep = f.skus[0]!;
    await sql(`UPDATE skus SET merged_into_id = '${keep.id}', is_active = false WHERE id = '${dup.id}'`);
    await sql(`INSERT INTO sku_barcodes (sku_id, uom_code, barcode) VALUES ('${dup.id}', 'PIECE', 'KEY-${dup.code}') ON CONFLICT DO NOTHING`);
    await withTx(async (tx) => {
      expect((await getSkuByCode(tx, dup.code)).id).toBe(keep.id);
      expect((await resolveSkuBarcode(tx, dup.case_barcode)).sku.id).toBe(keep.id);
      expect((await resolveSaeKey(tx, `KEY-${dup.code}`))?.id).toBe(keep.id);
    });
    // an order captured with the old code lands on the survivor
    const o = await sup.post('/orders', { order_number: `MRG-${f.tag}`, customer_code: f.customer.code, lines: [{ sku_code: dup.code, qty: 3, uom_code: 'PIECE' }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    const od = await sup.get(`/orders/${o.body.id}`);
    expect(od.body.lines[0].sku.code).toBe(keep.code);
  });
});
