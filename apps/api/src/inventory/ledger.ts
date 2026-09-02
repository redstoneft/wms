// =====================================================================
// THE LEDGER API. Every quantity change in the warehouse goes through here.
//
//  * A movement row is INSERTed; the database trigger applies the balance
//    deltas (CHECK qty >= 0 aborts the transaction on shortage) and moves the
//    LPN to the destination location.
//  * Callers must already hold row locks (lockLpn) so that concurrent operators
//    serialize on the LPN and get a clean business error instead of a
//    constraint violation — but the constraint is the last line of defence.
//  * Nothing here ever writes inventory_balances directly.
// =====================================================================

import type { InventoryStatus, MovementType, UomCode } from '@wms/shared';
import type { Tx } from '../db.js';
import { NotFoundError, RuleError } from '../errors.js';
import type { ActorContext } from '../lib/context.js';

export interface MovementRefs {
  reference_type?: string | null;
  reference_id?: string | null;
  order_id?: string | null;
  receipt_id?: string | null;
  shipment_id?: string | null;
  transfer_id?: string | null;
  task_id?: string | null;
  incident_id?: string | null;
  reason?: string | null;
  note?: string | null;
}

export interface MovementInput extends MovementRefs {
  movement_type: MovementType;
  sku_id: string;
  qty: bigint;
  uom_code?: UomCode;
  uom_qty?: bigint;
  from_lpn_id?: string | null;
  to_lpn_id?: string | null;
  from_location_id?: string | null;
  to_location_id?: string | null;
  from_status?: InventoryStatus | null;
  to_status?: InventoryStatus | null;
  /** distinct sub-key when one request produces several movements */
  idempotency_suffix?: string;
}

export interface LpnRow {
  id: string;
  code: string;
  lpn_type: string;
  status: string;
  warehouse_id: string;
  current_location_id: string | null;
  receipt_id: string | null;
  container_id: string | null;
  supplier_id: string | null;
  order_id: string | null;
  shipment_id: string | null;
  cases_count: number;
  weight_kg: string | null;
  version: number;
}

export interface BalanceRow {
  id: string;
  lpn_id: string;
  sku_id: string;
  status: InventoryStatus;
  qty: bigint;
  version: number;
}

export interface LocationRow {
  id: string;
  warehouse_id: string;
  zone_id: string | null;
  rack_id: string | null;
  code: string;
  barcode: string;
  location_type: string;
  admin_status: string;
  pallet_capacity: number;
  max_weight_kg: string;
  height_m: string;
  restrictions: Record<string, unknown> | null;
  is_active: boolean;
  level: number | null;
  pick_sequence: number | null;
}

/** Lock an LPN row (FOR UPDATE). Throws NotFound if missing. */
export async function lockLpn(tx: Tx, lpnId: string): Promise<LpnRow> {
  const rows = await tx.$queryRaw<LpnRow[]>`SELECT id, code, lpn_type, status, warehouse_id, current_location_id, receipt_id, container_id,
      supplier_id, order_id, shipment_id, cases_count, weight_kg::text AS weight_kg, version
    FROM lpns WHERE id = ${lpnId}::uuid FOR UPDATE`;
  const row = rows[0];
  if (!row) throw new NotFoundError('LPN', lpnId);
  return row;
}

export async function lockLpnByCode(tx: Tx, code: string): Promise<LpnRow> {
  const rows = await tx.$queryRaw<LpnRow[]>`SELECT id, code, lpn_type, status, warehouse_id, current_location_id, receipt_id, container_id,
      supplier_id, order_id, shipment_id, cases_count, weight_kg::text AS weight_kg, version
    FROM lpns WHERE code = ${code.trim().toUpperCase()} FOR UPDATE`;
  const row = rows[0];
  if (!row) throw new NotFoundError('LPN', code);
  return row;
}

/** Lock several LPNs in a deterministic order (avoids deadlocks). */
export async function lockLpns(tx: Tx, lpnIds: string[]): Promise<Map<string, LpnRow>> {
  const ids = [...new Set(lpnIds)].sort();
  const out = new Map<string, LpnRow>();
  for (const id of ids) out.set(id, await lockLpn(tx, id));
  return out;
}

