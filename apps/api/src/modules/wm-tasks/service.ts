// Tasks an operator creates for themself from the handheld, always stating the purpose ("para qué").
// Pick: the order is accepted/allocated if needed and the pick task is assigned to the operator.
// Count: a blind location count assigned to the operator. Put-away: a task for a pallet left without one.
import type { HandheldOrderInput, LpnRecountInput, SelfTaskInput } from '@wms/shared';
import type { Tx } from '../../db.js';
import { ForbiddenError, NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';
import { lockBalances, lockLocationByBarcode, lockLpnByCode } from '../../inventory/ledger.js';
import { toBaseQty } from '../../lib/lookup.js';
import { createReceipt } from '../inbound/service.js';
import { adjustInventory } from '../inventory/service.js';
import { finishCounting, submitCount } from '../counts/service.js';
import { createCountTask } from '../counts/service.js';
import { resolveImportSku } from '../imports/service.js';
import { acceptOrder, allocateOrder, createOrder } from '../orders/service.js';
import { createPickTask } from '../picking/service.js';
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
  if (await tx.orders.findFirst({ where: { order_number: { equals: number, mode: 'insensitive' } } })) throw new RuleError('ORDER_EXISTS', `Order ${number} already exists`);
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
