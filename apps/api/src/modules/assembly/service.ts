// Assembly orders: consume components from existing pallets and produce the finished product onto NEW pallets.
// Example: pan bodies arrive in masters of 24 on one pallet; after assembly the pans are packed 12 per case and
// fill three pallets. One pallet disappears (CONSUMED), three are born at the assembly station with put-away tasks.
import type { AssemblyCompleteInput } from '@wms/shared';
import type { Tx } from '../../db.js';
import { NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';
import { createInventory, createLpn, lockLocationByBarcode, lockLpnByCode, lpnContents, removeInventory, setLpnStatus } from '../../inventory/ledger.js';
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
  const station = await lockLocationByBarcode(tx, input.station_barcode);
  if (!station.is_active || station.admin_status !== 'ACTIVE') throw new RuleError('STATION_BLOCKED', `Station ${station.code} is ${station.admin_status}`);
  if (station.rack_id) throw new RuleError('STATION_IS_RACK', `${station.code} is a rack position; the assembly station must be a floor area (zone ARM / staging)`);

  const outSku = await resolveSku(tx, input.output.sku_code);
  if (!outSku.is_active) throw new RuleError('SKU_INACTIVE', `SKU ${outSku.code} is inactive`);
  if (outSku.requires_lot && !input.output.lot) throw new RuleError('LOT_REQUIRED', `SKU ${outSku.code} requires a lot`);
  if (outSku.requires_expiry && !input.output.expiry_date) throw new RuleError('EXPIRY_REQUIRED', `SKU ${outSku.code} requires an expiry date`);

  const outputQty = input.output.pallets.reduce((acc, p) => acc + BigInt(p.cases) * BigInt(p.pieces_per_case), 0n);
  const scrapQty = input.scrap ? BigInt(input.scrap.qty) : 0n;
  const consumedQty = input.inputs.reduce((acc, i) => acc + BigInt(i.qty), 0n);
  const inputSkus = new Set(input.inputs.map((i) => i.sku_code));
  // Single component (body → pan) is 1:1: every consumed piece is either a finished piece or scrap. Kits (several components) skip the check.
  if (inputSkus.size === 1 && consumedQty !== outputQty + scrapQty) {
    throw new RuleError('ASSEMBLY_UNBALANCED', `Consumed ${consumedQty} pieces but produced ${outputQty} + scrap ${scrapQty}; register the difference as scrap with a reason`, {
      consumed: consumedQty.toString(),
      produced: outputQty.toString(),
      scrap: scrapQty.toString(),
    });
  }
  for (const i of input.inputs) if (i.sku_code === input.output.sku_code) throw new RuleError('SAME_SKU', 'Input and output SKU cannot be the same product');

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
      created_by: ctx.userId,
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
    await removeInventory(tx, ctx, {
      movement_type: 'ASSEMBLY_OUT',
      from_lpn: lpn,
      sku_id: sku.id,
      qty: BigInt(line.qty),
      status: 'AVAILABLE',
      reference_type: 'assembly_order',
      reference_id: order.id,
      reason: `Armado ${code}`,
      note: `→ ${outSku.code}`,
    });
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
    after: { code, station: station.code, output_sku: outSku.code, output_qty: outputQty.toString(), consumed_qty: consumedQty.toString(), scrap_qty: scrapQty.toString(), consumed, produced: produced.map((p) => p.lpn), incident_id: incidentId },
  });

  const full = await tx.assembly_orders.findUniqueOrThrow({ where: { id: order.id }, include: ORDER_INCLUDE });
  return { ...full, consumed, produced, warnings };
}

export async function listAssemblies(tx: Tx, q: { limit: number; sku?: string }) {
  return tx.assembly_orders.findMany({
    where: q.sku ? { output_sku: { code: q.sku } } : {},
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
