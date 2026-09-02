import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { z } from 'zod';
import { UOM_CODES, validateUomHierarchy, type ImportType, type UomCode } from '@wms/shared';
import type { Tx } from '../../db.js';
import { getDb, withTx } from '../../db.js';
import { ConflictError, NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';
import { createInventory, createLpn, lockLocationByBarcode } from '../../inventory/ledger.js';
import { createOrder } from '../orders/service.js';

export interface RowError {
  row: number;
  column: string;
  message: string;
}

export type Row = Record<string, string>;

// ---------------------------------------------------------------------
// Templates (headers + one example row). Column names are stable contracts.
// ---------------------------------------------------------------------
export const TEMPLATES: Record<ImportType, { columns: string[]; example: string[]; description: string }> = {
  SKUS: {
    columns: ['sku', 'description', 'family', 'compatibility_group', 'abc_class', 'unit_weight_kg', 'case_qty', 'pallet_cases', 'inner_qty', 'requires_lot', 'requires_expiry'],
    example: ['SKU-0001', 'Olla express 6L', 'COCINA', 'GENERAL', 'A', '1.25', '6', '40', '', 'false', 'false'],
    description: 'case_qty = piezas por caja; pallet_cases = cajas por pallet; inner_qty = piezas por inner (opcional)',
  },
  BARCODES: { columns: ['sku', 'barcode', 'uom_code'], example: ['SKU-0001', '7501234567890', 'PIECE'], description: 'uom_code: PIECE | INNER | CASE | PALLET' },
  CUSTOMERS: { columns: ['code', 'name', 'tax_id', 'address'], example: ['CLI-001', 'Walmart de México', 'WME123456789', 'Av. Principal 1, CDMX'], description: '' },
  SUPPLIERS: { columns: ['code', 'name', 'tax_id', 'contact'], example: ['PROV-001', 'Zhejiang Cookware Co.', '', 'sales@example.com'], description: '' },
  LOCATIONS: {
    columns: ['code', 'location_type', 'zone_code', 'x_m', 'y_m', 'width_m', 'depth_m', 'height_m', 'pallet_capacity', 'max_weight_kg'],
    example: ['DOCK-01', 'RECEIVING', 'REC', '2', '2', '6', '4', '3', '20', '50000'],
    description: 'Áreas (no racks): RECEIVING | STAGING | SHIPPING | QUARANTINE | RETURNS | DAMAGED',
  },
  RACKS: {
    columns: ['zone_code', 'aisle_code', 'rack_code', 'bays', 'levels', 'positions_per_bay', 'bay_width_m', 'level_height_m', 'depth_m', 'x_m', 'y_m', 'rotation_deg', 'location_type', 'pallet_capacity', 'max_weight_kg'],
    example: ['A', '01', 'R01', '10', '4', '1', '2.7', '1.8', '1.2', '10', '5', '0', 'RESERVE', '1', '1500'],
    description: 'Genera automáticamente las ubicaciones <ZONA>-<PASILLO>-R##-N##-P##',
  },
  INITIAL_INVENTORY: {
    columns: ['location_code', 'sku', 'qty', 'uom_code', 'lot', 'expiry_date', 'lpn'],
    example: ['A-01-R01-N01-P01', 'SKU-0001', '40', 'CASE', '', '', ''],
    description: 'lpn vacío = se genera un LPN nuevo por fila; mismo valor en varias filas = pallet mixto',
  },
  ORDERS: {
    columns: ['order_number', 'customer_code', 'destination', 'order_date', 'priority', 'sku', 'qty', 'uom_code'],
    example: ['PED-48571', 'CLI-001', 'CEDIS Monterrey', '2026-09-01', '3', 'SKU-0001', '10', 'CASE'],
    description: 'Una fila por línea; las filas del mismo order_number forman un pedido',
  },
  PURCHASE_ORDERS: {
    columns: ['po_number', 'supplier_code', 'expected_date', 'sku', 'qty', 'uom_code'],
    example: ['OC-2026-001', 'PROV-001', '2026-09-15', 'SKU-0001', '400', 'CASE'],
    description: 'Una fila por línea',
  },
};

export function templateCsv(type: ImportType): string {
  const t = TEMPLATES[type];
  return Papa.unparse([t.columns, t.example]);
}

// ---------------------------------------------------------------------
// Parsing: CSV (UTF-8, comma/semicolon) or XLSX (first sheet). Header row required.
// ---------------------------------------------------------------------
export async function parseFile(buf: Buffer, fileName: string): Promise<{ rows: Row[]; errors: RowError[] }> {
  if (buf.length === 0) throw new RuleError('EMPTY_FILE', 'File is empty');
  if (buf.length > 20 * 1024 * 1024) throw new RuleError('FILE_TOO_LARGE', 'Max 20 MB');
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.xlsx')) return parseXlsx(buf);
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) return parseCsv(buf);
  // sniff: xlsx is a zip
  if (buf[0] === 0x50 && buf[1] === 0x4b) return parseXlsx(buf);
  return parseCsv(buf);
}

