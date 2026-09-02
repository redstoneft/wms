// SAE integration: a fake PostgREST server plays both Supabase mirrors with the
// real shapes observed in production (padded keys, alias layers, retail orders).
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, expectReconciled, sql, userWithRoles, type Client } from '../helpers.js';

// ---------------- fake PostgREST ----------------
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {
  // RAW mirror
  sae_inve01: [
    { cve_art: 'SIC20G', descr: 'SARTEN DE CERAMICA 20CM RED STONE', lin_prod: 'IMP', uni_med: 'pz', uni_emp: 1, fac_conv: 1, peso: 0.9, con_lote: 'N', status: 'A' },
    { cve_art: '.SIC20G', descr: 'SARTEN IMPERIAL 20CM GRIS (CAJA)', lin_prod: 'IMP', uni_med: 'pz', uni_emp: 6, fac_conv: 1, peso: 0, con_lote: 'N', status: 'A' },
    { cve_art: 'SIC20G-GRIS-1', descr: 'SARTEN ALUM 20CM GRIS REDSTONE', lin_prod: 'IMP', uni_med: 'pz', uni_emp: 1, fac_conv: 1, peso: 0, con_lote: 'N', status: 'A' },
    { cve_art: ' CMET24R.', descr: 'CACEROLA METALICA 24CM ROJA 2023', lin_prod: 'METAL', uni_med: 'pz', uni_emp: 12, fac_conv: 1, peso: 0, con_lote: 'S', status: 'A' },
    { cve_art: 'BAJA1', descr: 'ARTICULO DADO DE BAJA', lin_prod: null, uni_med: 'pz', uni_emp: 1, fac_conv: 1, peso: 0, con_lote: 'N', status: 'B' },
    { cve_art: 'bad key!', descr: 'CLAVE INVALIDA', lin_prod: null, uni_med: 'pz', uni_emp: 1, fac_conv: 1, peso: 0, con_lote: 'N', status: 'A' },
  ],
  sae_clie01: [
    { clave: '        21', nombre: 'WALMART DE MEXICO SAB DE CV', rfc: 'WME991231XYZ', status: 'A', calle: 'AV. PRINCIPAL', numext: '1', colonia: 'CENTRO', municipio: 'CDMX', estado: 'CDMX', codigo: '01000' },
    { clave: '        22', nombre: 'CLIENTE BAJA', rfc: null, status: 'B', calle: null, numext: null, colonia: null, municipio: null, estado: null, codigo: null },
  ],
  sae_prov01: [
    { clave: '        30', nombre: 'GUANGDONG JINDA HARDWARE', rfc: null, status: 'A', mail: 'sales@jinda.cn', telefono: null },
    { clave: '        31', nombre: 'HQ-EVER CO., LTD.', rfc: null, status: 'A', mail: null, telefono: null },
  ],
  // ERP project
  sku_alias: [
    { cve_art: 'SIC20G', modelo: 'SIC20G', capa: 'BASE' },
    { cve_art: '.SIC20G', modelo: 'SIC20G', capa: 'CAJA' },
    { cve_art: 'SIC20G-GRIS-1', modelo: 'SIC20G', capa: 'PIEZA' },
  ],
  productos: [{ sku_interno: 'SIC20G', gtin: '7500462718695', activo: true }, { sku_interno: 'CMET24R', gtin: '7500462700001', activo: true }],
  sae_inventario: [
    { cve_art: 'SIC20G', descripcion: 'SARTEN DE CERAMICA 20CM RED STONE', existencia: 180, actualizado_en: '2026-09-02T04:41:20Z' },
    { cve_art: '.SIC20G', descripcion: 'SARTEN IMPERIAL 20CM GRIS', existencia: 0, actualizado_en: '2026-09-02T04:41:20Z' },
    { cve_art: 'SIC20G-GRIS-1', descripcion: 'SARTEN ALUM 20CM GRIS REDSTONE', existencia: 48, actualizado_en: '2026-09-02T04:41:20Z' },
  ],
  sae_compras: [
    { cve_doc: '          0000000337', tipo: 'c', cve_prov: '        30', fecha: '2099-01-01', fecha_rec: '2099-01-05', estado: 'E', su_refer: 'PI-2026-77' },
    { cve_doc: '          0000000300', tipo: 'c', cve_prov: '        30', fecha: '2000-01-01', fecha_rec: null, estado: 'E', su_refer: '' }, // too old
    { cve_doc: '          0000000338', tipo: 'c', cve_prov: '        30', fecha: '2099-01-02', fecha_rec: null, estado: 'C', su_refer: '' }, // cancelled
  ],
  sae_compras_lineas: [
    { cve_doc: '          0000000337', cve_art: 'SIC20G', cantidad: 550, costo: 160.02 },
    { cve_doc: '          0000000337', cve_art: 'SIC20G', cantidad: 50, costo: 160.02 },
    { cve_doc: '          0000000337', cve_art: 'SIC20G-GRIS-1', cantidad: 100, costo: 90 },
  ],
  clientes: [{ id: 'c-walmart', nombre: 'WALMART', codigo_interno: 'WMT', cliente_sae_id: null, rfc: null, razon_social: null, activo: true }],
  cedis: [{ codigo: '7494', nombre: 'CEDIS Cuautitlán', ciudad: 'Cuautitlán Izcalli', estado: 'Estado de México' }],
  pedidos: [
    { id: 'p-1', cliente_id: 'c-walmart', num_orden_compra: '8834970889', fecha_pedido: '2099-01-01', fecha_envio: '2099-01-02', fecha_cancelacion: '2099-01-09', cedis_codigo: '7494', estatus: 'validado', instrucciones: 'Entregar antes de las 10:00' },
    { id: 'p-2', cliente_id: 'c-walmart', num_orden_compra: '6283704347', fecha_pedido: '2099-01-01', fecha_envio: null, fecha_cancelacion: null, cedis_codigo: null, estatus: 'validado', instrucciones: null },
    { id: 'p-3', cliente_id: 'c-walmart', num_orden_compra: '1111111111', fecha_pedido: '2099-01-01', fecha_envio: null, fecha_cancelacion: null, cedis_codigo: null, estatus: 'cancelado', instrucciones: null },
  ],
  pedido_lineas: [
    { pedido_id: 'p-1', num_linea: '001', sku_cliente: '101581797', sku_interno: 'SIC20G', gtin: '7500462718695', cantidad: 198, cantidad_surtir: 198, uom: 'EA', piezas_por_caja: 6 },
    { pedido_id: 'p-1', num_linea: '002', sku_cliente: '101581798', sku_interno: 'SIC20G-GRIS-1', gtin: null, cantidad: 96, cantidad_surtir: 96, uom: 'EA', piezas_por_caja: 6 },
    { pedido_id: 'p-2', num_linea: '001', sku_cliente: 'X', sku_interno: 'NOEXISTE', gtin: null, cantidad: 10, cantidad_surtir: 10, uom: 'EA', piezas_por_caja: 4 },
    { pedido_id: 'p-3', num_linea: '001', sku_cliente: 'X', sku_interno: 'SIC20G', gtin: null, cantidad: 10, cantidad_surtir: 10, uom: 'EA', piezas_por_caja: 6 },
  ],
};

