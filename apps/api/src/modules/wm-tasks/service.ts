// Tasks an operator creates for themself from the handheld, always stating the purpose ("para qué").
// Pick: the order is accepted/allocated if needed and the pick task is assigned to the operator.
// Count: a blind location count assigned to the operator. Put-away: a task for a pallet left without one.
import type { DamageLinkOrderInput, DamageReportInput, HandheldOrderInput, LpnRecountInput, SelfTaskInput } from '@wms/shared';
import type { Tx } from '../../db.js';
import { ForbiddenError, NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';
import { createLpn, lockBalances, lockLocationByBarcode, lockLpn, lockLpnByCode, removeInventory, transferBetweenLpns, type LpnRow } from '../../inventory/ledger.js';
import { toBaseQty } from '../../lib/lookup.js';
import { createReceipt } from '../inbound/service.js';
import { adjustInventory, changeInventoryStatus } from '../inventory/service.js';
import { finishCounting, submitCount } from '../counts/service.js';
import { createCountTask } from '../counts/service.js';
import { resolveImportSku } from '../imports/service.js';
import { freeOrderNumber, acceptOrder, allocateOrder, createOrder } from '../orders/service.js';
import { createIncident } from '../incidents/service.js';
import { appendAllocationsToActiveTask, createPickTask } from '../picking/service.js';
import { createPutawayTask } from '../putaway/service.js';

export async function createSelfTask(tx: Tx, ctx: ActorContext, input: SelfTaskInput) {
  const purpose = input.purpose.trim();
  if (input.kind !== 'RECEIPT' && !input.reference.trim()) throw new RuleError('REFERENCE_REQUIRED', 'Escanea la referencia de la tarea');
  // the kind must match what the operator is allowed to execute
  const needs: Record<SelfTaskInput['kind'], 'picking.execute' | 'counts.execute' | 'putaway.execute' | 'receiving.scan'> = { PICK: 'picking.execute', COUNT: 'counts.execute', PUTAWAY: 'putaway.execute', RECEIPT: 'receiving.scan' };
  if (!ctx.permissions.has(needs[input.kind])) throw new ForbiddenError(`Your role cannot execute ${input.kind} tasks`);
  switch (input.kind) {
    case 'PICK': {
      const number = input.reference.trim().toUpperCase();
      const order = await tx.orders.findFirst({ where: { order_number: { equals: number, mode: 'insensitive' } } });
      if (!order) {
        if (!input.new_order) throw new NotFoundError('order', number);
        // a brand-new order built on the floor: free picking (scan pallets whenever, close when done)
        const customer = await tx.customers.findUnique({ where: { code: input.new_order.customer_code } });
        if (!customer) throw new NotFoundError('customer', input.new_order.customer_code);
        const created = await tx.orders.create({ data: { order_number: number, customer_id: customer.id, destination: input.new_order.destination ?? null, order_date: new Date(), status: 'ACCEPTED', source: 'MANUAL', notes: purpose, created_by: ctx.userId } });
        const task = await tx.pick_tasks.create({ data: { order_id: created.id, assigned_to: ctx.userId, mode: 'FREE', purpose } });
        await audit(tx, ctx, { action: 'order.create', entity_type: 'order', entity_id: created.id, after: { order_number: number, customer: customer.code, source: 'MANUAL', free_pick: true }, reason: purpose });
        await audit(tx, ctx, { action: 'task.self_created', entity_type: 'pick_task', entity_id: task.id, after: { kind: 'PICK', mode: 'FREE', order: number }, reason: purpose });
        return { kind: 'PICK' as const, id: task.id, mode: 'FREE' as const, order_number: number, lines: 0, staging: null, next: '/wm/pick' };
      }
      // an open free-pick task of this order that is already mine: just continue it
      const mine = await tx.pick_tasks.findFirst({ where: { order_id: order.id, mode: 'FREE', status: { in: ['PENDING', 'IN_PROGRESS'] } } });
      if (mine) {
        if (mine.assigned_to && mine.assigned_to !== ctx.userId) throw new RuleError('TASK_TAKEN', `Order ${order.order_number} is being picked by someone else`);
        return { kind: 'PICK' as const, id: mine.id, mode: 'FREE' as const, order_number: order.order_number, lines: 0, staging: null, next: '/wm/pick' };
      }
      if (order.status === 'IMPORTED') await acceptOrder(tx, ctx, order.id);
      const fresh = await tx.orders.findUniqueOrThrow({ where: { id: order.id } });
      if (['ACCEPTED', 'PARTIALLY_ALLOCATED'].includes(fresh.status)) await allocateOrder(tx, ctx, { order_id: order.id, allow_partial: true });
      const r = await createPickTask(tx, ctx, order.id, ctx.userId);
      await tx.pick_tasks.update({ where: { id: r.task.id }, data: { purpose } });
      await audit(tx, ctx, { action: 'task.self_created', entity_type: 'pick_task', entity_id: r.task.id, after: { kind: 'PICK', order: fresh.order_number, lines: r.lines, staging: r.staging?.code ?? null }, reason: purpose });
      return { kind: 'PICK' as const, id: r.task.id, mode: 'ALLOCATED' as const, order_number: fresh.order_number, lines: r.lines, staging: r.staging?.code ?? null, next: '/wm/pick' };
    }
    case 'COUNT': {
      const task = await createCountTask(tx, ctx, { count_type: 'LOCATION', location_barcodes: [input.reference.trim()], assigned_to: ctx.userId, is_blind: true, notes: purpose });
      await audit(tx, ctx, { action: 'task.self_created', entity_type: 'count_task', entity_id: task.id, after: { kind: 'COUNT', location: input.reference.trim() }, reason: purpose });
      return { kind: 'COUNT' as const, id: task.id, next: '/wm/count' };
    }
    case 'RECEIPT': {
      // a new receipt opened on the floor; the dock is the warehouse's receiving dock unless the operator scanned one
      let dock: { id: string; code: string; location_type: string };
      if (input.reference.trim()) {
        dock = await lockLocationByBarcode(tx, input.reference.trim());
        if (dock.location_type !== 'RECEIVING') throw new RuleError('NOT_RECEIVING_LOCATION', `${dock.code} no es un andén de recibo`);
      } else {
        const wh = (await tx.warehouses.findFirst({ where: { is_default: true, is_active: true } })) ?? (await tx.warehouses.findFirst({ where: { is_active: true, NOT: { code: 'ESCUELA' } }, orderBy: { created_at: 'asc' } }));
        if (!wh) throw new RuleError('NO_WAREHOUSE', 'No hay almacén configurado');
        // prefer a dock without an open receipt, then the first dock by code
        const docks = await tx.locations.findMany({ where: { warehouse_id: wh.id, location_type: 'RECEIVING', is_active: true, admin_status: 'ACTIVE' }, orderBy: { code: 'asc' } });
        if (!docks.length) throw new RuleError('NO_DOCK', `El almacén ${wh.code} no tiene andén de recibo`);
        const open = await tx.receipts.groupBy({ by: ['receiving_location_id'], where: { status: { in: ['OPEN', 'IN_PROGRESS'] }, receiving_location_id: { in: docks.map((d) => d.id) } } });
        const busy = new Set(open.map((o) => o.receiving_location_id));
        dock = docks.find((d) => !busy.has(d.id)) ?? docks[0]!;
      }
      const receipt = await createReceipt(tx, ctx, { receiving_location_id: dock.id, notes: purpose });
      await audit(tx, ctx, { action: 'task.self_created', entity_type: 'receipt', entity_id: receipt.id, after: { kind: 'RECEIPT', receipt: receipt.receipt_number, dock: dock.code }, reason: purpose });
      return { kind: 'RECEIPT' as const, id: receipt.id, receipt_number: receipt.receipt_number, dock: dock.code, next: `/wm/receive?receipt=${receipt.id}` };
    }
    case 'PUTAWAY': {
      const lpn = await lockLpnByCode(tx, input.reference.trim().toUpperCase());
      if (['SHIPPED', 'CANCELLED', 'CONSUMED'].includes(lpn.status)) throw new RuleError('LPN_FROZEN', `LPN ${lpn.code} is ${lpn.status}`);
      const task = await createPutawayTask(tx, ctx, lpn);
      await tx.putaway_tasks.update({ where: { id: task.id }, data: { purpose, assigned_to: ctx.userId } });
      await audit(tx, ctx, { action: 'task.self_created', entity_type: 'putaway_task', entity_id: task.id, after: { kind: 'PUTAWAY', lpn: lpn.code, suggested: task.suggested_location_id }, reason: purpose });
      return { kind: 'PUTAWAY' as const, id: task.id, lpn: lpn.code, next: '/wm/putaway' };
    }
  }
}

/** A manual order captured on the handheld (products scanned, quantities typed). Accepted right away; optionally picked now. */
export async function createHandheldOrder(tx: Tx, ctx: ActorContext, input: HandheldOrderInput) {
  const number = input.order_number.trim().toUpperCase();
  await freeOrderNumber(tx, ctx, number); // a cancelled order with this number is renamed and the number reused
  // several scans of the same product collapse into one line
  const merged = new Map<string, { sku_code: string; qty: bigint; uom_code: HandheldOrderInput['lines'][number]['uom_code'] }>();
  for (const l of input.lines) {
    const sku = await resolveImportSku(tx, l.sku_code.trim());
    if (!sku.is_active) throw new RuleError('SKU_INACTIVE', `SKU ${sku.code} is inactive`);
    const key = `${sku.code}|${l.uom_code}`;
    const cur = merged.get(key);
    if (cur) cur.qty += BigInt(l.qty);
    else merged.set(key, { sku_code: sku.code, qty: BigInt(l.qty), uom_code: l.uom_code });
  }
  const order = await createOrder(tx, ctx, { order_number: number, customer_code: input.customer_code, destination: input.destination, order_date: new Date(), priority: 5, notes: input.purpose, source: 'MANUAL', lines: [...merged.values()] });
  await acceptOrder(tx, ctx, order.id);
  await audit(tx, ctx, { action: 'order.handheld_capture', entity_type: 'order', entity_id: order.id, after: { order_number: number, customer: input.customer_code, lines: merged.size, start_now: input.start_now }, reason: input.purpose });
  if (!input.start_now) return { order_id: order.id, order_number: number, lines: merged.size, task_id: null, next: '/wm' };
  const alloc = await allocateOrder(tx, ctx, { order_id: order.id, allow_partial: true });
  const r = await createPickTask(tx, ctx, order.id, ctx.userId);
  await tx.pick_tasks.update({ where: { id: r.task.id }, data: { purpose: input.purpose } });
  await audit(tx, ctx, { action: 'task.self_created', entity_type: 'pick_task', entity_id: r.task.id, after: { kind: 'PICK', order: number, lines: r.lines, staging: r.staging?.code ?? null, allocation: alloc }, reason: input.purpose });
  return { order_id: order.id, order_number: number, lines: merged.size, task_id: r.task.id, staging: r.staging?.code ?? null, next: '/wm/pick' };
}

/**
 * Re-receive a pallet: the operator scans what the pallet really holds. Whoever may approve counts gets the
 * adjustments applied at once (audited, one incident per product); anyone else leaves a finished count on the
 * pallet's location (recount by a second person + supervisor approval, the normal control), never a silent change.
 */
export async function recountLpn(tx: Tx, ctx: ActorContext, input: LpnRecountInput) {
  const lpn = await lockLpnByCode(tx, input.lpn_code.trim().toUpperCase());
  if (['PICKING', 'STAGED'].includes(lpn.status) && lpn.order_id) return recountOutboundLpn(tx, ctx, lpn, input);
  if (!['STORED', 'OPEN'].includes(lpn.status) || !lpn.current_location_id) throw new RuleError('LPN_STATUS', `LPN ${lpn.code} is ${lpn.status}; only stored pallets can be re-received`);
  const loc = await tx.locations.findUniqueOrThrow({ where: { id: lpn.current_location_id } });
  const balances = (await lockBalances(tx, lpn.id)).filter((b) => b.qty > 0n);
  const busy = balances.filter((b) => b.status !== 'AVAILABLE');
  if (busy.length) throw new RuleError('LPN_BUSY', `LPN ${lpn.code} has inventory in ${[...new Set(busy.map((b) => b.status))].join(', ')}; free it first`);
  const counted = new Map<string, { code: string; qty: bigint }>();
  for (const l of input.lines) {
    const sku = await resolveImportSku(tx, l.sku_code.trim());
    const { base } = await toBaseQty(tx, sku.id, BigInt(l.qty), l.uom_code);
    const cur = counted.get(sku.id);
    counted.set(sku.id, { code: sku.code, qty: (cur?.qty ?? 0n) + base });
  }
  const system = new Map(balances.map((b) => [b.sku_id, b.qty]));
  const skuIds = [...new Set([...system.keys(), ...counted.keys()])];
  const deltas: { sku: string; system: string; counted: string; delta: string }[] = [];
  for (const id of skuIds) {
    const sys = system.get(id) ?? 0n;
    const cnt = counted.get(id)?.qty ?? 0n;
    const code = counted.get(id)?.code ?? (await tx.skus.findUniqueOrThrow({ where: { id }, select: { code: true } })).code;
    deltas.push({ sku: code, system: sys.toString(), counted: cnt.toString(), delta: (cnt - sys).toString() });
  }
  const reason = `Re-recepción de tarima ${lpn.code}: ${input.purpose.trim()}`;
  if (ctx.permissions.has('counts.approve')) {
    for (const d of deltas) {
      const delta = BigInt(d.delta);
      if (delta === 0n) continue;
      await adjustInventory(tx, ctx, { lpn_code: lpn.code, sku_code: d.sku, direction: delta > 0n ? 'IN' : 'OUT', qty: delta > 0n ? delta : -delta, uom_code: 'PIECE', reason });
    }
    await audit(tx, ctx, { action: 'lpn.recount_applied', entity_type: 'lpn', entity_id: lpn.id, after: { location: loc.code, deltas }, reason: input.purpose });
    return { mode: 'APPLIED' as const, lpn: lpn.code, location: loc.code, deltas, task_id: null, status: 'APPLIED' };
  }
  // no approval rights: leave a count on the pallet's location with the operator's figures, following the normal control
  const task = await createCountTask(tx, ctx, { count_type: 'LOCATION', location_barcodes: [loc.barcode], assigned_to: ctx.userId, is_blind: true, notes: reason });
  for (const id of skuIds) {
    const code = deltas.find((d) => d.sku === (counted.get(id)?.code ?? d.sku))?.sku;
    await submitCount(tx, ctx, { count_task_id: task.id, location_barcode: loc.barcode, lpn_code: lpn.code, barcode: code ?? '', qty: counted.get(id)?.qty ?? 0n, uom_code: 'PIECE' });
  }
  const fin = await finishCounting(tx, ctx, task.id);
  await audit(tx, ctx, { action: 'lpn.recount_submitted', entity_type: 'lpn', entity_id: lpn.id, after: { location: loc.code, deltas, count_task: task.id, status: fin.status }, reason: input.purpose });
  return { mode: 'COUNT' as const, lpn: lpn.code, location: loc.code, deltas, task_id: task.id, status: fin.status };
}

/**
 * Re-receiving an OUTBOUND pallet (picked or in staging): a box turned out to hold fewer pieces than registered.
 * The operator types what the pallet really holds; the difference leaves the pallet in the ledger, the order's picked
 * quantity drops by the same amount and the missing pieces are planned again and put in front of the picker (appended to
 * the open task, or a new task). An incident records the short box. Extra pieces are not registered here.
 */
async function recountOutboundLpn(tx: Tx, ctx: ActorContext, lpn: Awaited<ReturnType<typeof lockLpnByCode>>, input: LpnRecountInput) {
  const order = await tx.orders.findUniqueOrThrow({ where: { id: lpn.order_id! }, select: { id: true, order_number: true, status: true, shipment_id: true } });
  if (order.shipment_id || ['LOADING', 'LOADED', 'SHIPPED', 'CANCELLED'].includes(order.status)) throw new RuleError('ORDER_STATUS', `El pedido ${order.order_number} está ${order.status}; ya no se puede corregir desde aquí`);
  const balances = (await lockBalances(tx, lpn.id)).filter((b) => b.qty > 0n && (b.status === 'PICKING' || b.status === 'STAGING'));
  const counted = new Map<string, { code: string; qty: bigint }>();
  for (const l of input.lines) {
    const sku = await resolveImportSku(tx, l.sku_code.trim());
    const { base } = await toBaseQty(tx, sku.id, BigInt(l.qty), l.uom_code);
    const cur = counted.get(sku.id);
    counted.set(sku.id, { code: sku.code, qty: (cur?.qty ?? 0n) + base });
  }
  for (const [id, c] of counted) if (!balances.some((b) => b.sku_id === id) && c.qty > 0n) throw new RuleError('SKU_NOT_ON_PALLET', `${c.code} no va en la tarima ${lpn.code} (pedido ${order.order_number}); solo se corrige lo que ya estaba surtido en ella`);
  const deltas: { sku: string; system: string; counted: string; delta: string }[] = [];
  let needsPlan = false;
  for (const b of balances) {
    const cnt = counted.get(b.sku_id)?.qty ?? 0n;
    const sku = await tx.skus.findUniqueOrThrow({ where: { id: b.sku_id }, select: { id: true, code: true } });
    deltas.push({ sku: sku.code, system: b.qty.toString(), counted: cnt.toString(), delta: (cnt - b.qty).toString() });
    if (cnt > b.qty) throw new RuleError('MORE_THAN_PICKED', `${sku.code}: la tarima tiene ${cnt} y el sistema ${b.qty}; las piezas de más se registran surtiendo (captura normal), no aquí`);
    if (cnt === b.qty) continue;
    const missing = b.qty - cnt;
    // 1) the pieces never existed on the outbound pallet
    await removeInventory(tx, ctx, { movement_type: 'ADJUST_OUT', from_lpn: lpn, sku_id: sku.id, qty: missing, status: b.status, order_id: order.id, reference_type: 'lpn', reference_id: lpn.id, reason: `Caja incompleta en ${lpn.code}: ${input.purpose.trim()}`.slice(0, 120), note: `Re-recepción de tarima de salida ${lpn.code} del pedido ${order.order_number}: faltan ${missing} de ${sku.code}` });
    // 2) the order line is short again by that much
    await shortenPickedLine(tx, ctx, { order, lpn, sku, missing, purpose: input.purpose.trim(), title: `Caja incompleta: faltan ${missing} de ${sku.code} en la tarima de salida ${lpn.code} (pedido ${order.order_number})`, description: `${input.purpose.trim()}. Registrado por ${ctx.username} al re-recibir la tarima de salida: el sistema tenía ${b.qty}, la tarima trae ${cnt}. Las ${missing} piezas se vuelven a planear.` });
    needsPlan = true;
  }
  // if the pallet ended up empty it is consumed; the order falls back to picking
  const leftOnPallet = await tx.inventory_balances.count({ where: { lpn_id: lpn.id, qty: { gt: 0n } } });
  if (leftOnPallet === 0) await tx.lpns.update({ where: { id: lpn.id }, data: { status: 'CONSUMED', version: { increment: 1 } } });
  const replanned = needsPlan ? await replanOrderShortfall(tx, ctx, order) : { task_id: null, added: 0, short: [] as string[] };
  const status = (await tx.orders.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } })).status;
  await audit(tx, ctx, { action: 'lpn.outbound_recount', entity_type: 'lpn', entity_id: lpn.id, after: { order: order.order_number, deltas, replanned, status }, reason: input.purpose });
  const loc = lpn.current_location_id ? await tx.locations.findUnique({ where: { id: lpn.current_location_id }, select: { code: true } }) : null;
  return { mode: 'OUTBOUND' as const, lpn: lpn.code, location: loc?.code ?? '', order_number: order.order_number, order_status: status, deltas, replanned, task_id: replanned.task_id, status };
}