function parseCsv(buf: Buffer): { rows: Row[]; errors: RowError[] } {
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const res = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: 'greedy', transformHeader: (h) => h.trim().toLowerCase(), delimiter: '' });
  const errors: RowError[] = res.errors.filter((e) => e.code !== 'UndetectableDelimiter').map((e) => ({ row: (e.row ?? 0) + 2, column: '', message: e.message }));
  const rows = res.data.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v ?? '').trim()])));
  return { rows, errors };
}

async function parseXlsx(buf: Buffer): Promise<{ rows: Row[]; errors: RowError[] }> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  } catch {
    throw new RuleError('INVALID_XLSX', 'File is not a valid XLSX workbook');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new RuleError('EMPTY_WORKBOOK', 'Workbook has no sheets');
  const header = (ws.getRow(1).values as unknown[]).slice(1).map((v) => String(v ?? '').trim().toLowerCase());
  const rows: Row[] = [];
  ws.eachRow((row, idx) => {
    if (idx === 1) return;
    const vals = (row.values as unknown[]).slice(1);
    const obj: Row = {};
    let empty = true;
    header.forEach((h, i) => {
      const raw = vals[i];
      let s = '';
      if (raw instanceof Date) s = raw.toISOString().slice(0, 10);
      else if (raw && typeof raw === 'object' && 'result' in (raw as object)) s = String((raw as { result: unknown }).result ?? '');
      else if (raw && typeof raw === 'object' && 'richText' in (raw as object)) s = (raw as { richText: { text: string }[] }).richText.map((t) => t.text).join('');
      else s = String(raw ?? '');
      s = s.trim();
      if (s) empty = false;
      if (h) obj[h] = s;
    });
    if (!empty) rows.push(obj);
  });
  return { rows, errors: [] };
}

// ---------------------------------------------------------------------
// Validation. Every row is validated; nothing is applied if any row fails.
// ---------------------------------------------------------------------
const zBool = z.string().transform((s) => ['true', '1', 'si', 'sí', 'yes', 'y'].includes(s.toLowerCase()));
const zIntStr = z.string().regex(/^\d+$/, 'must be a positive integer');
const zNumStr = z.string().regex(/^\d+(\.\d+)?$/, 'must be a number');
const zDateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const zCodeStr = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/, 'invalid characters');
const zUomStr = z.enum(UOM_CODES);
const opt = <T extends z.ZodTypeAny>(s: T) => z.union([z.literal(''), s]);

const ROW_SCHEMAS: Record<ImportType, z.ZodTypeAny> = {
  SKUS: z.object({
    sku: zCodeStr,
    description: z.string().min(1).max(300),
    family: z.string().max(60).default(''),
    compatibility_group: z.string().max(60).default(''),
    abc_class: opt(z.enum(['A', 'B', 'C'])).default(''),
    unit_weight_kg: opt(zNumStr).default(''),
    case_qty: opt(zIntStr).default(''),
    pallet_cases: opt(zIntStr).default(''),
    inner_qty: opt(zIntStr).default(''),
    requires_lot: opt(zBool).default(''),
    requires_expiry: opt(zBool).default(''),
  }),
  BARCODES: z.object({ sku: zCodeStr, barcode: z.string().min(3).max(64).regex(/^[\x21-\x7E]+$/, 'printable ASCII only'), uom_code: opt(zUomStr).default('') }),
  CUSTOMERS: z.object({ code: zCodeStr, name: z.string().min(1).max(200), tax_id: z.string().max(40).default(''), address: z.string().max(500).default('') }),
  SUPPLIERS: z.object({ code: zCodeStr, name: z.string().min(1).max(200), tax_id: z.string().max(40).default(''), contact: z.string().max(500).default('') }),
  LOCATIONS: z.object({
    code: zCodeStr.max(40),
    location_type: z.enum(['RECEIVING', 'STAGING', 'SHIPPING', 'QUARANTINE', 'RETURNS', 'DAMAGED']),
    zone_code: z.string().max(20).default(''),
    x_m: opt(zNumStr).default(''),
    y_m: opt(zNumStr).default(''),
    width_m: opt(zNumStr).default(''),
    depth_m: opt(zNumStr).default(''),
    height_m: opt(zNumStr).default(''),
    pallet_capacity: opt(zIntStr).default(''),
    max_weight_kg: opt(zNumStr).default(''),
  }),
  RACKS: z.object({
    zone_code: zCodeStr.max(20),
    aisle_code: zCodeStr.max(20),
    rack_code: zCodeStr.max(20),
    bays: zIntStr,
    levels: zIntStr,
    positions_per_bay: opt(zIntStr).default(''),
    bay_width_m: opt(zNumStr).default(''),
    level_height_m: opt(zNumStr).default(''),
    depth_m: opt(zNumStr).default(''),
    x_m: opt(zNumStr).default(''),
    y_m: opt(zNumStr).default(''),
    rotation_deg: opt(zIntStr).default(''),
    location_type: opt(z.enum(['RESERVE', 'PICKING'])).default(''),
    pallet_capacity: opt(zIntStr).default(''),
    max_weight_kg: opt(zNumStr).default(''),
  }),
  INITIAL_INVENTORY: z.object({ location_code: zCodeStr.max(40), sku: zCodeStr, qty: zIntStr, uom_code: opt(zUomStr).default(''), lot: z.string().max(60).default(''), expiry_date: opt(zDateStr).default(''), lpn: z.string().max(30).default('') }),
  ORDERS: z.object({
    order_number: zCodeStr.max(60),
    customer_code: zCodeStr,
    destination: z.string().max(500).default(''),
    order_date: opt(zDateStr).default(''),
    priority: opt(z.string().regex(/^[1-9]$/, '1-9')).default(''),
    sku: zCodeStr,
    qty: zIntStr,
    uom_code: opt(zUomStr).default(''),
  }),
  PURCHASE_ORDERS: z.object({ po_number: zCodeStr.max(60), supplier_code: zCodeStr, expected_date: opt(zDateStr).default(''), sku: zCodeStr, qty: zIntStr, uom_code: opt(zUomStr).default('') }),
};

