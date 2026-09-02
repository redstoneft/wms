import { evaluateRelease, type ReleaseCheckResult } from '@wms/shared';
import type { Tx } from '../../db.js';
import { ConflictError, NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';
import { findLocationOfType } from '../../lib/lookup.js';
import { lockBalances, lockLocationByBarcode, lockLpnByCode, moveLpn, removeInventory, lockLpn } from '../../inventory/ledger.js';
import { createIncident } from '../incidents/service.js';

export interface CreateShipmentInput {
  carrier_id?: string;
  vehicle?: string;
  plates?: string;
  driver_name?: string;
  destination?: string;
  dock_location_id?: string;
  order_ids: string[];
  notes?: string;
}

async function lockShipment(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string; status: string; version: number; shipment_number: string; dock_location_id: string | null }[]>`
    SELECT id, status, version, shipment_number, dock_location_id FROM shipments WHERE id = ${id}::uuid FOR UPDATE`;
  const s = rows[0];
  if (!s) throw new NotFoundError('shipment', id);
  return s;
}

export async function createShipment(tx: Tx, ctx: ActorContext, input: CreateShipmentInput) {
  const num = await tx.$queryRaw<{ n: string }[]>`SELECT next_doc_number('SHP', 'shipment_seq') AS n`;
  const sh = await tx.shipments.create({
    data: {
      shipment_number: num[0]!.n,
      carrier_id: input.carrier_id ?? null,
      vehicle: input.vehicle ?? null,
      plates: input.plates ?? null,
      driver_name: input.driver_name ?? null,
      destination: input.destination ?? null,
      dock_location_id: input.dock_location_id ?? null,
      notes: input.notes ?? null,
      created_by: ctx.userId,
    },
  });
  for (const oid of input.order_ids) await addOrder(tx, ctx, sh.id, oid);
  await audit(tx, ctx, { action: 'shipment.create', entity_type: 'shipment', entity_id: sh.id, after: { number: sh.shipment_number, orders: input.order_ids.length } });
  return sh;
}