type OrderRef = { id: string; order_number: string; status: string };

/** An order line lost `missing` picked pieces (short box, damage): picked drops, the newest picks are undone in the plan, an incident is opened. */
async function shortenPickedLine(tx: Tx, ctx: ActorContext, p: { order: OrderRef; lpn: { id: string; code: string; current_location_id: string | null }; sku: { id: string; code: string }; missing: bigint; purpose: string; title: string; description: string }) {
  const line = await tx.order_lines.findFirst({ where: { order_id: p.order.id, sku_id: p.sku.id } });
  if (!line) throw new RuleError('LINE_NOT_FOUND', `${p.sku.code} no está en el pedido ${p.order.order_number}`);
  const newPicked = line.picked_qty - p.missing > 0n ? line.picked_qty - p.missing : 0n;
  await tx.order_lines.update({ where: { id: line.id }, data: { picked_qty: newPicked, verified_qty: 0n, loaded_qty: 0n } });
  let left = p.missing;
  const own = await tx.allocations.findMany({ where: { order_line_id: line.id, lpn_id: p.lpn.id, picked_qty: { gt: 0n } }, orderBy: { created_at: 'desc' } });
  const others = await tx.allocations.findMany({ where: { order_line_id: line.id, lpn_id: { not: p.lpn.id }, picked_qty: { gt: 0n }, status: { in: ['PICKED', 'ACTIVE'] } }, orderBy: { created_at: 'desc' } });
  for (const a of [...own, ...others]) {
    if (left <= 0n) break;
    const cut = a.picked_qty < left ? a.picked_qty : left;
    const rest = a.picked_qty - cut;
    await tx.allocations.update({ where: { id: a.id }, data: rest > 0n ? { picked_qty: rest, qty: rest } : { picked_qty: 0n, status: 'RELEASED' } });
    await tx.pick_task_lines.updateMany({ where: { allocation_id: a.id }, data: rest > 0n ? { picked_qty: rest, qty: rest } : { picked_qty: 0n, status: 'CANCELLED' } });
    left -= cut;
  }
  // the line's allocated counter must mirror what is still planned and unpicked, or the replan would think it is covered
  const planned = await tx.allocations.aggregate({ where: { order_line_id: line.id, status: 'ACTIVE' }, _sum: { qty: true, picked_qty: true } });
  await tx.order_lines.update({ where: { id: line.id }, data: { allocated_qty: (planned._sum.qty ?? 0n) - (planned._sum.picked_qty ?? 0n) } });
  await createIncident(tx, ctx, { incident_type: 'PICKING_ERROR', severity: 'MEDIUM', title: p.title, description: p.description, entity_type: 'order', entity_id: p.order.id, sku_id: p.sku.id, lpn_id: p.lpn.id, location_id: p.lpn.current_location_id, order_id: p.order.id, qty: p.missing });
}

