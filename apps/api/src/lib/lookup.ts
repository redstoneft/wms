import { UomTable, type UomCode } from '@wms/shared';
import type { Tx } from '../db.js';
import { NotFoundError, RuleError } from '../errors.js';

export interface SkuRow {
  id: string;
  code: string;
  description: string;
  family: string | null;
  compatibility_group: string | null;
  abc_class: string;
  unit_weight_kg: string;
  allow_negative: boolean;
  is_active: boolean;
  requires_lot: boolean;
  requires_expiry: boolean;
}

export async function getSkuByCode(tx: Tx, code: string): Promise<SkuRow> {
  const rows = await tx.$queryRaw<SkuRow[]>`SELECT id, code, description, family, compatibility_group, abc_class, unit_weight_kg::text AS unit_weight_kg,
      allow_negative, is_active, requires_lot, requires_expiry FROM skus WHERE code = ${code.trim()}`;
  const r = rows[0];
  if (!r) throw new NotFoundError('SKU', code);
  return r;
}

export async function getSkuById(tx: Tx, id: string): Promise<SkuRow> {
  const rows = await tx.$queryRaw<SkuRow[]>`SELECT id, code, description, family, compatibility_group, abc_class, unit_weight_kg::text AS unit_weight_kg,
      allow_negative, is_active, requires_lot, requires_expiry FROM skus WHERE id = ${id}::uuid`;
  const r = rows[0];
  if (!r) throw new NotFoundError('SKU', id);
  return r;
}

/** Resolve a scanned barcode (SKU code or any registered barcode) to a SKU + packaging level. */
export async function resolveSkuBarcode(tx: Tx, scanned: string): Promise<{ sku: SkuRow; uom_code: UomCode }> {
  const s = scanned.trim();
  if (!s) throw new RuleError('EMPTY_SCAN', 'Empty barcode');
  const rows = await tx.$queryRaw<{ sku_id: string; uom_code: UomCode }[]>`SELECT sku_id, uom_code FROM sku_barcodes WHERE barcode = ${s}`;
  if (rows[0]) return { sku: await getSkuById(tx, rows[0].sku_id), uom_code: rows[0].uom_code };
  const bySku = await tx.$queryRaw<SkuRow[]>`SELECT id, code, description, family, compatibility_group, abc_class, unit_weight_kg::text AS unit_weight_kg,
      allow_negative, is_active, requires_lot, requires_expiry FROM skus WHERE code = ${s}`;
  if (bySku[0]) return { sku: bySku[0], uom_code: 'PIECE' };
  throw new NotFoundError('barcode', s);
}

export async function uomTableFor(tx: Tx, skuId: string): Promise<UomTable> {
  const rows = await tx.$queryRaw<{ uom_code: UomCode; base_qty: bigint }[]>`SELECT uom_code, base_qty FROM sku_uoms WHERE sku_id = ${skuId}::uuid`;
  return new UomTable(rows.map((r) => ({ uom_code: r.uom_code, base_qty: r.base_qty })));
}

/** Convert a scanned quantity (in uom) to base units, validating the UoM exists for the SKU. */
export async function toBaseQty(tx: Tx, skuId: string, qty: bigint, uom: UomCode): Promise<{ base: bigint; table: UomTable }> {
  const table = await uomTableFor(tx, skuId);
  if (!table.has(uom)) throw new RuleError('UOM_NOT_DEFINED', `UoM ${uom} is not defined for this SKU`);
  return { base: table.toBase(qty, uom), table };
}

export async function getWarehouseDefault(tx: Tx): Promise<{ id: string; code: string }> {
  const rows = await tx.$queryRaw<{ id: string; code: string }[]>`SELECT id, code FROM warehouses WHERE is_active ORDER BY created_at LIMIT 1`;
  if (!rows[0]) throw new RuleError('NO_WAREHOUSE', 'No active warehouse configured');
  return rows[0];
}

export async function findLocationOfType(tx: Tx, warehouseId: string, type: string): Promise<{ id: string; code: string; barcode: string } | null> {
  const rows = await tx.$queryRaw<{ id: string; code: string; barcode: string }[]>`SELECT id, code, barcode FROM locations
    WHERE warehouse_id = ${warehouseId}::uuid AND location_type = ${type} AND is_active AND admin_status = 'ACTIVE' ORDER BY code LIMIT 1`;
  return rows[0] ?? null;
}