export async function addOrder(tx: Tx, ctx: ActorContext, shipmentId: string, orderId: string) {
  const sh = await lockShipment(tx, shipmentId);
  if (!['OPEN', 'LOADING'].includes(sh.status)) throw new RuleError('SHIPMENT_STATUS', `Shipment is ${sh.status}`);
  const orows = await tx.$queryRaw<{ id: string; status: string; shipment_id: string | null; order_number: string }[]>`SELECT id, status, shipment_id, order_number FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
  const o = orows[0];
  if (!o) throw new NotFoundError('order', orderId);
  if (o.shipment_id && o.shipment_id !== shipmentId) throw new ConflictError('ORDER_IN_OTHER_SHIPMENT', `Order ${o.order_number} is already in another shipment`);
  if (!['VERIFIED', 'STAGED', 'PICKED', 'ALLOCATED', 'PARTIALLY_ALLOCATED', 'PICKING'].includes(o.status)) throw new RuleError('ORDER_STATUS', `Order ${o.order_number} is ${o.status} and cannot be added`);
  await tx.orders.update({ where: { id: orderId }, data: { shipment_id: shipmentId, version: { increment: 1 } } });
  await audit(tx, ctx, { action: 'shipment.add_order', entity_type: 'shipment', entity_id: shipmentId, after: { order: o.order_number } });
  return { ok: true };
}

export async function removeOrder(tx: Tx, ctx: ActorContext, shipmentId: string, orderId: string) {
  const sh = await lockShipment(tx, shipmentId);
  if (!['OPEN', 'LOADING'].includes(sh.status)) throw new RuleError('SHIPMENT_STATUS', `Shipment is ${sh.status}`);
  const o = await tx.orders.findUnique({ where: { id: orderId } });
  if (!o || o.shipment_id !== shipmentId) throw new NotFoundError('order in shipment', orderId);
  const loaded = await tx.lpns.count({ where: { order_id: orderId, status: 'LOADED' } });
  if (loaded) throw new RuleError('ORDER_HAS_LOADED_LPNS', 'Unload the order\'s pallets before removing it from the shipment');
  await tx.orders.update({ where: { id: orderId }, data: { shipment_id: null, version: { increment: 1 } } });
  await audit(tx, ctx, { action: 'shipment.remove_order', entity_type: 'shipment', entity_id: shipmentId, after: { order: o.order_number } });
  return { ok: true };
}

/**
 * Loading scan: each pallet is physically re-scanned at the dock. Only STAGED,
 * VERIFIED-order pallets that belong to an order of this shipment may be
 * loaded. LOADED is recorded per LPN/SKU in the ledger — never inferred.
 */
export async function loadScan(tx: Tx, ctx: ActorContext, input: { shipment_id: string; lpn_code: string; dock_location_barcode?: string }) {
  const sh = await lockShipment(tx, input.shipment_id);
  if (!['OPEN', 'LOADING'].includes(sh.status)) throw new RuleError('SHIPMENT_STATUS', `Shipment is ${sh.status}; loading is closed`);
  const lpn = await lockLpnByCode(tx, input.lpn_code);
  if (lpn.status === 'LOADED') throw new ConflictError('ALREADY_LOADED', `LPN ${lpn.code} is already loaded${lpn.shipment_id === sh.id ? ' on this shipment' : ' on another shipment'}`);
  if (lpn.status !== 'STAGED') throw new RuleError('LPN_STATUS', `LPN ${lpn.code} is ${lpn.status}; only staged pallets can be loaded`);
  if (!lpn.order_id) throw new RuleError('LPN_NO_ORDER', 'LPN has no order');
  const order = await tx.orders.findUniqueOrThrow({ where: { id: lpn.order_id } });
  if (order.shipment_id !== sh.id) {
    await createIncident(tx, ctx, { incident_type: 'LOADING_ERROR', severity: 'HIGH', title: `Intento de cargar pallet ${lpn.code} del pedido ${order.order_number} en embarque ${sh.shipment_number}`, entity_type: 'shipment', entity_id: sh.id, lpn_id: lpn.id, order_id: order.id, shipment_id: sh.id });
    throw new RuleError('WRONG_SHIPMENT', `LPN ${lpn.code} belongs to order ${order.order_number}, which is not in this shipment`);
  }
  if (order.status !== 'VERIFIED' && order.status !== 'LOADING') throw new RuleError('ORDER_NOT_VERIFIED', `Order ${order.order_number} is ${order.status}; it must pass second-person verification before loading`);

  let dockId = sh.dock_location_id;
  if (input.dock_location_barcode) {
    const dock = await lockLocationByBarcode(tx, input.dock_location_barcode);
    if (dock.location_type !== 'SHIPPING') throw new RuleError('NOT_SHIPPING_DOCK', `${dock.code} is not a shipping dock`);
    if (dockId && dockId !== dock.id) throw new RuleError('WRONG_DOCK', 'Shipment is assigned to a different dock');
    dockId = dock.id;
  }
  if (!dockId) {
    const d = await findLocationOfType(tx, lpn.warehouse_id, 'SHIPPING');
    if (!d) throw new RuleError('NO_SHIPPING_DOCK', 'No shipping dock configured');
    dockId = d.id;
  }
  const balances = await lockBalances(tx, lpn.id);
  if (balances.some((b) => b.status !== 'STAGING')) throw new RuleError('LPN_STATUS', `LPN ${lpn.code} has inventory not in STAGING`);
  // verified guard per line: loaded ≤ verified is also a DB CHECK
  for (const b of balances) {
    const ol = await tx.order_lines.findFirst({ where: { order_id: order.id, sku_id: b.sku_id } });
    if (!ol) throw new RuleError('SKU_NOT_IN_ORDER', `LPN ${lpn.code} contains a SKU not required by order ${order.order_number}`);
    if (ol.loaded_qty + b.qty > ol.verified_qty) throw new RuleError('LOAD_EXCEEDS_VERIFIED', `Loading ${b.qty} of ${ol.sku_id} exceeds verified quantity for order ${order.order_number}`);
  }
  const movements = await moveLpn(tx, ctx, { movement_type: 'LOAD', lpn, to_location_id: dockId, only_status: 'STAGING', to_status: 'LOADED', order_id: order.id, shipment_id: sh.id, reference_type: 'shipment', reference_id: sh.id });
  for (const b of balances) {
    await tx.order_lines.updateMany({ where: { order_id: order.id, sku_id: b.sku_id }, data: { loaded_qty: { increment: b.qty } } });
  }
  await tx.lpns.update({ where: { id: lpn.id }, data: { status: 'LOADED', shipment_id: sh.id, version: { increment: 1 } } });
  if (sh.status === 'OPEN') await tx.shipments.update({ where: { id: sh.id }, data: { status: 'LOADING', loading_started_at: new Date(), dock_location_id: dockId, version: { increment: 1 } } });
  if (order.status === 'VERIFIED') await tx.orders.update({ where: { id: order.id }, data: { status: 'LOADING', version: { increment: 1 } } });
  // staged pallets left for the order?
  const staged = await tx.lpns.count({ where: { order_id: order.id, status: 'STAGED' } });
  if (staged === 0) {
    await tx.orders.update({ where: { id: order.id }, data: { status: 'LOADED', version: { increment: 1 } } });
    await tx.staging_assignments.updateMany({ where: { order_id: order.id, released_at: null }, data: { released_at: new Date() } });
  }
  await audit(tx, ctx, { action: 'load.scan', entity_type: 'shipment', entity_id: sh.id, after: { lpn: lpn.code, order: order.order_number, movements: movements.map(String) } });
  const check = await releaseCheck(tx, sh.id);
  return { lpn_code: lpn.code, order_number: order.order_number, order_loaded: staged === 0, movements, release: { can_release: check.can_release, blocking: check.blocking_reasons.length } };
}

/** Take a pallet back off the truck (wrong load): LOADED → STAGING at its order's staging lane. */
export async function unloadScan(tx: Tx, ctx: ActorContext, input: { shipment_id: string; lpn_code: string; reason: string }) {
  const sh = await lockShipment(tx, input.shipment_id);
  if (!['LOADING', 'LOADED', 'BLOCKED'].includes(sh.status)) throw new RuleError('SHIPMENT_STATUS', `Shipment is ${sh.status}`);
  const lpn = await lockLpnByCode(tx, input.lpn_code);
  if (lpn.status !== 'LOADED' || lpn.shipment_id !== sh.id) throw new RuleError('LPN_NOT_LOADED', `LPN ${lpn.code} is not loaded on this shipment`);
  const order = await tx.orders.findUniqueOrThrow({ where: { id: lpn.order_id! } });
  let staging = await tx.staging_assignments.findFirst({ where: { order_id: order.id, released_at: null } });
  if (!staging) {
    const free = await tx.$queryRaw<{ id: string }[]>`SELECT loc.id FROM locations loc WHERE loc.location_type = 'STAGING' AND loc.is_active AND loc.admin_status = 'ACTIVE'
      AND NOT EXISTS (SELECT 1 FROM staging_assignments sa WHERE sa.location_id = loc.id AND sa.released_at IS NULL) ORDER BY loc.code FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!free[0]) throw new RuleError('NO_STAGING_AVAILABLE', 'No staging lane available to unload into');
    staging = await tx.staging_assignments.create({ data: { order_id: order.id, location_id: free[0].id } });
  }
  const balances = await lockBalances(tx, lpn.id);
  const movements = await moveLpn(tx, ctx, { movement_type: 'UNLOAD', lpn, to_location_id: staging.location_id, only_status: 'LOADED', to_status: 'STAGING', order_id: order.id, shipment_id: sh.id, reason: input.reason });
  for (const b of balances) await tx.order_lines.updateMany({ where: { order_id: order.id, sku_id: b.sku_id }, data: { loaded_qty: { decrement: b.qty } } });
  await tx.lpns.update({ where: { id: lpn.id }, data: { status: 'STAGED', shipment_id: null, version: { increment: 1 } } });
  await tx.orders.update({ where: { id: order.id }, data: { status: 'LOADING', version: { increment: 1 } } });
  if (sh.status === 'LOADED' || sh.status === 'BLOCKED') await tx.shipments.update({ where: { id: sh.id }, data: { status: 'LOADING', version: { increment: 1 } } });
  await audit(tx, ctx, { action: 'load.unload', entity_type: 'shipment', entity_id: sh.id, after: { lpn: lpn.code, order: order.order_number, movements: movements.map(String) }, reason: input.reason });
  return { lpn_code: lpn.code, movements };
}