/** What the order is now short of gets planned again and put in front of the picker (open task, or a new one). */
async function replanOrderShortfall(tx: Tx, ctx: ActorContext, order: OrderRef): Promise<{ task_id: string | null; added: number; short: string[] }> {
  await tx.verifications.updateMany({ where: { order_id: order.id, status: 'IN_PROGRESS' }, data: { status: 'CANCELLED', completed_at: new Date() } });
  const back = ['STAGED', 'VERIFIED', 'PICKED'].includes(order.status) ? 'PARTIALLY_ALLOCATED' : order.status;
  await tx.orders.update({ where: { id: order.id }, data: { status: back, version: { increment: 1 } } });
  const alloc = await allocateOrder(tx, ctx, { order_id: order.id, allow_partial: true });
  const short = alloc.lines.filter((l) => l.short > 0n).map((l) => `${l.sku}: faltan ${l.short}`);
  let taskId = alloc.appended?.task_id ?? null;
  let added = alloc.appended?.added ?? 0;
  if (!taskId && alloc.lines.some((l) => l.allocated_now > 0n)) {
    const t = await createPickTask(tx, ctx, order.id);
    taskId = t.task.id;
    added = t.lines;
  }
  if (!taskId) {
    const r = await appendAllocationsToActiveTask(tx, ctx, order.id);
    if (r) {
      taskId = r.task_id;
      added = r.added;
    }
  }
  return { task_id: taskId, added, short };
}