export async function lockLocation(tx: Tx, locationId: string): Promise<LocationRow> {
  const rows = await tx.$queryRaw<LocationRow[]>`SELECT id, warehouse_id, zone_id, rack_id, code, barcode, location_type, admin_status,
      pallet_capacity, max_weight_kg::text AS max_weight_kg, height_m::text AS height_m, restrictions, is_active, level, pick_sequence
    FROM locations WHERE id = ${locationId}::uuid FOR UPDATE`;
  const row = rows[0];
  if (!row) throw new NotFoundError('location', locationId);
  return row;
}

export async function lockLocationByBarcode(tx: Tx, barcode: string): Promise<LocationRow> {
  // exact barcode match wins; the human-readable code is only a fallback (avoids ambiguity when a barcode equals another location's code)
  const byBarcode = await tx.$queryRaw<LocationRow[]>`SELECT id, warehouse_id, zone_id, rack_id, code, barcode, location_type, admin_status,
      pallet_capacity, max_weight_kg::text AS max_weight_kg, height_m::text AS height_m, restrictions, is_active, level, pick_sequence
    FROM locations WHERE barcode = ${barcode.trim()} FOR UPDATE`;
  if (byBarcode[0]) return byBarcode[0];
  const byCode = await tx.$queryRaw<LocationRow[]>`SELECT id, warehouse_id, zone_id, rack_id, code, barcode, location_type, admin_status,
      pallet_capacity, max_weight_kg::text AS max_weight_kg, height_m::text AS height_m, restrictions, is_active, level, pick_sequence
    FROM locations WHERE code = ${barcode.trim().toUpperCase()} FOR UPDATE`;
  const row = byCode[0];
  if (!row) throw new NotFoundError('location', barcode);
  return row;
}

/** Balances of an LPN (locked). */
export async function lockBalances(tx: Tx, lpnId: string): Promise<BalanceRow[]> {
  return tx.$queryRaw<BalanceRow[]>`SELECT id, lpn_id, sku_id, status, qty, version FROM inventory_balances
    WHERE lpn_id = ${lpnId}::uuid AND qty > 0 ORDER BY sku_id, status FOR UPDATE`;
}

export async function getBalance(tx: Tx, lpnId: string, skuId: string, status: InventoryStatus): Promise<bigint> {
  const rows = await tx.$queryRaw<{ qty: bigint }[]>`SELECT qty FROM inventory_balances
    WHERE lpn_id = ${lpnId}::uuid AND sku_id = ${skuId}::uuid AND status = ${status} FOR UPDATE`;
  return rows[0]?.qty ?? 0n;
}

/**
 * Inserts one ledger row. The trigger does the rest. Returns the movement id.
 */
export async function recordMovement(tx: Tx, ctx: ActorContext, m: MovementInput): Promise<bigint> {
  if (m.qty <= 0n) throw new RuleError('INVALID_QTY', 'Movement quantity must be > 0');
  const idem = ctx.idempotencyKey ? `${ctx.userId}:${ctx.idempotencyKey}:${m.idempotency_suffix ?? m.movement_type}` : null;
  const rows = await tx.$queryRaw<{ id: bigint }[]>`
    INSERT INTO inventory_movements (
      movement_type, sku_id, qty, uom_code, uom_qty, from_lpn_id, to_lpn_id, from_location_id, to_location_id,
      from_status, to_status, user_id, device_id, occurred_at, reference_type, reference_id, order_id, receipt_id,
      shipment_id, transfer_id, task_id, incident_id, reason, note, idempotency_key)
    VALUES (
      ${m.movement_type}, ${m.sku_id}::uuid, ${m.qty}, ${m.uom_code ?? 'PIECE'}, ${m.uom_qty ?? m.qty},
      ${m.from_lpn_id ?? null}::uuid, ${m.to_lpn_id ?? null}::uuid, ${m.from_location_id ?? null}::uuid, ${m.to_location_id ?? null}::uuid,
      ${m.from_status ?? null}, ${m.to_status ?? null}, ${ctx.userId}::uuid, ${ctx.deviceId}, now(),
      ${m.reference_type ?? null}, ${m.reference_id ?? null}, ${m.order_id ?? null}::uuid, ${m.receipt_id ?? null}::uuid,
      ${m.shipment_id ?? null}::uuid, ${m.transfer_id ?? null}::uuid, ${m.task_id ?? null}::uuid, ${m.incident_id ?? null}::uuid,
      ${m.reason ?? null}, ${m.note ?? null}, ${idem})
    RETURNING id`;
  return rows[0]!.id;
}