function applyFilters(rows: Row[], params: URLSearchParams): Row[] {
  let out = rows;
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
    const m = /^(eq|neq|gte|lte|gt|lt|in)\.(.*)$/s.exec(v);
    if (!m) continue;
    const [, op, val] = m;
    out = out.filter((r) => {
      const x = r[k];
      switch (op) {
        case 'eq': return String(x) === val;
        case 'neq': return String(x) !== val;
        case 'gte': return String(x) >= val!;
        case 'lte': return String(x) <= val!;
        case 'gt': return String(x) > val!;
        case 'lt': return String(x) < val!;
        case 'in': {
          const list = val!.replace(/^\(|\)$/g, '').split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
          return list.includes(String(x));
        }
      }
      return true;
    });
  }
  const order = params.get('order');
  if (order) {
    const [col, dir] = order.split('.');
    out = [...out].sort((a, b) => (String(a[col!]) < String(b[col!]) ? -1 : 1) * (dir === 'desc' ? -1 : 1));
  }
  const limit = params.get('limit');
  if (limit) out = out.slice(0, Number(limit));
  return out;
}

let server: http.Server;
let port = 0;
let sup: Client;
let requests = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests++;
    const url = new URL(req.url ?? '/', 'http://x');
    const table = url.pathname.replace('/rest/v1/', '');
    if (req.headers.apikey !== 'fake-key') {
      res.writeHead(401).end('{"message":"no key"}');
      return;
    }
    const rows = tables[table];
    if (!rows) {
      res.writeHead(404).end(`{"message":"table ${table} missing"}`);
      return;
    }
    const range = /^(\d+)-(\d+)$/.exec(String(req.headers.range ?? '0-999'));
    const from = Number(range?.[1] ?? 0);
    const to = Number(range?.[2] ?? 999);
    const filtered = applyFilters(rows, url.searchParams);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(filtered.slice(from, to + 1)));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
  process.env.SAE_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SAE_SUPABASE_KEY = 'fake-key';
  process.env.SAE_RAW_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SAE_RAW_SUPABASE_KEY = 'fake-key';
  process.env.SAE_PO_SINCE_DAYS = '60';
  sup = await userWithRoles('saesup', ['SUPERVISOR']);
  // the shared test database persists between runs: remove what a previous run imported so counts are deterministic
  await sql(`DELETE FROM orders WHERE source = 'SAE' AND external_ref LIKE 'p-%'`);
  await sql(`DELETE FROM purchase_orders WHERE external_source = 'SAE'`);
  await sql(`DELETE FROM skus WHERE external_source = 'SAE' AND id NOT IN (SELECT sku_id FROM inventory_balances)`);
  await sql(`DELETE FROM customers WHERE external_source IN ('SAE','PEDIDOS') AND id NOT IN (SELECT customer_id FROM orders)`);
  await sql(`DELETE FROM suppliers WHERE external_source = 'SAE' AND id NOT IN (SELECT supplier_id FROM purchase_orders) AND id NOT IN (SELECT supplier_id FROM containers WHERE supplier_id IS NOT NULL) AND id NOT IN (SELECT supplier_id FROM lpns WHERE supplier_id IS NOT NULL)`);
});
afterAll(async () => {
  server.close();
  delete process.env.SAE_SUPABASE_URL;
  delete process.env.SAE_RAW_SUPABASE_URL;
  await closeApp();
});