/** THE ABSOLUTE RULE, evaluated from live data. */
export async function releaseCheck(tx: Tx, shipmentId: string): Promise<ReleaseCheckResult & { shipment_id: string }> {
  const lines = await tx.$queryRaw<{ order_number: string; sku_code: string; required_qty: bigint; picked_qty: bigint; verified_qty: bigint; loaded_qty: bigint }[]>`
    SELECT o.order_number, s.code AS sku_code, ol.required_qty, ol.picked_qty, ol.verified_qty, ol.loaded_qty
      FROM orders o JOIN order_lines ol ON ol.order_id = o.id JOIN skus s ON s.id = ol.sku_id
     WHERE o.shipment_id = ${shipmentId}::uuid AND o.status <> 'CANCELLED' ORDER BY o.order_number, s.code`;
  // what is physically on the truck according to the ledger (LOADED balances of LPNs on this shipment)
  const onTruck = await tx.$queryRaw<{ order_number: string | null; sku_code: string; qty: bigint }[]>`
    SELECT o.order_number, s.code AS sku_code, sum(b.qty)::bigint AS qty
      FROM lpns l JOIN inventory_balances b ON b.lpn_id = l.id AND b.status = 'LOADED' AND b.qty > 0 JOIN skus s ON s.id = b.sku_id
      LEFT JOIN orders o ON o.id = l.order_id
     WHERE l.shipment_id = ${shipmentId}::uuid GROUP BY o.order_number, s.code`;
  const unexpected = onTruck.filter((t) => !lines.find((l) => l.order_number === t.order_number && l.sku_code === t.sku_code));
  // ledger vs counters must agree
  const counterMismatch = lines.filter((l) => {
    const t = onTruck.find((x) => x.order_number === l.order_number && x.sku_code === l.sku_code);
    return (t?.qty ?? 0n) !== l.loaded_qty;
  });
  const incidents = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM incidents i WHERE i.status IN ('OPEN','IN_REVIEW') AND i.severity IN ('HIGH','CRITICAL')
       AND (i.shipment_id = ${shipmentId}::uuid OR i.order_id IN (SELECT id FROM orders WHERE shipment_id = ${shipmentId}::uuid))`;
  const orders = await tx.orders.findMany({ where: { shipment_id: shipmentId, status: { not: 'CANCELLED' } }, select: { order_number: true, status: true, verifier_id: true, picker_id: true } });
  const notVerified = orders.filter((o) => !o.verifier_id).map((o) => o.order_number);
  const activeVerifications = await tx.verifications.findMany({ where: { status: 'IN_PROGRESS', order: { shipment_id: shipmentId } }, include: { order: { select: { order_number: true } } } });
  const result = evaluateRelease({
    lines,
    unexpected_loaded: unexpected.map((u) => ({ order_number: u.order_number, sku_code: u.sku_code, qty: u.qty })),
    open_critical_incidents: Number(incidents[0]?.n ?? 0),
    orders_not_verified: notVerified,
    verification_incomplete: activeVerifications.map((v) => v.order.order_number),
  });
  for (const m of counterMismatch) result.blocking_reasons.push(`${m.order_number} / ${m.sku_code}: ledger LOADED quantity does not match order line counter (integrity check)`);
  result.can_release = result.blocking_reasons.length === 0;
  return { ...result, shipment_id: shipmentId };
}

export async function releaseShipment(tx: Tx, ctx: ActorContext, input: { shipment_id: string; version: number }) {
  const sh = await lockShipment(tx, input.shipment_id);
  if (sh.version !== input.version) throw new ConflictError('STALE_VERSION', 'Shipment changed; reload and re-check before releasing');
  if (!['LOADING', 'LOADED', 'BLOCKED'].includes(sh.status)) throw new RuleError('SHIPMENT_STATUS', `Shipment is ${sh.status}`);
  const check = await releaseCheck(tx, sh.id);
  await tx.shipments.update({ where: { id: sh.id }, data: { release_check: JSON.parse(JSON.stringify(check, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) } });
  if (!check.can_release) {
    await tx.shipments.update({ where: { id: sh.id }, data: { status: 'BLOCKED', version: { increment: 1 } } });
    await audit(tx, ctx, { action: 'shipment.release_blocked', entity_type: 'shipment', entity_id: sh.id, after: { reasons: check.blocking_reasons } });
    throw new RuleError('RELEASE_BLOCKED', 'EMBARQUE INCORRECTO — release blocked', { blocking_reasons: check.blocking_reasons, lines: check.lines });
  }
  await tx.shipments.update({ where: { id: sh.id }, data: { status: 'RELEASED', released_at: new Date(), released_by: ctx.userId, loading_finished_at: new Date(), version: { increment: 1 } } });
  await audit(tx, ctx, { action: 'shipment.release', entity_type: 'shipment', entity_id: sh.id, after: { totals: { required: check.totals.required.toString(), loaded: check.totals.loaded.toString() } } });
  return { shipment_id: sh.id, status: 'RELEASED', check };
}

/** Truck leaves: LOADED inventory is shipped out of the warehouse (ledger SHIP movements). */
export async function departShipment(tx: Tx, ctx: ActorContext, shipmentId: string) {
  const sh = await lockShipment(tx, shipmentId);
  if (sh.status !== 'RELEASED') throw new RuleError('SHIPMENT_STATUS', `Shipment must be RELEASED to depart (is ${sh.status})`);
  // re-validate: nothing may have changed
  const check = await releaseCheck(tx, sh.id);
  if (!check.can_release) throw new RuleError('RELEASE_BLOCKED', 'Shipment no longer passes the release check', { blocking_reasons: check.blocking_reasons });
  const lpns = await tx.lpns.findMany({ where: { shipment_id: sh.id, status: 'LOADED' } });
  let movements = 0;
  for (const l of lpns) {
    const lpn = await lockLpn(tx, l.id);
    const balances = await lockBalances(tx, lpn.id);
    for (const b of balances) {
      await removeInventory(tx, ctx, { movement_type: 'SHIP', from_lpn: lpn, sku_id: b.sku_id, qty: b.qty, status: 'LOADED', order_id: lpn.order_id, shipment_id: sh.id, reference_type: 'shipment', reference_id: sh.id });
      movements++;
    }
    await tx.lpns.update({ where: { id: lpn.id }, data: { status: 'SHIPPED', version: { increment: 1 } } });
  }
  await tx.orders.updateMany({ where: { shipment_id: sh.id, status: { not: 'CANCELLED' } }, data: { status: 'SHIPPED' } });
  await tx.staging_assignments.updateMany({ where: { order: { shipment_id: sh.id }, released_at: null }, data: { released_at: new Date() } });
  await tx.shipments.update({ where: { id: sh.id }, data: { status: 'DEPARTED', departed_at: new Date(), version: { increment: 1 } } });
  await audit(tx, ctx, { action: 'shipment.depart', entity_type: 'shipment', entity_id: sh.id, after: { lpns: lpns.length, movements } });
  return { shipment_id: sh.id, status: 'DEPARTED', lpns: lpns.length, movements };
}

export async function shipmentDetail(tx: Tx, id: string) {
  const sh = await tx.shipments.findUnique({
    where: { id },
    include: { carrier: true, orders: { include: { customer: true, lines: { include: { sku: true } } } }, lpns: { select: { id: true, code: true, status: true, order_id: true } } },
  });
  if (!sh) throw new NotFoundError('shipment', id);
  const dock = sh.dock_location_id ? await tx.locations.findUnique({ where: { id: sh.dock_location_id }, select: { code: true, barcode: true } }) : null;
  const check = await releaseCheck(tx, id);
  return { ...sh, dock, release: check };
}