// ---------------------------------------------------------------------
// Higher-level primitives (all require the caller to have locked the LPN)
// ---------------------------------------------------------------------

/** Create inventory out of nothing (receipt, adjustment in, return, initial load). */
export async function createInventory(
  tx: Tx,
  ctx: ActorContext,
  p: { movement_type: MovementType; to_lpn: LpnRow; sku_id: string; qty: bigint; uom_code?: UomCode; uom_qty?: bigint; status: InventoryStatus; location_id: string } & MovementRefs,
): Promise<bigint> {
  return recordMovement(tx, ctx, {
    movement_type: p.movement_type,
    sku_id: p.sku_id,
    qty: p.qty,
    uom_code: p.uom_code,
    uom_qty: p.uom_qty,
    to_lpn_id: p.to_lpn.id,
    to_location_id: p.location_id,
    to_status: p.status,
    reference_type: p.reference_type,
    reference_id: p.reference_id,
    order_id: p.order_id,
    receipt_id: p.receipt_id,
    shipment_id: p.shipment_id,
    transfer_id: p.transfer_id,
    task_id: p.task_id,
    incident_id: p.incident_id,
    reason: p.reason,
    note: p.note,
    idempotency_suffix: `${p.movement_type}:${p.to_lpn.id}:${p.sku_id}`,
  });
}

/** Remove inventory (ship, adjustment out, scrap). */
export async function removeInventory(
  tx: Tx,
  ctx: ActorContext,
  p: { movement_type: MovementType; from_lpn: LpnRow; sku_id: string; qty: bigint; uom_code?: UomCode; uom_qty?: bigint; status: InventoryStatus } & MovementRefs,
): Promise<bigint> {
  const have = await getBalance(tx, p.from_lpn.id, p.sku_id, p.status);
  if (have < p.qty) {
    throw new RuleError('INSUFFICIENT_INVENTORY', `LPN ${p.from_lpn.code} has ${have} in ${p.status}, requested ${p.qty}`, {
      lpn: p.from_lpn.code,
      available: have.toString(),
      requested: p.qty.toString(),
    });
  }
  return recordMovement(tx, ctx, {
    movement_type: p.movement_type,
    sku_id: p.sku_id,
    qty: p.qty,
    uom_code: p.uom_code,
    uom_qty: p.uom_qty,
    from_lpn_id: p.from_lpn.id,
    from_location_id: p.from_lpn.current_location_id,
    from_status: p.status,
    reference_type: p.reference_type,
    reference_id: p.reference_id,
    order_id: p.order_id,
    receipt_id: p.receipt_id,
    shipment_id: p.shipment_id,
    transfer_id: p.transfer_id,
    task_id: p.task_id,
    incident_id: p.incident_id,
    reason: p.reason,
    note: p.note,
    idempotency_suffix: `${p.movement_type}:${p.from_lpn.id}:${p.sku_id}:${p.status}`,
  });
}