/**
 * Damaged pieces (merma) reported from the handheld. On a stored pallet the pieces stay there as DAMAGED (blocked for
 * picking) with an incident. On an outbound pallet being picked or staged, the damaged pieces move to a new DAMAGED
 * pallet at the same spot, the order's picked quantity drops and the difference is planned again for the picker.
 */
export async function reportDamage(tx: Tx, ctx: ActorContext, input: DamageReportInput) {
  const lpn = await lockLpnByCode(tx, input.lpn_code.trim().toUpperCase());
  const sku = await resolveImportSku(tx, input.sku_code.trim());
  const { base: qty } = await toBaseQty(tx, sku.id, BigInt(input.qty), input.uom_code);
  if (qty <= 0n) throw new RuleError('INVALID_QTY', 'La cantidad debe ser mayor a cero');
  const reason = input.reason.trim();
  if (['STORED', 'OPEN'].includes(lpn.status)) {
    const r = await changeInventoryStatus(tx, ctx, { lpn_code: lpn.code, sku_code: sku.code, action: 'DAMAGE', qty, reason: `Merma reportada por ${ctx.username}: ${reason}` });
    await audit(tx, ctx, { action: 'inventory.damage_reported', entity_type: 'lpn', entity_id: lpn.id, after: { sku: sku.code, qty: qty.toString(), movements: r.movements.map(String), mode: 'STORAGE', order: input.order_number ?? null }, reason });
    const report = await tx.damage_reports.create({ data: { user_id: ctx.userId, username: ctx.username, lpn_id: lpn.id, lpn_code: lpn.code, sku_id: sku.id, qty, reason, mode: 'STORAGE' } });
    if (input.order_number) {
      const link = await linkDamageToOrder(tx, ctx, { order_number: input.order_number, sku_code: sku.code, qty, uom_code: 'PIECE', lpn_code: lpn.code, reason, report_id: report.id });
      return { ...link, mode: 'STORAGE' as const, lpn: lpn.code, damaged_lpn: lpn.code, report_id: report.id };
    }
    return { mode: 'STORAGE' as const, lpn: lpn.code, damaged_lpn: lpn.code, sku: sku.code, qty: qty.toString(), order_number: null, replanned: null, report_id: report.id };
  }
  if (!['PICKING', 'STAGED'].includes(lpn.status) || !lpn.order_id) throw new RuleError('LPN_STATUS', `La tarima ${lpn.code} está ${lpn.status}; si ya está cargada, descárgala primero (Cargar → Descargar)`);
  const order = await tx.orders.findUniqueOrThrow({ where: { id: lpn.order_id }, select: { id: true, order_number: true, status: true, shipment_id: true } });
  if (order.shipment_id || ['LOADING', 'LOADED', 'SHIPPED', 'CANCELLED'].includes(order.status)) throw new RuleError('ORDER_STATUS', `El pedido ${order.order_number} está ${order.status}; ya no se puede corregir desde aquí`);
  const bal = (await lockBalances(tx, lpn.id)).find((b) => b.sku_id === sku.id && b.qty > 0n && (b.status === 'PICKING' || b.status === 'STAGING'));
  if (!bal) throw new RuleError('SKU_NOT_ON_PALLET', `${sku.code} no va en la tarima ${lpn.code}`);
  if (qty > bal.qty) throw new RuleError('MORE_THAN_ON_PALLET', `${sku.code}: la tarima ${lpn.code} solo tiene ${bal.qty}`);
  if (!lpn.current_location_id) throw new RuleError('NO_LOCATION', `La tarima ${lpn.code} no tiene ubicación`);
  // the damaged pieces leave the order on a pallet of their own, blocked, right where they are
  const damaged = await createLpn(tx, ctx, { warehouse_id: lpn.warehouse_id, lpn_type: 'STORAGE', location_id: lpn.current_location_id, lot: null, expiry_date: null });
  await tx.lpns.update({ where: { id: damaged.id }, data: { status: 'STORED' } });
  await transferBetweenLpns(tx, ctx, { movement_type: 'DAMAGE', from_lpn: lpn, to_lpn: { ...damaged, status: 'STORED' }, sku_id: sku.id, qty, from_status: bal.status as 'PICKING' | 'STAGING', to_status: 'DAMAGED', to_location_id: lpn.current_location_id, order_id: order.id, reference_type: 'lpn', reference_id: lpn.id, reason: `Merma: ${reason}`.slice(0, 120), note: `Merma reportada por ${ctx.username} en la tarima de salida ${lpn.code} del pedido ${order.order_number}: ${qty} de ${sku.code} pasan a la tarima ${damaged.code} como DAÑADO` });
  const leftOnPallet = await tx.inventory_balances.count({ where: { lpn_id: lpn.id, qty: { gt: 0n } } });
  if (leftOnPallet === 0) await tx.lpns.update({ where: { id: lpn.id }, data: { status: 'CONSUMED', version: { increment: 1 } } });
  await shortenPickedLine(tx, ctx, { order, lpn, sku, missing: qty, purpose: reason, title: `Merma: ${qty} de ${sku.code} dañadas en la tarima de salida ${lpn.code} (pedido ${order.order_number})`, description: `${reason}. Reportado por ${ctx.username}. Las piezas dañadas quedan en la tarima ${damaged.code} (DAÑADO) en ${lpn.code === damaged.code ? '' : 'la misma posición'}; las ${qty} piezas se vuelven a planear para el pedido.` });
  const replanned = await replanOrderShortfall(tx, ctx, order);
  await audit(tx, ctx, { action: 'inventory.damage_reported', entity_type: 'lpn', entity_id: lpn.id, after: { sku: sku.code, qty: qty.toString(), damaged_lpn: damaged.code, order: order.order_number, replanned, mode: 'OUTBOUND' }, reason });
  const report = await tx.damage_reports.create({ data: { user_id: ctx.userId, username: ctx.username, lpn_id: lpn.id, lpn_code: lpn.code, sku_id: sku.id, qty, reason, mode: 'OUTBOUND', order_id: order.id, linked_at: new Date(), task_id: replanned.task_id } });
  return { mode: 'OUTBOUND' as const, lpn: lpn.code, damaged_lpn: damaged.code, sku: sku.code, qty: qty.toString(), order_number: order.order_number, replanned, report_id: report.id };
}

