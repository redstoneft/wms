// Excel import template: data sheet first (header only) + catalogue sheets the person filling it needs.
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, getApp, makeFixture, sql, userWithRoles, type Client, type Fixture } from '../helpers.js';

let sup: Client;
let f: Fixture;
beforeAll(async () => {
  sup = await userWithRoles('tplsup', ['SUPERVISOR']);
  f = await makeFixture({ skus: 2 }); // own SKUs/locations: never load inventory onto catalogue SKUs other suites count on
});
afterAll(closeApp);

async function download(type: string) {
  const a = await getApp();
  const r = await a.inject({ method: 'GET', url: `/api/imports/templates/${type.toLowerCase()}.xlsx`, headers: { cookie: sup.cookie } });
  expect(r.statusCode).toBe(200);
  expect(String(r.headers['content-type'])).toContain('spreadsheetml');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.rawPayload as unknown as ExcelJS.Buffer);
  return { wb, buf: r.rawPayload };
}

describe('Excel import template with catalogue sheets', () => {
  it('INITIAL_INVENTORY: data sheet first, then every active SKU with its SAE keys/GTIN, the locations and the instructions', async () => {
    const { wb } = await download('INITIAL_INVENTORY');
    expect(wb.worksheets.map((w) => w.name)).toEqual(['INITIAL_INVENTORY', 'SKUs', 'Ubicaciones', 'Instrucciones']);
    const data = wb.worksheets[0]!;
    expect((data.getRow(1).values as unknown[]).slice(1)).toEqual(['location_code', 'sku', 'qty', 'uom_code', 'pieces_per_case', 'lot', 'expiry_date', 'lpn']);
    let filled = 0;
    data.eachRow((row, i) => {
      if (i > 1 && (row.values as unknown[]).some((v) => v !== null && v !== undefined && String(v) !== '')) filled++;
    });
    expect(filled).toBe(0); // no example row that could be imported by accident

    const skus = wb.getWorksheet('SKUs')!;
    const nSkus = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM skus WHERE is_active`);
    expect(skus.rowCount - 1).toBe(Number(nSkus[0]!.n));
    expect(String(skus.getRow(1).getCell(1).value)).toBe('Código WMS');
    // a SKU with an alias barcode lists it in the alias column
    const withAlias = await sql<{ code: string; barcode: string }>(`SELECT s.code, b.barcode FROM sku_barcodes b JOIN skus s ON s.id = b.sku_id WHERE s.is_active AND b.barcode <> s.code AND (s.gtin IS NULL OR b.barcode <> s.gtin) LIMIT 1`);
    if (withAlias[0]) {
      let found = false;
      skus.eachRow((row, i) => {
        if (i > 1 && String(row.getCell(1).value) === withAlias[0]!.code) found = String(row.getCell(4).value).includes(withAlias[0]!.barcode);
      });
      expect(found).toBe(true);
    }

    const locs = wb.getWorksheet('Ubicaciones')!;
    const nLocs = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM locations WHERE is_active AND admin_status = 'ACTIVE'`);
    expect(locs.rowCount - 1).toBe(Number(nLocs[0]!.n));

    const ins = wb.getWorksheet('Instrucciones')!;
    const cols: string[] = [];
    ins.eachRow((row, i) => {
      if (i > 1 && row.getCell(1).value && !String(row.getCell(1).value).startsWith('Paso')) cols.push(String(row.getCell(1).value));
    });
    expect(cols).toEqual(['location_code', 'sku', 'qty', 'uom_code', 'pieces_per_case', 'lot', 'expiry_date', 'lpn']);
  });

  it('ORDERS gets Clientes, PURCHASE_ORDERS gets Proveedores, SKUS gets no catalogue of itself', async () => {
    expect((await download('ORDERS')).wb.worksheets.map((w) => w.name)).toEqual(['ORDERS', 'SKUs', 'Clientes', 'Instrucciones']);
    expect((await download('PURCHASE_ORDERS')).wb.worksheets.map((w) => w.name)).toEqual(['PURCHASE_ORDERS', 'SKUs', 'Proveedores', 'Instrucciones']);
    expect((await download('SKUS')).wb.worksheets.map((w) => w.name)).toEqual(['SKUS', 'Instrucciones']);
  });

  it('a filled template (scanned location barcode LOC-… and SAE alias) validates through the normal import, ignoring the catalogue sheets', async () => {
    const { wb } = await download('INITIAL_INVENTORY');
    wb.worksheets[0]!.addRow([f.reserve[0]!.barcode, f.skus[0]!.piece_barcode, 5, 'PIECE', '', '', '', '']); // scanned: location barcode (LOC-…) and product alias barcode, not WMS codes
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const boundary = 'xxTpl';
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="plantilla_initial_inventory.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const a = await getApp();
    const r = await a.inject({ method: 'POST', url: '/api/imports?type=INITIAL_INVENTORY&mode=VALIDATE', headers: { cookie: sup.cookie, 'x-requested-with': 'wms-client', 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([head, buf, tail]) });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.errors).toEqual([]);
    expect(body.ok).toBe(true);
    expect(body.total_rows).toBe(1);
  });

  it('pieces_per_case: the row packing factor wins over the catalogue and is stored in pieces', async () => {
    const a = await getApp();
    const loc = [{ code: f.reserve[1]!.barcode }]; // scanned form on APPLY too
    const sku = [{ code: f.skus[1]!.code }];
    const send = async (rows: string, mode: 'VALIDATE' | 'APPLY') => {
      const csv = `location_code,sku,qty,uom_code,pieces_per_case,lot,expiry_date,lpn\n${rows}`;
      const boundary = 'xxPpc';
      const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="inv-${Date.now()}-${Math.random()}.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`;
      const r = await a.inject({ method: 'POST', url: `/api/imports?type=INITIAL_INVENTORY&mode=${mode}`, headers: { cookie: sup.cookie, 'x-requested-with': 'wms-client', 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
      return JSON.parse(r.body);
    };
    // factor only makes sense for cases
    const bad = await send(`${loc[0]!.code},${sku[0]!.code},3,PIECE,7,,,`, 'VALIDATE');
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].column).toBe('pieces_per_case');
    // 3 cases × 7 pieces each = 21 pieces, whatever the catalogue says
    const ok = await send(`${loc[0]!.code},${sku[0]!.code},3,CASE,7,,,`, 'APPLY');
    expect(ok.status).toBe('APPLIED');
    const mv = await sql<{ qty: bigint; uom_code: string; uom_qty: bigint }>(`SELECT m.qty, m.uom_code, m.uom_qty FROM inventory_movements m JOIN skus s ON s.id = m.sku_id JOIN locations l ON l.id = m.to_location_id WHERE s.code = '${sku[0]!.code}' AND l.code = '${f.reserve[1]!.code}' AND m.movement_type = 'INITIAL_LOAD' ORDER BY m.id DESC LIMIT 1`);
    expect(mv[0]!.qty).toBe(21n);
    const where = await sql<{ code: string }>(`SELECT l.code FROM inventory_movements m JOIN locations l ON l.id = m.to_location_id WHERE m.id = (SELECT max(id) FROM inventory_movements WHERE movement_type = 'INITIAL_LOAD')`);
    expect(where[0]!.code).toBe(f.reserve[1]!.code);
    expect(mv[0]!.uom_code).toBe('CASE');
    expect(mv[0]!.uom_qty).toBe(3n);
  });
});
