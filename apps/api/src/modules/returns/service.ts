import type { QuickReturnInput, ReturnDisposition, UomCode } from '@wms/shared';
import type { Tx } from '../../db.js';
import { NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';
import { getSkuByCode, resolveSkuBarcode, toBaseQty } from '../../lib/lookup.js';
import { changeStatus, createInventory, createLpn, lockLocationByBarcode, lockLpn, lockLpnByCode, removeInventory, type LpnRow } from '../../inventory/ledger.js';
import { createIncident } from '../incidents/service.js';
import { createPutawayTask } from '../putaway/service.js';
import { splitPallet } from '../picking/service.js';

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

/** Splits `total` into `n` parts, remainder on the first ones. */
function splitQty(total: bigint, n: number): bigint[] {
  const each = total / BigInt(n);
  let rest = total - each * BigInt(n);
  return Array.from({ length: n }, () => { const q = each + (rest > 0n ? 1n : 0n); if (rest > 0n) rest -= 1n; return q; });
}

/**
 * A return line received on several pallets: the line is split into one line per pallet (expected and received
 * proportional), each with its own RETURN pallet at the returns location, so each pallet is classified on its own.
 */
export async function receiveReturnLine(tx: Tx, ctx: ActorContext, input: { return_id: string; line_id: string; qty: bigint; uom_code?: UomCode; returns_location_barcode: string; pallets?: number }) {
  const n = input.pallets ?? 1;
  if (n <= 1) return receiveReturnLineOne(tx, ctx, input);
  const line = await tx.return_lines.findUnique({ where: { id: input.line_id } });
  if (!line || line.return_id !== input.return_id) throw new NotFoundError('return line', input.line_id);
  if (line.lpn_id) throw new RuleError('LINE_HAS_PALLET', 'Esta línea ya tiene tarima; recibe el resto como líneas nuevas o en una sola tarima');
  const { base } = await toBaseQty(tx, line.sku_id, input.qty, input.uom_code ?? 'PIECE');
  if (base < BigInt(n)) throw new RuleError('QTY_LT_PALLETS', `${base} piezas no se pueden repartir en ${n} tarimas`);
  const parts = splitQty(base, n);
  const expParts = splitQty(line.expected_qty, n);
  const pallets: { code: string; qty: string; line_id: string }[] = [];
  let last: Awaited<ReturnType<typeof receiveReturnLineOne>> | null = null;
  for (let i = 0; i < n; i++) {
    let lineId = line.id;
    if (i === 0) await tx.return_lines.update({ where: { id: line.id }, data: { expected_qty: expParts[0]! } });
    else lineId = (await tx.return_lines.create({ data: { return_id: line.return_id, sku_id: line.sku_id, expected_qty: expParts[i]!, notes: line.notes } })).id;
    last = await receiveReturnLineOne(tx, ctx, { ...input, line_id: lineId, qty: parts[i]!, uom_code: 'PIECE' });
    pallets.push({ code: last.lpn_code, qty: last.qty.toString(), line_id: lineId });
  }
  await audit(tx, ctx, { action: 'return.receive_multi', entity_type: 'return', entity_id: input.return_id, after: { sku: last!.sku, total: base.toString(), pallets } });
  return { ...last!, qty: base, pallets };
}

async function receiveReturnLineOne(tx: Tx, ctx: ActorContext, input: { return_id: string; line_id: string; qty: bigint; uom_code?: UomCode; returns_location_barcode: string }) {
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
  return { lpn_code: lpn.code, sku: line.sku.code, qty: base, pallets: [] as { code: string; qty: string; line_id: string }[] };
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

/**
 * Quick return from the handheld. Good pieces go straight onto a pallet that already holds the product (the operator
 * confirms at the rack by scanning the pallet or its location); damaged pieces go to the returns area as DAMAGED with
 * an incident. The return document is created already closed, so the office sees it without extra steps.
 */
export async function quickReturn(tx: Tx, ctx: ActorContext, input: QuickReturnInput) {
  // SKU code, or any of its barcodes (the handheld may send what was scanned)
  const sku = await getSkuByCode(tx, input.sku_code).catch(async (e) => {
    if (!(e instanceof NotFoundError)) throw e;
    return (await resolveSkuBarcode(tx, input.sku_code)).sku;
  });
  const { base } = await toBaseQty(tx, sku.id, input.qty, input.uom_code);
  const customer = input.customer_code ? await tx.customers.findUnique({ where: { code: input.customer_code } }) : null;
  if (input.customer_code && !customer) throw new NotFoundError('customer', input.customer_code);
  const order = input.original_order_number ? await tx.orders.findUnique({ where: { order_number: input.original_order_number } }) : null;
  if (input.original_order_number && !order) throw new NotFoundError('order', input.original_order_number);
  // onto an existing open return (reopened by the admin, or a formal one): no new document, one more line
  const existing = input.return_id ? await tx.$queryRaw<{ id: string; status: string; return_number: string; customer_id: string | null; original_order_id: string | null }[]>`SELECT id, status, return_number, customer_id, original_order_id FROM returns WHERE id = ${input.return_id}::uuid FOR UPDATE` : [];
  if (input.return_id && !existing[0]) throw new NotFoundError('return', input.return_id);
  if (existing[0] && existing[0].status === 'CLOSED') throw new RuleError('RETURN_CLOSED', `La devolución ${existing[0].return_number} está cerrada; pide al administrador que la reabra`);
  const num = existing[0] ? [{ n: existing[0].return_number }] : await tx.$queryRaw<{ n: string }[]>`SELECT next_doc_number('RET', 'return_seq') AS n`;
  const reason = input.note?.trim() || (input.damaged ? 'Devolución rápida (dañada)' : 'Devolución rápida');

  let lpn: LpnRow;
  let locationCode: string;
  let status: 'AVAILABLE' | 'DAMAGED';
  const extraPallets: LpnRow[] = [];
  const palletQtys: bigint[] = [];
  if ((input.new_pallets ?? 0) > 0) {
    // whole pallets coming back: N new pallets born at the returns area (available with put-away, or damaged)
    const n = input.new_pallets!;
    if (base < BigInt(n)) throw new RuleError('QTY_LT_PALLETS', `${base} piezas no se pueden repartir en ${n} tarimas`);
    const wh = (await tx.warehouses.findFirst({ where: { is_default: true, is_active: true } })) ?? (await tx.warehouses.findFirst({ where: { is_active: true, NOT: { code: 'ESCUELA' } }, orderBy: { created_at: 'asc' } }));
    if (!wh) throw new RuleError('NO_WAREHOUSE', 'No hay almacén configurado');
    const ret = await tx.locations.findFirst({ where: { warehouse_id: wh.id, location_type: 'RETURNS', is_active: true }, orderBy: { code: 'asc' } });
    if (!ret) throw new RuleError('NO_RETURNS_LOCATION', 'El almacén no tiene un área de devoluciones (RETURNS)');
    for (const q of splitQty(base, n)) {
      const created = await createLpn(tx, ctx, { warehouse_id: wh.id, lpn_type: input.damaged ? 'RETURN' : 'STORAGE', location_id: ret.id });
      await tx.lpns.update({ where: { id: created.id }, data: { status: 'STORED' } });
      extraPallets.push({ ...created, status: 'STORED' });
      palletQtys.push(q);
    }
    lpn = extraPallets[0]!;
    locationCode = ret.code;
    status = input.damaged ? 'DAMAGED' : 'AVAILABLE';
  } else if (!input.damaged) {
    if (!input.to_lpn_code) throw new RuleError('PALLET_REQUIRED', 'Elige la tarima donde va la devolución');
    lpn = await lockLpnByCode(tx, input.to_lpn_code);
    if (lpn.status !== 'STORED' || !lpn.current_location_id) throw new RuleError('LPN_STATUS', `La tarima ${lpn.code} está ${lpn.status}; elige una tarima guardada en rack`);
    const loc = await tx.locations.findUniqueOrThrow({ where: { id: lpn.current_location_id }, select: { code: true, barcode: true, location_type: true } });
    if (loc.location_type !== 'RESERVE' && loc.location_type !== 'PICKING') throw new RuleError('LOCATION_TYPE', `La tarima ${lpn.code} está en ${loc.code} (${loc.location_type}), no en una posición de almacén`);
    const holds = await tx.inventory_balances.count({ where: { lpn_id: lpn.id, sku_id: sku.id, qty: { gt: 0n } } });
    if (!holds) throw new RuleError('LPN_OTHER_PRODUCT', `La tarima ${lpn.code} no tiene ${sku.code}; elige una tarima que sí lo tenga`);
    const scanned = (input.scanned ?? '').trim().toUpperCase();
    if (!scanned) throw new RuleError('SCAN_REQUIRED', 'Escanea la tarima o la ubicación al dejar las piezas');
    if (scanned !== lpn.code.toUpperCase() && scanned !== loc.code.toUpperCase() && scanned !== loc.barcode.toUpperCase() && scanned.replace(/^LOC-/, '') !== loc.code.toUpperCase()) {
      throw new RuleError('WRONG_PALLET', `Escaneaste ${scanned}; la tarima elegida es ${lpn.code} en ${loc.code}`, { expected_lpn: lpn.code, expected_location: loc.code, scanned });
    }
    locationCode = loc.code;
    status = 'AVAILABLE';
  } else {
    const wh = (await tx.warehouses.findFirst({ where: { is_default: true, is_active: true } })) ?? (await tx.warehouses.findFirst({ where: { is_active: true, NOT: { code: 'ESCUELA' } }, orderBy: { created_at: 'asc' } }));
    if (!wh) throw new RuleError('NO_WAREHOUSE', 'No hay almacén configurado');
    const ret = await tx.locations.findFirst({ where: { warehouse_id: wh.id, location_type: 'RETURNS', is_active: true }, orderBy: { code: 'asc' } });
    if (!ret) throw new RuleError('NO_RETURNS_LOCATION', 'El almacén no tiene un área de devoluciones (RETURNS)');
    const created = await createLpn(tx, ctx, { warehouse_id: wh.id, lpn_type: 'RETURN', location_id: ret.id });
    await tx.lpns.update({ where: { id: created.id }, data: { status: 'STORED' } });
    lpn = { ...created, status: 'STORED' };
    locationCode = ret.code;
    status = 'DAMAGED';
  }

  const lineData = { sku_id: sku.id, expected_qty: base, received_qty: base, disposition: input.damaged ? 'DAMAGED' : 'RESTOCK', disposition_qty: base, lpn_id: lpn.id, inspected_by: ctx.userId, notes: input.note ?? null };
  const r = existing[0]
    ? await tx.returns.update({ where: { id: existing[0].id }, data: { status: 'INSPECTING', received_by: ctx.userId, received_at: new Date(), lines: { create: [lineData] } } })
    : await tx.returns.create({
        data: {
          return_number: num[0]!.n,
          customer_id: customer?.id ?? null,
          original_order_id: order?.id ?? null,
          reason,
          status: 'CLOSED',
          created_by: ctx.userId,
          received_by: ctx.userId,
          received_at: new Date(),
          closed_at: new Date(),
          lines: { create: [lineData] },
        },
      });
  // extra pallets of a multi-pallet quick return each get their own line, so each pallet can be classified alone
  if (extraPallets.length > 1) {
    await tx.return_lines.deleteMany({ where: { return_id: r.id, lpn_id: lpn.id, sku_id: sku.id, received_qty: base } });
    for (let i = 0; i < extraPallets.length; i++) {
      await tx.return_lines.create({ data: { ...lineData, return_id: r.id, lpn_id: extraPallets[i]!.id, expected_qty: palletQtys[i]!, received_qty: palletQtys[i]!, disposition_qty: palletQtys[i]! } });
    }
  }
  let movementId: bigint;
  const pallets: { code: string; qty: string; putaway_task: string | null }[] = [];
  if (extraPallets.length) {
    movementId = 0n;
    for (let i = 0; i < extraPallets.length; i++) {
      const p = extraPallets[i]!;
      movementId = await createInventory(tx, ctx, { movement_type: 'RETURN_RECEIPT', to_lpn: p, sku_id: sku.id, qty: palletQtys[i]!, uom_code: 'PIECE', uom_qty: palletQtys[i]!, status, location_id: p.current_location_id!, reference_type: 'return', reference_id: r.id, order_id: order?.id ?? null, reason });
      const task = input.damaged ? null : await createPutawayTask(tx, ctx, p, { allowStoredLocation: true });
      pallets.push({ code: p.code, qty: palletQtys[i]!.toString(), putaway_task: task?.id ?? null });
    }
  } else {
    movementId = await createInventory(tx, ctx, { movement_type: 'RETURN_RECEIPT', to_lpn: lpn, sku_id: sku.id, qty: base, uom_code: input.uom_code, uom_qty: input.qty, status, location_id: lpn.current_location_id!, reference_type: 'return', reference_id: r.id, order_id: order?.id ?? null, reason });
  }
  let incident: string | null = null;
  if (input.damaged) {
    const inc = await createIncident(tx, ctx, { incident_type: 'DAMAGED', severity: 'MEDIUM', title: `Devolución dañada: ${sku.code} x${base}`, description: reason, entity_type: 'return', entity_id: r.id, sku_id: sku.id, lpn_id: lpn.id, location_id: lpn.current_location_id, order_id: order?.id ?? null, qty: base });
    incident = inc.incident_number;
  }
  await audit(tx, ctx, { action: 'return.quick', entity_type: 'return', entity_id: r.id, after: { number: r.return_number, sku: sku.code, qty: base.toString(), lpn: lpn.code, location: locationCode, damaged: input.damaged, customer: customer?.code ?? null, order: order?.order_number ?? null, movement_id: movementId.toString(), pallets }, reason });
  return { return_number: r.return_number, return_status: r.status, sku: { code: sku.code, description: sku.description }, qty_base: base, lpn: lpn.code, location: locationCode, damaged: input.damaged, incident, pallets };
}

export async function closeReturn(tx: Tx, ctx: ActorContext, returnId: string) {
  const r = await tx.returns.findUnique({ where: { id: returnId }, include: { lines: true } });
  if (!r) throw new NotFoundError('return', returnId);
  if (r.status !== 'CLASSIFIED') throw new RuleError('RETURN_STATUS', 'All received units must be classified before closing');
  await tx.returns.update({ where: { id: returnId }, data: { status: 'CLOSED', closed_at: new Date() } });
  await audit(tx, ctx, { action: 'return.close', entity_type: 'return', entity_id: returnId });
  return { ok: true };
}

/** Admin: a closed return is opened again (more product to receive, or a pallet to reclassify). Audited with the reason. */
export async function reopenReturn(tx: Tx, ctx: ActorContext, returnId: string, reason: string) {
  const r = await tx.returns.findUnique({ where: { id: returnId }, include: { lines: true } });
  if (!r) throw new NotFoundError('return', returnId);
  if (r.status !== 'CLOSED') throw new RuleError('RETURN_STATUS', `La devolución ${r.return_number} está ${r.status}; solo se reabren devoluciones cerradas`);
  const received = r.lines.some((l) => l.received_qty > 0n);
  const status = received ? 'INSPECTING' : 'OPEN';
  await tx.returns.update({ where: { id: returnId }, data: { status, closed_at: null } });
  await audit(tx, ctx, { action: 'return.reopen', entity_type: 'return', entity_id: returnId, before: { status: 'CLOSED' }, after: { status }, reason });
  return { id: returnId, return_number: r.return_number, status };
}

/** Open returns for the handheld (reopened by the admin or formal ones still being received): number, customer, lines. */
export async function openReturns(tx: Tx) {
  const rows = await tx.returns.findMany({ where: { status: { not: 'CLOSED' }, is_training: false }, include: { customer: { select: { code: true, name: true } }, lines: { include: { sku: { select: { code: true, description: true } } } } }, orderBy: { created_at: 'desc' }, take: 50 });
  const lpnIds = rows.flatMap((r) => r.lines.map((l) => l.lpn_id).filter((x): x is string => !!x));
  const lpns = await tx.lpns.findMany({ where: { id: { in: lpnIds } }, select: { id: true, code: true, status: true, current_location_id: true } });
  const tasks = await tx.putaway_tasks.findMany({ where: { lpn_id: { in: lpnIds }, status: { in: ['PENDING', 'ASSIGNED', 'IN_PROGRESS'] } }, select: { id: true, lpn_id: true, suggested_location_id: true }, orderBy: { created_at: 'desc' } });
  const locIds = [...new Set([...lpns.map((l) => l.current_location_id), ...tasks.map((t) => t.suggested_location_id)].filter((x): x is string => !!x))];
  const locs = new Map((await tx.locations.findMany({ where: { id: { in: locIds } }, select: { id: true, code: true } })).map((l) => [l.id, l.code]));
  const taskByLpn = new Map<string, { id: string; suggested_location_id: string | null }>();
  for (const t of tasks) if (!taskByLpn.has(t.lpn_id)) taskByLpn.set(t.lpn_id, t);
  const byId = new Map(lpns.map((l) => [l.id, l]));
  return rows.map((r) => ({
    id: r.id, return_number: r.return_number, status: r.status, customer: r.customer?.name ?? null, reason: r.reason, created_at: r.created_at,
    lines: r.lines.map((l) => {
      const p = l.lpn_id ? byId.get(l.lpn_id) : null;
      const t = p ? taskByLpn.get(p.id) : undefined;
      return { id: l.id, sku_code: l.sku.code, description: l.sku.description, expected_qty: l.expected_qty.toString(), received_qty: l.received_qty.toString(), lpn: p ? { code: p.code, status: p.status, location: p.current_location_id ? (locs.get(p.current_location_id) ?? null) : null, putaway_task_id: t?.id ?? null, suggested: t?.suggested_location_id ? (locs.get(t.suggested_location_id) ?? null) : null } : null };
    }),
  }));
}

/**
 * What entered the return as ONE pallet is really several: the pallet (stored, holding the line's product) is split
 * evenly into N pallets at the same spot, every pallet (the original included) gets a put-away task so the operator
 * chooses where each one goes, and the return line becomes one line per pallet.
 */
export async function splitReturnPallet(tx: Tx, ctx: ActorContext, input: { return_id: string; lpn_code: string; pallets: number }) {
  const rrows = await tx.$queryRaw<{ id: string; status: string; return_number: string }[]>`SELECT id, status, return_number FROM returns WHERE id = ${input.return_id}::uuid FOR UPDATE`;
  const ret = rrows[0];
  if (!ret) throw new NotFoundError('return', input.return_id);
  if (ret.status === 'CLOSED') throw new RuleError('RETURN_CLOSED', `La devolución ${ret.return_number} está cerrada`);
  const lpn = await lockLpnByCode(tx, input.lpn_code);
  const line = await tx.return_lines.findFirst({ where: { return_id: ret.id, lpn_id: lpn.id }, include: { sku: true } });
  if (!line) throw new RuleError('LPN_NOT_IN_RETURN', `La tarima ${lpn.code} no es de la devolución ${ret.return_number}`);
  if (lpn.status !== 'STORED' || !lpn.current_location_id) throw new RuleError('LPN_STATUS', `La tarima ${lpn.code} está ${lpn.status}`);
  const bal = await tx.inventory_balances.findFirst({ where: { lpn_id: lpn.id, sku_id: line.sku_id, qty: { gt: 0n }, status: { in: ['AVAILABLE', 'QUARANTINE', 'DAMAGED'] } }, orderBy: { qty: 'desc' } });
  if (!bal || bal.status !== 'AVAILABLE') throw new RuleError('NOT_AVAILABLE', `La tarima ${lpn.code} no tiene ${line.sku.code} disponible para repartir (está ${bal?.status ?? 'vacía'})`);
  const total = bal.qty;
  if (total < BigInt(input.pallets)) throw new RuleError('QTY_LT_PALLETS', `${total} piezas no se pueden repartir en ${input.pallets} tarimas`);
  const parts = splitQty(total, input.pallets);
  const pallets: { code: string; qty: string; putaway_task_id: string | null; suggested: string | null; line_id: string }[] = [];
  // the original keeps the first part; each other part goes to a new pallet (same spot) via the ledger split
  for (let i = 1; i < input.pallets; i++) {
    const r = await splitPallet(tx, ctx, { from_lpn_code: lpn.code, sku_code: line.sku.code, qty: parts[i]!, uom_code: 'PIECE' });
    const newLpn = await lockLpnByCode(tx, r.to_lpn);
    const task = await createPutawayTask(tx, ctx, newLpn, { allowStoredLocation: true });
    const nl = await tx.return_lines.create({ data: { return_id: ret.id, sku_id: line.sku_id, expected_qty: parts[i]!, received_qty: parts[i]!, disposition: line.disposition, disposition_qty: line.disposition ? parts[i]! : 0n, lpn_id: newLpn.id, inspected_by: line.inspected_by, notes: line.notes } });
    const sug = task.suggested_location_id ? (await tx.locations.findUnique({ where: { id: task.suggested_location_id }, select: { code: true } }))?.code ?? null : null;
    pallets.push({ code: newLpn.code, qty: parts[i]!.toString(), putaway_task_id: task.id, suggested: sug, line_id: nl.id });
  }
  const fresh = await lockLpn(tx, lpn.id);
  const task0 = await createPutawayTask(tx, ctx, fresh, { allowStoredLocation: true });
  await tx.return_lines.update({ where: { id: line.id }, data: { expected_qty: parts[0]!, received_qty: parts[0]!, disposition_qty: line.disposition ? parts[0]! : 0n } });
  const sug0 = task0.suggested_location_id ? (await tx.locations.findUnique({ where: { id: task0.suggested_location_id }, select: { code: true } }))?.code ?? null : null;
  pallets.unshift({ code: lpn.code, qty: parts[0]!.toString(), putaway_task_id: task0.id, suggested: sug0, line_id: line.id });
  await audit(tx, ctx, { action: 'return.split_pallet', entity_type: 'return', entity_id: ret.id, after: { lpn: lpn.code, sku: line.sku.code, total: total.toString(), pallets } });
  return { return_number: ret.return_number, sku: line.sku.code, total: total.toString(), pallets };
}

