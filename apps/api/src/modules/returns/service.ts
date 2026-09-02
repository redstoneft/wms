import type { ReturnDisposition, UomCode } from '@wms/shared';
import type { Tx } from '../../db.js';
import { NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';
import { getSkuByCode, toBaseQty } from '../../lib/lookup.js';
import { changeStatus, createInventory, createLpn, lockLocationByBarcode, lockLpn, removeInventory } from '../../inventory/ledger.js';
import { createIncident } from '../incidents/service.js';
import { createPutawayTask } from '../putaway/service.js';

/**
 * Reverse logistics: customer → return receipt → inspection → classification.
 * Received units enter the ledger in QUARANTINE on a RETURN LPN at the RETURNS
 * area; classification moves them to AVAILABLE (restock, put-away task),
 * keeps them in QUARANTINE, marks DAMAGED, or scraps them (ledger OUT).
 */
export async function createReturn(tx: Tx, ctx: ActorContext, input: { customer_code: string; original_order_number?: string; reason?: string; lines: { sku_code: string; qty: bigint; uom_code: UomCode }[] }) {
  const customer = await tx.customers.findUnique({ where: { code: input.customer_code } });
  if (!customer) throw new NotFoundError('customer', input.customer_code);
  const order = input.original_order_number ? await tx.orders.findUnique({ where: { order_number: input.original_order_number } }) : null;
  if (input.original_order_number && !order) throw new NotFoundError('order', input.original_order_number);
  const num = await tx.$queryRaw<{ n: string }[]>`SELECT next_doc_number('RET', 'return_seq') AS n`;
  const lines = [];
  for (const l of input.lines) {
    const sku = await getSkuByCode(tx, l.sku_code);
    const { base } = await toBaseQty(tx, sku.id, l.qty, l.uom_code);
    lines.push({ sku_id: sku.id, expected_qty: base });
  }
  const r = await tx.returns.create({
    data: { return_number: num[0]!.n, customer_id: customer.id, original_order_id: order?.id ?? null, reason: input.reason ?? null, created_by: ctx.userId, lines: { create: lines } },
    include: { lines: { include: { sku: true } } },
  });
  await audit(tx, ctx, { action: 'return.create', entity_type: 'return', entity_id: r.id, after: { number: r.return_number, lines: lines.length, order: order?.order_number ?? null } });
  return r;
}

export async function receiveReturnLine(tx: Tx, ctx: ActorContext, input: { return_id: string; line_id: string; qty: bigint; uom_code?: UomCode; returns_location_barcode: string }) {
  const rrows = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT id, status FROM returns WHERE id = ${input.return_id}::uuid FOR UPDATE`;
  const ret = rrows[0];
  if (!ret) throw new NotFoundError('return', input.return_id);
  if (['CLOSED'].includes(ret.status)) throw new RuleError('RETURN_CLOSED', 'Return is closed');
  const line = await tx.return_lines.findUnique({ where: { id: input.line_id }, include: { sku: true } });
  if (!line || line.return_id !== ret.id) throw new NotFoundError('return line', input.line_id);
  const { base } = await toBaseQty(tx, line.sku_id, input.qty, input.uom_code ?? 'PIECE');
  const loc = await lockLocationByBarcode(tx, input.returns_location_barcode);
  if (loc.location_type !== 'RETURNS') throw new RuleError('NOT_RETURNS_LOCATION', `${loc.code} is not a RETURNS location`);
  let lpn;
  if (line.lpn_id) lpn = await lockLpn(tx, line.lpn_id);
  else {
    lpn = await createLpn(tx, ctx, { warehouse_id: loc.warehouse_id, lpn_type: 'RETURN', location_id: loc.id });
    await tx.lpns.update({ where: { id: lpn.id }, data: { status: 'STORED' } });
  }
  await createInventory(tx, ctx, { movement_type: 'RETURN_RECEIPT', to_lpn: lpn, sku_id: line.sku_id, qty: base, uom_code: input.uom_code ?? 'PIECE', uom_qty: input.qty, status: 'QUARANTINE', location_id: loc.id, reference_type: 'return', reference_id: ret.id, order_id: (await tx.returns.findUniqueOrThrow({ where: { id: ret.id } })).original_order_id, reason: 'Customer return' });
  await tx.return_lines.update({ where: { id: line.id }, data: { received_qty: { increment: base }, lpn_id: lpn.id } });
  await tx.returns.update({ where: { id: ret.id }, data: { status: 'RECEIVED', received_by: ctx.userId, received_at: new Date() } });
  await audit(tx, ctx, { action: 'return.receive', entity_type: 'return', entity_id: ret.id, after: { sku: line.sku.code, qty: base.toString(), lpn: lpn.code } });
  return { lpn_code: lpn.code, sku: line.sku.code, qty: base };
}

export async function classifyReturnLine(tx: Tx, ctx: ActorContext, input: { return_id: string; line_id: string; disposition: ReturnDisposition; qty: bigint; reason: string }) {
  const rrows = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT id, status FROM returns WHERE id = ${input.return_id}::uuid FOR UPDATE`;
  const ret = rrows[0];
  if (!ret) throw new NotFoundError('return', input.return_id);
  const line = await tx.return_lines.findUnique({ where: { id: input.line_id }, include: { sku: true } });
  if (!line || line.return_id !== ret.id) throw new NotFoundError('return line', input.line_id);
  if (!line.lpn_id) throw new RuleError('NOT_RECEIVED', 'Receive the line before classifying it');
  const lpn = await lockLpn(tx, line.lpn_id);
  const remaining = line.received_qty - line.disposition_qty;
  if (input.qty > remaining) throw new RuleError('QTY_EXCEEDED', `Only ${remaining} units left to classify`);
  switch (input.disposition) {
    case 'RESTOCK':
      await changeStatus(tx, ctx, { movement_type: 'QUARANTINE_OUT', lpn, sku_id: line.sku_id, qty: input.qty, from_status: 'QUARANTINE', to_status: 'AVAILABLE', reference_type: 'return', reference_id: ret.id, reason: input.reason });
      break;
    case 'DAMAGED':
      await changeStatus(tx, ctx, { movement_type: 'DAMAGE', lpn, sku_id: line.sku_id, qty: input.qty, from_status: 'QUARANTINE', to_status: 'DAMAGED', reference_type: 'return', reference_id: ret.id, reason: input.reason });
      await createIncident(tx, ctx, { incident_type: 'DAMAGED', severity: 'LOW', title: `Devolución dañada ${line.sku.code} x${input.qty}`, description: input.reason, entity_type: 'return', entity_id: ret.id, sku_id: line.sku_id, lpn_id: lpn.id, qty: input.qty });
      break;
    case 'SCRAP':
      await removeInventory(tx, ctx, { movement_type: 'SCRAP', from_lpn: lpn, sku_id: line.sku_id, qty: input.qty, status: 'QUARANTINE', reference_type: 'return', reference_id: ret.id, reason: input.reason });
      break;
    case 'QUARANTINE':
      break; // stays
  }
  await tx.return_lines.update({ where: { id: line.id }, data: { disposition: input.disposition, disposition_qty: { increment: input.qty }, inspected_by: ctx.userId, notes: input.reason } });
  const all = await tx.return_lines.findMany({ where: { return_id: ret.id } });
  const done = all.every((l) => l.received_qty > 0n && l.disposition_qty >= l.received_qty);
  await tx.returns.update({ where: { id: ret.id }, data: { status: done ? 'CLASSIFIED' : 'INSPECTING' } });
  // if any AVAILABLE units now on the LPN, schedule put-away
  const avail = await tx.inventory_balances.findFirst({ where: { lpn_id: lpn.id, status: 'AVAILABLE', qty: { gt: 0n } } });
  let putaway = null;
  if (avail && done) putaway = await createPutawayTask(tx, ctx, lpn);
  await audit(tx, ctx, { action: 'return.classify', entity_type: 'return', entity_id: ret.id, after: { sku: line.sku.code, disposition: input.disposition, qty: input.qty.toString(), lpn: lpn.code }, reason: input.reason });
  return { disposition: input.disposition, qty: input.qty, lpn_code: lpn.code, return_status: done ? 'CLASSIFIED' : 'INSPECTING', putaway_task: putaway?.id ?? null };
}

export async function closeReturn(tx: Tx, ctx: ActorContext, returnId: string) {
  const r = await tx.returns.findUnique({ where: { id: returnId }, include: { lines: true } });
  if (!r) throw new NotFoundError('return', returnId);
  if (r.status !== 'CLASSIFIED') throw new RuleError('RETURN_STATUS', 'All received units must be classified before closing');
  await tx.returns.update({ where: { id: returnId }, data: { status: 'CLOSED', closed_at: new Date() } });
  await audit(tx, ctx, { action: 'return.close', entity_type: 'return', entity_id: returnId });
  return { ok: true };
}
