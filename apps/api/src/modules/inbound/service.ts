import { CONTAINER_TRANSITIONS, type ContainerStatus, type UomCode } from '@wms/shared';
import type { Tx } from '../../db.js';
import { ConflictError, NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';
import { getSkuByCode, resolveSkuBarcode, toBaseQty } from '../../lib/lookup.js';
import { createInventory, createLpn, lockLocation, lockLpnByCode, type LpnRow } from '../../inventory/ledger.js';
import { createIncident } from '../incidents/service.js';
import { createPutawayTask } from '../putaway/service.js';

// ------------------------- containers -------------------------

export async function transitionContainer(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: { status: ContainerStatus; version: number; notes?: string; seal_number?: string; plates?: string; driver_name?: string },
) {
  const rows = await tx.$queryRaw<{ id: string; status: ContainerStatus; version: number }[]>`SELECT id, status, version FROM containers WHERE id = ${id}::uuid FOR UPDATE`;
  const c = rows[0];
  if (!c) throw new NotFoundError('container', id);
  if (c.version !== input.version) throw new ConflictError('STALE_VERSION', 'Container was modified by someone else; reload and retry');
  const allowed = CONTAINER_TRANSITIONS[c.status];
  if (!allowed.includes(input.status)) {
    throw new RuleError('INVALID_TRANSITION', `Cannot go from ${c.status} to ${input.status}`, { allowed });
  }
  if (input.status === 'CLOSED') {
    const openReceipts = await tx.receipts.count({ where: { container_id: id, status: { in: ['OPEN', 'IN_PROGRESS'] } } });
    if (openReceipts) throw new RuleError('RECEIPTS_OPEN', `Container has ${openReceipts} receipt(s) still open`);
  }
  const now = new Date();
  const timestamps: Record<string, Date> = {};
  if (input.status === 'ARRIVED') timestamps.arrived_at = now;
  if (input.status === 'UNLOADING') {
    timestamps.unload_started_at = now;
    timestamps.opened_at = now;
  }
  if (input.status === 'UNLOADED') timestamps.unload_finished_at = now;
  if (input.status === 'CLOSED') timestamps.closed_at = now;
  const before = await tx.containers.findUnique({ where: { id } });
  const after = await tx.containers.update({
    where: { id },
    data: {
      status: input.status,
      version: { increment: 1 },
      notes: input.notes ?? before!.notes,
      seal_number: input.seal_number ?? before!.seal_number,
      plates: input.plates ?? before!.plates,
      driver_name: input.driver_name ?? before!.driver_name,
      operator_id: ctx.userId,
      ...timestamps,
    },
  });
  await audit(tx, ctx, { action: `container.${input.status.toLowerCase()}`, entity_type: 'container', entity_id: id, before: { status: c.status }, after: { status: input.status }, reason: input.notes ?? null });
  return after;
}

// ------------------------- receipts -------------------------

export async function createReceipt(
  tx: Tx,
  ctx: ActorContext,
  input: { container_id?: string; po_id?: string; receiving_location_id: string; notes?: string; expected?: { sku_code: string; qty: bigint; uom_code: UomCode }[] },
) {
  const loc = await tx.locations.findUnique({ where: { id: input.receiving_location_id } });
  if (!loc || loc.location_type !== 'RECEIVING') throw new RuleError('NOT_RECEIVING_LOCATION', 'Receipts must be opened on a RECEIVING location');
  let poId = input.po_id ?? null;
  if (input.container_id) {
    const c = await tx.containers.findUnique({ where: { id: input.container_id } });
    if (!c) throw new NotFoundError('container', input.container_id);
    if (!['UNLOADED', 'RECEIVING', 'UNLOADING', 'ARRIVED'].includes(c.status)) throw new RuleError('CONTAINER_STATUS', `Container is ${c.status}; it must be arrived/unloading/unloaded to receive`);
    poId = poId ?? c.po_id;
    if (c.status !== 'RECEIVING') {
      await tx.containers.update({ where: { id: c.id }, data: { status: 'RECEIVING', version: { increment: 1 } } });
    }
  }
  const num = await tx.$queryRaw<{ n: string }[]>`SELECT next_doc_number('RCV', 'receipt_seq') AS n`;
  const receipt = await tx.receipts.create({
    data: {
      receipt_number: num[0]!.n,
      container_id: input.container_id ?? null,
      po_id: poId,
      receiving_location_id: input.receiving_location_id,
      received_by: ctx.userId,
      notes: input.notes ?? null,
    },
  });
  // expected lines from PO or explicit list
  if (poId) {
    // a PO may list the same SKU on several lines: expectations are per SKU
    const poLines = await tx.purchase_order_lines.findMany({ where: { po_id: poId } });
    const bySku = new Map<string, bigint>();
    for (const l of poLines) {
      const remaining = l.ordered_qty - l.received_qty;
      if (remaining > 0n) bySku.set(l.sku_id, (bySku.get(l.sku_id) ?? 0n) + remaining);
    }
    for (const [skuId, remaining] of bySku) {
      await tx.receipt_lines.create({ data: { receipt_id: receipt.id, sku_id: skuId, expected_qty: remaining } });
    }
  }
  for (const e of input.expected ?? []) {
    const sku = await getSkuByCode(tx, e.sku_code);
    const { base } = await toBaseQty(tx, sku.id, e.qty, e.uom_code);
    await tx.receipt_lines.upsert({
      where: { receipt_id_sku_id: { receipt_id: receipt.id, sku_id: sku.id } },
      create: { receipt_id: receipt.id, sku_id: sku.id, expected_qty: base },
      update: { expected_qty: { increment: base } },
    });
  }
  await audit(tx, ctx, { action: 'receipt.create', entity_type: 'receipt', entity_id: receipt.id, after: receipt });
  return receipt;
}

export interface ReceiveScanInput {
  receipt_id: string;
  barcode: string;
  qty: bigint;
  uom_code?: UomCode;
  lpn_code?: string;
  cases_count?: number;
  weight_kg?: number;
  lot?: string;
  expiry_date?: string;
  damaged: boolean;
  note?: string;
}

/**
 * One receiving scan = one SKU quantity onto a pallet (new or existing open LPN
 * of this receipt). Inventory is created at the receiving location in
 * AVAILABLE (or DAMAGED) status via the ledger. Over-receipt is allowed but
 * flagged: the line goes to OVER and an incident is created at close.
 */
export async function receiveScan(tx: Tx, ctx: ActorContext, input: ReceiveScanInput) {
  const receipt = await tx.$queryRaw<{ id: string; status: string; receiving_location_id: string; container_id: string | null; po_id: string | null }[]>`
    SELECT id, status, receiving_location_id, container_id, po_id FROM receipts WHERE id = ${input.receipt_id}::uuid FOR UPDATE`;
  const r = receipt[0];
  if (!r) throw new NotFoundError('receipt', input.receipt_id);
  if (!['OPEN', 'IN_PROGRESS'].includes(r.status)) throw new RuleError('RECEIPT_NOT_OPEN', `Receipt is ${r.status}`);

  const { sku, uom_code: scannedUom } = await resolveSkuBarcode(tx, input.barcode);
  if (!sku.is_active) throw new RuleError('SKU_INACTIVE', `SKU ${sku.code} is inactive`);
  const uom = input.uom_code ?? scannedUom;
  const { base } = await toBaseQty(tx, sku.id, input.qty, uom);
  if (sku.requires_lot && !input.lot) throw new RuleError('LOT_REQUIRED', `SKU ${sku.code} requires a lot number`);
  if (sku.requires_expiry && !input.expiry_date) throw new RuleError('EXPIRY_REQUIRED', `SKU ${sku.code} requires an expiry date`);

  const location = await lockLocation(tx, r.receiving_location_id);
  const container = r.container_id ? await tx.containers.findUnique({ where: { id: r.container_id } }) : null;

  // expected vs received line
  const line = await tx.receipt_lines.findUnique({ where: { receipt_id_sku_id: { receipt_id: r.id, sku_id: sku.id } } });
  const hasExpectations = (await tx.receipt_lines.count({ where: { receipt_id: r.id } })) > 0;
  const unexpectedSku = hasExpectations && !line;

  let lpn: LpnRow;
  if (input.lpn_code) {
    lpn = await lockLpnByCode(tx, input.lpn_code);
    if (lpn.receipt_id !== r.id) throw new RuleError('LPN_OTHER_RECEIPT', `LPN ${lpn.code} belongs to another receipt`);
    if (lpn.status !== 'OPEN') throw new RuleError('LPN_NOT_OPEN', `LPN ${lpn.code} is ${lpn.status}; it cannot receive more product`);
    if (input.cases_count) await tx.lpns.update({ where: { id: lpn.id }, data: { cases_count: { increment: input.cases_count } } });
  } else {
    lpn = await createLpn(tx, ctx, {
      warehouse_id: location.warehouse_id,
      lpn_type: 'INBOUND',
      location_id: location.id,
      receipt_id: r.id,
      container_id: r.container_id,
      supplier_id: container?.supplier_id ?? null,
      lot: input.lot ?? null,
      expiry_date: input.expiry_date ?? null,
      weight_kg: input.weight_kg ?? null,
      cases_count: input.cases_count ?? 0,
    });
  }

  const movementId = await createInventory(tx, ctx, {
    movement_type: 'RECEIPT',
    to_lpn: lpn,
    sku_id: sku.id,
    qty: base,
    uom_code: uom,
    uom_qty: input.qty,
    status: input.damaged ? 'DAMAGED' : 'AVAILABLE',
    location_id: location.id,
    receipt_id: r.id,
    reference_type: 'receipt',
    reference_id: r.id,
    note: input.note ?? null,
  });

  const updatedLine = await tx.receipt_lines.upsert({
    where: { receipt_id_sku_id: { receipt_id: r.id, sku_id: sku.id } },
    create: { receipt_id: r.id, sku_id: sku.id, expected_qty: 0n, received_qty: base, damaged_qty: input.damaged ? base : 0n, status: hasExpectations ? 'OVER' : 'COMPLETE' },
    update: { received_qty: { increment: base }, damaged_qty: input.damaged ? { increment: base } : undefined },
  });
  const status = lineStatus(updatedLine.expected_qty, updatedLine.received_qty);
  await tx.receipt_lines.update({ where: { id: updatedLine.id }, data: { status } });
  if (r.status === 'OPEN') await tx.receipts.update({ where: { id: r.id }, data: { status: 'IN_PROGRESS' } });

  if (input.damaged) {
    await createIncident(tx, ctx, {
      incident_type: 'DAMAGED',
      severity: 'MEDIUM',
      title: `Producto dañado en recepción: ${sku.code} x${base}`,
      entity_type: 'receipt',
      entity_id: r.id,
      sku_id: sku.id,
      lpn_id: lpn.id,
      location_id: location.id,
      receipt_id: r.id,
      qty: base,
    });
  }
  if (unexpectedSku) {
    await createIncident(tx, ctx, {
      incident_type: 'WRONG_SKU',
      severity: 'HIGH',
      title: `SKU no esperado en recepción: ${sku.code}`,
      entity_type: 'receipt',
      entity_id: r.id,
      sku_id: sku.id,
      lpn_id: lpn.id,
      receipt_id: r.id,
      qty: base,
    });
  }

  await audit(tx, ctx, {
    action: 'receipt.scan',
    entity_type: 'receipt',
    entity_id: r.id,
    after: { lpn: lpn.code, sku: sku.code, qty: base.toString(), uom, uom_qty: input.qty.toString(), damaged: input.damaged, movement_id: movementId.toString() },
  });

  return {
    lpn: { id: lpn.id, code: lpn.code, is_new: !input.lpn_code },
    sku: { id: sku.id, code: sku.code, description: sku.description },
    qty_base: base,
    line: { expected_qty: updatedLine.expected_qty, received_qty: updatedLine.received_qty, status },
    movement_id: movementId,
    unexpected_sku: unexpectedSku,
  };
}

function lineStatus(expected: bigint, received: bigint): string {
  if (expected === 0n) return received > 0n ? 'OVER' : 'PENDING';
  if (received === 0n) return 'PENDING';
  if (received < expected) return 'PARTIAL';
  if (received === expected) return 'COMPLETE';
  return 'OVER';
}

/** Close an LPN built during receiving: it becomes a storage pallet and gets a put-away task. */
export async function closeReceivingLpn(tx: Tx, ctx: ActorContext, lpnCode: string) {
  const lpn = await lockLpnByCode(tx, lpnCode);
  if (lpn.status !== 'OPEN') throw new RuleError('LPN_NOT_OPEN', `LPN ${lpn.code} is ${lpn.status}`);
  const contents = await tx.inventory_balances.findMany({ where: { lpn_id: lpn.id, qty: { gt: 0n } } });
  if (contents.length === 0) throw new RuleError('EMPTY_LPN', `LPN ${lpn.code} is empty`);
  await tx.lpns.update({ where: { id: lpn.id }, data: { status: 'STORED', lpn_type: 'STORAGE', version: { increment: 1 } } });
  const onlyDamaged = contents.every((c) => c.status === 'DAMAGED');
  const task = onlyDamaged ? null : await createPutawayTask(tx, ctx, { ...lpn, status: 'STORED' });
  await audit(tx, ctx, { action: 'lpn.close', entity_type: 'lpn', entity_id: lpn.id, after: { code: lpn.code, putaway_task: task?.id ?? null } });
  return { lpn_code: lpn.code, putaway_task: task };
}

/**
 * Completes a receipt: compares expected vs received per SKU, creates SHORTAGE /
 * OVERAGE incidents, updates PO received quantities, closes any still-open LPNs.
 */
export async function completeReceipt(tx: Tx, ctx: ActorContext, input: { receipt_id: string; accept_differences: boolean; notes?: string }) {
  const rows = await tx.$queryRaw<{ id: string; status: string; container_id: string | null; po_id: string | null }[]>`
    SELECT id, status, container_id, po_id FROM receipts WHERE id = ${input.receipt_id}::uuid FOR UPDATE`;
  const r = rows[0];
  if (!r) throw new NotFoundError('receipt', input.receipt_id);
  if (!['OPEN', 'IN_PROGRESS'].includes(r.status)) throw new RuleError('RECEIPT_NOT_OPEN', `Receipt is ${r.status}`);

  const lines = await tx.receipt_lines.findMany({ where: { receipt_id: r.id }, include: { sku: true } });
  const differences = lines.filter((l) => l.expected_qty !== l.received_qty);
  if (differences.length && !input.accept_differences) {
    throw new RuleError('RECEIPT_DIFFERENCES', 'Receipt has differences between expected and received; confirm with accept_differences=true', {
      differences: differences.map((d) => ({ sku: d.sku.code, expected: d.expected_qty.toString(), received: d.received_qty.toString() })),
    });
  }
  const incidents: string[] = [];
  for (const d of differences) {
    const inc = await createIncident(tx, ctx, {
      incident_type: d.received_qty < d.expected_qty ? 'SHORTAGE' : 'OVERAGE',
      severity: d.received_qty === 0n ? 'HIGH' : 'MEDIUM',
      title: `${d.received_qty < d.expected_qty ? 'Faltante' : 'Sobrante'} en recepción: ${d.sku.code} esperado ${d.expected_qty} recibido ${d.received_qty}`,
      entity_type: 'receipt',
      entity_id: r.id,
      sku_id: d.sku_id,
      receipt_id: r.id,
      qty: d.received_qty > d.expected_qty ? d.received_qty - d.expected_qty : d.expected_qty - d.received_qty,
    });
    incidents.push(inc.incident_number);
  }
  // close still-open LPNs
  const openLpns = await tx.lpns.findMany({ where: { receipt_id: r.id, status: 'OPEN' } });
  const tasks: string[] = [];
  for (const l of openLpns) {
    const contents = await tx.inventory_balances.count({ where: { lpn_id: l.id, qty: { gt: 0n } } });
    if (contents === 0) {
      await tx.lpns.update({ where: { id: l.id }, data: { status: 'CANCELLED', version: { increment: 1 } } });
      continue;
    }
    const res = await closeReceivingLpn(tx, ctx, l.code);
    if (res.putaway_task) tasks.push(res.putaway_task.id);
  }
  // PO progress
  if (r.po_id) {
    for (const l of lines) {
      // distribute received units across the PO lines of that SKU (a PO may list a SKU more than once)
      let left = l.received_qty;
      const poLines = await tx.purchase_order_lines.findMany({ where: { po_id: r.po_id, sku_id: l.sku_id }, orderBy: { line_no: 'asc' } });
      for (let i = 0; i < poLines.length && left > 0n; i++) {
        const pl = poLines[i]!;
        const room = pl.ordered_qty - pl.received_qty;
        const add = i === poLines.length - 1 ? left : room > 0n ? (room < left ? room : left) : 0n;
        if (add > 0n) {
          await tx.purchase_order_lines.update({ where: { id: pl.id }, data: { received_qty: { increment: add } } });
          left -= add;
        }
      }
    }
    const poLines = await tx.purchase_order_lines.findMany({ where: { po_id: r.po_id } });
    const complete = poLines.every((l) => l.received_qty >= l.ordered_qty);
    await tx.purchase_orders.update({ where: { id: r.po_id }, data: { status: complete ? 'RECEIVED' : 'PARTIAL' } });
  }
  const status = differences.length ? 'WITH_INCIDENT' : 'COMPLETED';
  const receipt = await tx.receipts.update({ where: { id: r.id }, data: { status, completed_at: new Date(), notes: input.notes ?? undefined } });
  if (r.container_id) {
    const others = await tx.receipts.count({ where: { container_id: r.container_id, status: { in: ['OPEN', 'IN_PROGRESS'] } } });
    if (others === 0) {
      await tx.containers.update({ where: { id: r.container_id }, data: { status: differences.length ? 'WITH_INCIDENT' : 'RECEIVED', version: { increment: 1 } } });
    }
  }
  await audit(tx, ctx, { action: 'receipt.complete', entity_type: 'receipt', entity_id: r.id, after: { status, incidents, putaway_tasks: tasks }, reason: input.notes ?? null });
  return { receipt, incidents, putaway_tasks: tasks, differences: differences.map((d) => ({ sku: d.sku.code, expected: d.expected_qty, received: d.received_qty })) };
}

export async function closeReceipt(tx: Tx, ctx: ActorContext, receiptId: string) {
  const r = await tx.receipts.findUnique({ where: { id: receiptId } });
  if (!r) throw new NotFoundError('receipt', receiptId);
  if (!['COMPLETED', 'WITH_INCIDENT'].includes(r.status)) throw new RuleError('RECEIPT_NOT_COMPLETED', 'Complete the receipt before closing it');
  const openLpns = await tx.lpns.count({ where: { receipt_id: receiptId, status: 'OPEN' } });
  if (openLpns) throw new RuleError('LPNS_OPEN', `${openLpns} LPN(s) of this receipt are still open`);
  const updated = await tx.receipts.update({ where: { id: receiptId }, data: { status: 'CLOSED', closed_at: new Date() } });
  await audit(tx, ctx, { action: 'receipt.close', entity_type: 'receipt', entity_id: receiptId, before: { status: r.status }, after: { status: 'CLOSED' } });
  return updated;
}