const DAMAGE_OPEN_STATUSES = ['PICKING', 'PARTIALLY_ALLOCATED', 'PICKED', 'STAGED', 'VERIFIED', 'ALLOCATED', 'ACCEPTED'];

/** Orders that have `sku` picked onto an outbound pallet that is not loaded yet: the ones a merma can be charged to. */
export async function damageCandidateOrders(tx: Tx, skuCode: string) {
  const sku = await resolveImportSku(tx, skuCode);
  const rows = await tx.$queryRaw<{ order_number: string; customer: string; status: string; picked: bigint }[]>`
    SELECT o.order_number, c.name AS customer, o.status, COALESCE(SUM(b.qty), 0)::bigint AS picked
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    JOIN lpns l ON l.order_id = o.id AND l.status IN ('PICKING', 'STAGED')
    JOIN inventory_balances b ON b.lpn_id = l.id AND b.sku_id = ${sku.id}::uuid AND b.qty > 0 AND b.status IN ('PICKING', 'STAGING')
    WHERE o.status NOT IN ('SHIPPED', 'CANCELLED', 'LOADING', 'LOADED') AND o.shipment_id IS NULL
    GROUP BY o.id, c.name
    ORDER BY o.created_at DESC`;
  return rows.map((r) => ({ ...r, picked: r.picked.toString() }));
}