/** Change the status of (part of) a SKU inside an LPN, in place. */
export async function changeStatus(
  tx: Tx,
  ctx: ActorContext,
  p: { movement_type: MovementType; lpn: LpnRow; sku_id: string; qty: bigint; from_status: InventoryStatus; to_status: InventoryStatus } & MovementRefs,
): Promise<bigint> {
  if (p.from_status === p.to_status) throw new RuleError('INVALID_MOVEMENT', 'from_status equals to_status');
  const have = await getBalance(tx, p.lpn.id, p.sku_id, p.from_status);
  if (have < p.qty) {
    throw new RuleError('INSUFFICIENT_INVENTORY', `LPN ${p.lpn.code} has ${have} in ${p.from_status}, requested ${p.qty}`, {
      lpn: p.lpn.code,
      available: have.toString(),
      requested: p.qty.toString(),
      status: p.from_status,
    });
  }
  return recordMovement(tx, ctx, {
    movement_type: p.movement_type,
    sku_id: p.sku_id,
    qty: p.qty,
    from_lpn_id: p.lpn.id,
    to_lpn_id: p.lpn.id,
    from_location_id: p.lpn.current_location_id,
    to_location_id: p.lpn.current_location_id,
    from_status: p.from_status,
    to_status: p.to_status,
    reference_type: p.reference_type,
    reference_id: p.reference_id,
    order_id: p.order_id,
    receipt_id: p.receipt_id,
    shipment_id: p.shipment_id,
    transfer_id: p.transfer_id,
    task_id: p.task_id,
    incident_id: p.incident_id,
    reason: p.reason,
    note: p.note,
    idempotency_suffix: `${p.movement_type}:${p.lpn.id}:${p.sku_id}:${p.from_status}>${p.to_status}`,
  });
}

/**
 * Move a whole LPN (every SKU / every status, or only the given status) to a
 * new location, optionally changing status. Because the location lives on the
 * LPN row, the pallet can never be half-moved.
 */
export async function moveLpn(
  tx: Tx,
  ctx: ActorContext,
  p: {
    movement_type: MovementType;
    lpn: LpnRow;
    to_location_id: string;
    only_status?: InventoryStatus;
    to_status?: InventoryStatus; // if omitted, status is preserved
  } & MovementRefs,
): Promise<bigint[]> {
  const balances = await lockBalances(tx, p.lpn.id);
  const relevant = p.only_status ? balances.filter((b) => b.status === p.only_status) : balances;
  if (relevant.length === 0) throw new RuleError('EMPTY_LPN', `LPN ${p.lpn.code} has no inventory to move`);
  if (p.only_status && relevant.length !== balances.length) {
    throw new RuleError('MIXED_STATUS_LPN', `LPN ${p.lpn.code} contains inventory in other statuses; it cannot be moved partially`);
  }
  const ids: bigint[] = [];
  for (const b of relevant) {
    const toStatus = p.to_status ?? b.status;
    if (p.lpn.current_location_id === p.to_location_id && toStatus === b.status) {
      throw new RuleError('SAME_LOCATION', `LPN ${p.lpn.code} is already in the destination location`);
    }
    ids.push(
      await recordMovement(tx, ctx, {
        movement_type: p.movement_type,
        sku_id: b.sku_id,
        qty: b.qty,
        from_lpn_id: p.lpn.id,
        to_lpn_id: p.lpn.id,
        from_location_id: p.lpn.current_location_id,
        to_location_id: p.to_location_id,
        from_status: b.status,
        to_status: toStatus,
        reference_type: p.reference_type,
        reference_id: p.reference_id,
        order_id: p.order_id,
        receipt_id: p.receipt_id,
        shipment_id: p.shipment_id,
        transfer_id: p.transfer_id,
        task_id: p.task_id,
        incident_id: p.incident_id,
        reason: p.reason,
        note: p.note,
        idempotency_suffix: `${p.movement_type}:${p.lpn.id}:${b.sku_id}:${b.status}`,
      }),
    );
  }
  return ids;
}