describe('SAE → WMS synchronisation', () => {
  it('status reports configuration and freshness without leaking keys', async () => {
    const r = await sup.get('/sae/status');
    expect(r.status).toBe(200);
    expect(r.body.configured).toMatchObject({ erp: true, raw: true });
    expect(JSON.stringify(r.body)).not.toContain('fake-key');
  });

  it('imports ONE SKU per product (GTIN/model) with every SAE key as alias barcode; legacy per-key SKUs are merged', async () => {
    // a per-key SKU left by an older import (the CAJA variant), with a hand-added barcode and no inventory
    await sql(`INSERT INTO skus (code, description, external_source, external_ref, model_code, packaging_layer) VALUES ('.SIC20G', 'SARTEN IMPERIAL 20CM GRIS (CAJA)', 'SAE', '.SIC20G', 'SIC20G', 'CAJA')`);
    await sql(`INSERT INTO sku_uoms (sku_id, uom_code, base_qty) SELECT id, 'PIECE', 1 FROM skus WHERE code = '.SIC20G'`);
    await sql(`INSERT INTO sku_barcodes (sku_id, barcode, uom_code) SELECT id, 'LEGACY-CAJA-BC', 'PIECE' FROM skus WHERE code = '.SIC20G'`);
    const r = await sup.post('/sae/sync', { entities: ['skus'] });
    expect(r.status).toBe(200);
    const res = r.body.results[0];
    expect(res.entity).toBe('skus');
    expect(res.status).toBe('OK');
    expect(res.source_rows).toBe(6); // 6 SAE keys …
    expect(res.created).toBe(3); // … = 3 products: SIC20G (3 keys), CMET24R, BAJA1; 'bad key!' rejected; the legacy '.SIC20G' SKU is folded into SIC20G
    expect(res.errors.some((e: any) => e.ref === 'bad key!')).toBe(true);
    expect(res.notes).toContain('fusionados=1');
    const skus = await sql<{ code: string; gtin: string | null; model_code: string; is_active: boolean; family: string | null; requires_lot: boolean }>(`SELECT code, gtin, model_code, is_active, family, requires_lot FROM skus WHERE external_source = 'SAE' ORDER BY code`);
    expect(skus.map((s) => s.code)).toEqual(['BAJA1', 'CMET24R', 'SIC20G']); // no '.SIC20G', no 'SIC20G-GRIS-1', padded 'CMET24R.' → model CMET24R
    const byCode = Object.fromEntries(skus.map((s) => [s.code, s]));
    expect(byCode['SIC20G']).toMatchObject({ gtin: '7500462718695', model_code: 'SIC20G', is_active: true, family: 'IMP' });
    expect(byCode['CMET24R']).toMatchObject({ gtin: '7500462700001', requires_lot: true, family: 'METAL' }); // GTIN registered under the model name
    expect(byCode['BAJA1']).toMatchObject({ is_active: false, gtin: null });
    const uoms = await sql<{ code: string; uom_code: string; base_qty: bigint }>(`SELECT s.code, u.uom_code, u.base_qty FROM sku_uoms u JOIN skus s ON s.id = u.sku_id WHERE s.external_source = 'SAE' ORDER BY s.code, u.uom_code`);
    expect(uoms.filter((u) => u.code === 'SIC20G').map((u) => `${u.uom_code}=${u.base_qty}`)).toEqual(['CASE=6', 'PIECE=1']); // from pedido_lineas
    expect(uoms.filter((u) => u.code === 'CMET24R').map((u) => `${u.uom_code}=${u.base_qty}`)).toEqual(['CASE=12', 'PIECE=1']); // from uni_emp
    // every SAE key (and the GTIN) resolves to the product, with the packaging level of the key
    const bc = await sql<{ code: string; barcode: string; uom_code: string }>(`SELECT s.code, b.barcode, b.uom_code FROM sku_barcodes b JOIN skus s ON s.id = b.sku_id WHERE s.external_source = 'SAE' ORDER BY b.barcode`);
    const bcOf = (b: string) => bc.find((x) => x.barcode === b);
    expect(bcOf('7500462718695')).toMatchObject({ code: 'SIC20G', uom_code: 'PIECE' });
    expect(bcOf('SIC20G')).toMatchObject({ code: 'SIC20G', uom_code: 'PIECE' });
    expect(bcOf('.SIC20G')).toMatchObject({ code: 'SIC20G', uom_code: 'CASE' }); // CAJA key → cases
    expect(bcOf('SIC20G-GRIS-1')).toMatchObject({ code: 'SIC20G', uom_code: 'PIECE' });
    expect(bcOf('LEGACY-CAJA-BC')).toMatchObject({ code: 'SIC20G' }); // hand-added barcode survived the merge
    expect(bcOf('7500462700001')).toMatchObject({ code: 'CMET24R', uom_code: 'PIECE' });
    expect(bcOf('CMET24R.')).toMatchObject({ code: 'CMET24R' });
    // scanning any key on the floor resolves to the product
    const scan = await sup.get('/skus/by-barcode/.SIC20G');
    expect(scan.body).toMatchObject({ sku: { code: 'SIC20G' }, uom_code: 'CASE' });
    // idempotent
    const again = await sup.post('/sae/sync', { entities: ['skus'] });
    expect(again.body.results[0]).toMatchObject({ created: 0, updated: 3 });
    expect((await sql<{ n: bigint }>(`SELECT count(*) AS n FROM skus WHERE external_source = 'SAE'`))[0]!.n).toBe(3n);
    const merges = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM audit_logs WHERE action = 'sku.merge'`);
    expect(merges[0]!.n).toBeGreaterThanOrEqual(1n);
  });

  it('imports customers (SAE + retail platform) and suppliers idempotently', async () => {
    const r = await sup.post('/sae/sync', { entities: ['customers', 'suppliers'] });
    const cust = r.body.results.find((x: any) => x.entity === 'customers');
    const supp = r.body.results.find((x: any) => x.entity === 'suppliers');
    expect(cust).toMatchObject({ status: 'OK', created: 3 }); // 2 SAE + WALMART retail
    expect(supp).toMatchObject({ status: 'OK', created: 2 });
    const c = await sql<{ code: string; name: string; is_active: boolean; address: string | null; external_source: string }>(`SELECT code, name, is_active, address, external_source FROM customers WHERE external_source IN ('SAE','PEDIDOS') ORDER BY code`);
    expect(c.find((x) => x.code === '21')).toMatchObject({ is_active: true, external_source: 'SAE' });
    expect(c.find((x) => x.code === '21')!.address).toContain('CENTRO');
    expect(c.find((x) => x.code === '22')!.is_active).toBe(false);
    expect(c.find((x) => x.code === 'WMT')).toMatchObject({ name: 'WALMART', external_source: 'PEDIDOS' });
    const s = await sql<{ code: string; contact: string | null }>(`SELECT code, contact FROM suppliers WHERE external_source = 'SAE' ORDER BY code`);
    expect(s.map((x) => x.code)).toEqual(['30', '31']);
    expect(s[0]!.contact).toContain('sales@jinda.cn');
    const again = await sup.post('/sae/sync', { entities: ['customers', 'suppliers'] });
    expect(again.body.results.find((x: any) => x.entity === 'customers')).toMatchObject({ created: 0, updated: 3 });
    expect(again.body.results.find((x: any) => x.entity === 'suppliers')).toMatchObject({ created: 0, updated: 2 });
  });

  it('imports open recent purchase orders with aggregated lines; old and cancelled ones are ignored', async () => {
    const r = await sup.post('/sae/sync', { entities: ['purchase_orders'] });
    const res = r.body.results[0];
    expect(res).toMatchObject({ status: 'OK', source_rows: 1, created: 1 });
    const po = await sql<{ po_number: string; expected_date: Date; notes: string; supplier_code: string }>(`SELECT p.po_number, p.expected_date, p.notes, s.code AS supplier_code FROM purchase_orders p JOIN suppliers s ON s.id = p.supplier_id WHERE p.external_source = 'SAE'`);
    expect(po).toHaveLength(1);
    expect(po[0]).toMatchObject({ po_number: '0000000337', supplier_code: '30' });
    expect(po[0]!.notes).toContain('PI-2026-77');
    const lines = await sql<{ code: string; ordered_qty: bigint }>(`SELECT s.code, l.ordered_qty FROM purchase_order_lines l JOIN skus s ON s.id = l.sku_id JOIN purchase_orders p ON p.id = l.po_id WHERE p.po_number = '0000000337' ORDER BY s.code`);
    expect(lines.map((l) => `${l.code}=${l.ordered_qty}`)).toEqual(['SIC20G=700']); // 550 + 50 + 100 (PIEZA key of the same product)
    const again = await sup.post('/sae/sync', { entities: ['purchase_orders'] });
    expect(again.body.results[0]).toMatchObject({ created: 0, updated: 1 });
    expect((await sql<{ n: bigint }>(`SELECT count(*) AS n FROM purchase_orders WHERE external_source = 'SAE'`))[0]!.n).toBe(1n);
  });

  it('imports retail customer orders with priority/destination; orders with unknown SKUs are rejected whole; cancellations propagate', async () => {
    const r = await sup.post('/sae/sync', { entities: ['customer_orders'] });
    const res = r.body.results[0];
    expect(res.status).toBe('OK');
    expect(res.created).toBe(1); // p-1
    expect(res.errors.some((e: any) => e.ref === '6283704347' && /NOEXISTE/.test(e.message))).toBe(true); // p-2 rejected entirely
    const o = await sql<{ order_number: string; status: string; priority: number; destination: string; customer: string; external_ref: string; source: string }>(`SELECT o.order_number, o.status, o.priority, o.destination, c.code AS customer, o.external_ref, o.source FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.source = 'SAE' AND o.external_ref LIKE 'p-%'`);
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ order_number: '8834970889', status: 'IMPORTED', priority: 5, customer: 'WMT', external_ref: 'p-1', source: 'SAE' });
    expect(o[0]!.destination).toContain('CEDIS Cuautitlán');
    const lines = await sql<{ code: string; required_qty: bigint }>(`SELECT s.code, l.required_qty FROM order_lines l JOIN skus s ON s.id = l.sku_id JOIN orders o ON o.id = l.order_id WHERE o.order_number = '8834970889' ORDER BY l.line_no`);
    expect(lines.map((l) => `${l.code}=${l.required_qty}`)).toEqual(['SIC20G=294']); // two keys of the same product → one line
    // re-run: still one order; then the platform cancels p-1 → WMS order cancelled
    await sup.post('/sae/sync', { entities: ['customer_orders'] });
    expect((await sql<{ n: bigint }>(`SELECT count(*) AS n FROM orders WHERE source = 'SAE' AND external_ref LIKE 'p-%'`))[0]!.n).toBe(1n);
    tables.pedidos![0]!.estatus = 'cancelado';
    const r2 = await sup.post('/sae/sync', { entities: ['customer_orders'] });
    expect(r2.body.results[0].updated).toBe(1);
    expect((await sql<{ status: string }>(`SELECT status FROM orders WHERE external_ref = 'p-1'`))[0]!.status).toBe('CANCELLED');
    tables.pedidos![0]!.estatus = 'validado';
    // a cancelled order is not resurrected
    const r3 = await sup.post('/sae/sync', { entities: ['customer_orders'] });
    expect(r3.body.results[0].created).toBe(0);
    await expectReconciled();
  });

  it('stock comparison reports SAE vs WMS per SKU without touching inventory', async () => {
    const before = (await sql<{ n: bigint }>(`SELECT count(*) AS n FROM inventory_movements`))[0]!.n;
    const r = await sup.get('/sae/stock-compare');
    expect(r.status).toBe(200);
    expect(r.body.skus_sae).toBe(3); // SAE keys
    const sic = r.body.differences.find((d: any) => d.sku === 'SIC20G');
    // 180 (base) + 0 cases × 6 + 48 (piece key) = 228 pieces of the product
    expect(sic).toMatchObject({ in_wms: true, gtin: '7500462718695', sae_existencia: '228', wms_total: '0', diff: '-228' });
    expect(sic.sae_keys).toHaveLength(3);
    expect((await sql<{ n: bigint }>(`SELECT count(*) AS n FROM inventory_movements`))[0]!.n).toBe(before);
  });

  it('runs are logged and audited; a missing source is a clean 422', async () => {
    const runs = await sup.get('/sae/runs');
    expect(runs.body.length).toBeGreaterThanOrEqual(8);
    expect(runs.body.filter((x: any) => x.status === 'OK').length).toBeGreaterThanOrEqual(8);
    const aud = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM audit_logs WHERE action LIKE 'integration.sae.%'`);
    expect(aud[0]!.n).toBeGreaterThanOrEqual(8n);
    delete process.env.SAE_RAW_SUPABASE_URL;
    const r = await sup.post('/sae/sync', { entities: ['suppliers'] });
    expect(r.body.results[0]).toMatchObject({ status: 'FAILED' });
    expect(r.body.results[0].notes).toMatch(/not configured/);
    process.env.SAE_RAW_SUPABASE_URL = `http://127.0.0.1:${port}`;
    expect(requests).toBeGreaterThan(10);
  });
});