/**
 * The merma was registered on a storage pallet, but the pieces were already picked for an order (they fell while
 * building its pallet). The order's outbound pallet gives the pieces back to that storage pallet (compensating the
 * DAMAGED that is now there), the order loses them and they get planned again.
 */
export async function linkDamageToOrder(tx: Tx, ctx: ActorContext, input: DamageLinkOrderInput) {
  const sku = await resolveImportSku(tx, input.sku_code.trim());
  const { base: qty } = await toBaseQty(tx, sku.id, BigInt(input.qty), input.uom_code);
  if (qty <= 0n) throw new RuleError('INVALID_QTY', 'La cantidad debe ser mayor a cero');
  const reason = input.reason.trim();
  const order = await tx.orders.findFirst({ where: { order_number: input.order_number.trim() }, select: { id: true, order_number: true, status: true, shipment_id: true } });
  if (!order) throw new RuleError('ORDER_NOT_FOUND', `No existe el pedido ${input.order_number}`);
  if (order.shipment_id || !DAMAGE_OPEN_STATUSES.includes(order.status)) throw new RuleError('ORDER_STATUS', `El pedido ${order.order_number} está ${order.status}; si ya está cargado, descárgalo primero`);
  const outbounds = await tx.lpns.findMany({ where: { order_id: order.id, status: { in: ['PICKING', 'STAGED'] } }, orderBy: { created_at: 'desc' } });
  const sources: { lpn: LpnRow; balance: { status: string; qty: bigint } }[] = [];
  for (const o of outbounds) {
    const b = (await lockBalances(tx, o.id)).find((x) => x.sku_id === sku.id && x.qty > 0n && (x.status === 'PICKING' || x.status === 'STAGING'));
    if (b) sources.push({ lpn: await lockLpn(tx, o.id), balance: b });
  }
  const onOrder = sources.reduce((a, s) => a + s.balance.qty, 0n);
  if (onOrder < qty) throw new RuleError('MORE_THAN_PICKED', `El pedido ${order.order_number} solo tiene ${onOrder} de ${sku.code} en sus tarimas de salida`);
  sources.sort((a, b) => (b.balance.qty > a.balance.qty ? 1 : -1));
  let target: LpnRow | null = null;
  if (input.lpn_code) {
    target = await lockLpnByCode(tx, input.lpn_code.trim().toUpperCase());
    if (!['STORED', 'OPEN', 'CONSUMED'].includes(target.status) || !target.current_location_id) throw new RuleError('LPN_STATUS', `La tarima ${target.code} está ${target.status}`);
    if (target.status === 'CONSUMED') await tx.lpns.update({ where: { id: target.id }, data: { status: 'STORED', lpn_type: 'STORAGE', order_id: null, version: { increment: 1 } } });
  }
  let left = qty;
  const touched: string[] = [];
  let damagedLpn: string | null = null;
  for (const s of sources) {
    if (left <= 0n) break;
    const take = s.balance.qty < left ? s.balance.qty : left;
    if (target) {
      await transferBetweenLpns(tx, ctx, { movement_type: 'UNPICK', from_lpn: s.lpn, to_lpn: { ...target, status: 'STORED' }, sku_id: sku.id, qty: take, from_status: s.balance.status as 'PICKING' | 'STAGING', to_status: 'AVAILABLE', to_location_id: target.current_location_id!, order_id: order.id, reference_type: 'order', reference_id: order.id, reason: `Merma cargada al pedido: ${reason}`.slice(0, 120), note: `${take} de ${sku.code} salen del pedido ${order.order_number} (tarima ${s.lpn.code}) y regresan a ${target.code}: compensan la merma registrada ahí` });
      damagedLpn = target.code;
    } else {
      if (!s.lpn.current_location_id) throw new RuleError('NO_LOCATION', `La tarima ${s.lpn.code} no tiene ubicación`);
      const dmg = await createLpn(tx, ctx, { warehouse_id: s.lpn.warehouse_id, lpn_type: 'STORAGE', location_id: s.lpn.current_location_id, lot: null, expiry_date: null });
      await tx.lpns.update({ where: { id: dmg.id }, data: { status: 'STORED' } });
      await transferBetweenLpns(tx, ctx, { movement_type: 'DAMAGE', from_lpn: s.lpn, to_lpn: { ...dmg, status: 'STORED' }, sku_id: sku.id, qty: take, from_status: s.balance.status as 'PICKING' | 'STAGING', to_status: 'DAMAGED', to_location_id: s.lpn.current_location_id, order_id: order.id, reference_type: 'lpn', reference_id: s.lpn.id, reason: `Merma: ${reason}`.slice(0, 120), note: `Merma reportada por ${ctx.username} en el pedido ${order.order_number}: ${take} de ${sku.code} de la tarima ${s.lpn.code} pasan a ${dmg.code} como DAÑADO` });
      damagedLpn = dmg.code;
    }
    const leftOnPallet = await tx.inventory_balances.count({ where: { lpn_id: s.lpn.id, qty: { gt: 0n } } });
    if (leftOnPallet === 0) await tx.lpns.update({ where: { id: s.lpn.id }, data: { status: 'CONSUMED', version: { increment: 1 } } });
    touched.push(s.lpn.code);
    left -= take;
  }
  const first = sources[0]!.lpn;
  await shortenPickedLine(tx, ctx, { order, lpn: first, sku, missing: qty, purpose: reason, title: `Merma: ${qty} de ${sku.code} dañadas del pedido ${order.order_number}`, description: `${reason}. Reportado por ${ctx.username}. Tarimas de salida afectadas: ${touched.join(', ')}. ${target ? `Las piezas buenas que faltan se reponen; la merma quedó registrada en ${target.code}.` : `Las piezas dañadas quedan en ${damagedLpn} (DAÑADO).`} Las ${qty} piezas se vuelven a planear.` });
  const replanned = await replanOrderShortfall(tx, ctx, order);
  if (input.report_id) {
    const rep = await tx.damage_reports.findUnique({ where: { id: input.report_id } });
    if (!rep) throw new RuleError('REPORT_NOT_FOUND', 'No existe esa merma');
    if (rep.order_id) throw new RuleError('ALREADY_LINKED', 'Esa merma ya se cargó a un pedido');
    await tx.damage_reports.update({ where: { id: rep.id }, data: { order_id: order.id, linked_at: new Date(), task_id: replanned.task_id } });
  }
  await audit(tx, ctx, { action: 'inventory.damage_linked', entity_type: 'order', entity_id: order.id, after: { sku: sku.code, qty: qty.toString(), from: touched, to: target?.code ?? damagedLpn, replanned, report_id: input.report_id ?? null }, reason });
  return { mode: 'OUTBOUND' as const, lpn: touched.join(', '), damaged_lpn: damagedLpn ?? '', sku: sku.code, qty: qty.toString(), order_number: order.order_number, replanned, report_id: input.report_id ?? null };
}

