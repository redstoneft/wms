import type { UomCode } from '@wms/shared';
import type { Tx } from '../../db.js';
import { ConflictError, NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';
import { resolveSkuBarcode, toBaseQty } from '../../lib/lookup.js';
import { changeStatus, createLpn, lockBalances, lockLocationByBarcode, lockLpn, lockLpnByCode, moveLpn, recordMovement, transferBetweenLpns, type LpnRow } from '../../inventory/ledger.js';
import { createIncident } from '../incidents/service.js';
import { createPutawayTask } from '../putaway/service.js';

// ---------------------------------------------------------------------
// Pick task generation (route = location pick_sequence) + staging assignment
// ---------------------------------------------------------------------

export async function createPickTask(tx: Tx, ctx: ActorContext, orderId: string, assignTo?: string) {
  const orows = await tx.$queryRaw<{ id: string; status: string; order_number: string }[]>`SELECT id, status, order_number FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
  const order = orows[0];
  if (!order) throw new NotFoundError('order', orderId);
  if (!['ALLOCATED', 'PARTIALLY_ALLOCATED', 'PICKED'].includes(order.status)) throw new RuleError('ORDER_STATUS', `Order is ${order.status}; allocate it first`);
  const existing = await tx.pick_tasks.findFirst({ where: { order_id: orderId, status: { in: ['PENDING', 'IN_PROGRESS'] } } });
  if (existing) throw new ConflictError('PICK_TASK_EXISTS', 'Order already has an active pick task');

  const allocs = await tx.$queryRaw<{ id: string; order_line_id: string; lpn_id: string; sku_id: string; qty: bigint; picked_qty: bigint; location_id: string; pick_sequence: number | null; location_code: string; lpn_total: bigint; single_sku: boolean }[]>`
    SELECT a.id, a.order_line_id, a.lpn_id, a.sku_id, a.qty, a.picked_qty, l.current_location_id AS location_id, loc.pick_sequence, loc.code AS location_code,
           (SELECT sum(b.qty) FROM inventory_balances b WHERE b.lpn_id = l.id AND b.qty > 0)::bigint AS lpn_total,
           NOT EXISTS (SELECT 1 FROM inventory_balances b WHERE b.lpn_id = l.id AND b.qty > 0 AND b.sku_id <> a.sku_id) AS single_sku
      FROM allocations a JOIN order_lines ol ON ol.id = a.order_line_id JOIN lpns l ON l.id = a.lpn_id JOIN locations loc ON loc.id = l.current_location_id
     WHERE ol.order_id = ${orderId}::uuid AND a.status = 'ACTIVE' AND a.qty > a.picked_qty
     ORDER BY loc.pick_sequence NULLS LAST, loc.code, l.code`;
  if (!allocs.length) throw new RuleError('NOTHING_TO_PICK', 'Order has no active allocations');

  const task = await tx.pick_tasks.create({ data: { order_id: orderId, assigned_to: assignTo ?? null } });
  let seq = 1;
  for (const a of allocs) {
    const fullPallet = a.single_sku && a.qty - a.picked_qty === a.lpn_total;
    await tx.pick_task_lines.create({
      data: { pick_task_id: task.id, order_line_id: a.order_line_id, allocation_id: a.id, sequence: seq++, location_id: a.location_id, lpn_id: a.lpn_id, sku_id: a.sku_id, qty: a.qty - a.picked_qty, full_pallet: fullPallet },
    });
  }
  const staging = await assignStaging(tx, ctx, orderId);
  await audit(tx, ctx, { action: 'pick.task_created', entity_type: 'pick_task', entity_id: task.id, after: { order: order.order_number, lines: allocs.length, staging: staging.code } });
  return { task, lines: allocs.length, staging };
}

/** Picks a free STAGING location (no active assignment, no pallets), locking it so two orders never share one. */
async function assignStaging(tx: Tx, ctx: ActorContext, orderId: string) {
  const current = await tx.staging_assignments.findFirst({ where: { order_id: orderId, released_at: null }, include: { location: true } });
  if (current) return current.location;
  const rows = await tx.$queryRaw<{ id: string; code: string; barcode: string }[]>`
    SELECT loc.id, loc.code, loc.barcode FROM locations loc
     WHERE loc.location_type = 'STAGING' AND loc.is_active AND loc.admin_status = 'ACTIVE'
       AND NOT EXISTS (SELECT 1 FROM staging_assignments sa WHERE sa.location_id = loc.id AND sa.released_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM lpns l WHERE l.current_location_id = loc.id)
     ORDER BY loc.code FOR UPDATE SKIP LOCKED LIMIT 1`;
  const loc = rows[0];
  if (!loc) throw new RuleError('NO_STAGING_AVAILABLE', 'No free staging location available');
  await tx.staging_assignments.create({ data: { order_id: orderId, location_id: loc.id } });
  await audit(tx, ctx, { action: 'staging.assign', entity_type: 'order', entity_id: orderId, after: { location: loc.code } });
  return loc;
}

export async function startPickTask(tx: Tx, ctx: ActorContext, taskId: string) {
  const rows = await tx.$queryRaw<{ id: string; status: string; assigned_to: string | null; order_id: string }[]>`SELECT id, status, assigned_to, order_id FROM pick_tasks WHERE id = ${taskId}::uuid FOR UPDATE`;
  const t = rows[0];
  if (!t) throw new NotFoundError('pick task', taskId);
  if (t.status === 'COMPLETED' || t.status === 'CANCELLED') throw new RuleError('TASK_STATUS', `Task is ${t.status}`);
  if (t.status === 'IN_PROGRESS' && t.assigned_to && t.assigned_to !== ctx.userId) throw new ConflictError('TASK_TAKEN', 'Another picker already owns this task');
  if (t.assigned_to && t.assigned_to !== ctx.userId && !ctx.permissions.has('picking.assign')) throw new ConflictError('TASK_ASSIGNED', 'Task is assigned to someone else');
  await tx.pick_tasks.update({ where: { id: taskId }, data: { status: 'IN_PROGRESS', assigned_to: ctx.userId, started_at: new Date(), version: { increment: 1 } } });
  await tx.orders.update({ where: { id: t.order_id }, data: { status: 'PICKING', picker_id: ctx.userId, version: { increment: 1 } } });
  await audit(tx, ctx, { action: 'pick.start', entity_type: 'pick_task', entity_id: taskId });
  return pickTaskView(tx, taskId);
}

export async function pickTaskView(tx: Tx, taskId: string) {
  const task = await tx.pick_tasks.findUnique({ where: { id: taskId }, include: { order: { include: { customer: true, staging_assignments: { where: { released_at: null }, include: { location: true } } } } } });
  if (!task) throw new NotFoundError('pick task', taskId);
  const lines = await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT ptl.id, ptl.sequence, ptl.status, ptl.scan_step, ptl.qty::text AS qty, ptl.picked_qty::text AS picked_qty, ptl.full_pallet,
           loc.code AS location_code, loc.barcode AS location_barcode, l.code AS lpn_code, s.code AS sku_code, s.description AS sku_description,
           (SELECT json_agg(json_build_object('uom_code', u.uom_code, 'base_qty', u.base_qty::text)) FROM sku_uoms u WHERE u.sku_id = s.id) AS uoms
      FROM pick_task_lines ptl JOIN locations loc ON loc.id = ptl.location_id JOIN lpns l ON l.id = ptl.lpn_id JOIN skus s ON s.id = ptl.sku_id
     WHERE ptl.pick_task_id = ${taskId}::uuid ORDER BY ptl.sequence`;
  const outbound = task.outbound_lpn_id ? await tx.lpns.findUnique({ where: { id: task.outbound_lpn_id }, select: { code: true } }) : null;
  return {
    task: { id: task.id, status: task.status, assigned_to: task.assigned_to, started_at: task.started_at, completed_at: task.completed_at, outbound_lpn: outbound?.code ?? null },
    order: { id: task.order.id, order_number: task.order.order_number, customer: task.order.customer.name, destination: task.order.destination, status: task.order.status },
    staging: task.order.staging_assignments[0]?.location ?? null,
    lines,
  };
}

// ---------------------------------------------------------------------
// Directed picking scan state machine: LOCATION → LPN/SKU → QTY
// ---------------------------------------------------------------------

export async function pickScan(tx: Tx, ctx: ActorContext, input: { pick_task_id: string; line_id: string; step: 'LOCATION' | 'LPN' | 'QTY'; scanned?: string; qty?: bigint; uom_code?: UomCode }) {
  const trows = await tx.$queryRaw<{ id: string; status: string; assigned_to: string | null; order_id: string; outbound_lpn_id: string | null }[]>`
    SELECT id, status, assigned_to, order_id, outbound_lpn_id FROM pick_tasks WHERE id = ${input.pick_task_id}::uuid FOR UPDATE`;
  const task = trows[0];
  if (!task) throw new NotFoundError('pick task', input.pick_task_id);
  if (task.status !== 'IN_PROGRESS') throw new RuleError('TASK_STATUS', `Task is ${task.status}; start it first`);
  if (task.assigned_to !== ctx.userId) throw new ConflictError('NOT_YOUR_TASK', 'This task belongs to another picker');
  const lrows = await tx.$queryRaw<{ id: string; status: string; scan_step: number; qty: bigint; picked_qty: bigint; location_id: string; lpn_id: string; sku_id: string; allocation_id: string; order_line_id: string; full_pallet: boolean }[]>`
    SELECT id, status, scan_step, qty, picked_qty, location_id, lpn_id, sku_id, allocation_id, order_line_id, full_pallet FROM pick_task_lines WHERE id = ${input.line_id}::uuid AND pick_task_id = ${task.id}::uuid FOR UPDATE`;
  const line = lrows[0];
  if (!line) throw new NotFoundError('pick line', input.line_id);
  if (line.status === 'PICKED') throw new ConflictError('LINE_PICKED', 'Line already picked');
  if (line.status === 'SHORT' || line.status === 'CANCELLED') throw new RuleError('LINE_STATUS', `Line is ${line.status}`);
  const expectedLoc = await tx.locations.findUniqueOrThrow({ where: { id: line.location_id } });
  const expectedLpn = await lockLpn(tx, line.lpn_id);
  const sku = await tx.skus.findUniqueOrThrow({ where: { id: line.sku_id } });

  switch (input.step) {
    case 'LOCATION': {
      const scanned = (input.scanned ?? '').trim();
      if (scanned !== expectedLoc.barcode && scanned.toUpperCase() !== expectedLoc.code) {
        throw blocked(ctx, task.id, line.id, 'WRONG_LOCATION', `UBICACIÓN INCORRECTA — esperada ${expectedLoc.code}`, { expected: expectedLoc.code, scanned });
      }
      if (expectedLpn.current_location_id !== expectedLoc.id) {
        throw new RuleError('LPN_MOVED', `LPN ${expectedLpn.code} is no longer in ${expectedLoc.code}; ask a supervisor`, { lpn: expectedLpn.code });
      }
      await tx.pick_task_lines.update({ where: { id: line.id }, data: { scan_step: 1, status: 'IN_PROGRESS' } });
      return { ok: true, next: 'LPN', line_id: line.id, expected_lpn: expectedLpn.code, sku: sku.code };
    }
    case 'LPN': {
      if (line.scan_step < 1) throw new RuleError('SCAN_ORDER', 'Scan the location first');
      const scanned = (input.scanned ?? '').trim();
      if (scanned.toUpperCase() !== expectedLpn.code) {
        // maybe they scanned the product barcode: it must be the right SKU…
        let okSku = false;
        try {
          const r = await resolveSkuBarcode(tx, scanned);
          okSku = r.sku.id === line.sku_id;
        } catch {
          okSku = false;
        }
        if (!okSku) {
          const code = /^PLT-/i.test(scanned) ? 'WRONG_LPN' : 'WRONG_SKU';
          throw blocked(ctx, task.id, line.id, code, code === 'WRONG_LPN' ? `LPN INCORRECTO — esperado ${expectedLpn.code}` : `SKU INCORRECTO — esperado ${sku.code}`, { expected_lpn: expectedLpn.code, expected_sku: sku.code, scanned });
        }
        // …and unambiguous: if another pallet of this SKU sits in the same location the LPN itself must be scanned
        const others = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(DISTINCT l.id) AS n FROM lpns l JOIN inventory_balances b ON b.lpn_id = l.id AND b.qty > 0 AND b.sku_id = ${line.sku_id}::uuid
          WHERE l.current_location_id = ${expectedLoc.id}::uuid`;
        if (Number(others[0]?.n ?? 0n) > 1) {
          throw blocked(ctx, task.id, line.id, 'LPN_REQUIRED', `Hay varios pallets de ${sku.code} en ${expectedLoc.code}: escanee el LPN ${expectedLpn.code}`, { expected_lpn: expectedLpn.code });
        }
      }
      await tx.pick_task_lines.update({ where: { id: line.id }, data: { scan_step: 2 } });
      const remaining = line.qty - line.picked_qty;
      return { ok: true, next: 'QTY', line_id: line.id, remaining, full_pallet: line.full_pallet };
    }
    case 'QTY': {
      if (line.scan_step < 2) throw new RuleError('SCAN_ORDER', 'Scan location and LPN/product first');
      if (input.qty === undefined || !input.uom_code) throw new RuleError('QTY_REQUIRED', 'quantity and unit of measure are required');
      const uom = input.uom_code;
      const { base } = await toBaseQty(tx, line.sku_id, input.qty, uom);
      const remaining = line.qty - line.picked_qty;
      if (base > remaining) {
        throw blocked(ctx, task.id, line.id, 'QTY_EXCEEDED', `CANTIDAD EXCEDIDA — faltan ${remaining}, escaneaste ${base}`, { remaining: remaining.toString(), scanned: base.toString() });
      }
      let movementId: bigint;
      let outboundCode: string;
      // whole-pallet conversion only when the pallet really holds exactly what is left on the line (single SKU, all of it)
      const palletState = await tx.$queryRaw<{ total: bigint; skus: bigint }[]>`SELECT COALESCE(sum(qty),0)::bigint AS total, count(DISTINCT sku_id)::bigint AS skus FROM inventory_balances WHERE lpn_id = ${expectedLpn.id}::uuid AND qty > 0`;
      const wholePallet = line.full_pallet && base === remaining && palletState[0]!.skus === 1n && palletState[0]!.total === remaining;
      if (wholePallet) {
        // whole pallet becomes the outbound unit, in place
        movementId = await changeStatus(tx, ctx, { movement_type: 'PICK', lpn: expectedLpn, sku_id: line.sku_id, qty: base, from_status: 'ALLOCATED', to_status: 'PICKING', order_id: task.order_id, task_id: task.id, reference_type: 'pick_line', reference_id: line.id });
        await tx.lpns.update({ where: { id: expectedLpn.id }, data: { status: 'PICKING', lpn_type: 'OUTBOUND', order_id: task.order_id, version: { increment: 1 } } });
        outboundCode = expectedLpn.code;
      } else {
        const outbound = await getOrCreateOutboundLpn(tx, ctx, task, expectedLpn);
        movementId = await transferBetweenLpns(tx, ctx, {
          movement_type: 'PICK',
          from_lpn: expectedLpn,
          to_lpn: outbound,
          sku_id: line.sku_id,
          qty: base,
          uom_code: uom,
          uom_qty: input.qty,
          from_status: 'ALLOCATED',
          to_status: 'PICKING',
          to_location_id: expectedLpn.current_location_id,
          order_id: task.order_id,
          task_id: task.id,
          reference_type: 'pick_line',
          reference_id: line.id,
        });
        outboundCode = outbound.code;
        // if the source pallet is now empty, mark it consumed
        const left = await tx.inventory_balances.count({ where: { lpn_id: expectedLpn.id, qty: { gt: 0n } } });
        if (left === 0) await tx.lpns.update({ where: { id: expectedLpn.id }, data: { status: 'CONSUMED', version: { increment: 1 } } });
      }
      const newPicked = line.picked_qty + base;
      const done = newPicked === line.qty;
      await tx.pick_task_lines.update({ where: { id: line.id }, data: { picked_qty: newPicked, status: done ? 'PICKED' : 'IN_PROGRESS', scan_step: done ? 0 : 2, picked_at: done ? new Date() : null } });
      await tx.allocations.update({ where: { id: line.allocation_id }, data: { picked_qty: { increment: base }, status: done ? 'PICKED' : 'ACTIVE' } });
      await tx.order_lines.update({ where: { id: line.order_line_id }, data: { picked_qty: { increment: base }, allocated_qty: { decrement: base } } });
      await audit(tx, ctx, { action: 'pick.scan', entity_type: 'pick_task', entity_id: task.id, after: { line: line.id, sku: sku.code, qty: base.toString(), from_lpn: expectedLpn.code, to_lpn: outboundCode, movement_id: movementId.toString() } });
      const completed = await maybeCompleteTask(tx, ctx, task.id);
      return { ok: true, next: done ? 'NEXT_LINE' : 'QTY', line_id: line.id, picked: newPicked, remaining: line.qty - newPicked, outbound_lpn: outboundCode, task_completed: completed };
    }
  }
}

async function getOrCreateOutboundLpn(tx: Tx, ctx: ActorContext, task: { id: string; order_id: string; outbound_lpn_id: string | null }, atLpn: LpnRow): Promise<LpnRow> {
  if (task.outbound_lpn_id) {
    const l = await lockLpn(tx, task.outbound_lpn_id);
    if (l.status === 'PICKING') return l;
  }
  const lpn = await createLpn(tx, ctx, { warehouse_id: atLpn.warehouse_id, lpn_type: 'OUTBOUND', location_id: atLpn.current_location_id, order_id: task.order_id });
  await tx.lpns.update({ where: { id: lpn.id }, data: { status: 'PICKING' } });
  await tx.pick_tasks.update({ where: { id: task.id }, data: { outbound_lpn_id: lpn.id } });
  task.outbound_lpn_id = lpn.id;
  return { ...lpn, status: 'PICKING' };
}

/** A blocked scan: the business transaction rolls back, but the attempt is persisted afterwards for traceability/KPIs. */
function blocked(ctx: ActorContext, taskId: string, lineId: string, code: string, message: string, details: Record<string, unknown>): RuleError {
  return new RuleError(code, message, details).persistAfterRollback((tx2) =>
    audit(tx2, ctx, { action: `pick.blocked_${code.toLowerCase()}`, entity_type: 'pick_task', entity_id: taskId, after: { line: lineId, details } }),
  );
}

async function maybeCompleteTask(tx: Tx, ctx: ActorContext, taskId: string): Promise<boolean> {
  const open = await tx.pick_task_lines.count({ where: { pick_task_id: taskId, status: { in: ['PENDING', 'IN_PROGRESS'] } } });
  if (open > 0) return false;
  const t = await tx.pick_tasks.update({ where: { id: taskId }, data: { status: 'COMPLETED', completed_at: new Date(), version: { increment: 1 } } });
  // allocations added after this task was created still need a pick wave: keep the order pickable
  const remainingAllocs = await tx.allocations.count({ where: { order_line: { order_id: t.order_id }, status: 'ACTIVE' } });
  await tx.orders.update({ where: { id: t.order_id }, data: { status: remainingAllocs > 0 ? 'PARTIALLY_ALLOCATED' : 'PICKED', version: { increment: 1 } } });
  await audit(tx, ctx, { action: 'pick.task_completed', entity_type: 'pick_task', entity_id: taskId, after: { remaining_active_allocations: remainingAllocs } });
  return true;
}

/**
 * Supervisor closes a line short: the unpicked remainder is deallocated, an
 * incident is created, the line is SHORT. The order line keeps picked < required
 * so the release rule will block the shipment until resolved.
 */
export async function shortLine(tx: Tx, ctx: ActorContext, input: { pick_task_id: string; line_id: string; reason: string }) {
  const lrows = await tx.$queryRaw<{ id: string; status: string; qty: bigint; picked_qty: bigint; lpn_id: string; sku_id: string; allocation_id: string; order_line_id: string; order_id: string }[]>`
    SELECT ptl.id, ptl.status, ptl.qty, ptl.picked_qty, ptl.lpn_id, ptl.sku_id, ptl.allocation_id, ptl.order_line_id, pt.order_id
      FROM pick_task_lines ptl JOIN pick_tasks pt ON pt.id = ptl.pick_task_id WHERE ptl.id = ${input.line_id}::uuid AND pt.id = ${input.pick_task_id}::uuid FOR UPDATE OF ptl`;
  const line = lrows[0];
  if (!line) throw new NotFoundError('pick line', input.line_id);
  if (!['PENDING', 'IN_PROGRESS'].includes(line.status)) throw new RuleError('LINE_STATUS', `Line is ${line.status}`);
  const remaining = line.qty - line.picked_qty;
  const lpn = await lockLpn(tx, line.lpn_id);
  if (remaining > 0n) {
    await recordMovement(tx, ctx, {
      movement_type: 'DEALLOCATE',
      sku_id: line.sku_id,
      qty: remaining,
      from_lpn_id: lpn.id,
      to_lpn_id: lpn.id,
      from_location_id: lpn.current_location_id,
      to_location_id: lpn.current_location_id,
      from_status: 'ALLOCATED',
      to_status: 'AVAILABLE',
      order_id: line.order_id,
      reference_type: 'pick_line',
      reference_id: line.id,
      reason: input.reason,
      idempotency_suffix: `SHORT:${line.id}`,
    });
    await tx.order_lines.update({ where: { id: line.order_line_id }, data: { allocated_qty: { decrement: remaining } } });
  }
  await tx.allocations.update({ where: { id: line.allocation_id }, data: { status: 'RELEASED', ...(line.picked_qty > 0n ? { qty: line.picked_qty } : {}) } });
  await tx.pick_task_lines.update({ where: { id: line.id }, data: { status: 'SHORT' } });
  const sku = await tx.skus.findUniqueOrThrow({ where: { id: line.sku_id } });
  const inc = await createIncident(tx, ctx, { incident_type: 'PICKING_ERROR', severity: 'HIGH', title: `Surtido incompleto ${sku.code}: faltan ${remaining} en ${lpn.code}`, description: input.reason, entity_type: 'pick_task', entity_id: input.pick_task_id, sku_id: sku.id, lpn_id: lpn.id, location_id: lpn.current_location_id, order_id: line.order_id, qty: remaining });
  await audit(tx, ctx, { action: 'pick.short', entity_type: 'pick_task', entity_id: input.pick_task_id, after: { line: line.id, remaining: remaining.toString(), incident: inc.incident_number }, reason: input.reason });
  const completed = await maybeCompleteTask(tx, ctx, input.pick_task_id);
  return { line_id: line.id, status: 'SHORT', deallocated: remaining, incident: inc.incident_number, task_completed: completed };
}

// ---------------------------------------------------------------------
// Staging: outbound LPNs are scanned into the order's staging lane
// ---------------------------------------------------------------------

export async function stageLpn(tx: Tx, ctx: ActorContext, input: { lpn_code: string; staging_location_barcode: string }) {
  const lpn = await lockLpnByCode(tx, input.lpn_code);
  if (lpn.status !== 'PICKING') throw new RuleError('LPN_STATUS', `LPN ${lpn.code} is ${lpn.status}; only picked pallets can be staged`);
  if (!lpn.order_id) throw new RuleError('LPN_NO_ORDER', 'Outbound LPN has no order');
  const loc = await lockLocationByBarcode(tx, input.staging_location_barcode);
  if (loc.location_type !== 'STAGING') throw new RuleError('NOT_STAGING', `${loc.code} is not a staging location`);
  const assignment = await tx.staging_assignments.findFirst({ where: { order_id: lpn.order_id, released_at: null } });
  if (!assignment) throw new RuleError('NO_STAGING_ASSIGNED', 'Order has no staging lane assigned');
  if (assignment.location_id !== loc.id) {
    const expected = await tx.locations.findUnique({ where: { id: assignment.location_id } });
    throw new RuleError('WRONG_LOCATION', `STAGING INCORRECTO — este pedido va en ${expected?.code}`, { expected: expected?.code, scanned: loc.code });
  }
  const balances = await lockBalances(tx, lpn.id);
  if (balances.some((b) => b.status !== 'PICKING')) throw new RuleError('MIXED_STATUS', `LPN ${lpn.code} has inventory not in PICKING status`);
  const movements = await moveLpn(tx, ctx, { movement_type: 'STAGE', lpn, to_location_id: loc.id, only_status: 'PICKING', to_status: 'STAGING', order_id: lpn.order_id, reference_type: 'staging', reference_id: assignment.id });
  await tx.lpns.update({ where: { id: lpn.id }, data: { status: 'STAGED', version: { increment: 1 } } });
  // order staged when the pick task is done and nothing of the order is still PICKING
  const stillPicking = await tx.lpns.count({ where: { order_id: lpn.order_id, status: 'PICKING' } });
  const openTasks = await tx.pick_tasks.count({ where: { order_id: lpn.order_id, status: { in: ['PENDING', 'IN_PROGRESS'] } } });
  let orderStatus: string | null = null;
  const orderRow = await tx.orders.findUniqueOrThrow({ where: { id: lpn.order_id }, select: { status: true } });
  if (stillPicking === 0 && openTasks === 0 && orderRow.status === 'PICKED') {
    await tx.orders.update({ where: { id: lpn.order_id }, data: { status: 'STAGED', version: { increment: 1 } } });
    orderStatus = 'STAGED';
  }
  await audit(tx, ctx, { action: 'stage.lpn', entity_type: 'lpn', entity_id: lpn.id, after: { location: loc.code, order_id: lpn.order_id, movements: movements.map(String) } });
  return { lpn_code: lpn.code, location: loc.code, order_status: orderStatus, movements };
}

/**
 * Returns picked goods of an order to stock (used on cancellation): every
 * outbound LPN of the order goes PICKING/STAGING → AVAILABLE and becomes a
 * storage pallet with a put-away task. Full traceability is preserved.
 */
export async function unpickOrder(tx: Tx, ctx: ActorContext, orderId: string, reason: string) {
  const lpns = await tx.lpns.findMany({ where: { order_id: orderId, status: { in: ['PICKING', 'STAGED'] } } });
  const lines = await tx.order_lines.findMany({ where: { order_id: orderId } });
  for (const l of lpns) {
    const lpn = await lockLpn(tx, l.id);
    const balances = await lockBalances(tx, lpn.id);
    for (const b of balances) {
      if (b.status !== 'PICKING' && b.status !== 'STAGING') continue;
      await recordMovement(tx, ctx, {
        movement_type: 'UNPICK',
        sku_id: b.sku_id,
        qty: b.qty,
        from_lpn_id: lpn.id,
        to_lpn_id: lpn.id,
        from_location_id: lpn.current_location_id,
        to_location_id: lpn.current_location_id,
        from_status: b.status,
        to_status: 'AVAILABLE',
        order_id: orderId,
        reason,
        idempotency_suffix: `UNPICK:${lpn.id}:${b.sku_id}:${b.status}`,
      });
      const ol = lines.find((x) => x.sku_id === b.sku_id);
      if (ol) {
        const dec = b.qty < ol.picked_qty ? b.qty : ol.picked_qty;
        await tx.order_lines.update({ where: { id: ol.id }, data: { picked_qty: { decrement: dec }, verified_qty: 0n } });
        ol.picked_qty -= dec;
      }
    }
    await tx.lpns.update({ where: { id: lpn.id }, data: { status: 'STORED', lpn_type: 'STORAGE', order_id: null, version: { increment: 1 } } });
    await createPutawayTask(tx, ctx, { ...lpn, status: 'STORED' }, { allowStoredLocation: true });
  }
  await tx.allocations.updateMany({ where: { order_line: { order_id: orderId }, status: 'PICKED' }, data: { status: 'RELEASED' } });
  return { lpns: lpns.length };
}