export interface ValidationResult {
  ok: boolean;
  total_rows: number;
  valid_rows: number;
  errors: RowError[];
  summary: Record<string, unknown>;
}

/** Structural + referential validation (existence of SKUs, customers, ...). */
export async function validateRows(tx: Tx, type: ImportType, rows: Row[], parseErrors: RowError[]): Promise<ValidationResult> {
  const errors: RowError[] = [...parseErrors];
  const t = TEMPLATES[type];
  if (rows.length === 0) errors.push({ row: 1, column: '', message: 'file has no data rows' });
  if (rows.length > 50_000) errors.push({ row: 1, column: '', message: 'max 50,000 rows per file' });
  const present = new Set(Object.keys(rows[0] ?? {}));
  const required = t.columns.filter((c) => !isOptionalColumn(type, c));
  for (const c of required) if (!present.has(c)) errors.push({ row: 1, column: c, message: `missing column '${c}'` });
  if (errors.length) return { ok: false, total_rows: rows.length, valid_rows: 0, errors, summary: {} };

  const schema = ROW_SCHEMAS[type];
  const parsed: Record<string, unknown>[] = [];
  rows.forEach((r, i) => {
    const res = schema.safeParse(r);
    if (!res.success) {
      for (const iss of res.error.issues) errors.push({ row: i + 2, column: String(iss.path[0] ?? ''), message: iss.message });
    } else parsed.push(res.data as Record<string, unknown>);
  });
  if (errors.length) return { ok: false, total_rows: rows.length, valid_rows: parsed.length, errors, summary: {} };

  // referential checks
  const summary: Record<string, unknown> = {};
  const skuCodes = [...new Set(parsed.map((p) => p.sku as string).filter(Boolean))];
  const skus = skuCodes.length ? await tx.skus.findMany({ where: { code: { in: skuCodes } }, include: { uoms: true } }) : [];
  const skuMap = new Map(skus.map((s) => [s.code, s]));
  const dup = new Set<string>();
  switch (type) {
    case 'SKUS': {
      parsed.forEach((p, i) => {
        const code = p.sku as string;
        if (dup.has(code)) errors.push({ row: i + 2, column: 'sku', message: `duplicate sku ${code} in file` });
        dup.add(code);
        const caseQ = p.case_qty ? BigInt(p.case_qty as string) : null;
        const palletC = p.pallet_cases ? BigInt(p.pallet_cases as string) : null;
        const innerQ = p.inner_qty ? BigInt(p.inner_qty as string) : null;
        if (palletC && !caseQ) errors.push({ row: i + 2, column: 'pallet_cases', message: 'pallet_cases requires case_qty' });
        const defs = [{ uom_code: 'PIECE' as UomCode, base_qty: 1n }];
        if (innerQ) defs.push({ uom_code: 'INNER', base_qty: innerQ });
        if (caseQ) defs.push({ uom_code: 'CASE', base_qty: caseQ });
        if (caseQ && palletC) defs.push({ uom_code: 'PALLET', base_qty: caseQ * palletC });
        try {
          for (const e of validateUomHierarchy(defs)) errors.push({ row: i + 2, column: 'case_qty', message: e });
        } catch (e) {
          errors.push({ row: i + 2, column: 'case_qty', message: (e as Error).message });
        }
      });
      summary.existing = skus.length;
      summary.new = skuCodes.length - skus.length;
      break;
    }
    case 'BARCODES': {
      const bcs = parsed.map((p) => p.barcode as string);
      const existing = await tx.sku_barcodes.findMany({ where: { barcode: { in: bcs } }, include: { sku: true } });
      parsed.forEach((p, i) => {
        if (!skuMap.has(p.sku as string)) errors.push({ row: i + 2, column: 'sku', message: `unknown sku ${p.sku}` });
        if (dup.has(p.barcode as string)) errors.push({ row: i + 2, column: 'barcode', message: 'duplicate barcode in file' });
        dup.add(p.barcode as string);
        const ex = existing.find((e) => e.barcode === p.barcode);
        if (ex && ex.sku.code !== p.sku) errors.push({ row: i + 2, column: 'barcode', message: `barcode already assigned to ${ex.sku.code}` });
        const uom = (p.uom_code as string) || 'PIECE';
        const s = skuMap.get(p.sku as string);
        if (s && !s.uoms.some((u) => u.uom_code === uom)) errors.push({ row: i + 2, column: 'uom_code', message: `sku ${p.sku} has no UoM ${uom}` });
      });
      break;
    }
    case 'CUSTOMERS':
    case 'SUPPLIERS':
      parsed.forEach((p, i) => {
        if (dup.has(p.code as string)) errors.push({ row: i + 2, column: 'code', message: 'duplicate code in file' });
        dup.add(p.code as string);
      });
      break;
    case 'LOCATIONS': {
      const zones = await tx.zones.findMany();
      parsed.forEach((p, i) => {
        const code = (p.code as string).toUpperCase();
        if (dup.has(code)) errors.push({ row: i + 2, column: 'code', message: 'duplicate code in file' });
        dup.add(code);
        if (p.zone_code && !zones.find((z) => z.code === p.zone_code)) errors.push({ row: i + 2, column: 'zone_code', message: `unknown zone ${p.zone_code}` });
      });
      break;
    }
    case 'RACKS': {
      const zones = await tx.zones.findMany({ include: { aisles: { include: { racks: true } } } });
      parsed.forEach((p, i) => {
        const z = zones.find((x) => x.code === p.zone_code);
        if (!z) errors.push({ row: i + 2, column: 'zone_code', message: `unknown zone ${p.zone_code}` });
        const key = `${p.zone_code}/${p.aisle_code}/${p.rack_code}`;
        if (dup.has(key)) errors.push({ row: i + 2, column: 'rack_code', message: 'duplicate rack in file' });
        dup.add(key);
        if (z?.aisles.find((a) => a.code === p.aisle_code)?.racks.find((r) => r.code === p.rack_code)) errors.push({ row: i + 2, column: 'rack_code', message: `rack ${key} already exists` });
        if (Number(p.bays) < 1 || Number(p.bays) > 200) errors.push({ row: i + 2, column: 'bays', message: '1-200' });
        if (Number(p.levels) < 1 || Number(p.levels) > 30) errors.push({ row: i + 2, column: 'levels', message: '1-30' });
      });
      break;
    }
    case 'INITIAL_INVENTORY': {
      const locCodes = [...new Set(parsed.map((p) => (p.location_code as string).toUpperCase()))];
      const locs = await tx.locations.findMany({ where: { code: { in: locCodes } } });
      const anyInventory = await tx.inventory_movements.count();
      if (anyInventory > 0) summary.warning = 'Warehouse already has movements; initial inventory is added as INITIAL_LOAD on top of existing stock';
      const lpnLoc = new Map<string, string>();
      parsed.forEach((p, i) => {
        const s = skuMap.get(p.sku as string);
        if (!s) errors.push({ row: i + 2, column: 'sku', message: `unknown sku ${p.sku}` });
        const loc = locs.find((l) => l.code === (p.location_code as string).toUpperCase());
        if (!loc) errors.push({ row: i + 2, column: 'location_code', message: `unknown location ${p.location_code}` });
        else if (!['RESERVE', 'PICKING'].includes(loc.location_type)) errors.push({ row: i + 2, column: 'location_code', message: `location ${loc.code} is ${loc.location_type}; initial inventory goes to RESERVE/PICKING` });
        else if (loc.admin_status !== 'ACTIVE') errors.push({ row: i + 2, column: 'location_code', message: `location ${loc.code} is ${loc.admin_status}` });
        const uom = (p.uom_code as string) || 'PIECE';
        if (s && !s.uoms.some((u) => u.uom_code === uom)) errors.push({ row: i + 2, column: 'uom_code', message: `sku ${p.sku} has no UoM ${uom}` });
        if (BigInt(p.qty as string) === 0n) errors.push({ row: i + 2, column: 'qty', message: 'qty must be > 0' });
        if (p.lpn) {
          if (!/^PLT-\d{4}-\d{8}$/.test(p.lpn as string) && !/^[A-Za-z0-9_-]{1,30}$/.test(p.lpn as string)) errors.push({ row: i + 2, column: 'lpn', message: 'lpn must be a group key (letters/digits) — real codes are generated' });
          const prev = lpnLoc.get(p.lpn as string);
          if (prev && prev !== (p.location_code as string).toUpperCase()) errors.push({ row: i + 2, column: 'lpn', message: `lpn group ${p.lpn} appears in two locations` });
          lpnLoc.set(p.lpn as string, (p.location_code as string).toUpperCase());
        }
        if (s?.requires_lot && !p.lot) errors.push({ row: i + 2, column: 'lot', message: `sku ${p.sku} requires lot` });
        if (s?.requires_expiry && !p.expiry_date) errors.push({ row: i + 2, column: 'expiry_date', message: `sku ${p.sku} requires expiry_date` });
      });
      break;
    }
    case 'ORDERS': {
      const custCodes = [...new Set(parsed.map((p) => p.customer_code as string))];
      const custs = await tx.customers.findMany({ where: { code: { in: custCodes } } });
      const orderNos = [...new Set(parsed.map((p) => p.order_number as string))];
      const existing = await tx.orders.findMany({ where: { order_number: { in: orderNos } }, select: { order_number: true } });
      const orderCustomer = new Map<string, string>();
      parsed.forEach((p, i) => {
        if (!custs.find((c) => c.code === p.customer_code)) errors.push({ row: i + 2, column: 'customer_code', message: `unknown customer ${p.customer_code}` });
        if (existing.find((e) => e.order_number === p.order_number)) errors.push({ row: i + 2, column: 'order_number', message: `order ${p.order_number} already exists` });
        const s = skuMap.get(p.sku as string);
        if (!s) errors.push({ row: i + 2, column: 'sku', message: `unknown sku ${p.sku}` });
        else if (!s.is_active) errors.push({ row: i + 2, column: 'sku', message: `sku ${p.sku} is inactive` });
        const uom = (p.uom_code as string) || 'PIECE';
        if (s && !s.uoms.some((u) => u.uom_code === uom)) errors.push({ row: i + 2, column: 'uom_code', message: `sku ${p.sku} has no UoM ${uom}` });
        if (BigInt(p.qty as string) === 0n) errors.push({ row: i + 2, column: 'qty', message: 'qty must be > 0' });
        const prev = orderCustomer.get(p.order_number as string);
        if (prev && prev !== p.customer_code) errors.push({ row: i + 2, column: 'customer_code', message: `order ${p.order_number} has two different customers` });
        orderCustomer.set(p.order_number as string, p.customer_code as string);
      });
      summary.orders = orderNos.length;
      break;
    }
    case 'PURCHASE_ORDERS': {
      const supCodes = [...new Set(parsed.map((p) => p.supplier_code as string))];
      const sups = await tx.suppliers.findMany({ where: { code: { in: supCodes } } });
      const poNos = [...new Set(parsed.map((p) => p.po_number as string))];
      const existing = await tx.purchase_orders.findMany({ where: { po_number: { in: poNos } } });
      parsed.forEach((p, i) => {
        if (!sups.find((c) => c.code === p.supplier_code)) errors.push({ row: i + 2, column: 'supplier_code', message: `unknown supplier ${p.supplier_code}` });
        if (existing.find((e) => e.po_number === p.po_number)) errors.push({ row: i + 2, column: 'po_number', message: `PO ${p.po_number} already exists` });
        const s = skuMap.get(p.sku as string);
        if (!s) errors.push({ row: i + 2, column: 'sku', message: `unknown sku ${p.sku}` });
        const uom = (p.uom_code as string) || 'CASE';
        if (s && !s.uoms.some((u) => u.uom_code === uom)) errors.push({ row: i + 2, column: 'uom_code', message: `sku ${p.sku} has no UoM ${uom}` });
      });
      summary.purchase_orders = poNos.length;
      break;
    }
  }
  return { ok: errors.length === 0, total_rows: rows.length, valid_rows: errors.length ? 0 : parsed.length, errors: errors.slice(0, 1000), summary };
}

