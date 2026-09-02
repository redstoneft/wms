import { getDb, withTx, type Tx } from '../../db.js';
import { NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';
import { getSkuByCode } from '../../lib/lookup.js';
import { startTransfer } from '../transfers/service.js';

/**
 * Scans every active rule: when AVAILABLE quantity in the pick location is at
 * or below the minimum and no task is active, creates a replenishment task
 * choosing the best source pallet (oldest full pallet of the SKU in RESERVE
 * that fits the gap; FIFO by LPN creation).
 */
export async function evaluateReplenishmentRules(ctx: ActorContext): Promise<{ created: number }> {
  return withTx(async (tx) => {
    const rules = await tx.$queryRaw<{ id: string; sku_id: string; pick_location_id: string; min_qty: bigint; max_qty: bigint; current: bigint }[]>`
      SELECT r.id, r.sku_id, r.pick_location_id, r.min_qty, r.max_qty,
             COALESCE((SELECT sum(b.qty) FROM lpns l JOIN inventory_balances b ON b.lpn_id = l.id AND b.sku_id = r.sku_id AND b.status IN ('AVAILABLE','ALLOCATED')
                        WHERE l.current_location_id = r.pick_location_id), 0)::bigint AS current
        FROM replenishment_rules r
       WHERE r.is_active
         AND NOT EXISTS (SELECT 1 FROM replenishment_tasks t WHERE t.rule_id = r.id AND t.status IN ('PENDING','IN_PROGRESS'))
       FOR UPDATE OF r SKIP LOCKED`;
    let created = 0;
    for (const r of rules) {
      if (r.current > r.min_qty) continue;
      const gap = r.max_qty - r.current;
      const source = await pickSourcePallet(tx, r.sku_id, gap, r.pick_location_id);
      const task = await tx.replenishment_tasks.create({
        data: { rule_id: r.id, sku_id: r.sku_id, source_lpn_id: source?.lpn_id ?? null, from_location_id: source?.location_id ?? null, to_location_id: r.pick_location_id, qty: source?.qty ?? gap, status: 'PENDING' },
      });
      await audit(tx, ctx, { action: 'replenishment.task_created', entity_type: 'replenishment_task', entity_id: task.id, after: { rule: r.id, current: r.current.toString(), gap: gap.toString(), source: source?.lpn_code ?? null } });
      created++;
    }
    return { created };
  });
}

async function pickSourcePallet(tx: Tx, skuId: string, gap: bigint, excludeLocation: string) {
  const rows = await tx.$queryRaw<{ lpn_id: string; lpn_code: string; location_id: string; qty: bigint }[]>`
    SELECT l.id AS lpn_id, l.code AS lpn_code, l.current_location_id AS location_id, sum(b.qty)::bigint AS qty
      FROM lpns l JOIN inventory_balances b ON b.lpn_id = l.id AND b.status = 'AVAILABLE' AND b.sku_id = ${skuId}::uuid
      JOIN locations loc ON loc.id = l.current_location_id
     WHERE l.status = 'STORED' AND loc.location_type = 'RESERVE' AND l.current_location_id <> ${excludeLocation}::uuid
       AND NOT EXISTS (SELECT 1 FROM inventory_balances b2 WHERE b2.lpn_id = l.id AND b2.qty > 0 AND (b2.sku_id <> ${skuId}::uuid OR b2.status <> 'AVAILABLE'))
       AND NOT EXISTS (SELECT 1 FROM replenishment_tasks t WHERE t.source_lpn_id = l.id AND t.status IN ('PENDING','IN_PROGRESS'))
     GROUP BY l.id ORDER BY (sum(b.qty) <= ${gap}) DESC, sum(b.qty) DESC, l.created_at ASC LIMIT 1`;
  return rows[0] ?? null;
}

/** Operator takes a task: a transfer to the picking location is started for the source pallet. */
export async function startReplenishment(tx: Tx, ctx: ActorContext, taskId: string) {
  const rows = await tx.$queryRaw<{ id: string; status: string; source_lpn_id: string | null; to_location_id: string; sku_id: string }[]>`
    SELECT id, status, source_lpn_id, to_location_id, sku_id FROM replenishment_tasks WHERE id = ${taskId}::uuid FOR UPDATE`;
  const t = rows[0];
  if (!t) throw new NotFoundError('replenishment task', taskId);
  if (t.status !== 'PENDING') throw new RuleError('TASK_STATUS', `Task is ${t.status}`);
  let sourceLpnId = t.source_lpn_id;
  if (!sourceLpnId) {
    const rule = await tx.replenishment_rules.findUnique({ where: { id: (await tx.replenishment_tasks.findUniqueOrThrow({ where: { id: taskId } })).rule_id } });
    const cur = await tx.$queryRaw<{ q: bigint }[]>`SELECT COALESCE(sum(b.qty),0)::bigint AS q FROM lpns l JOIN inventory_balances b ON b.lpn_id = l.id AND b.sku_id = ${t.sku_id}::uuid AND b.status IN ('AVAILABLE','ALLOCATED') WHERE l.current_location_id = ${t.to_location_id}::uuid`;
    const gap = rule ? rule.max_qty - (cur[0]?.q ?? 0n) : 0n;
    const src = await pickSourcePallet(tx, t.sku_id, gap > 0n ? gap : 1n, t.to_location_id);
    if (!src) throw new RuleError('NO_SOURCE_PALLET', 'No reserve pallet available for this SKU');
    sourceLpnId = src.lpn_id;
    await tx.replenishment_tasks.update({ where: { id: taskId }, data: { source_lpn_id: src.lpn_id, from_location_id: src.location_id, qty: src.qty } });
  }
  const lpn = await tx.lpns.findUniqueOrThrow({ where: { id: sourceLpnId } });
  const dest = await tx.locations.findUniqueOrThrow({ where: { id: t.to_location_id } });
  const transfer = await startTransfer(tx, ctx, { lpn_code: lpn.code, to_location_barcode: dest.barcode, reason: `Replenishment task ${taskId}`, transfer_type: 'REPLENISHMENT' });
  await tx.replenishment_tasks.update({ where: { id: taskId }, data: { status: 'IN_PROGRESS', transfer_id: transfer.transfer.id, assigned_to: ctx.userId } });
  await audit(tx, ctx, { action: 'replenishment.start', entity_type: 'replenishment_task', entity_id: taskId, after: { lpn: lpn.code, to: dest.code, transfer: transfer.transfer.id } });
  return { task_id: taskId, transfer: transfer.transfer, lpn_code: lpn.code, to_location: transfer.to_location };
}

export async function upsertRule(tx: Tx, ctx: ActorContext, input: { sku_code: string; pick_location_barcode: string; min_qty: bigint; max_qty: bigint }) {
  const sku = await getSkuByCode(tx, input.sku_code);
  const loc = await tx.locations.findFirst({ where: { OR: [{ barcode: input.pick_location_barcode }, { code: input.pick_location_barcode.toUpperCase() }] } });
  if (!loc) throw new NotFoundError('location', input.pick_location_barcode);
  if (loc.location_type !== 'PICKING') throw new RuleError('NOT_PICKING_LOCATION', `Location ${loc.code} is ${loc.location_type}; replenishment targets PICKING locations`);
  if (input.max_qty <= input.min_qty) throw new RuleError('MIN_MAX', 'max_qty must be greater than min_qty');
  const rule = await tx.replenishment_rules.upsert({
    where: { sku_id_pick_location_id: { sku_id: sku.id, pick_location_id: loc.id } },
    create: { sku_id: sku.id, pick_location_id: loc.id, min_qty: input.min_qty, max_qty: input.max_qty },
    update: { min_qty: input.min_qty, max_qty: input.max_qty, is_active: true },
  });
  await audit(tx, ctx, { action: 'replenishment.rule_upsert', entity_type: 'replenishment_rule', entity_id: rule.id, after: rule });
  return rule;
}

export async function listTasks(status: string[]) {
  return getDb().$queryRaw<Record<string, unknown>[]>`
    SELECT t.*, s.code AS sku_code, s.description, l.code AS source_lpn_code, f.code AS from_code, d.code AS to_code, d.barcode AS to_barcode
      FROM replenishment_tasks t JOIN skus s ON s.id = t.sku_id LEFT JOIN lpns l ON l.id = t.source_lpn_id
      LEFT JOIN locations f ON f.id = t.from_location_id JOIN locations d ON d.id = t.to_location_id
     WHERE t.status = ANY(${status}::text[]) ORDER BY t.created_at`;
}
