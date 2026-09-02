import type { AllocationStrategy, UomCode } from '@wms/shared';
import type { Tx } from '../../db.js';
import { ConflictError, NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';
import { getSkuByCode, toBaseQty } from '../../lib/lookup.js';
import { lockLpn, recordMovement } from '../../inventory/ledger.js';
import { consumeAuthorization } from '../authorizations/routes.js';
import { getSettings } from '../settings/routes.js';
import { createIncident } from '../incidents/service.js';
import { unpickOrder } from '../picking/service.js';

export interface CreateOrderInput {
  order_number: string;
  customer_code: string;
  destination?: string;
  order_date?: Date;
  priority: number;
  external_ref?: string;
  notes?: string;
  source?: 'IMPORT' | 'MANUAL' | 'SAE';
  lines: { sku_code: string; qty: bigint; uom_code: UomCode }[];
}

export async function createOrder(tx: Tx, ctx: ActorContext, input: CreateOrderInput) {
  const customer = await tx.customers.findUnique({ where: { code: input.customer_code } });
  if (!customer) throw new NotFoundError('customer', input.customer_code);
  if (await tx.orders.findUnique({ where: { order_number: input.order_number } })) throw new ConflictError('ORDER_EXISTS', `Order ${input.order_number} already exists`);
  const lines = [];
  const seen = new Map<string, number>();
  let n = 1;
  for (const l of input.lines) {
    const sku = await getSkuByCode(tx, l.sku_code);
    if (!sku.is_active) throw new RuleError('SKU_INACTIVE', `SKU ${sku.code} is inactive`);
    const { base } = await toBaseQty(tx, sku.id, l.qty, l.uom_code);
    // merge duplicate SKU lines
    const idx = seen.get(sku.id);
    if (idx !== undefined) {
      lines[idx]!.required_qty += base;
      lines[idx]!.uom_qty += l.qty;
      continue;
    }
    seen.set(sku.id, lines.length);
    lines.push({ line_no: n++, sku_id: sku.id, required_qty: base, uom_code: l.uom_code, uom_qty: l.qty });
  }
  const order = await tx.orders.create({
    data: {
      order_number: input.order_number,
      customer_id: customer.id,
      destination: input.destination ?? null,
      order_date: input.order_date ?? null,
      priority: input.priority,
      external_ref: input.external_ref ?? null,
      notes: input.notes ?? null,
      source: input.source ?? 'MANUAL',
      created_by: ctx.userId,
      lines: { create: lines },
    },
    include: { lines: { include: { sku: true } }, customer: true },
  });
  await audit(tx, ctx, { action: 'order.create', entity_type: 'order', entity_id: order.id, after: { order_number: order.order_number, lines: lines.length } });
  return order;
}

export async function acceptOrder(tx: Tx, ctx: ActorContext, orderId: string) {
  const o = await lockOrder(tx, orderId);
  if (o.status !== 'IMPORTED') throw new RuleError('ORDER_STATUS', `Order is ${o.status}`);
  const updated = await tx.orders.update({ where: { id: orderId }, data: { status: 'ACCEPTED', version: { increment: 1 } } });
  await audit(tx, ctx, { action: 'order.accept', entity_type: 'order', entity_id: orderId, before: { status: o.status }, after: { status: 'ACCEPTED' } });
  return updated;
}

async function lockOrder(tx: Tx, orderId: string) {
  const rows = await tx.$queryRaw<{ id: string; status: string; version: number; order_number: string; picker_id: string | null; shipment_id: string | null }[]>`
    SELECT id, status, version, order_number, picker_id, shipment_id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
  const o = rows[0];
  if (!o) throw new NotFoundError('order', orderId);
  return o;
}

interface CandidateBalance {
  balance_id: string;
  lpn_id: string;
  lpn_code: string;
  qty: bigint;
  lpn_total_sku_qty: bigint;
  single_sku: boolean;
  location_type: string;
}

/**
 * Allocation. Candidate balances are locked FOR UPDATE in strategy order, so
 * two orders competing for the same pallet serialize and the second one sees
 * the reduced AVAILABLE quantity. Only AVAILABLE inventory in STORED LPNs at
 * active RESERVE/PICKING locations is eligible (quarantine/blocked/damaged
 * can never be allocated, by construction).
 */
export async function allocateOrder(tx: Tx, ctx: ActorContext, input: { order_id: string; strategy?: AllocationStrategy; allow_partial: boolean }) {
  const o = await lockOrder(tx, input.order_id);
  if (!['ACCEPTED', 'PARTIALLY_ALLOCATED', 'IMPORTED'].includes(o.status)) throw new RuleError('ORDER_STATUS', `Order is ${o.status}; only accepted orders can be allocated`);
  const settings = await getSettings(tx);
  const strategy = input.strategy ?? (settings.allocation_strategy as AllocationStrategy);
  const lines = await tx.order_lines.findMany({ where: { order_id: o.id }, include: { sku: true }, orderBy: { line_no: 'asc' } });
  const result: { sku: string; required: bigint; allocated_before: bigint; allocated_now: bigint; short: bigint; lpns: string[] }[] = [];
  let anyShort = false;

  for (const line of lines) {
    let remaining = line.required_qty - line.allocated_qty - line.picked_qty;
    const entry = { sku: line.sku.code, required: line.required_qty, allocated_before: line.allocated_qty, allocated_now: 0n, short: 0n, lpns: [] as string[] };
    if (remaining <= 0n) {
      result.push(entry);
      continue;
    }
    const candidates = await tx.$queryRaw<CandidateBalance[]>`
      SELECT b.id AS balance_id, l.id AS lpn_id, l.code AS lpn_code, b.qty,
             (SELECT sum(b2.qty) FROM inventory_balances b2 WHERE b2.lpn_id = l.id AND b2.sku_id = b.sku_id)::bigint AS lpn_total_sku_qty,
             NOT EXISTS (SELECT 1 FROM inventory_balances b3 WHERE b3.lpn_id = l.id AND b3.qty > 0 AND b3.sku_id <> b.sku_id) AS single_sku,
             loc.location_type
        FROM inventory_balances b
        JOIN lpns l ON l.id = b.lpn_id
        JOIN locations loc ON loc.id = l.current_location_id
       WHERE b.sku_id = ${line.sku_id}::uuid AND b.status = 'AVAILABLE' AND b.qty > 0
         AND l.status = 'STORED' AND loc.is_active AND loc.admin_status = 'ACTIVE' AND loc.location_type IN ('RESERVE','PICKING')
         AND (l.expiry_date IS NULL OR l.expiry_date >= CURRENT_DATE)
       ORDER BY
         CASE WHEN ${strategy} = 'FEFO' THEN l.expiry_date END ASC NULLS LAST,
         CASE WHEN ${strategy} = 'LPN' THEN l.code END ASC,
         CASE WHEN ${strategy} = 'LOCATION' THEN loc.pick_sequence END ASC NULLS LAST,
         CASE WHEN ${strategy} = 'CASE_PIECE' THEN (loc.location_type = 'PICKING') END DESC,
         CASE WHEN ${strategy} = 'FULL_PALLET' THEN (b.qty <= ${remaining}) END DESC,
         CASE WHEN ${strategy} = 'FULL_PALLET' THEN b.qty END DESC,
         l.created_at ASC, l.code ASC
       FOR UPDATE OF b`;
    for (const c of candidates) {
      if (remaining <= 0n) break;
      const take = c.qty < remaining ? c.qty : remaining;
      const lpn = await lockLpn(tx, c.lpn_id);
      await recordMovement(tx, ctx, {
        movement_type: 'ALLOCATE',
        sku_id: line.sku_id,
        qty: take,
        from_lpn_id: lpn.id,
        to_lpn_id: lpn.id,
        from_location_id: lpn.current_location_id,
        to_location_id: lpn.current_location_id,
        from_status: 'AVAILABLE',
        to_status: 'ALLOCATED',
        order_id: o.id,
        reference_type: 'order_line',
        reference_id: line.id,
        idempotency_suffix: `ALLOC:${line.id}:${lpn.id}`,
      });
      await tx.allocations.create({ data: { order_line_id: line.id, lpn_id: lpn.id, sku_id: line.sku_id, qty: take, strategy } });
      remaining -= take;
      entry.allocated_now += take;
      entry.lpns.push(c.lpn_code);
    }
    if (remaining > 0n) {
      anyShort = true;
      entry.short = remaining;
    }
    await tx.order_lines.update({ where: { id: line.id }, data: { allocated_qty: { increment: entry.allocated_now } } });
    result.push(entry);
  }
  if (anyShort && !input.allow_partial) {
    throw new RuleError('INSUFFICIENT_INVENTORY', 'Not enough available inventory to allocate the full order', { lines: result.map((r) => ({ ...r, required: r.required.toString(), allocated_before: r.allocated_before.toString(), allocated_now: r.allocated_now.toString(), short: r.short.toString() })) });
  }
  const status = anyShort ? 'PARTIALLY_ALLOCATED' : 'ALLOCATED';
  await tx.orders.update({ where: { id: o.id }, data: { status, version: { increment: 1 } } });
  await audit(tx, ctx, { action: 'order.allocate', entity_type: 'order', entity_id: o.id, after: { status, strategy, result } });
  return { order_id: o.id, status, strategy, lines: result };
}

/** Releases ALL active allocations of an order back to AVAILABLE. */
export async function deallocateOrder(tx: Tx, ctx: ActorContext, orderId: string, reason: string) {
  const allocs = await tx.$queryRaw<{ id: string; lpn_id: string; sku_id: string; qty: bigint; picked_qty: bigint; order_line_id: string }[]>`
    SELECT a.id, a.lpn_id, a.sku_id, a.qty, a.picked_qty, a.order_line_id FROM allocations a JOIN order_lines ol ON ol.id = a.order_line_id
     WHERE ol.order_id = ${orderId}::uuid AND a.status = 'ACTIVE' ORDER BY a.lpn_id FOR UPDATE OF a`;
  let released = 0n;
  for (const a of allocs) {
    const remaining = a.qty - a.picked_qty;
    if (remaining > 0n) {
      const lpn = await lockLpn(tx, a.lpn_id);
      await recordMovement(tx, ctx, {
        movement_type: 'DEALLOCATE',
        sku_id: a.sku_id,
        qty: remaining,
        from_lpn_id: lpn.id,
        to_lpn_id: lpn.id,
        from_location_id: lpn.current_location_id,
        to_location_id: lpn.current_location_id,
        from_status: 'ALLOCATED',
        to_status: 'AVAILABLE',
        order_id: orderId,
        reference_type: 'allocation',
        reference_id: a.id,
        reason,
        idempotency_suffix: `DEALLOC:${a.id}`,
      });
      await tx.order_lines.update({ where: { id: a.order_line_id }, data: { allocated_qty: { decrement: remaining } } });
      released += remaining;
    }
    await tx.allocations.update({ where: { id: a.id }, data: { status: 'RELEASED', qty: a.picked_qty } });
  }
  return { released, allocations: allocs.length };
}

/**
 * Cancel an order. Allowed freely before picking; during picking it needs a
 * supervisor authorization and picked goods are returned to stock as a new
 * storage pallet (never lost). Loaded/shipped orders cannot be cancelled here.
 */
export async function cancelOrder(tx: Tx, ctx: ActorContext, input: { order_id: string; reason: string; authorization_id?: string }) {
  const o = await lockOrder(tx, input.order_id);
  if (['SHIPPED', 'LOADED', 'LOADING', 'CANCELLED'].includes(o.status)) throw new RuleError('ORDER_STATUS', `Order is ${o.status} and cannot be cancelled`);
  if (o.shipment_id) throw new RuleError('ORDER_IN_SHIPMENT', 'Remove the order from its shipment first');
  if (['PICKING', 'PICKED', 'STAGED', 'VERIFIED'].includes(o.status)) {
    if (!input.authorization_id) throw new RuleError('AUTHORIZATION_REQUIRED', 'Cancelling an order during/after picking requires supervisor authorization (ORDER_CANCEL_DURING_PICKING)');
    await consumeAuthorization(tx, input.authorization_id, { exception_type: 'ORDER_CANCEL_DURING_PICKING', entity_type: 'order', entity_id: o.id });
    await unpickOrder(tx, ctx, o.id, input.reason);
  }
  const de = await deallocateOrder(tx, ctx, o.id, input.reason);
  await tx.pick_tasks.updateMany({ where: { order_id: o.id, status: { in: ['PENDING', 'IN_PROGRESS'] } }, data: { status: 'CANCELLED' } });
  await tx.pick_task_lines.updateMany({ where: { pick_task: { order_id: o.id }, status: { in: ['PENDING', 'IN_PROGRESS'] } }, data: { status: 'CANCELLED' } });
  await tx.staging_assignments.updateMany({ where: { order_id: o.id, released_at: null }, data: { released_at: new Date() } });
  await tx.verifications.updateMany({ where: { order_id: o.id, status: 'IN_PROGRESS' }, data: { status: 'CANCELLED', completed_at: new Date() } });
  await tx.orders.update({ where: { id: o.id }, data: { status: 'CANCELLED', version: { increment: 1 }, notes: input.reason } });
  if (['PICKING', 'PICKED', 'STAGED', 'VERIFIED'].includes(o.status)) {
    await createIncident(tx, ctx, { incident_type: 'OTHER', severity: 'LOW', title: `Pedido ${o.order_number} cancelado durante surtido`, description: input.reason, entity_type: 'order', entity_id: o.id, order_id: o.id });
  }
  await audit(tx, ctx, { action: 'order.cancel', entity_type: 'order', entity_id: o.id, before: { status: o.status }, after: { status: 'CANCELLED', deallocated: de.released.toString() }, reason: input.reason });
  return { order_id: o.id, status: 'CANCELLED', deallocated: de.released };
}

export async function orderDetail(tx: Tx, orderId: string) {
  const order = await tx.orders.findUnique({
    where: { id: orderId },
    include: {
      customer: true,
      lines: { include: { sku: true, allocations: { include: { lpn: { select: { code: true, current_location: { select: { code: true } } } } } } }, orderBy: { line_no: 'asc' } },
      pick_tasks: { orderBy: { created_at: 'desc' }, take: 3 },
      staging_assignments: { where: { released_at: null }, include: { location: { select: { code: true, barcode: true } } } },
      verifications: { orderBy: { started_at: 'desc' }, take: 3 },
      shipment: true,
      lpns: { select: { id: true, code: true, status: true, current_location: { select: { code: true } } } },
    },
  });
  if (!order) throw new NotFoundError('order', orderId);
  const [picker, verifier] = await Promise.all([
    order.picker_id ? tx.users.findUnique({ where: { id: order.picker_id }, select: { username: true, full_name: true } }) : null,
    order.verifier_id ? tx.users.findUnique({ where: { id: order.verifier_id }, select: { username: true, full_name: true } }) : null,
  ]);
  return { ...order, picker, verifier };
}