function isOptionalColumn(type: ImportType, c: string): boolean {
  const optional: Record<ImportType, string[]> = {
    SKUS: ['family', 'compatibility_group', 'abc_class', 'unit_weight_kg', 'case_qty', 'pallet_cases', 'inner_qty', 'requires_lot', 'requires_expiry'],
    BARCODES: ['uom_code'],
    CUSTOMERS: ['tax_id', 'address'],
    SUPPLIERS: ['tax_id', 'contact'],
    LOCATIONS: ['zone_code', 'x_m', 'y_m', 'width_m', 'depth_m', 'height_m', 'pallet_capacity', 'max_weight_kg'],
    RACKS: ['positions_per_bay', 'bay_width_m', 'level_height_m', 'depth_m', 'x_m', 'y_m', 'rotation_deg', 'location_type', 'pallet_capacity', 'max_weight_kg'],
    INITIAL_INVENTORY: ['uom_code', 'lot', 'expiry_date', 'lpn'],
    ORDERS: ['destination', 'order_date', 'priority', 'uom_code'],
    PURCHASE_ORDERS: ['expected_date', 'uom_code'],
  };
  return optional[type].includes(c);
}

// ---------------------------------------------------------------------
// Apply: all-or-nothing in one transaction. The same file (sha256) can only
// be applied once per import type (partial unique index) — a double upload
// under bad Wi-Fi cannot duplicate orders or inventory.
// ---------------------------------------------------------------------
export async function runImport(ctx: ActorContext, type: ImportType, buf: Buffer, fileName: string, mode: 'VALIDATE' | 'APPLY') {
  const sha = createHash('sha256').update(buf).digest('hex');
  const { rows, errors: parseErrors } = await parseFile(buf, fileName);
  const db = getDb();
  if (mode === 'APPLY') {
    const applied = await db.import_jobs.findFirst({ where: { import_type: type, file_sha256: sha, status: 'APPLIED' } });
    if (applied) throw new ConflictError('IMPORT_ALREADY_APPLIED', `This exact file was already imported on ${applied.applied_at?.toISOString()}`, { job_id: applied.id });
  }
  return withTx(async (tx) => {
    const validation = await validateRows(tx, type, rows, parseErrors);
    const job = await tx.import_jobs.create({
      data: { import_type: type, file_name: fileName.slice(0, 255), file_sha256: sha, status: validation.ok ? 'VALIDATED' : 'REJECTED', total_rows: validation.total_rows, valid_rows: validation.valid_rows, error_rows: validation.errors.length, errors: validation.errors as unknown as object, summary: validation.summary as object, created_by: ctx.userId },
    });
    if (!validation.ok || mode === 'VALIDATE') {
      return { job_id: job.id, status: job.status, ...validation };
    }
    const parsed = rows.map((r) => ROW_SCHEMAS[type].parse(r) as Record<string, string>);
    const result = await applyRows(tx, ctx, type, parsed);
    await tx.import_jobs.update({ where: { id: job.id }, data: { status: 'APPLIED', applied_at: new Date(), summary: { ...validation.summary, ...result } as object } });
    await audit(tx, ctx, { action: `import.${type.toLowerCase()}`, entity_type: 'import_job', entity_id: job.id, after: { file: fileName, rows: rows.length, result } });
    return { job_id: job.id, status: 'APPLIED', ...validation, result };
  });
}

