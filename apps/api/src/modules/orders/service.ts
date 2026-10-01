import type { AllocationStrategy, UomCode } from '@wms/shared';
import type { Tx } from '../../db.js';
import { ConflictError, NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';
import { getSkuByCode, toBaseQty } from '../../lib/lookup.js';
import { createInventory, createLpn, getBalance, lockBalances, lockLpn, recordMovement, removeInventory, transferBetweenLpns } from '../../inventory/ledger.js';
import { createPutawayTask } from '../putaway/service.js';
import { consumeAuthorization } from '../authorizations/routes.js';
import { getSettings } from '../settings/routes.js';
import { createIncident } from '../incidents/service.js';
import { appendAllocationsToActiveTask, createPickTask, returnPickedToSource, unpickOrder } from '../picking/service.js';

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

/**
 * A number can be captured again after its order was cancelled: the cancelled record keeps its history under
 * "<number> ~CANCELADO-n" and the number is free. A live order with that number still blocks.
 */
export async function freeOrderNumber(tx: Tx, ctx: ActorContext, number: string): Promise<void> {
  const existing = await tx.orders.findFirst({ where: { order_number: { equals: number, mode: 'insensitive' } } });
  if (!existing) return;
  if (existing.status !== 'CANCELLED') throw new ConflictError('ORDER_EXISTS', `El pedido ${number} ya existe (estado ${existing.status}); cancélalo primero o usa otro número`, { status: existing.status });
  let n = 1;
  let renamed = `${number} ~CANCELADO-${n}`;
  while (await tx.orders.findFirst({ where: { order_number: { equals: renamed, mode: 'insensitive' } }, select: { id: true } })) renamed = `${number} ~CANCELADO-${++n}`;
  await tx.orders.update({ where: { id: existing.id }, data: { order_number: renamed, version: { increment: 1 } } });
  await audit(tx, ctx, { action: 'order.number_released', entity_type: 'order', entity_id: existing.id, before: { order_number: number }, after: { order_number: renamed }, reason: 'El número se vuelve a capturar; el pedido cancelado conserva su historial' });
}

export async function createOrder(tx: Tx, ctx: ActorContext, input: CreateOrderInput) {
  const customer = await tx.customers.findUnique({ where: { code: input.customer_code } });
  if (!customer) throw new NotFoundError('customer', input.customer_code);
  await freeOrderNumber(tx, ctx, input.order_number);
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
  const rows = await tx.$queryRaw<{ id: string; status: string; version: number; order_number: string; picker_id: string | null; shipment_id: string | null; is_training: boolean }[]>`
    SELECT id, status, version, order_number, picker_id, shipment_id, is_training FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
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
/**
 * FULL_PALLET: whole pallets first (largest that still fits what is left), and the remainder from the smallest pallet
 * that covers it, so as few pallets as possible are broken. Re-evaluated after every take, not a fixed sort.
 */
function fewestBrokenPallets<T extends { qty: bigint }>(cands: T[], remaining: bigint): T[] {
  const left = [...cands];
  const out: T[] = [];
  while (remaining > 0n && left.length) {
    const fits = left.filter((c) => c.qty <= remaining);
    const pick = fits.length ? fits.reduce((m, c) => (c.qty > m.qty ? c : m)) : left.reduce((m, c) => (c.qty < m.qty ? c : m));
    out.push(pick);
    left.splice(left.indexOf(pick), 1);
    remaining -= pick.qty < remaining ? pick.qty : remaining;
  }
  return [...out, ...left];
}

export async function allocateOrder(tx: Tx, ctx: ActorContext, input: { order_id: string; strategy?: AllocationStrategy; allow_partial: boolean }) {
  const o = await lockOrder(tx, input.order_id);
  if (!['ACCEPTED', 'PARTIALLY_ALLOCATED', 'PICKED', 'PICKING'].includes(o.status)) throw new RuleError('ORDER_STATUS', `Order is ${o.status}; only accepted orders can be allocated`);
  // an open pick task is no obstacle: what gets allocated now is appended to it as new lines
  const activeTask = await tx.pick_tasks.count({ where: { order_id: o.id, status: { in: ['PENDING', 'IN_PROGRESS'] } } });
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
         CASE WHEN ${strategy} = 'FULL_PALLET' AND b.qty <= ${remaining} THEN b.qty END DESC,
         CASE WHEN ${strategy} = 'FULL_PALLET' AND b.qty > ${remaining} THEN b.qty END ASC,
         l.created_at ASC, l.code ASC`;
    // Lock order everywhere is LPN → balance. Candidates are read unlocked and re-checked under the LPN lock,
    // so a concurrent allocation of the same pallet is seen (smaller AVAILABLE) instead of double-allocated.
    const ordered = strategy === 'FULL_PALLET' ? fewestBrokenPallets(candidates, remaining) : candidates;
    for (const c of ordered) {
      if (remaining <= 0n) break;
      const lpn = await lockLpn(tx, c.lpn_id);
      if (lpn.status !== 'STORED') continue;
      const available = await getBalance(tx, lpn.id, line.sku_id, 'AVAILABLE');
      if (available <= 0n) continue;
      const take = available < remaining ? available : remaining;
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
  let status = anyShort ? 'PARTIALLY_ALLOCATED' : 'ALLOCATED';
  let appended: { task_id: string; added: number } | null = null;
  if (activeTask) {
    appended = await appendAllocationsToActiveTask(tx, ctx, o.id);
    status = 'PICKING';
  }
  await tx.orders.update({ where: { id: o.id }, data: { status, version: { increment: 1 } } });
  await audit(tx, ctx, { action: 'order.allocate', entity_type: 'order', entity_id: o.id, after: { status, strategy, result, appended } });
  return { order_id: o.id, status, strategy, lines: result, appended };
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
    // keep qty > 0 (DB check); when something was picked the allocation shrinks to what was actually taken
    await tx.allocations.update({ where: { id: a.id }, data: { status: 'RELEASED', ...(a.picked_qty > 0n ? { qty: a.picked_qty } : {}) } });
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
    if (input.authorization_id) await consumeAuthorization(tx, input.authorization_id, { exception_type: 'ORDER_CANCEL_DURING_PICKING', entity_type: 'order', entity_id: o.id }, ctx);
    else if (!ctx.permissions.has('exceptions.authorize')) throw new RuleError('AUTHORIZATION_REQUIRED', 'Cancelling an order during/after picking requires supervisor authorization (ORDER_CANCEL_DURING_PICKING)');
    // else: a supervisor/admin cancels on their own authority (reason is mandatory; the audit entry names them)
    await unpickOrder(tx, ctx, o.id, input.reason);
  }
  const de = await deallocateOrder(tx, ctx, o.id, input.reason);
  await tx.pick_tasks.updateMany({ where: { order_id: o.id, status: { in: ['PENDING', 'IN_PROGRESS'] } }, data: { status: 'CANCELLED' } });
  await tx.pick_task_lines.updateMany({ where: { pick_task: { order_id: o.id }, status: { in: ['PENDING', 'IN_PROGRESS'] } }, data: { status: 'CANCELLED' } });
  await tx.staging_assignments.updateMany({ where: { order_id: o.id, released_at: null }, data: { released_at: new Date() } });
  await tx.verifications.updateMany({ where: { order_id: o.id, status: 'IN_PROGRESS' }, data: { status: 'CANCELLED', completed_at: new Date() } });
  const prev = await tx.orders.findUniqueOrThrow({ where: { id: o.id }, select: { notes: true } });
  await tx.orders.update({ where: { id: o.id }, data: { status: 'CANCELLED', version: { increment: 1 }, notes: [prev.notes, `[CANCELADO] ${input.reason}`].filter(Boolean).join('\n') } });
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

/**
 * Admin only: the goods left the warehouse without following the flow (no staging/verification/loading). Everything
 * the order holds (picked, staged, loaded pallets) is shipped; what was never picked leaves from its allocated pallet,
 * or from available stock when nothing was allocated. Missing stock is not invented: it is recorded on an incident.
 */
/**
 * Reopen a closed order (admin). CANCELLED → ACCEPTED with its lines (nothing was reserved any more). SHIPPED → every SHIP
 * movement of the order not yet undone comes back onto the same pallet (own outbound pallets keep their picked/staged/
 * loaded state; stock pallets consumed by force-deliver return as AVAILABLE); lines, pallets and the staging lane are
 * rebuilt from what came back. An order whose truck already departed cannot be reopened here.
 */
export async function reopenOrder(tx: Tx, ctx: ActorContext, input: { order_id: string; reason: string }) {
  const o = await lockOrder(tx, input.order_id);
  if (!['SHIPPED', 'CANCELLED'].includes(o.status)) throw new RuleError('ORDER_STATUS', `Order is ${o.status}; only delivered or cancelled orders can be reopened`);
  const prev = await tx.orders.findUniqueOrThrow({ where: { id: o.id }, select: { notes: true, shipment_id: true } });
  const lines = await tx.order_lines.findMany({ where: { order_id: o.id }, include: { sku: true }, orderBy: { line_no: 'asc' } });
  if (!lines.length) throw new RuleError('NO_LINES', `Order ${o.order_number} has no lines left to reopen`);
  if (o.status === 'CANCELLED') {
    await tx.order_lines.updateMany({ where: { order_id: o.id }, data: { allocated_qty: 0n, picked_qty: 0n, verified_qty: 0n, loaded_qty: 0n } });
    await tx.orders.update({ where: { id: o.id }, data: { status: 'ACCEPTED', picker_id: null, verifier_id: null, verified_at: null, shipment_id: null, version: { increment: 1 }, notes: [prev.notes, `[REABIERTO] ${input.reason}`].filter(Boolean).join('\n') } });
    const inc = await createIncident(tx, ctx, { incident_type: 'OTHER', severity: 'LOW', title: `Pedido ${o.order_number} reabierto (estaba cancelado)`, description: input.reason, entity_type: 'order', entity_id: o.id, order_id: o.id });
    await audit(tx, ctx, { action: 'order.reopen', entity_type: 'order', entity_id: o.id, before: { status: o.status }, after: { status: 'ACCEPTED', incident_id: inc.id }, reason: input.reason });
    return { order_id: o.id, order_number: o.order_number, status: 'ACCEPTED', restored: [], incident_id: inc.id };
  }
  if (prev.shipment_id) {
    const sh = await tx.shipments.findUnique({ where: { id: prev.shipment_id }, select: { status: true, shipment_number: true } });
    if (sh?.status === 'DEPARTED') throw new RuleError('SHIPMENT_DEPARTED', `El embarque ${sh.shipment_number} ya salió; el pedido no se puede reabrir desde aquí`);
  }
  const ships = await tx.$queryRaw<{ id: bigint; sku_id: string; qty: bigint; from_lpn_id: string; from_status: string; from_location_id: string | null }[]>`
    SELECT m.id, m.sku_id, m.qty, m.from_lpn_id, m.from_status, m.from_location_id FROM inventory_movements m
     WHERE m.order_id = ${o.id}::uuid AND m.movement_type = 'SHIP'
       AND NOT EXISTS (SELECT 1 FROM inventory_movements u WHERE u.movement_type = 'SHIP_UNDO' AND u.reference_type = 'ship_movement' AND u.reference_id = m.id::text)
     ORDER BY m.id`;
  if (!ships.length) throw new RuleError('NOTHING_TO_RESTORE', `Order ${o.order_number} has no shipped inventory to bring back`);
  const restored: { lpn: string; sku: string; qty: string; status: string; location: string | null }[] = [];
  const ownPicked = new Map<string, bigint>();
  for (const s of ships) {
    const lpn = await lockLpn(tx, s.from_lpn_id);
    const own = lpn.order_id === o.id;
    const status = own ? (s.from_status as 'PICKING' | 'STAGING' | 'LOADED') : 'AVAILABLE';
    const locationId = lpn.current_location_id ?? s.from_location_id;
    if (!locationId) throw new RuleError('NO_LOCATION', `LPN ${lpn.code} has no location to return to`);
    const lpnStatus = own ? (status === 'LOADED' ? 'LOADED' : status === 'STAGING' ? 'STAGED' : 'PICKING') : 'STORED';
    // the pallet must accept inventory again before the movement (the ledger refuses SHIPPED pallets)
    await tx.lpns.update({ where: { id: lpn.id }, data: { status: lpnStatus, current_location_id: locationId, ...(own ? { shipment_id: null } : {}), version: { increment: 1 } } });
    await createInventory(tx, ctx, { movement_type: 'SHIP_UNDO', to_lpn: { ...lpn, status: lpnStatus, current_location_id: locationId }, sku_id: s.sku_id, qty: s.qty, status, location_id: locationId, order_id: o.id, reference_type: 'ship_movement', reference_id: s.id.toString(), reason: input.reason, note: `Pedido ${o.order_number} reabierto` });
    if (own) ownPicked.set(s.sku_id, (ownPicked.get(s.sku_id) ?? 0n) + s.qty);
    const loc = await tx.locations.findUnique({ where: { id: locationId }, select: { code: true, location_type: true } });
    restored.push({ lpn: lpn.code, sku: lines.find((l) => l.sku_id === s.sku_id)?.sku.code ?? s.sku_id, qty: s.qty.toString(), status, location: loc?.code ?? null });
  }
  // lines: what sits on the order's own pallets counts as picked; nothing is reserved or verified any more
  let allPicked = true;
  let anyPicked = false;
  for (const line of lines) {
    const picked = ownPicked.get(line.sku_id) ?? 0n;
    const p = picked > line.required_qty ? line.required_qty : picked;
    if (p < line.required_qty) allPicked = false;
    if (p > 0n) anyPicked = true;
    await tx.order_lines.update({ where: { id: line.id }, data: { picked_qty: p, allocated_qty: 0n, verified_qty: 0n, loaded_qty: 0n } });
  }
  // reservations force-deliver marked as picked on stock pallets are released (the stock is available again)
  await tx.$executeRaw`UPDATE allocations a SET status = 'RELEASED' FROM order_lines ol, lpns l WHERE a.order_line_id = ol.id AND ol.order_id = ${o.id}::uuid AND a.lpn_id = l.id AND a.status = 'PICKED' AND l.order_id IS DISTINCT FROM ${o.id}::uuid`;
  // the lane: if the order's pallets sit in a staging lane, that lane is the order's again
  const lane = await tx.$queryRaw<{ id: string; code: string }[]>`SELECT loc.id, loc.code FROM lpns l JOIN locations loc ON loc.id = l.current_location_id WHERE l.order_id = ${o.id}::uuid AND l.status = 'STAGED' AND loc.location_type = 'STAGING' AND NOT EXISTS (SELECT 1 FROM staging_assignments sa WHERE sa.location_id = loc.id AND sa.released_at IS NULL) LIMIT 1`;
  if (lane[0]) await tx.staging_assignments.create({ data: { order_id: o.id, location_id: lane[0].id } });
  const status = allPicked ? (lane[0] ? 'STAGED' : 'PICKED') : anyPicked ? 'PARTIALLY_ALLOCATED' : 'ACCEPTED';
  await tx.orders.update({ where: { id: o.id }, data: { status, verifier_id: null, verified_at: null, shipment_id: null, version: { increment: 1 }, notes: [prev.notes, `[REABIERTO] ${input.reason}`].filter(Boolean).join('\n') } });
  const inc = await createIncident(tx, ctx, { incident_type: 'OTHER', severity: 'MEDIUM', title: `Pedido ${o.order_number} reabierto: ${restored.length} movimiento(s) de salida revertidos`, description: `${input.reason}. Regresa: ${restored.map((r) => `${r.lpn} ${r.sku} ${r.qty} (${r.status}${r.location ? ` en ${r.location}` : ''})`).join(', ')}`, entity_type: 'order', entity_id: o.id, order_id: o.id });
  await audit(tx, ctx, { action: 'order.reopen', entity_type: 'order', entity_id: o.id, before: { status: o.status }, after: { status, restored, incident_id: inc.id }, reason: input.reason });
  return { order_id: o.id, order_number: o.order_number, status, restored, incident_id: inc.id };
}

export async function forceDeliver(tx: Tx, ctx: ActorContext, input: { order_id: string; reason: string }) {
  const o = await lockOrder(tx, input.order_id);
  if (['SHIPPED', 'CANCELLED'].includes(o.status)) throw new RuleError('ORDER_STATUS', `Order is ${o.status}`);
  const lines = await tx.order_lines.findMany({ where: { order_id: o.id }, include: { sku: true }, orderBy: { line_no: 'asc' } });
  const shipped: { lpn: string; sku: string; qty: string; from: string }[] = [];
  const missing: { sku: string; qty: string }[] = [];
  const ship = async (lpnId: string, skuId: string, qty: bigint, status: 'PICKING' | 'STAGING' | 'LOADED' | 'ALLOCATED' | 'AVAILABLE', from: string) => {
    const lpn = await lockLpn(tx, lpnId);
    await removeInventory(tx, ctx, { movement_type: 'SHIP', from_lpn: lpn, sku_id: skuId, qty, status, order_id: o.id, reference_type: 'order_force_deliver', reference_id: o.id, reason: input.reason, note: 'entrega fuera de flujo' });
    const left = await tx.inventory_balances.count({ where: { lpn_id: lpn.id, qty: { gt: 0n } } });
    if (left === 0) await tx.lpns.update({ where: { id: lpn.id }, data: { status: lpn.order_id === o.id ? 'SHIPPED' : 'CONSUMED', version: { increment: 1 } } });
    const sku = lines.find((l) => l.sku_id === skuId)?.sku.code ?? skuId;
    shipped.push({ lpn: lpn.code, sku, qty: qty.toString(), from });
  };
  // 1) whatever the order already holds on its outbound pallets
  const own = await tx.lpns.findMany({ where: { order_id: o.id, status: { in: ['PICKING', 'STAGED', 'LOADED'] } } });
  for (const l of own) {
    const balances = (await lockBalances(tx, l.id)).filter((b) => b.qty > 0n && ['PICKING', 'STAGING', 'LOADED'].includes(b.status));
    for (const b of balances) await ship(l.id, b.sku_id, b.qty, b.status as 'PICKING' | 'STAGING' | 'LOADED', 'surtido');
  }
  // 2) what was never picked: from the allocated pallets, then from available stock
  for (const line of lines) {
    let remaining = line.required_qty - line.picked_qty;
    if (remaining <= 0n) continue;
    const allocs = await tx.allocations.findMany({ where: { order_line_id: line.id, status: 'ACTIVE' } });
    for (const a of allocs) {
      if (remaining <= 0n) break;
      const have = await getBalance(tx, a.lpn_id, line.sku_id, 'ALLOCATED');
      const take = have < remaining ? have : remaining;
      if (take > 0n) {
        await ship(a.lpn_id, line.sku_id, take, 'ALLOCATED', 'asignado');
        remaining -= take;
      }
      await tx.allocations.update({ where: { id: a.id }, data: { status: 'PICKED', picked_qty: a.qty } });
    }
    if (remaining > 0n) {
      const stock = await tx.$queryRaw<{ lpn_id: string; qty: bigint }[]>`
        SELECT b.lpn_id, b.qty FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id JOIN warehouses w ON w.id = l.warehouse_id
         WHERE b.sku_id = ${line.sku_id}::uuid AND b.status = 'AVAILABLE' AND b.qty > 0 AND l.status IN ('STORED','OPEN') AND l.current_location_id IS NOT NULL
           AND (w.code = 'ESCUELA') = ${o.is_training}
         ORDER BY b.qty DESC, l.created_at ASC`;
      for (const s of stock) {
        if (remaining <= 0n) break;
        const take = s.qty < remaining ? s.qty : remaining;
        await ship(s.lpn_id, line.sku_id, take, 'AVAILABLE', 'existencia');
        remaining -= take;
      }
    }
    await tx.order_lines.update({ where: { id: line.id }, data: { picked_qty: line.required_qty - remaining, verified_qty: line.required_qty - remaining, loaded_qty: line.required_qty - remaining, allocated_qty: 0n } });
    if (remaining > 0n) missing.push({ sku: line.sku.code, qty: remaining.toString() });
  }
  // 3) close everything the flow left open
  await tx.pick_tasks.updateMany({ where: { order_id: o.id, status: { in: ['PENDING', 'IN_PROGRESS'] } }, data: { status: 'COMPLETED', completed_at: new Date() } });
  await tx.pick_task_lines.updateMany({ where: { pick_task: { order_id: o.id }, status: { in: ['PENDING', 'IN_PROGRESS'] } }, data: { status: 'CANCELLED' } });
  await tx.allocations.updateMany({ where: { order_line: { order_id: o.id }, status: 'ACTIVE' }, data: { status: 'RELEASED' } });
  await tx.staging_assignments.updateMany({ where: { order_id: o.id, released_at: null }, data: { released_at: new Date() } });
  await tx.verifications.updateMany({ where: { order_id: o.id, status: 'IN_PROGRESS' }, data: { status: 'CANCELLED', completed_at: new Date() } });
  const prev = await tx.orders.findUniqueOrThrow({ where: { id: o.id }, select: { notes: true, order_number: true } });
  await tx.orders.update({ where: { id: o.id }, data: { status: 'SHIPPED', version: { increment: 1 }, notes: [prev.notes, `[ENTREGADO FUERA DE FLUJO] ${input.reason}`].filter(Boolean).join('\n') } });
  const inc = await createIncident(tx, ctx, {
    incident_type: 'OTHER',
    severity: missing.length ? 'HIGH' : 'MEDIUM',
    title: `Pedido ${prev.order_number} entregado fuera de flujo`,
    description: `${input.reason}${missing.length ? ` · SIN EXISTENCIA PARA: ${missing.map((m) => `${m.sku} ${m.qty}`).join(', ')}` : ''}`,
    entity_type: 'order',
    entity_id: o.id,
    order_id: o.id,
  });
  await audit(tx, ctx, { action: 'order.force_deliver', entity_type: 'order', entity_id: o.id, before: { status: o.status }, after: { status: 'SHIPPED', shipped, missing, incident_id: inc.id }, reason: input.reason });
  return { order_id: o.id, status: 'SHIPPED', shipped, missing, incident_id: inc.id };
}

/**
 * Admin only: the customer changed the order after it was picked. Each line gets its new required quantity:
 *  - less than what was picked → the excess leaves the outbound pallets onto a new storage pallet (put-away task);
 *  - less than what was allocated (not yet picked) → the extra allocation is released;
 *  - more than what was picked → the line needs allocation and picking again (the order goes back to PARTIALLY_ALLOCATED);
 *  - a SKU not in the order → new line; qty 0 → the line is removed (its picked pieces go back to stock first).
 * Verification is invalidated for the changed lines. Everything is audited with the reason and an incident is opened.
 */
export async function adjustOrderLines(tx: Tx, ctx: ActorContext, input: { order_id: string; reason: string; lines: { sku_code: string; qty: bigint; uom_code: UomCode }[] }) {
  const o = await lockOrder(tx, input.order_id);
  if (['SHIPPED', 'CANCELLED', 'LOADING', 'LOADED'].includes(o.status)) throw new RuleError('ORDER_STATUS', `Order is ${o.status}; quantities can no longer change`);
  if (o.shipment_id) throw new RuleError('ORDER_IN_SHIPMENT', 'Remove the order from its shipment first');
  const lines = await tx.order_lines.findMany({ where: { order_id: o.id }, include: { sku: true }, orderBy: { line_no: 'asc' } });
  const changes: { sku: string; before: string; after: string; returned_to_stock: string; new_lpns: string[]; released_allocation: string; to_pick: string }[] = [];
  let needsPick = false;
  let touched = false;
  let maxLine = lines.reduce((m, l) => Math.max(m, l.line_no), 0);
  for (const inp of input.lines) {
    const sku = await getSkuByCode(tx, inp.sku_code);
    const { base: newReq } = await toBaseQty(tx, sku.id, inp.qty, inp.uom_code);
    const line = lines.find((l) => l.sku_id === sku.id) ?? null;
    if (!line) {
      if (newReq <= 0n) continue;
      const created = await tx.order_lines.create({ data: { order_id: o.id, line_no: ++maxLine, sku_id: sku.id, required_qty: newReq, uom_code: inp.uom_code, uom_qty: inp.qty }, include: { sku: true } });
      lines.push(created);
      changes.push({ sku: sku.code, before: '0', after: newReq.toString(), returned_to_stock: '0', new_lpns: [], released_allocation: '0', to_pick: newReq.toString() });
      needsPick = true;
      touched = true;
      continue;
    }
    if (newReq === line.required_qty) continue;
    touched = true;
    const change = { sku: sku.code, before: line.required_qty.toString(), after: newReq.toString(), returned_to_stock: '0', new_lpns: [] as string[], released_allocation: '0', to_pick: '0' };
    let picked = line.picked_qty;
    if (newReq < picked) {
      // excess picked pieces go back to the pallets and positions they came from; what cannot be traced goes to a new pallet
      let excess = picked - newReq;
      let returned = 0n;
      for (const r of await returnPickedToSource(tx, ctx, o.id, input.reason, { sku_id: sku.id, qty: excess })) {
        returned += BigInt(r.qty);
        excess -= BigInt(r.qty);
        change.new_lpns.push(r.to_lpn);
      }
      const outbound = await tx.$queryRaw<{ lpn_id: string; status: string; qty: bigint }[]>`
        SELECT b.lpn_id, b.status, b.qty FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id
         WHERE l.order_id = ${o.id}::uuid AND b.sku_id = ${sku.id}::uuid AND b.qty > 0 AND b.status IN ('PICKING','STAGING') AND l.status IN ('PICKING','STAGED')
         ORDER BY l.created_at DESC`;
      for (const row of outbound) {
        if (excess <= 0n) break;
        const take = row.qty < excess ? row.qty : excess;
        const from = await lockLpn(tx, row.lpn_id);
        if (!from.current_location_id) continue;
        const to = await createLpn(tx, ctx, { warehouse_id: from.warehouse_id, lpn_type: 'STORAGE', location_id: from.current_location_id, parent_lpn_id: from.id });
        await tx.lpns.update({ where: { id: to.id }, data: { status: 'STORED' } });
        await transferBetweenLpns(tx, ctx, { movement_type: 'UNPICK', from_lpn: from, to_lpn: { ...to, status: 'STORED' }, sku_id: sku.id, qty: take, from_status: row.status as 'PICKING' | 'STAGING', to_status: 'AVAILABLE', to_location_id: from.current_location_id, order_id: o.id, reference_type: 'order_adjust', reference_id: line.id, reason: input.reason, note: `Ajuste del pedido ${o.order_number}: ${take} pzas regresan a existencia` });
        await createPutawayTask(tx, ctx, { ...to, status: 'STORED' }, { allowStoredLocation: true });
        const left = await tx.inventory_balances.count({ where: { lpn_id: from.id, qty: { gt: 0n } } });
        if (left === 0) {
          await tx.lpns.update({ where: { id: from.id }, data: { status: 'CONSUMED', version: { increment: 1 } } });
          await tx.pick_tasks.updateMany({ where: { outbound_lpn_id: from.id }, data: { outbound_lpn_id: null } });
        }
        change.new_lpns.push(to.code);
        returned += take;
        excess -= take;
      }
      if (excess > 0n) throw new RuleError('PICKED_NOT_FOUND', `Order ${o.order_number} shows ${picked} picked of ${sku.code} but only ${picked - excess} were found on its pallets`);
      // picked allocations shrink to what stays with the order (newest first)
      let undo = returned;
      const pickedAllocs = await tx.allocations.findMany({ where: { order_line_id: line.id, status: 'PICKED' }, orderBy: { created_at: 'desc' } });
      for (const a of pickedAllocs) {
        if (undo <= 0n) break;
        const cut = a.picked_qty < undo ? a.picked_qty : undo;
        const rest = a.picked_qty - cut;
        await tx.allocations.update({ where: { id: a.id }, data: rest > 0n ? { picked_qty: rest, qty: rest } : { picked_qty: 0n, status: 'RELEASED' } });
        undo -= cut;
      }
      picked -= returned;
      change.returned_to_stock = returned.toString();
    }
    // allocated but not picked beyond the new requirement: release it
    const activeAllocs = await tx.$queryRaw<{ id: string; lpn_id: string; qty: bigint; picked_qty: bigint }[]>`SELECT id, lpn_id, qty, picked_qty FROM allocations WHERE order_line_id = ${line.id}::uuid AND status = 'ACTIVE' ORDER BY created_at DESC FOR UPDATE`;
    let allocated = activeAllocs.reduce((a, x) => a + (x.qty - x.picked_qty), 0n);
    let release = allocated + picked - newReq;
    let released = 0n;
    for (const a of activeAllocs) {
      if (release <= 0n) break;
      const remaining = a.qty - a.picked_qty;
      const cut = remaining < release ? remaining : release;
      if (cut <= 0n) continue;
      const lpn = await lockLpn(tx, a.lpn_id);
      await recordMovement(tx, ctx, { movement_type: 'DEALLOCATE', sku_id: sku.id, qty: cut, from_lpn_id: lpn.id, to_lpn_id: lpn.id, from_location_id: lpn.current_location_id, to_location_id: lpn.current_location_id, from_status: 'ALLOCATED', to_status: 'AVAILABLE', order_id: o.id, reference_type: 'allocation', reference_id: a.id, reason: input.reason, idempotency_suffix: `ADJUST:${a.id}:${cut}` });
      const newQty = a.qty - cut;
      await tx.allocations.update({ where: { id: a.id }, data: newQty > 0n ? { qty: newQty } : { status: 'RELEASED', ...(a.picked_qty > 0n ? { qty: a.picked_qty } : {}) } });
      await tx.pick_task_lines.updateMany({ where: { allocation_id: a.id, status: { in: ['PENDING', 'IN_PROGRESS'] } }, data: newQty > 0n ? { qty: newQty } : { status: 'CANCELLED' } });
      release -= cut;
      released += cut;
      allocated -= cut;
    }
    change.released_allocation = released.toString();
    const toPick = newReq - picked - allocated;
    if (toPick > 0n) {
      needsPick = true;
      change.to_pick = toPick.toString();
    }
    const verifiedNow = line.verified_qty > newReq ? newReq : line.verified_qty;
    if (newReq === 0n) {
      // a line cannot stay at 0 (required > 0 rule): it is removed; the movements, the audit entry and the incident keep its history
      await tx.pick_task_lines.deleteMany({ where: { order_line_id: line.id } });
      await tx.allocations.deleteMany({ where: { order_line_id: line.id } });
      await tx.order_lines.delete({ where: { id: line.id } });
      changes.push(change);
      continue;
    }
    await tx.order_lines.update({ where: { id: line.id }, data: { required_qty: newReq, uom_code: inp.uom_code, uom_qty: inp.qty, picked_qty: picked, allocated_qty: allocated, verified_qty: verifiedNow, loaded_qty: 0n } });
    changes.push(change);
  }
  if (!touched) return { order_id: o.id, order_number: o.order_number, status: o.status, changes: [], incident_id: null };
  // the order's state after the change
  let status = o.status;
  if (needsPick && ['PICKED', 'STAGED', 'VERIFIED', 'ALLOCATED'].includes(o.status)) status = 'PARTIALLY_ALLOCATED';
  else if (o.status === 'VERIFIED') status = 'STAGED';
  if (['STAGED', 'VERIFIED'].includes(o.status)) {
    await tx.verifications.updateMany({ where: { order_id: o.id, status: 'IN_PROGRESS' }, data: { status: 'CANCELLED', completed_at: new Date() } });
    await tx.order_lines.updateMany({ where: { order_id: o.id }, data: { verified_qty: 0n } });
  }
  const prev = await tx.orders.findUniqueOrThrow({ where: { id: o.id }, select: { notes: true } });
  await tx.orders.update({ where: { id: o.id }, data: { status, version: { increment: 1 }, notes: [prev.notes, `[AJUSTE DE CANTIDADES] ${input.reason}: ${changes.map((c) => `${c.sku} ${c.before}→${c.after}`).join(', ')}`].filter(Boolean).join('\n') } });
  // what is now needed gets allocated and put in front of the picker right away: appended to the open task, or a new task
  let picking: { allocated: boolean; task_id: string | null; added: number; short: string[] } = { allocated: false, task_id: null, added: 0, short: [] };
  if (needsPick && ['PICKING', 'PARTIALLY_ALLOCATED', 'PICKED', 'ACCEPTED'].includes(status)) {
    const alloc = await allocateOrder(tx, ctx, { order_id: o.id, allow_partial: true });
    const short = alloc.lines.filter((l) => l.short > 0n).map((l) => `${l.sku}: faltan ${l.short}`);
    let taskId = alloc.appended?.task_id ?? null;
    let added = alloc.appended?.added ?? 0;
    if (!taskId && alloc.lines.some((l) => l.allocated_now > 0n)) {
      const t = await createPickTask(tx, ctx, o.id);
      taskId = t.task.id;
      added = t.lines;
    }
    status = (await tx.orders.findUniqueOrThrow({ where: { id: o.id }, select: { status: true } })).status;
    picking = { allocated: true, task_id: taskId, added, short };
  }
  const inc = await createIncident(tx, ctx, { incident_type: 'OTHER', severity: 'LOW', title: `Pedido ${o.order_number}: cantidades cambiadas después de surtir`, description: `${input.reason} · ${changes.map((c) => `${c.sku} ${c.before}→${c.after}${c.returned_to_stock !== '0' ? ` (${c.returned_to_stock} a existencia: ${c.new_lpns.join(', ')})` : ''}${c.to_pick !== '0' ? ` (${c.to_pick} por surtir)` : ''}`).join('; ')}`, entity_type: 'order', entity_id: o.id, order_id: o.id });
  await audit(tx, ctx, { action: 'order.adjust_lines', entity_type: 'order', entity_id: o.id, before: { status: o.status }, after: { status, changes, picking, incident_id: inc.id }, reason: input.reason });
  return { order_id: o.id, order_number: o.order_number, status, changes, picking, incident_id: inc.id };
}