/** Move quantity of a SKU from one LPN to another (pick to outbound pallet, split, consolidate). */
export async function transferBetweenLpns(
  tx: Tx,
  ctx: ActorContext,
  p: {
    movement_type: MovementType;
    from_lpn: LpnRow;
    to_lpn: LpnRow;
    sku_id: string;
    qty: bigint;
    uom_code?: UomCode;
    uom_qty?: bigint;
    from_status: InventoryStatus;
    to_status: InventoryStatus;
    /** where the receiving LPN physically is after this movement (defaults to from LPN location) */
    to_location_id?: string | null;
  } & MovementRefs,
): Promise<bigint> {
  if (p.from_lpn.id === p.to_lpn.id) throw new RuleError('INVALID_MOVEMENT', 'from and to LPN are the same');
  const have = await getBalance(tx, p.from_lpn.id, p.sku_id, p.from_status);
  if (have < p.qty) {
    throw new RuleError('INSUFFICIENT_INVENTORY', `LPN ${p.from_lpn.code} has ${have} in ${p.from_status}, requested ${p.qty}`, {
      lpn: p.from_lpn.code,
      available: have.toString(),
      requested: p.qty.toString(),
    });
  }
  return recordMovement(tx, ctx, {
    movement_type: p.movement_type,
    sku_id: p.sku_id,
    qty: p.qty,
    uom_code: p.uom_code,
    uom_qty: p.uom_qty,
    from_lpn_id: p.from_lpn.id,
    to_lpn_id: p.to_lpn.id,
    from_location_id: p.from_lpn.current_location_id,
    to_location_id: p.to_location_id ?? p.from_lpn.current_location_id,
    from_status: p.from_status,
    to_status: p.to_status,
    reference_type: p.reference_type,
    reference_id: p.reference_id,
    order_id: p.order_id,
    receipt_id: p.receipt_id,
    shipment_id: p.shipment_id,
    transfer_id: p.transfer_id,
    task_id: p.task_id,
    incident_id: p.incident_id,
    reason: p.reason,
    note: p.note,
    idempotency_suffix: `${p.movement_type}:${p.from_lpn.id}>${p.to_lpn.id}:${p.sku_id}`,
  });
}

/** Creates a new LPN row with a never-reused code. */
export async function createLpn(
  tx: Tx,
  ctx: ActorContext,
  p: {
    warehouse_id: string;
    lpn_type: 'INBOUND' | 'STORAGE' | 'OUTBOUND' | 'RETURN';
    location_id: string | null;
    receipt_id?: string | null;
    container_id?: string | null;
    supplier_id?: string | null;
    order_id?: string | null;
    parent_lpn_id?: string | null;
    lot?: string | null;
    /** ISO date YYYY-MM-DD (never a JS Date: avoids timezone shifts) */
    expiry_date?: string | null;
    weight_kg?: number | null;
    cases_count?: number;
  },
): Promise<LpnRow> {
  const rows = await tx.$queryRaw<LpnRow[]>`
    INSERT INTO lpns (code, lpn_type, status, warehouse_id, current_location_id, receipt_id, container_id, supplier_id, order_id,
                      parent_lpn_id, lot, expiry_date, weight_kg, cases_count, created_by)
    VALUES (next_lpn_code(), ${p.lpn_type}, 'OPEN', ${p.warehouse_id}::uuid, ${p.location_id}::uuid, ${p.receipt_id ?? null}::uuid,
            ${p.container_id ?? null}::uuid, ${p.supplier_id ?? null}::uuid, ${p.order_id ?? null}::uuid, ${p.parent_lpn_id ?? null}::uuid,
            ${p.lot ?? null}, ${p.expiry_date ?? null}::date, ${p.weight_kg ?? null}, ${p.cases_count ?? 0}, ${ctx.userId}::uuid)
    RETURNING id, code, lpn_type, status, warehouse_id, current_location_id, receipt_id, container_id, supplier_id, order_id, shipment_id,
              cases_count, weight_kg::text AS weight_kg, version`;
  return rows[0]!;
}

export async function setLpnStatus(tx: Tx, lpnId: string, status: string, extra: { shipment_id?: string | null; order_id?: string | null } = {}): Promise<void> {
  await tx.lpns.update({ where: { id: lpnId }, data: { status, ...extra, version: { increment: 1 } } });
}

/** Total quantity (all statuses) in an LPN, by SKU. */
export async function lpnContents(tx: Tx, lpnId: string): Promise<{ sku_id: string; status: InventoryStatus; qty: bigint }[]> {
  return tx.$queryRaw<{ sku_id: string; status: InventoryStatus; qty: bigint }[]>`SELECT sku_id, status, qty FROM inventory_balances
    WHERE lpn_id = ${lpnId}::uuid AND qty > 0 ORDER BY sku_id, status`;
}
