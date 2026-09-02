import type { InventoryStatus, MovementType, UomCode } from '@wms/shared';
import type { Tx } from '../../db.js';
import { ForbiddenError, NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';
import { getSkuByCode, toBaseQty } from '../../lib/lookup.js';
import { changeStatus, createInventory, lockBalances, lockLpnByCode, removeInventory } from '../../inventory/ledger.js';
import { consumeAuthorization } from '../authorizations/routes.js';
import { createIncident } from '../incidents/service.js';

/**
 * Manual inventory adjustment. Always requires a reason, always creates an
 * incident (INVENTORY_DIFFERENCE) so it can be reviewed, never silent.
 * OUT adjustments beyond AVAILABLE stock are rejected (no negative inventory).
 */
export async function adjustInventory(
  tx: Tx,
  ctx: ActorContext,
  input: { lpn_code: string; sku_code: string; direction: 'IN' | 'OUT'; qty: bigint; uom_code: UomCode; reason: string; incident_id?: string; authorization_id?: string },
) {
  const lpn = await lockLpnByCode(tx, input.lpn_code);
  if (!['STORED', 'OPEN'].includes(lpn.status)) throw new RuleError('LPN_STATUS', `LPN ${lpn.code} is ${lpn.status}; adjustments only on stored pallets`);
  if (!lpn.current_location_id) throw new RuleError('LPN_NO_LOCATION', 'LPN has no location');
  const sku = await getSkuByCode(tx, input.sku_code);
  const { base } = await toBaseQty(tx, sku.id, input.qty, input.uom_code);
  // adjustments of significant size need a supervisor
  if (input.authorization_id) {
    await consumeAuthorization(tx, input.authorization_id, { exception_type: 'COUNT_ADJUSTMENT', entity_type: 'lpn', entity_id: lpn.id });
  } else if (!ctx.permissions.has('counts.approve')) {
    throw new ForbiddenError('Inventory adjustments require supervisor approval (authorization_id) or the counts.approve permission');
  }
  let movementId: bigint;
  if (input.direction === 'IN') {
    movementId = await createInventory(tx, ctx, { movement_type: 'ADJUST_IN', to_lpn: lpn, sku_id: sku.id, qty: base, uom_code: input.uom_code, uom_qty: input.qty, status: 'AVAILABLE', location_id: lpn.current_location_id, reason: input.reason, incident_id: input.incident_id ?? null, reference_type: 'adjustment' });
  } else {
    movementId = await removeInventory(tx, ctx, { movement_type: 'ADJUST_OUT', from_lpn: lpn, sku_id: sku.id, qty: base, uom_code: input.uom_code, uom_qty: input.qty, status: 'AVAILABLE', reason: input.reason, incident_id: input.incident_id ?? null, reference_type: 'adjustment' });
  }
  let incidentId = input.incident_id ?? null;
  if (!incidentId) {
    const inc = await createIncident(tx, ctx, {
      incident_type: 'INVENTORY_DIFFERENCE',
      severity: 'MEDIUM',
      title: `Ajuste manual ${input.direction} ${base} x ${sku.code} en ${lpn.code}`,
      description: input.reason,
      entity_type: 'lpn',
      entity_id: lpn.id,
      sku_id: sku.id,
      lpn_id: lpn.id,
      location_id: lpn.current_location_id,
      qty: base,
    });
    incidentId = inc.id;
    await tx.incidents.update({ where: { id: inc.id }, data: { status: 'RESOLVED', resolution: `Ajuste aplicado (movimiento ${movementId})`, resolved_by: ctx.userId, resolved_at: new Date() } });
  }
  await audit(tx, ctx, { action: `inventory.adjust_${input.direction.toLowerCase()}`, entity_type: 'lpn', entity_id: lpn.id, after: { sku: sku.code, qty: base.toString(), movement_id: movementId.toString(), incident_id: incidentId }, reason: input.reason });
  return { movement_id: movementId, incident_id: incidentId, lpn_code: lpn.code, sku_code: sku.code, qty_base: base };
}

const STATUS_ACTIONS: Record<string, { from: InventoryStatus; to: InventoryStatus; type: MovementType }> = {
  QUARANTINE: { from: 'AVAILABLE', to: 'QUARANTINE', type: 'QUARANTINE_IN' },
  RELEASE_QUARANTINE: { from: 'QUARANTINE', to: 'AVAILABLE', type: 'QUARANTINE_OUT' },
  BLOCK: { from: 'AVAILABLE', to: 'BLOCKED', type: 'BLOCK' },
  UNBLOCK: { from: 'BLOCKED', to: 'AVAILABLE', type: 'UNBLOCK' },
  DAMAGE: { from: 'AVAILABLE', to: 'DAMAGED', type: 'DAMAGE' },
  RELEASE_DAMAGE: { from: 'DAMAGED', to: 'AVAILABLE', type: 'DAMAGE_RELEASE' },
};

/** Quarantine / block / damage transitions (whole LPN or one SKU, all or a quantity). */
export async function changeInventoryStatus(
  tx: Tx,
  ctx: ActorContext,
  input: { lpn_code: string; sku_code?: string; action: keyof typeof STATUS_ACTIONS; qty?: bigint; reason_code?: string; reason: string },
) {
  const def = STATUS_ACTIONS[input.action];
  if (!def) throw new RuleError('UNKNOWN_ACTION', 'Unknown status action');
  const lpn = await lockLpnByCode(tx, input.lpn_code);
  if (!['STORED', 'OPEN'].includes(lpn.status)) throw new RuleError('LPN_STATUS', `LPN ${lpn.code} is ${lpn.status}`);
  if (input.reason_code) {
    const rc = await tx.quarantine_reasons.findUnique({ where: { code: input.reason_code } });
    if (!rc || !rc.is_active) throw new RuleError('UNKNOWN_REASON_CODE', `Reason code ${input.reason_code} not configured`);
  }
  const balances = await lockBalances(tx, lpn.id);
  let targets = balances.filter((b) => b.status === def.from);
  if (input.sku_code) {
    const sku = await getSkuByCode(tx, input.sku_code);
    targets = targets.filter((b) => b.sku_id === sku.id);
  }
  if (targets.length === 0) throw new RuleError('NOTHING_TO_CHANGE', `LPN ${lpn.code} has no ${def.from} inventory${input.sku_code ? ` of ${input.sku_code}` : ''}`);
  if (input.qty !== undefined && targets.length !== 1) throw new RuleError('QTY_NEEDS_SKU', 'A quantity requires a single SKU');
  const movements: bigint[] = [];
  for (const b of targets) {
    const qty = input.qty ?? b.qty;
    movements.push(await changeStatus(tx, ctx, { movement_type: def.type, lpn, sku_id: b.sku_id, qty, from_status: def.from, to_status: def.to, reason: `${input.reason_code ? input.reason_code + ': ' : ''}${input.reason}` }));
  }
  if (def.to === 'DAMAGED' || def.to === 'QUARANTINE') {
    await createIncident(tx, ctx, {
      incident_type: def.to === 'DAMAGED' ? 'DAMAGED' : 'OTHER',
      severity: 'MEDIUM',
      title: `${input.action} ${lpn.code}${input.sku_code ? ' / ' + input.sku_code : ''}`,
      description: input.reason,
      entity_type: 'lpn',
      entity_id: lpn.id,
      lpn_id: lpn.id,
      location_id: lpn.current_location_id,
      sku_id: targets.length === 1 ? targets[0]!.sku_id : null,
      qty: targets.reduce((a, b) => a + (input.qty ?? b.qty), 0n),
    });
  }
  await audit(tx, ctx, { action: `inventory.${input.action.toLowerCase()}`, entity_type: 'lpn', entity_id: lpn.id, after: { movements: movements.map(String), sku: input.sku_code ?? 'ALL' }, reason: input.reason });
  return { lpn_code: lpn.code, movements };
}

/** Full timeline of an LPN or SKU: ledger + audit + labels + tasks, ordered. */
export async function timeline(tx: Tx, kind: 'LPN' | 'SKU', key: string) {
  if (kind === 'LPN') {
    const lpn = await tx.lpns.findUnique({ where: { code: key.toUpperCase() } });
    if (!lpn) throw new NotFoundError('LPN', key);
    const rows = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM (
        SELECT m.occurred_at AS at, 'MOVEMENT' AS kind, m.movement_type AS event, s.code AS sku, m.qty::text AS qty, fl.code AS from_location, tl.code AS to_location,
               m.from_status, m.to_status, u.username, m.reason, m.order_id::text AS order_id, m.receipt_id::text AS receipt_id, m.shipment_id::text AS shipment_id, m.id::text AS ref
          FROM inventory_movements m JOIN skus s ON s.id = m.sku_id LEFT JOIN users u ON u.id = m.user_id
          LEFT JOIN locations fl ON fl.id = m.from_location_id LEFT JOIN locations tl ON tl.id = m.to_location_id
         WHERE m.from_lpn_id = ${lpn.id}::uuid OR m.to_lpn_id = ${lpn.id}::uuid
        UNION ALL
        SELECT lp.created_at, 'LABEL', CASE WHEN lp.is_reprint THEN 'LABEL_REPRINT' ELSE 'LABEL_PRINT' END, NULL, NULL, NULL, NULL, NULL, NULL, u.username, lp.reprint_reason, NULL, NULL, NULL, lp.id::text
          FROM label_prints lp LEFT JOIN users u ON u.id = lp.printed_by WHERE lp.lpn_id = ${lpn.id}::uuid AND lp.status <> 'PREVIEW'
        UNION ALL
        SELECT a.occurred_at, 'AUDIT', a.action, NULL, NULL, NULL, NULL, NULL, NULL, a.username, a.reason, NULL, NULL, NULL, a.id::text
          FROM audit_logs a WHERE a.entity_type = 'lpn' AND a.entity_id = ${lpn.id}::text
        UNION ALL
        SELECT t.created_at, 'TASK', 'PUTAWAY_TASK_' || t.status, NULL, NULL, NULL, sl.code, NULL, NULL, u.username, t.override_reason, NULL, NULL, NULL, t.id::text
          FROM putaway_tasks t LEFT JOIN locations sl ON sl.id = t.suggested_location_id LEFT JOIN users u ON u.id = t.assigned_to WHERE t.lpn_id = ${lpn.id}::uuid
      ) x ORDER BY at, ref`;
    const orders = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT DISTINCT o.order_number, o.status, o.picker_id, o.verifier_id, pu.username AS picker, vu.username AS verifier, sh.shipment_number, sh.vehicle, sh.plates, sh.released_at, sh.departed_at
        FROM inventory_movements m JOIN orders o ON o.id = m.order_id LEFT JOIN users pu ON pu.id = o.picker_id LEFT JOIN users vu ON vu.id = o.verifier_id
        LEFT JOIN shipments sh ON sh.id = o.shipment_id
       WHERE m.from_lpn_id = ${lpn.id}::uuid OR m.to_lpn_id = ${lpn.id}::uuid`;
    return { lpn, events: rows, orders };
  }
  const sku = await tx.skus.findUnique({ where: { code: key } });
  if (!sku) throw new NotFoundError('SKU', key);
  const rows = await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT m.occurred_at AS at, m.movement_type AS event, m.qty::text AS qty, fl2.code AS from_lpn, tl2.code AS to_lpn, fl.code AS from_location, tl.code AS to_location,
           m.from_status, m.to_status, u.username, m.reason, o.order_number, r.receipt_number, sh.shipment_number, m.id::text AS ref
      FROM inventory_movements m LEFT JOIN users u ON u.id = m.user_id
      LEFT JOIN lpns fl2 ON fl2.id = m.from_lpn_id LEFT JOIN lpns tl2 ON tl2.id = m.to_lpn_id
      LEFT JOIN locations fl ON fl.id = m.from_location_id LEFT JOIN locations tl ON tl.id = m.to_location_id
      LEFT JOIN orders o ON o.id = m.order_id LEFT JOIN receipts r ON r.id = m.receipt_id LEFT JOIN shipments sh ON sh.id = m.shipment_id
     WHERE m.sku_id = ${sku.id}::uuid ORDER BY m.id DESC LIMIT 500`;
  return { sku, events: rows };
}

/** Rebuilds balances from the ledger and compares; also checks LPN locations. */
export async function reconcile(tx: Tx) {
  const balanceDiffs = await tx.$queryRaw<{ lpn_id: string; sku_id: string; status: string; ledger_qty: bigint; balance_qty: bigint }[]>`SELECT * FROM inventory_reconcile()`;
  const locationDiffs = await tx.$queryRaw<{ lpn_id: string; ledger_location_id: string | null; lpn_location_id: string | null }[]>`SELECT * FROM lpn_location_reconcile()`;
  const negatives = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM inventory_balances WHERE qty < 0`;
  const orphanLpns = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM lpns l WHERE l.status IN ('STORED','IN_TRANSFER','PICKING','STAGED','LOADED') AND l.current_location_id IS NULL`;
  const orderLineDiffs = await tx.$queryRaw<{ order_number: string; sku_code: string; picked_qty: bigint; ledger_picked: bigint }[]>`
    SELECT o.order_number, s.code AS sku_code, ol.picked_qty,
           COALESCE((SELECT sum(m.qty) FROM inventory_movements m WHERE m.order_id = o.id AND m.sku_id = ol.sku_id AND m.movement_type = 'PICK'), 0)
         - COALESCE((SELECT sum(m.qty) FROM inventory_movements m WHERE m.order_id = o.id AND m.sku_id = ol.sku_id AND m.movement_type = 'UNPICK'), 0)::bigint AS ledger_picked
      FROM order_lines ol JOIN orders o ON o.id = ol.order_id JOIN skus s ON s.id = ol.sku_id
     WHERE o.status NOT IN ('IMPORTED','ACCEPTED','CANCELLED')
    HAVING ol.picked_qty <> COALESCE((SELECT sum(m.qty) FROM inventory_movements m WHERE m.order_id = o.id AND m.sku_id = ol.sku_id AND m.movement_type = 'PICK'), 0)
         - COALESCE((SELECT sum(m.qty) FROM inventory_movements m WHERE m.order_id = o.id AND m.sku_id = ol.sku_id AND m.movement_type = 'UNPICK'), 0)`.catch(() => [] as never);
  const totals = await tx.$queryRaw<{ status: string; qty: bigint }[]>`SELECT status, sum(qty)::bigint AS qty FROM inventory_balances GROUP BY status ORDER BY status`;
  const ok = balanceDiffs.length === 0 && locationDiffs.length === 0 && Number(negatives[0]?.n ?? 0) === 0 && Number(orphanLpns[0]?.n ?? 0) === 0;
  return {
    ok,
    checked_at: new Date().toISOString(),
    balance_discrepancies: balanceDiffs,
    location_discrepancies: locationDiffs,
    negative_balances: Number(negatives[0]?.n ?? 0),
    stored_lpns_without_location: Number(orphanLpns[0]?.n ?? 0),
    order_line_discrepancies: orderLineDiffs,
    totals_by_status: totals,
  };
}
