// Assembly orders: consume components from existing pallets and produce the finished product onto NEW pallets.
// REPACK mode: input and output are the SAME SKU (bodies and assembled pans share the SAE key) — the stock does not change,
// only the packaging (masters of 24 → cases of 12) and the number of pallets. Unassembled bodies may be kept BLOCKED so
// picking never allocates them; the assembly consumes from AVAILABLE first and then from BLOCKED.
// Example: pan bodies arrive in masters of 24 on one pallet; after assembly the pans are packed 12 per case and
// fill three pallets. One pallet disappears (CONSUMED), three are born at the assembly station with put-away tasks.
import type { AssemblyCompleteInput, AssemblyFinishInput, AssemblyStartInput } from '@wms/shared';
import type { Tx } from '../../db.js';
import { NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';
import type { InventoryStatus } from '@wms/shared';
import { changeStatus, createInventory, createLpn, lockLocation, lockLocationByBarcode, lockLpn, lockLpnByCode, lpnContents, moveLpn, removeInventory, setLpnStatus, type LocationRow } from '../../inventory/ledger.js';
import { createIncident } from '../incidents/service.js';
import { createPutawayTask } from '../putaway/service.js';

const ORDER_INCLUDE = {
  station: { select: { id: true, code: true, barcode: true } },
  output_sku: { select: { id: true, code: true, description: true, gtin: true } },
  inputs: { include: { lpn: { select: { code: true, status: true } }, sku: { select: { code: true, description: true } } } },
  outputs: { include: { lpn: { select: { code: true, status: true, current_location_id: true } } } },
} as const;

/** `sku_code` may be the WMS code or any alias barcode (SAE key, GTIN) — same rule as the imports. */
async function resolveSku(tx: Tx, code: string) {
  const direct = await tx.skus.findUnique({ where: { code } });
  if (direct) return direct;
  const alias = await tx.sku_barcodes.findFirst({ where: { barcode: { in: [code, code.toUpperCase()] } }, include: { sku: true } });
  if (alias) return alias.sku;
  throw new NotFoundError('sku', code);
}

export async function completeAssembly(tx: Tx, ctx: ActorContext, input: AssemblyCompleteInput) {
  const station = await resolveStation(tx, input.station_barcode, input.inputs[0]?.lpn_code);

  const outSku = await resolveSku(tx, input.output.sku_code);
  if (!outSku.is_active) throw new RuleError('SKU_INACTIVE', `SKU ${outSku.code} is inactive`);
  if (outSku.requires_lot && !input.output.lot) throw new RuleError('LOT_REQUIRED', `SKU ${outSku.code} requires a lot`);
  if (outSku.requires_expiry && !input.output.expiry_date) throw new RuleError('EXPIRY_REQUIRED', `SKU ${outSku.code} requires an expiry date`);

  const outputQty = input.output.pallets.reduce((acc, p) => acc + BigInt(p.cases) * BigInt(p.pieces_per_case), 0n);
  const scrapQty = input.scrap ? BigInt(input.scrap.qty) : 0n;
  const consumedQty = input.inputs.reduce((acc, i) => acc + BigInt(i.qty), 0n);
  const inputSkuRows = await Promise.all([...new Set(input.inputs.map((i) => i.sku_code))].map((c) => resolveSku(tx, c)));
  const inputSkus = new Set(inputSkuRows.map((s) => s.id));
  const mode = inputSkus.size === 1 && inputSkus.has(outSku.id) ? 'REPACK' : 'ASSEMBLY';
  // Single component (body → pan, or the same SKU re-packed) is 1:1: every consumed piece is either a finished piece or scrap. Kits skip the check.
  if (inputSkus.size === 1 && consumedQty !== outputQty + scrapQty) {
    throw new RuleError('ASSEMBLY_UNBALANCED', `Consumed ${consumedQty} pieces but produced ${outputQty} + scrap ${scrapQty}; register the difference as scrap with a reason`, {
      consumed: consumedQty.toString(),
      produced: outputQty.toString(),
      scrap: scrapQty.toString(),
    });
  }
  if (mode === 'ASSEMBLY' && inputSkus.has(outSku.id)) throw new RuleError('MIXED_SAME_SKU', 'The finished product cannot also be one of several components; a same-SKU repack takes a single input SKU');

  const code = (await tx.$queryRaw<{ n: string }[]>`SELECT next_doc_number('ASM', 'assembly_seq') AS n`)[0]!.n;
  const order = await tx.assembly_orders.create({
    data: {
      code,
      warehouse_id: station.warehouse_id,
      station_location_id: station.id,
      output_sku_id: outSku.id,
      output_qty: outputQty,
      consumed_qty: consumedQty,
      scrap_qty: scrapQty,
      scrap_reason: input.scrap?.reason ?? null,
      notes: input.notes ?? null,
      mode,
      created_by: ctx.userId,
      started_at: new Date(),
      completed_at: new Date(),
      completed_by: ctx.userId,
    },
  });

  // 1) consume components
  const consumed: { lpn: string; sku: string; qty: string; lpn_status: string }[] = [];
  let mainInputSkuId: string | null = null;
  for (const [idx, line] of input.inputs.entries()) {
    const lpn = await lockLpnByCode(tx, line.lpn_code);
    if (['SHIPPED', 'CANCELLED', 'CONSUMED'].includes(lpn.status)) throw new RuleError('LPN_FROZEN', `LPN ${lpn.code} is ${lpn.status}`);
    if (lpn.warehouse_id !== station.warehouse_id) throw new RuleError('WRONG_WAREHOUSE', `LPN ${lpn.code} belongs to another warehouse`);
    const sku = await resolveSku(tx, line.sku_code);
    if (idx === 0) mainInputSkuId = sku.id;
    // AVAILABLE first, then BLOCKED (pallets of unassembled bodies are kept blocked so orders never allocate them)
    const held = (await lpnContents(tx, lpn.id)).filter((c) => c.sku_id === sku.id);
    let need = BigInt(line.qty);
    for (const st of ['AVAILABLE', 'BLOCKED'] as InventoryStatus[]) {
      const have = held.find((c) => c.status === st)?.qty ?? 0n;
      const take = have < need ? have : need;
      if (take <= 0n) continue;
      await removeInventory(tx, ctx, {
        movement_type: 'ASSEMBLY_OUT',
        from_lpn: lpn,
        sku_id: sku.id,
        qty: take,
        status: st,
        reference_type: 'assembly_order',
        reference_id: order.id,
        reason: `Armado ${code}`,
        note: mode === 'REPACK' ? 'reempaque (mismo SKU)' : `→ ${outSku.code}`,
      });
      need -= take;
    }
    if (need > 0n) {
      const avail = held.filter((c) => c.status === 'AVAILABLE' || c.status === 'BLOCKED').reduce((a, c) => a + c.qty, 0n);
      throw new RuleError('INSUFFICIENT_INVENTORY', `LPN ${lpn.code} has ${avail} pieces of ${sku.code} available/blocked, requested ${line.qty}`, { lpn: lpn.code, available: avail.toString(), requested: String(line.qty) });
    }
    await tx.assembly_inputs.create({ data: { order_id: order.id, lpn_id: lpn.id, sku_id: sku.id, qty: BigInt(line.qty) } });
    const left = await lpnContents(tx, lpn.id);
    let status = lpn.status;
    if (left.length === 0) {
      status = 'CONSUMED';
      await setLpnStatus(tx, lpn.id, 'CONSUMED');
    }
    consumed.push({ lpn: lpn.code, sku: sku.code, qty: line.qty.toString(), lpn_status: status });
  }

  // 2) produce finished pallets at the station
  const produced: { lpn: string; cases: number; pieces_per_case: number; qty: string; putaway_task_id: string | null; suggested_location: string | null }[] = [];
  const warnings: string[] = [];
  for (const p of input.output.pallets) {
    const qty = BigInt(p.cases) * BigInt(p.pieces_per_case);
    const lpn = await createLpn(tx, ctx, { warehouse_id: station.warehouse_id, lpn_type: 'STORAGE', location_id: station.id, lot: input.output.lot ?? null, expiry_date: input.output.expiry_date ?? null, cases_count: p.cases });
    await setLpnStatus(tx, lpn.id, 'STORED');
    await createInventory(tx, ctx, {
      movement_type: 'ASSEMBLY_IN',
      to_lpn: lpn,
      sku_id: outSku.id,
      qty,
      uom_code: 'CASE',
      uom_qty: BigInt(p.cases),
      status: 'AVAILABLE',
      location_id: station.id,
      reference_type: 'assembly_order',
      reference_id: order.id,
      reason: `Armado ${code}`,
      note: `${p.cases} cajas × ${p.pieces_per_case} pzas`,
    });
    let taskId: string | null = null;
    let suggested: string | null = null;
    try {
      const task = await createPutawayTask(tx, ctx, lpn, { allowStoredLocation: true });
      taskId = task.id;
      if (task.suggested_location_id) suggested = (await tx.locations.findUnique({ where: { id: task.suggested_location_id }, select: { code: true } }))?.code ?? null;
    } catch (e) {
      warnings.push(`${lpn.code}: sin tarea de acomodo (${(e as Error).message})`);
    }
    await tx.assembly_outputs.create({ data: { order_id: order.id, lpn_id: lpn.id, cases: p.cases, pieces_per_case: p.pieces_per_case, qty, putaway_task_id: taskId } });
    produced.push({ lpn: lpn.code, cases: p.cases, pieces_per_case: p.pieces_per_case, qty: qty.toString(), putaway_task_id: taskId, suggested_location: suggested });
  }

  // 3) scrap is a loss: it leaves a trace as an incident on the order
  let incidentId: string | null = null;
  if (scrapQty > 0n) {
    const inc = await createIncident(tx, ctx, {
      incident_type: 'DAMAGED',
      severity: 'LOW',
      title: `Merma en armado ${code}: ${scrapQty} pzas`,
      description: input.scrap!.reason,
      entity_type: 'assembly_order',
      entity_id: order.id,
      sku_id: mainInputSkuId,
      location_id: station.id,
      qty: scrapQty,
    });
    incidentId = inc.id;
    await tx.assembly_orders.update({ where: { id: order.id }, data: { incident_id: inc.id } });
  }

  await audit(tx, ctx, {
    action: 'assembly.completed',
    entity_type: 'assembly_order',
    entity_id: order.id,
    after: { code, mode, station: station.code, output_sku: outSku.code, output_qty: outputQty.toString(), consumed_qty: consumedQty.toString(), scrap_qty: scrapQty.toString(), consumed, produced: produced.map((p) => p.lpn), incident_id: incidentId },
  });

  const full = await tx.assembly_orders.findUniqueOrThrow({ where: { id: order.id }, include: ORDER_INCLUDE });
  return { ...full, consumed, produced, warnings };
}

// ---------------------------------------------------------------------------------------------------------------
// Two-phase assembly: 1) "surtir para armar" takes the component pallets to the station and blocks them (the order is
// IN_PROGRESS and visible on the handheld); 2) "confirmar armado" consumes them, creates the finished pallets (with
// put-away tasks) and records the defective pieces. An open order can be cancelled: inputs unblocked, put-away back.
// ---------------------------------------------------------------------------------------------------------------

/** The station: the scanned one, or (no scan) the warehouse's assembly area — zone ARM, else its first floor area. */
async function resolveStation(tx: Tx, barcode: string | undefined, firstLpnCode?: string): Promise<LocationRow> {
  if (!barcode) {
    const lpn = firstLpnCode ? await tx.lpns.findUnique({ where: { code: firstLpnCode.trim().toUpperCase() }, select: { warehouse_id: true } }) : null;
    const wh = lpn?.warehouse_id ?? (await tx.warehouses.findFirst({ where: { is_default: true, is_active: true } }))?.id ?? null;
    if (!wh) throw new RuleError('NO_STATION', 'No hay estación de armado configurada');
    const arm = await tx.locations.findFirst({ where: { warehouse_id: wh, is_active: true, admin_status: 'ACTIVE', rack_id: null, OR: [{ zone: { code: { contains: 'ARM', mode: 'insensitive' } } }, { code: { contains: 'ARM', mode: 'insensitive' } }] }, orderBy: { code: 'asc' }, select: { id: true } })
      ?? (await tx.locations.findFirst({ where: { warehouse_id: wh, is_active: true, admin_status: 'ACTIVE', rack_id: null, location_type: 'STAGING' }, orderBy: { code: 'asc' }, select: { id: true } }));
    if (!arm) throw new RuleError('NO_STATION', 'El almacén no tiene estación de armado (zona ARM) ni área de piso; escanea una');
    return lockLocation(tx, arm.id);
  }
  const station = await lockLocationByBarcode(tx, barcode);
  if (!station.is_active || station.admin_status !== 'ACTIVE') throw new RuleError('STATION_BLOCKED', `Station ${station.code} is ${station.admin_status}`);
  if (station.rack_id) throw new RuleError('STATION_IS_RACK', `${station.code} is a rack position; the assembly station must be a floor area (zone ARM / staging)`);
  return station;
}

export async function startAssembly(tx: Tx, ctx: ActorContext, input: AssemblyStartInput) {
  const station = await resolveStation(tx, input.station_barcode, input.inputs[0]?.lpn_code);
  const outSku = await resolveSku(tx, input.output_sku_code);
  if (!outSku.is_active) throw new RuleError('SKU_INACTIVE', `SKU ${outSku.code} is inactive`);
  const consumedQty = input.inputs.reduce((acc, i) => acc + BigInt(i.qty), 0n);
  const inputSkuRows = await Promise.all([...new Set(input.inputs.map((i) => i.sku_code))].map((c) => resolveSku(tx, c)));
  const inputSkus = new Set(inputSkuRows.map((r) => r.id));
  const mode = inputSkus.size === 1 && inputSkus.has(outSku.id) ? 'REPACK' : 'ASSEMBLY';
  if (mode === 'ASSEMBLY' && inputSkus.has(outSku.id)) throw new RuleError('MIXED_SAME_SKU', 'The finished product cannot also be one of several components; a same-SKU repack takes a single input SKU');

  const code = (await tx.$queryRaw<{ n: string }[]>`SELECT next_doc_number('ASM', 'assembly_seq') AS n`)[0]!.n;
  const order = await tx.assembly_orders.create({
    data: { code, warehouse_id: station.warehouse_id, station_location_id: station.id, output_sku_id: outSku.id, output_qty: 0n, consumed_qty: consumedQty, notes: input.notes, mode, status: 'IN_PROGRESS', created_by: ctx.userId, started_at: new Date() },
  });

  const moved: { lpn: string; sku: string; qty: string; from: string | null; blocked: string }[] = [];
  for (const line of input.inputs) {
    let lpn = await lockLpnByCode(tx, line.lpn_code);
    if (lpn.status !== 'STORED' || !lpn.current_location_id) throw new RuleError('LPN_STATUS', `LPN ${lpn.code} is ${lpn.status}; only stored pallets can be taken to assembly`);
    if (lpn.warehouse_id !== station.warehouse_id) throw new RuleError('WRONG_WAREHOUSE', `LPN ${lpn.code} belongs to another warehouse`);
    const busy = await tx.assembly_inputs.findFirst({ where: { lpn_id: lpn.id, order: { status: 'IN_PROGRESS' } }, include: { order: { select: { code: true } } } });
    if (busy) throw new RuleError('ASSEMBLY_LPN_BUSY', `LPN ${lpn.code} ya está apartada para el armado ${busy.order.code}`, { assembly: busy.order.code });
    const sku = await resolveSku(tx, line.sku_code);
    const held = (await lpnContents(tx, lpn.id)).filter((c) => c.sku_id === sku.id);
    const usable = held.filter((c) => c.status === 'AVAILABLE' || c.status === 'BLOCKED').reduce((a, c) => a + c.qty, 0n);
    const other = held.filter((c) => c.status !== 'AVAILABLE' && c.status !== 'BLOCKED' && c.qty > 0n);
    if (other.length) throw new RuleError('LPN_NOT_FREE', `LPN ${lpn.code} has ${sku.code} in ${other.map((c) => c.status).join(', ')}; it cannot go to assembly`);
    if (usable < BigInt(line.qty)) throw new RuleError('INSUFFICIENT_INVENTORY', `LPN ${lpn.code} has ${usable} pieces of ${sku.code} available/blocked, requested ${line.qty}`, { lpn: lpn.code, available: usable.toString(), requested: String(line.qty) });
    const fromLoc = (await tx.locations.findUnique({ where: { id: lpn.current_location_id }, select: { code: true } }))?.code ?? null;
    // the pallet physically goes to the station
    if (lpn.current_location_id !== station.id) {
      await moveLpn(tx, ctx, { movement_type: 'TRANSFER_COMPLETE', lpn, to_location_id: station.id, reference_type: 'assembly_order', reference_id: order.id, reason: `Surtido para armado ${code}` });
      lpn = await lockLpn(tx, lpn.id);
    }
    // and the pieces reserved for this assembly are blocked so no order can allocate them meanwhile
    const available = held.find((c) => c.status === 'AVAILABLE')?.qty ?? 0n;
    const toBlock = available < BigInt(line.qty) ? available : BigInt(line.qty);
    if (toBlock > 0n) await changeStatus(tx, ctx, { movement_type: 'BLOCK', lpn, sku_id: sku.id, qty: toBlock, from_status: 'AVAILABLE', to_status: 'BLOCKED', reference_type: 'assembly_order', reference_id: order.id, reason: `Apartado para armado ${code}` });
    await tx.assembly_inputs.create({ data: { order_id: order.id, lpn_id: lpn.id, sku_id: sku.id, qty: BigInt(line.qty) } });
    moved.push({ lpn: lpn.code, sku: sku.code, qty: line.qty.toString(), from: fromLoc, blocked: toBlock.toString() });
  }
  await audit(tx, ctx, { action: 'assembly.started', entity_type: 'assembly_order', entity_id: order.id, after: { code, mode, station: station.code, output_sku: outSku.code, consumed_qty: consumedQty.toString(), inputs: moved }, reason: input.notes });
  const full = await tx.assembly_orders.findUniqueOrThrow({ where: { id: order.id }, include: ORDER_INCLUDE });
  return { ...full, moved };
}

export async function finishAssembly(tx: Tx, ctx: ActorContext, id: string, input: AssemblyFinishInput) {
  const rows = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT id, status FROM assembly_orders WHERE id = ${id}::uuid FOR UPDATE`;
  if (!rows[0]) throw new NotFoundError('assembly_order', id);
  if (rows[0].status !== 'IN_PROGRESS') throw new RuleError('ASSEMBLY_STATUS', `El armado está ${rows[0].status}`);
  const order = await tx.assembly_orders.findUniqueOrThrow({ where: { id }, include: { inputs: true, output_sku: true } });
  const station = await lockLocation(tx, order.station_location_id);
  const outSku = order.output_sku;
  if (outSku.requires_lot && !input.lot) throw new RuleError('LOT_REQUIRED', `SKU ${outSku.code} requires a lot`);
  if (outSku.requires_expiry && !input.expiry_date) throw new RuleError('EXPIRY_REQUIRED', `SKU ${outSku.code} requires an expiry date`);
  const outputQty = input.pallets.reduce((acc, p) => acc + BigInt(p.cases) * BigInt(p.pieces_per_case), 0n);
  const scrapQty = input.scrap ? BigInt(input.scrap.qty) : 0n;
  const consumedQty = order.inputs.reduce((a, i) => a + i.qty, 0n);
  const inputSkus = new Set(order.inputs.map((i) => i.sku_id));
  if (inputSkus.size === 1 && consumedQty !== outputQty + scrapQty) {
    throw new RuleError('ASSEMBLY_UNBALANCED', `Consumed ${consumedQty} pieces but produced ${outputQty} + scrap ${scrapQty}; register the difference as scrap with a reason`, { consumed: consumedQty.toString(), produced: outputQty.toString(), scrap: scrapQty.toString() });
  }

  // 1) consume the reserved components (BLOCKED first: that is what phase 1 set aside)
  const consumed: { lpn: string; sku: string; qty: string; lpn_status: string }[] = [];
  for (const line of order.inputs) {
    const lpn = await lockLpn(tx, line.lpn_id);
    const held = (await lpnContents(tx, lpn.id)).filter((c) => c.sku_id === line.sku_id);
    let need = line.qty;
    for (const st of ['BLOCKED', 'AVAILABLE'] as InventoryStatus[]) {
      const have = held.find((c) => c.status === st)?.qty ?? 0n;
      const take = have < need ? have : need;
      if (take <= 0n) continue;
      await removeInventory(tx, ctx, { movement_type: 'ASSEMBLY_OUT', from_lpn: lpn, sku_id: line.sku_id, qty: take, status: st, reference_type: 'assembly_order', reference_id: order.id, reason: `Armado ${order.code}`, note: order.mode === 'REPACK' ? 'reempaque (mismo SKU)' : `→ ${outSku.code}` });
      need -= take;
    }
    if (need > 0n) throw new RuleError('INSUFFICIENT_INVENTORY', `LPN ${lpn.code} no longer holds the ${line.qty} pieces reserved for this assembly`, { lpn: lpn.code, missing: need.toString() });
    const left = await lpnContents(tx, lpn.id);
    let status = lpn.status;
    if (left.length === 0) {
      status = 'CONSUMED';
      await setLpnStatus(tx, lpn.id, 'CONSUMED');
    }
    const skuCode = (await tx.skus.findUnique({ where: { id: line.sku_id }, select: { code: true } }))?.code ?? line.sku_id;
    consumed.push({ lpn: lpn.code, sku: skuCode, qty: line.qty.toString(), lpn_status: status });
  }

  // 2) finished pallets at the station, each with its put-away task
  const { produced, warnings } = await produceOutputs(tx, ctx, { id: order.id, code: order.code }, station, outSku.id, input.pallets, input.lot ?? null, input.expiry_date ?? null);

  // 3) defective pieces
  let incidentId: string | null = null;
  if (scrapQty > 0n) {
    const inc = await createIncident(tx, ctx, { incident_type: 'DAMAGED', severity: 'LOW', title: `Defectuosas en armado ${order.code}: ${scrapQty} pzas`, description: input.scrap!.reason, entity_type: 'assembly_order', entity_id: order.id, sku_id: order.inputs[0]?.sku_id ?? null, location_id: station.id, qty: scrapQty });
    incidentId = inc.id;
  }
  await tx.assembly_orders.update({ where: { id: order.id }, data: { status: 'COMPLETED', output_qty: outputQty, scrap_qty: scrapQty, scrap_reason: input.scrap?.reason ?? null, incident_id: incidentId, completed_at: new Date(), completed_by: ctx.userId, notes: input.notes ? `${order.notes ?? ''}\n${input.notes}`.trim() : order.notes } });
  await audit(tx, ctx, { action: 'assembly.completed', entity_type: 'assembly_order', entity_id: order.id, after: { code: order.code, mode: order.mode, station: station.code, output_sku: outSku.code, output_qty: outputQty.toString(), consumed_qty: consumedQty.toString(), scrap_qty: scrapQty.toString(), consumed, produced: produced.map((p) => p.lpn), incident_id: incidentId, two_phase: true } });
  const full = await tx.assembly_orders.findUniqueOrThrow({ where: { id: order.id }, include: ORDER_INCLUDE });
  return { ...full, consumed, produced, warnings };
}

export async function cancelAssembly(tx: Tx, ctx: ActorContext, id: string, reason: string) {
  const rows = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT id, status FROM assembly_orders WHERE id = ${id}::uuid FOR UPDATE`;
  if (!rows[0]) throw new NotFoundError('assembly_order', id);
  if (rows[0].status !== 'IN_PROGRESS') throw new RuleError('ASSEMBLY_STATUS', `El armado está ${rows[0].status}`);
  const order = await tx.assembly_orders.findUniqueOrThrow({ where: { id }, include: { inputs: true } });
  const released: { lpn: string; putaway_task_id: string | null }[] = [];
  for (const line of order.inputs) {
    const lpn = await lockLpn(tx, line.lpn_id);
    const blocked = (await lpnContents(tx, lpn.id)).find((c) => c.sku_id === line.sku_id && c.status === 'BLOCKED')?.qty ?? 0n;
    const unblock = blocked < line.qty ? blocked : line.qty;
    if (unblock > 0n) await changeStatus(tx, ctx, { movement_type: 'UNBLOCK', lpn, sku_id: line.sku_id, qty: unblock, from_status: 'BLOCKED', to_status: 'AVAILABLE', reference_type: 'assembly_order', reference_id: order.id, reason: `Armado ${order.code} cancelado: ${reason}` });
    let taskId: string | null = null;
    try {
      taskId = (await createPutawayTask(tx, ctx, { ...lpn, status: 'STORED' }, { allowStoredLocation: true })).id;
    } catch {
      taskId = null; // e.g. the pallet is empty or stuck; the operator moves it by hand
    }
    released.push({ lpn: lpn.code, putaway_task_id: taskId });
  }
  await tx.assembly_orders.update({ where: { id: order.id }, data: { status: 'CANCELLED', completed_at: new Date(), completed_by: ctx.userId, notes: `${order.notes ?? ''}\nCancelado: ${reason}`.trim() } });
  await audit(tx, ctx, { action: 'assembly.cancelled', entity_type: 'assembly_order', entity_id: order.id, after: { code: order.code, released }, reason });
  return { id: order.id, code: order.code, status: 'CANCELLED', released };
}

/** Finished pallets born at the station (shared by the one-shot and the two-phase flows). */
async function produceOutputs(tx: Tx, ctx: ActorContext, order: { id: string; code: string }, station: LocationRow, outSkuId: string, pallets: { cases: number; pieces_per_case: number }[], lot: string | null, expiry: string | null) {
  const produced: { lpn: string; cases: number; pieces_per_case: number; qty: string; putaway_task_id: string | null; suggested_location: string | null }[] = [];
  const warnings: string[] = [];
  for (const p of pallets) {
    const qty = BigInt(p.cases) * BigInt(p.pieces_per_case);
    const lpn = await createLpn(tx, ctx, { warehouse_id: station.warehouse_id, lpn_type: 'STORAGE', location_id: station.id, lot, expiry_date: expiry, cases_count: p.cases });
    await setLpnStatus(tx, lpn.id, 'STORED');
    await createInventory(tx, ctx, { movement_type: 'ASSEMBLY_IN', to_lpn: lpn, sku_id: outSkuId, qty, uom_code: 'CASE', uom_qty: BigInt(p.cases), status: 'AVAILABLE', location_id: station.id, reference_type: 'assembly_order', reference_id: order.id, reason: `Armado ${order.code}`, note: `${p.cases} cajas × ${p.pieces_per_case} pzas` });
    let taskId: string | null = null;
    let suggested: string | null = null;
    try {
      const task = await createPutawayTask(tx, ctx, lpn, { allowStoredLocation: true });
      taskId = task.id;
      if (task.suggested_location_id) suggested = (await tx.locations.findUnique({ where: { id: task.suggested_location_id }, select: { code: true } }))?.code ?? null;
    } catch (e) {
      warnings.push(`${lpn.code}: sin tarea de acomodo (${(e as Error).message})`);
    }
    await tx.assembly_outputs.create({ data: { order_id: order.id, lpn_id: lpn.id, cases: p.cases, pieces_per_case: p.pieces_per_case, qty, putaway_task_id: taskId } });
    produced.push({ lpn: lpn.code, cases: p.cases, pieces_per_case: p.pieces_per_case, qty: qty.toString(), putaway_task_id: taskId, suggested_location: suggested });
  }
  return { produced, warnings };
}

export async function listAssemblies(tx: Tx, q: { limit: number; sku?: string; status?: string; include_training?: boolean }) {
  return tx.assembly_orders.findMany({
    where: { ...(q.include_training ? {} : { is_training: false }), ...(q.sku ? { output_sku: { code: q.sku } } : {}), ...(q.status ? { status: { in: q.status.split(',') } } : {}) },
    orderBy: { created_at: 'desc' },
    take: q.limit,
    include: ORDER_INCLUDE,
  });
}

export async function getAssembly(tx: Tx, id: string) {
  const row = await tx.assembly_orders.findUnique({ where: { id }, include: ORDER_INCLUDE });
  if (!row) throw new NotFoundError('assembly_order', id);
  return row;
}