type KnownCol =
  | 'sku' | 'description' | 'family' | 'compatibility_group' | 'abc_class' | 'unit_weight_kg' | 'case_qty' | 'pallet_cases' | 'inner_qty' | 'requires_lot' | 'requires_expiry'
  | 'barcode' | 'uom_code' | 'code' | 'name' | 'tax_id' | 'address' | 'contact' | 'location_type' | 'zone_code' | 'x_m' | 'y_m' | 'width_m' | 'depth_m' | 'height_m'
  | 'pallet_capacity' | 'max_weight_kg' | 'aisle_code' | 'rack_code' | 'bays' | 'levels' | 'positions_per_bay' | 'bay_width_m' | 'level_height_m' | 'rotation_deg'
  | 'location_code' | 'qty' | 'lot' | 'expiry_date' | 'lpn' | 'order_number' | 'customer_code' | 'destination' | 'order_date' | 'priority' | 'po_number' | 'supplier_code' | 'expected_date';
type ParsedRow = Record<KnownCol, string>;

async function applyRows(tx: Tx, ctx: ActorContext, type: ImportType, rowsIn: Record<string, string>[]): Promise<Record<string, unknown>> {
  const rows = rowsIn as ParsedRow[];
  switch (type) {
    case 'SKUS': {
      let created = 0;
      let updated = 0;
      for (const r of rows) {
        const caseQ = r.case_qty ? BigInt(r.case_qty) : null;
        const palletC = r.pallet_cases ? BigInt(r.pallet_cases) : null;
        const innerQ = r.inner_qty ? BigInt(r.inner_qty) : null;
        const uoms = [{ uom_code: 'PIECE', base_qty: 1n }];
        if (innerQ) uoms.push({ uom_code: 'INNER', base_qty: innerQ });
        if (caseQ) uoms.push({ uom_code: 'CASE', base_qty: caseQ });
        if (caseQ && palletC) uoms.push({ uom_code: 'PALLET', base_qty: caseQ * palletC });
        const data = {
          description: r.description,
          family: r.family || null,
          compatibility_group: r.compatibility_group || null,
          abc_class: r.abc_class || 'C',
          unit_weight_kg: r.unit_weight_kg ? Number(r.unit_weight_kg) : 0,
          requires_lot: r.requires_lot === 'true' || (r.requires_lot as unknown) === true,
          requires_expiry: r.requires_expiry === 'true' || (r.requires_expiry as unknown) === true,
        };
        const ex = await tx.skus.findUnique({ where: { code: r.sku } });
        if (ex) {
          await tx.skus.update({ where: { id: ex.id }, data });
          await tx.sku_uoms.deleteMany({ where: { sku_id: ex.id } });
          await tx.sku_uoms.createMany({ data: uoms.map((u) => ({ sku_id: ex.id, ...u })) });
          updated++;
        } else {
          await tx.skus.create({ data: { code: r.sku, ...data, uoms: { create: uoms } } });
          created++;
        }
      }
      return { created, updated };
    }
    case 'BARCODES': {
      let n = 0;
      for (const r of rows) {
        const sku = await tx.skus.findUniqueOrThrow({ where: { code: r.sku } });
        await tx.sku_barcodes.upsert({ where: { barcode: r.barcode }, create: { sku_id: sku.id, barcode: r.barcode, uom_code: r.uom_code || 'PIECE' }, update: { uom_code: r.uom_code || 'PIECE' } });
        n++;
      }
      return { upserted: n };
    }
    case 'CUSTOMERS': {
      let n = 0;
      for (const r of rows) {
        await tx.customers.upsert({ where: { code: r.code }, create: { code: r.code, name: r.name, tax_id: r.tax_id || null, address: r.address || null }, update: { name: r.name, tax_id: r.tax_id || null, address: r.address || null } });
        n++;
      }
      return { upserted: n };
    }
    case 'SUPPLIERS': {
      let n = 0;
      for (const r of rows) {
        await tx.suppliers.upsert({ where: { code: r.code }, create: { code: r.code, name: r.name, tax_id: r.tax_id || null, contact: r.contact || null }, update: { name: r.name, tax_id: r.tax_id || null, contact: r.contact || null } });
        n++;
      }
      return { upserted: n };
    }
    case 'LOCATIONS': {
      const wh = await tx.warehouses.findFirstOrThrow({ where: { is_active: true }, orderBy: { created_at: 'asc' } });
      let created = 0;
      let updated = 0;
      for (const r of rows) {
        const zone = r.zone_code ? await tx.zones.findFirst({ where: { code: r.zone_code } }) : null;
        const code = r.code.toUpperCase();
        const data = {
          location_type: r.location_type,
          zone_id: zone?.id ?? null,
          x_m: r.x_m ? Number(r.x_m) : 0,
          y_m: r.y_m ? Number(r.y_m) : 0,
          width_m: r.width_m ? Number(r.width_m) : 1.2,
          depth_m: r.depth_m ? Number(r.depth_m) : 1.2,
          height_m: r.height_m ? Number(r.height_m) : 1.8,
          pallet_capacity: r.pallet_capacity ? Number(r.pallet_capacity) : 1,
          max_weight_kg: r.max_weight_kg ? Number(r.max_weight_kg) : 1500,
        };
        const ex = await tx.locations.findFirst({ where: { warehouse_id: wh.id, code } });
        if (ex) {
          await tx.locations.update({ where: { id: ex.id }, data });
          updated++;
        } else {
          await tx.locations.create({ data: { warehouse_id: wh.id, code, barcode: `LOC-${code}`, ...data } });
          created++;
        }
      }
      return { created, updated };
    }
    case 'RACKS': {
      const { syncRackLocations } = await import('../layout/service.js');
      let racks = 0;
      let locations = 0;
      for (const r of rows) {
        const zone = await tx.zones.findFirstOrThrow({ where: { code: r.zone_code } });
        let aisle = await tx.aisles.findFirst({ where: { zone_id: zone.id, code: r.aisle_code } });
        if (!aisle) aisle = await tx.aisles.create({ data: { zone_id: zone.id, code: r.aisle_code } });
        const geometry = {
          bays: Number(r.bays),
          levels: Number(r.levels),
          positions_per_bay: r.positions_per_bay ? Number(r.positions_per_bay) : 1,
          bay_width_m: r.bay_width_m ? Number(r.bay_width_m) : 2.7,
          level_height_m: r.level_height_m ? Number(r.level_height_m) : 1.8,
          depth_m: r.depth_m ? Number(r.depth_m) : 1.2,
          x_m: r.x_m ? Number(r.x_m) : 0,
          y_m: r.y_m ? Number(r.y_m) : 0,
          rotation_deg: r.rotation_deg ? Number(r.rotation_deg) : 0,
        };
        const rack = await tx.racks.create({ data: { aisle_id: aisle.id, code: r.rack_code, ...geometry } });
        const gen = await syncRackLocations(tx, { ...rack, ...geometry }, { location_type: r.location_type || 'RESERVE', pallet_capacity: r.pallet_capacity ? Number(r.pallet_capacity) : 1, max_weight_kg: r.max_weight_kg ? Number(r.max_weight_kg) : 1500 });
        racks++;
        locations += gen.created;
      }
      return { racks, locations };
    }
    case 'INITIAL_INVENTORY': {
      const groups = new Map<string, { id: string; code: string }>();
      let lpns = 0;
      let movements = 0;
      for (const r of rows) {
        const sku = await tx.skus.findUniqueOrThrow({ where: { code: r.sku } });
        const loc = await lockLocationByBarcode(tx, r.location_code.toUpperCase());
        const uom = (r.uom_code || 'PIECE') as UomCode;
        const uomRow = await tx.sku_uoms.findUniqueOrThrow({ where: { sku_id_uom_code: { sku_id: sku.id, uom_code: uom } } });
        const base = BigInt(r.qty) * uomRow.base_qty;
        let lpnRef = r.lpn ? groups.get(r.lpn) : undefined;
        let lpnRow;
        if (!lpnRef) {
          lpnRow = await createLpn(tx, ctx, { warehouse_id: loc.warehouse_id, lpn_type: 'STORAGE', location_id: loc.id, lot: r.lot || null, expiry_date: r.expiry_date ? new Date(r.expiry_date) : null });
          await tx.lpns.update({ where: { id: lpnRow.id }, data: { status: 'STORED' } });
          lpnRef = { id: lpnRow.id, code: lpnRow.code };
          if (r.lpn) groups.set(r.lpn, lpnRef);
          lpns++;
        } else {
          const rows2 = await tx.$queryRaw<{ id: string; code: string; lpn_type: string; status: string; warehouse_id: string; current_location_id: string | null; receipt_id: string | null; container_id: string | null; supplier_id: string | null; order_id: string | null; shipment_id: string | null; cases_count: number; weight_kg: string | null; version: number }[]>`
            SELECT id, code, lpn_type, status, warehouse_id, current_location_id, receipt_id, container_id, supplier_id, order_id, shipment_id, cases_count, weight_kg::text AS weight_kg, version FROM lpns WHERE id = ${lpnRef.id}::uuid FOR UPDATE`;
          lpnRow = rows2[0]!;
        }
        await createInventory(tx, ctx, { movement_type: 'INITIAL_LOAD', to_lpn: lpnRow, sku_id: sku.id, qty: base, uom_code: uom, uom_qty: BigInt(r.qty), status: 'AVAILABLE', location_id: loc.id, reference_type: 'import', reason: 'Initial inventory load' });
        movements++;
      }
      return { lpns, movements };
    }
    case 'ORDERS': {
      const byOrder = new Map<string, ParsedRow[]>();
      for (const r of rows) byOrder.set(r.order_number, [...(byOrder.get(r.order_number) ?? []), r]);
      let n = 0;
      for (const [num, lines] of byOrder) {
        const first = lines[0]!;
        await createOrder(tx, ctx, {
          order_number: num,
          customer_code: first.customer_code,
          destination: first.destination || undefined,
          order_date: first.order_date ? new Date(first.order_date) : undefined,
          priority: first.priority ? Number(first.priority) : 5,
          source: 'IMPORT',
          lines: lines.map((l) => ({ sku_code: l.sku, qty: BigInt(l.qty), uom_code: (l.uom_code || 'PIECE') as UomCode })),
        });
        n++;
      }
      return { orders: n, lines: rows.length };
    }
    case 'PURCHASE_ORDERS': {
      const byPo = new Map<string, ParsedRow[]>();
      for (const r of rows) byPo.set(r.po_number, [...(byPo.get(r.po_number) ?? []), r]);
      let n = 0;
      for (const [num, lines] of byPo) {
        const first = lines[0]!;
        const supplier = await tx.suppliers.findUniqueOrThrow({ where: { code: first.supplier_code } });
        const poLines = [];
        let ln = 1;
        for (const l of lines) {
          const sku = await tx.skus.findUniqueOrThrow({ where: { code: l.sku } });
          const uom = (l.uom_code || 'CASE') as UomCode;
          const uomRow = await tx.sku_uoms.findUniqueOrThrow({ where: { sku_id_uom_code: { sku_id: sku.id, uom_code: uom } } });
          poLines.push({ line_no: ln++, sku_id: sku.id, ordered_qty: BigInt(l.qty) * uomRow.base_qty, uom_code: uom, uom_qty: BigInt(l.qty) });
        }
        await tx.purchase_orders.create({ data: { po_number: num, supplier_id: supplier.id, expected_date: first.expected_date ? new Date(first.expected_date) : null, created_by: ctx.userId, lines: { create: poLines } } });
        n++;
      }
      return { purchase_orders: n, lines: rows.length };
    }
  }
}

export async function importJob(id: string) {
  const j = await getDb().import_jobs.findUnique({ where: { id } });
  if (!j) throw new NotFoundError('import job', id);
  return j;
}