/** The mermas this user registered in the last two weeks, newest first, with the order they were charged to (if any). */
export async function myDamageReports(tx: Tx, ctx: ActorContext) {
  const since = new Date(Date.now() - 14 * 86_400_000);
  const rows = await tx.damage_reports.findMany({ where: { user_id: ctx.userId, created_at: { gte: since } }, orderBy: { created_at: 'desc' }, take: 50 });
  const skus = await tx.skus.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.sku_id))] } }, select: { id: true, code: true, description: true } });
  const orders = await tx.orders.findMany({ where: { id: { in: rows.flatMap((r) => (r.order_id ? [r.order_id] : [])) } }, select: { id: true, order_number: true, status: true } });
  const skuById = new Map(skus.map((s) => [s.id, s]));
  const orderById = new Map(orders.map((o) => [o.id, o]));
  return rows.map((r) => ({
    id: r.id,
    created_at: r.created_at,
    lpn: r.lpn_code,
    sku: skuById.get(r.sku_id)?.code ?? r.sku_id,
    description: skuById.get(r.sku_id)?.description ?? '',
    qty: r.qty.toString(),
    reason: r.reason,
    mode: r.mode,
    order_number: r.order_id ? (orderById.get(r.order_id)?.order_number ?? null) : null,
    order_status: r.order_id ? (orderById.get(r.order_id)?.status ?? null) : null,
    task_id: r.task_id,
  }));
}
