// Initial inventory import as the count sheets really arrive: scanned barcodes (GTIN with or without the leading
// zero Excel drops), several rows per position (full cases + an open case), Excel row numbers in the errors.
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, expectReconciled, getApp, makeFixture, sql, userWithRoles, type Client, type Fixture } from '../helpers.js';

let sup: Client;
let f: Fixture;
let gtin13: string;

beforeAll(async () => {
  sup = await userWithRoles('invsup', ['SUPERVISOR']);
  f = await makeFixture({ skus: 3 });
  // a UPC-A product: catalogue stores the 13-digit form with the leading zero
  gtin13 = `0${String(Date.now()).slice(-12)}`;
  await sql(`UPDATE skus SET gtin = '${gtin13}' WHERE id = '${f.skus[2]!.id}'`);
});
afterAll(closeApp);

async function upload(csv: string, mode: 'VALIDATE' | 'APPLY') {
  const a = await getApp();
  const boundary = 'xxInv';
  const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="inv-${Date.now()}-${Math.random()}.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`;
  const r = await a.inject({ method: 'POST', url: `/api/imports?type=INITIAL_INVENTORY&mode=${mode}`, headers: { cookie: sup.cookie, 'x-requested-with': 'wms-client', 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
  return JSON.parse(r.body);
}
const H = 'location_code,sku,qty,uom_code,pieces_per_case,lot,expiry_date,lpn\n';

describe('initial inventory import from count sheets', () => {
  it('full cases + an open case of the same product in one position become ONE pallet; scanned GTIN and 12-digit UPC resolve on APPLY', async () => {
    const loc = f.reserve[0]!;
    const upc12 = gtin13.slice(1);
    const csv = H + `${loc.barcode},${f.skus[0]!.piece_barcode},10,CASE,24,,,\n${loc.barcode},${f.skus[0]!.piece_barcode},1,CASE,7,,,\n${loc.code},${upc12},2,CASE,6,,,\n`;
    const v = await upload(csv, 'VALIDATE');
    expect(v.errors).toEqual([]);
    const r = await upload(csv, 'APPLY');
    expect(r.status, JSON.stringify(r.errors)).toBe('APPLIED');
    expect(r.result).toEqual({ lpns: 1, movements: 3 });
    const bal = await sql<{ code: string; qty: bigint }>(`SELECT s.code, b.qty FROM inventory_balances b JOIN skus s ON s.id = b.sku_id JOIN lpns l ON l.id = b.lpn_id WHERE l.current_location_id = '${loc.id}' ORDER BY s.code`);
    expect(bal.map((b) => `${b.code}=${b.qty}`)).toEqual([`${f.skus[0]!.code}=247`, `${f.skus[2]!.code}=12`]); // 10×24 + 1×7 ; 2×6 via the UPC without its zero
    await expectReconciled();
  });

  it('more pallets than the position holds is caught at validation, before anything is applied', async () => {
    const loc = f.reserve[1]!;
    const csv = H + `${loc.code},${f.skus[0]!.code},5,CASE,6,,,T-A\n${loc.code},${f.skus[1]!.code},5,CASE,6,,,T-B\n`;
    const v = await upload(csv, 'VALIDATE');
    expect(v.ok).toBe(false);
    expect(v.errors.some((e: { column: string; message: string }) => e.column === 'lpn' && /2 pallets for a capacity of 1/.test(e.message))).toBe(true);
  });

  it('errors point at the Excel row the person sees, even with blank rows in between', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('INITIAL_INVENTORY');
    ws.addRow(['location_code', 'sku', 'qty', 'uom_code', 'pieces_per_case', 'lot', 'expiry_date', 'lpn']);
    ws.addRow([f.reserve[2]!.barcode, f.skus[0]!.code, 3, 'CASE', 6, '', '', '']); // row 2 ok
    ws.addRow([]); // row 3 blank
    ws.addRow([]); // row 4 blank
    ws.addRow([f.reserve[3]!.barcode, f.skus[0]!.code, '', 'CASE', 6, '', '', '']); // row 5: qty missing
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const boundary = 'xxRow';
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="conteo.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const a = await getApp();
    const r = await a.inject({ method: 'POST', url: '/api/imports?type=INITIAL_INVENTORY&mode=VALIDATE', headers: { cookie: sup.cookie, 'x-requested-with': 'wms-client', 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([head, buf, tail]) });
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(false);
    expect(body.errors.map((e: { row: number; column: string }) => `${e.row}:${e.column}`)).toEqual(['5:qty']);
  });
});
