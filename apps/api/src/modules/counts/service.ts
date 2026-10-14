import type { CountType, UomCode } from '@wms/shared';
import type { Tx } from '../../db.js';
import { ForbiddenError, NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';
import { getSkuByCode, resolveSkuBarcode, toBaseQty } from '../../lib/lookup.js';
import { createInventory, createLpn, lockLpn, removeInventory } from '../../inventory/ledger.js';
import { normalizeLocationCode, resolveImportSku, type Row, type RowError } from '../imports/service.js';
import { createIncident } from '../incidents/service.js';

export interface CreateCountInput {
  count_type: CountType;
  location_barcodes?: string[];
  sku_codes?: string[];
  zone_id?: string;
  abc_class?: 'A' | 'B' | 'C';
  random_sample?: number;
  incident_id?: string;
  scheduled_for?: Date;
  assigned_to?: string;
  is_blind: boolean;
  notes?: string;
}

/** Builds a count task with a snapshot of system quantities (never shown to a blind counter). */
export async function createCountTask(tx: Tx, ctx: ActorContext, input: CreateCountInput) {
  let locationIds: string[] = [];
  const skuFilter: string[] = [];
  switch (input.count_type) {
    case 'LOCATION':
    case 'SCHEDULED':
    case 'INCIDENT': {
      if (input.incident_id && !input.location_barcodes?.length) {
        const inc = await tx.incidents.findUnique({ where: { id: input.incident_id } });
        if (!inc) throw new NotFoundError('incident', input.incident_id);
        if (inc.location_id) locationIds = [inc.location_id];
        else if (inc.lpn_id) {
          const l = await tx.lpns.findUnique({ where: { id: inc.lpn_id } });
          if (l?.current_location_id) locationIds = [l.current_location_id];
        }
        if (inc.sku_id) skuFilter.push(inc.sku_id);
      }
      for (const bc of input.location_barcodes ?? []) {
        const loc = await tx.locations.findFirst({ where: { OR: [{ barcode: bc }, { code: bc.toUpperCase() }] } });
        if (!loc) throw new NotFoundError('location', bc);
        locationIds.push(loc.id);
      }
      break;
    }
    case 'SKU': {
      for (const code of input.sku_codes ?? []) skuFilter.push((await getSkuByCode(tx, code)).id);
      if (!skuFilter.length) throw new RuleError('SKU_REQUIRED', 'sku_codes required for SKU counts');
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT DISTINCT l.current_location_id AS id FROM lpns l JOIN inventory_balances b ON b.lpn_id = l.id AND b.qty > 0
        WHERE b.sku_id = ANY(${skuFilter}::uuid[]) AND l.current_location_id IS NOT NULL`;
      locationIds = rows.map((r) => r.id);
      break;
    }
    case 'ZONE': {
      if (!input.zone_id) throw new RuleError('ZONE_REQUIRED', 'zone_id required');
      const rows = await tx.locations.findMany({ where: { zone_id: input.zone_id, is_active: true }, select: { id: true } });
      locationIds = rows.map((r) => r.id);
      break;
    }
    case 'ABC': {
      if (!input.abc_class) throw new RuleError('ABC_REQUIRED', 'abc_class required');
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT DISTINCT l.current_location_id AS id FROM lpns l JOIN inventory_balances b ON b.lpn_id = l.id AND b.qty > 0 JOIN skus s ON s.id = b.sku_id
        WHERE s.abc_class = ${input.abc_class} AND l.current_location_id IS NOT NULL`;
      locationIds = rows.map((r) => r.id);
      break;
    }
    case 'RANDOM': {
      const n = input.random_sample ?? 10;
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM locations WHERE is_active AND location_type IN ('RESERVE','PICKING') ORDER BY random() LIMIT ${n}`;
      locationIds = rows.map((r) => r.id);
      break;
    }
  }
  locationIds = [...new Set(locationIds)];
  if (!locationIds.length) throw new RuleError('EMPTY_SCOPE', 'The count scope contains no locations');
  if (locationIds.length > 500) throw new RuleError('SCOPE_TOO_LARGE', 'Limit count tasks to 500 locations');

  const task = await tx.count_tasks.create({
    data: {
      count_type: input.count_type,
      scope: { location_ids: locationIds, sku_ids: skuFilter },
      is_blind: input.is_blind,
      scheduled_for: input.scheduled_for ?? null,
      assigned_to: input.assigned_to ?? null,
      incident_id: input.incident_id ?? null,
      created_by: ctx.userId,
      notes: input.notes ?? null,
    },
  });
  // snapshot lines
  const snapshot = await tx.$queryRaw<{ location_id: string; lpn_id: string; sku_id: string; qty: bigint }[]>`
    SELECT l.current_location_id AS location_id, l.id AS lpn_id, b.sku_id, sum(b.qty)::bigint AS qty
      FROM lpns l JOIN inventory_balances b ON b.lpn_id = l.id AND b.qty > 0
     WHERE l.current_location_id = ANY(${locationIds}::uuid[]) AND (${skuFilter.length === 0} OR b.sku_id = ANY(${skuFilter}::uuid[]))
     GROUP BY l.current_location_id, l.id, b.sku_id`;
  if (snapshot.length) {
    await tx.count_lines.createMany({ data: snapshot.map((s) => ({ count_task_id: task.id, location_id: s.location_id, lpn_id: s.lpn_id, sku_id: s.sku_id, system_qty: s.qty })) });
  }
  await audit(tx, ctx, { action: 'count.create', entity_type: 'count_task', entity_id: task.id, after: { type: input.count_type, locations: locationIds.length, lines: snapshot.length } });
  return { ...task, lines: snapshot.length, locations: locationIds.length };
}

/** What the counter sees: locations to visit and (if not blind) expected contents. */
export async function taskForCounter(tx: Tx, taskId: string, actor: ActorContext) {
  const task = await tx.count_tasks.findUnique({ where: { id: taskId } });
  if (!task) throw new NotFoundError('count task', taskId);
  const scope = task.scope as { location_ids: string[] };
  const locations = await tx.locations.findMany({ where: { id: { in: scope.location_ids } }, select: { id: true, code: true, barcode: true }, orderBy: { code: 'asc' } });
  const lines = await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT cl.id, cl.status, loc.code AS location_code, l.code AS lpn_code, s.code AS sku_code, s.description,
           cl.counted_qty::text AS counted_qty, cl.recount_qty::text AS recount_qty,
           CASE WHEN ${task.is_blind && !actor.permissions.has('counts.approve')} THEN NULL ELSE cl.system_qty::text END AS system_qty,
           CASE WHEN ${task.is_blind && !actor.permissions.has('counts.approve')} THEN NULL ELSE cl.variance::text END AS variance
      FROM count_lines cl JOIN locations loc ON loc.id = cl.location_id LEFT JOIN lpns l ON l.id = cl.lpn_id JOIN skus s ON s.id = cl.sku_id
     WHERE cl.count_task_id = ${taskId}::uuid ORDER BY loc.code, l.code, s.code`;
  return { task, locations, lines };
}

/** Counter submits what they physically see for (location, lpn?, sku). */
export async function submitCount(tx: Tx, ctx: ActorContext, input: { count_task_id: string; location_barcode: string; lpn_code?: string; barcode: string; qty: bigint; uom_code?: UomCode }) {
  const rows = await tx.$queryRaw<{ id: string; status: string; scope: { location_ids: string[] }; assigned_to: string | null }[]>`
    SELECT id, status, scope, assigned_to FROM count_tasks WHERE id = ${input.count_task_id}::uuid FOR UPDATE`;
  const task = rows[0];
  if (!task) throw new NotFoundError('count task', input.count_task_id);
  if (!['PENDING', 'IN_PROGRESS', 'RECOUNT'].includes(task.status)) throw new RuleError('TASK_STATUS', `Count task is ${task.status}`);
  const loc = await tx.locations.findFirst({ where: { OR: [{ barcode: input.location_barcode }, { code: input.location_barcode.toUpperCase() }] } });
  if (!loc) throw new NotFoundError('location', input.location_barcode);
  if (!task.scope.location_ids.includes(loc.id)) throw new RuleError('LOCATION_NOT_IN_SCOPE', `Location ${loc.code} is not part of this count`);
  const { sku, uom_code } = await resolveSkuBarcode(tx, input.barcode);
  const { base } = await toBaseQty(tx, sku.id, input.qty, input.uom_code ?? uom_code);
  let lpnId: string | null = null;
  if (input.lpn_code) {
    const lpn = await tx.lpns.findUnique({ where: { code: input.lpn_code.toUpperCase() } });
    if (!lpn) throw new NotFoundError('LPN', input.lpn_code);
    lpnId = lpn.id;
  }
  const isRecount = task.status === 'RECOUNT';
  let line = await tx.count_lines.findFirst({ where: { count_task_id: task.id, location_id: loc.id, lpn_id: lpnId, sku_id: sku.id } });
  if (!line) {
    if (isRecount) throw new RuleError('LINE_NOT_FOUND', 'Recount only accepts lines that were part of the first count');
    // unexpected find: system says 0 here
    line = await tx.count_lines.create({ data: { count_task_id: task.id, location_id: loc.id, lpn_id: lpnId, sku_id: sku.id, system_qty: 0n } });
  }
  if (isRecount) {
    if (line.status !== 'RECOUNT') throw new RuleError('LINE_NOT_IN_RECOUNT', 'This line does not require a recount');
    if (line.counted_by === ctx.userId && !ctx.permissions.has('counts.approve')) throw new RuleError('SAME_COUNTER', 'The recount must be done by a different person');
    const variance = base - line.system_qty;
    line = await tx.count_lines.update({ where: { id: line.id }, data: { recount_qty: base, final_qty: base, variance, recounted_by: ctx.userId, recounted_at: new Date(), status: variance === 0n ? 'MATCHED' : 'VARIANCE' } });
  } else {
    if (line.status !== 'PENDING' && line.status !== 'COUNTED') throw new RuleError('LINE_STATUS', `Line already ${line.status}`);
    line = await tx.count_lines.update({ where: { id: line.id }, data: { counted_qty: base, counted_by: ctx.userId, counted_at: new Date(), status: 'COUNTED' } });
    if (task.status === 'PENDING') await tx.count_tasks.update({ where: { id: task.id }, data: { status: 'IN_PROGRESS', assigned_to: task.assigned_to ?? ctx.userId } });
  }
  await audit(tx, ctx, { action: isRecount ? 'count.recount' : 'count.submit', entity_type: 'count_task', entity_id: task.id, after: { location: loc.code, lpn: input.lpn_code ?? null, sku: sku.code, qty: base.toString() } });
  return { line_id: line.id, status: line.status, sku: sku.code, qty: base };
}

/**
 * Counter says "I am done": uncounted lines are treated as 0 (not found),
 * variances trigger a recount; when everything matches the task auto-closes.
 */
export async function finishCounting(tx: Tx, ctx: ActorContext, taskId: string) {
  const rows = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT id, status FROM count_tasks WHERE id = ${taskId}::uuid FOR UPDATE`;
  const task = rows[0];
  if (!task) throw new NotFoundError('count task', taskId);
  if (!['IN_PROGRESS', 'RECOUNT', 'PENDING'].includes(task.status)) throw new RuleError('TASK_STATUS', `Count task is ${task.status}`);
  const lines = await tx.count_lines.findMany({ where: { count_task_id: taskId } });
  let variances = 0;
  if (task.status === 'RECOUNT') {
    const pending = lines.filter((l) => l.status === 'RECOUNT');
    if (pending.length) throw new RuleError('RECOUNT_INCOMPLETE', `${pending.length} line(s) still need a recount`);
    variances = lines.filter((l) => l.status === 'VARIANCE').length;
    const status = variances ? 'PENDING_APPROVAL' : 'CLOSED';
    await tx.count_tasks.update({ where: { id: taskId }, data: { status, completed_at: new Date() } });
    await audit(tx, ctx, { action: 'count.finish_recount', entity_type: 'count_task', entity_id: taskId, after: { status, variances } });
    return { status, variances };
  }
  for (const l of lines) {
    const counted = l.status === 'PENDING' ? 0n : (l.counted_qty ?? 0n);
    const variance = counted - l.system_qty;
    if (variance === 0n) {
      await tx.count_lines.update({ where: { id: l.id }, data: { counted_qty: counted, final_qty: counted, variance: 0n, status: 'MATCHED', counted_by: l.counted_by ?? ctx.userId, counted_at: l.counted_at ?? new Date() } });
    } else {
      variances++;
      await tx.count_lines.update({ where: { id: l.id }, data: { counted_qty: counted, variance, status: 'RECOUNT', counted_by: l.counted_by ?? ctx.userId, counted_at: l.counted_at ?? new Date() } });
    }
  }
  const status = variances ? 'RECOUNT' : 'CLOSED';
  await tx.count_tasks.update({ where: { id: taskId }, data: { status, completed_at: variances ? null : new Date() } });
  await audit(tx, ctx, { action: 'count.finish', entity_type: 'count_task', entity_id: taskId, after: { status, variances, lines: lines.length } });
  return { status, variances, lines: lines.length };
}

/**
 * Supervisor approves: adjustments are written to the ledger. A line whose
 * system quantity changed since the count (movement in between) is NOT
 * adjusted — it is flagged and must be recounted. Nothing is ever silent.
 */
export async function approveCount(tx: Tx, ctx: ActorContext, input: { count_task_id: string; decision: 'APPROVE' | 'REJECT'; reason: string }) {
  if (!ctx.permissions.has('counts.approve')) throw new ForbiddenError('Approving count adjustments requires counts.approve');
  const rows = await tx.$queryRaw<{ id: string; status: string; incident_id: string | null }[]>`SELECT id, status, incident_id FROM count_tasks WHERE id = ${input.count_task_id}::uuid FOR UPDATE`;
  const task = rows[0];
  if (!task) throw new NotFoundError('count task', input.count_task_id);
  if (task.status !== 'PENDING_APPROVAL') throw new RuleError('TASK_STATUS', `Count task is ${task.status}; only PENDING_APPROVAL tasks can be approved`);
  const lines = await tx.count_lines.findMany({ where: { count_task_id: task.id, status: 'VARIANCE' }, include: { sku: true } });
  if (input.decision === 'REJECT') {
    await tx.count_lines.updateMany({ where: { count_task_id: task.id, status: 'VARIANCE' }, data: { status: 'REJECTED' } });
    await tx.count_tasks.update({ where: { id: task.id }, data: { status: 'REJECTED', approved_by: ctx.userId, approved_at: new Date(), notes: input.reason } });
    await audit(tx, ctx, { action: 'count.reject', entity_type: 'count_task', entity_id: task.id, reason: input.reason });
    return { status: 'REJECTED', adjusted: 0, skipped: [] };
  }
  const incident = task.incident_id
    ? { id: task.incident_id }
    : await createIncident(tx, ctx, { incident_type: 'INVENTORY_DIFFERENCE', severity: 'MEDIUM', title: `Ajustes por conteo cíclico ${task.id.slice(0, 8)}`, description: input.reason, entity_type: 'count_task', entity_id: task.id });
  let adjusted = 0;
  const skipped: { line_id: string; reason: string }[] = [];
  const created_lpns: { line_id: string; lpn: string; location: string; sku: string; qty: string }[] = [];
  for (const l of lines) {
    // the moment the product was physically looked at: anything the ledger did after that makes the count stale
    const observed = l.recounted_at ?? l.counted_at;
    if (!l.lpn_id) {
      // found product with no LPN: a new storage pallet is born here (its label must be printed), unless the spot moved since
      if ((l.final_qty ?? 0n) <= 0n) {
        skipped.push({ line_id: l.id, reason: 'NO_LPN' });
        continue;
      }
      if (observed && (await movedSince(tx, null, l.location_id, observed))) {
        await tx.count_lines.update({ where: { id: l.id }, data: { status: 'RECOUNT', recount_qty: null, final_qty: null } });
        skipped.push({ line_id: l.id, reason: 'INVENTORY_MOVED_SINCE_COUNT' });
        continue;
      }
      const loc = await tx.locations.findUniqueOrThrow({ where: { id: l.location_id } });
      const born = await createLpn(tx, ctx, { warehouse_id: loc.warehouse_id, lpn_type: 'STORAGE', location_id: loc.id });
      await tx.lpns.update({ where: { id: born.id }, data: { status: 'STORED' } });
      const mv = await createInventory(tx, ctx, { movement_type: 'COUNT_ADJUST_IN', to_lpn: { ...born, status: 'STORED' }, sku_id: l.sku_id, qty: l.final_qty!, status: 'AVAILABLE', location_id: loc.id, reason: `Cycle count ${task.id}`, incident_id: incident.id, reference_type: 'count_task', reference_id: task.id, task_id: task.id });
      await tx.count_lines.update({ where: { id: l.id }, data: { status: 'ADJUSTED', lpn_id: born.id, adjustment_movement_id: mv } });
      created_lpns.push({ line_id: l.id, lpn: born.code, location: loc.code, sku: l.sku.code, qty: l.final_qty!.toString() });
      adjusted++;
      continue;
    }
    const lpn = await lockLpn(tx, l.lpn_id);
    if (lpn.status !== 'STORED') {
      await tx.count_lines.update({ where: { id: l.id }, data: { status: 'RECOUNT', recount_qty: null, final_qty: null } });
      skipped.push({ line_id: l.id, reason: `LPN_NOT_STORED (${lpn.status})` });
      continue;
    }
    const cur = await tx.$queryRaw<{ qty: bigint; available: bigint }[]>`SELECT COALESCE(sum(qty),0)::bigint AS qty, COALESCE(sum(qty) FILTER (WHERE status='AVAILABLE'),0)::bigint AS available
      FROM inventory_balances WHERE lpn_id = ${l.lpn_id}::uuid AND sku_id = ${l.sku_id}::uuid`;
    const currentQty = cur[0]?.qty ?? 0n;
    const available = cur[0]?.available ?? 0n;
    // quantity or location changed since the snapshot, OR the pallet/spot had any movement after the physical observation
    // (a pallet put away after the count was never "not found": it simply was not there yet)
    if (currentQty !== l.system_qty || lpn.current_location_id !== l.location_id || (observed && (await movedSince(tx, l.lpn_id, l.location_id, observed)))) {
      await tx.count_lines.update({ where: { id: l.id }, data: { status: 'RECOUNT', recount_qty: null, final_qty: null } });
      skipped.push({ line_id: l.id, reason: 'INVENTORY_MOVED_SINCE_COUNT' });
      continue;
    }
    const delta = l.final_qty! - l.system_qty;
    if (delta === 0n) continue;
    let movementId: bigint;
    if (delta > 0n) {
      if (!lpn.current_location_id) {
        skipped.push({ line_id: l.id, reason: 'LPN_WITHOUT_LOCATION' });
        continue;
      }
      movementId = await createInventory(tx, ctx, { movement_type: 'COUNT_ADJUST_IN', to_lpn: lpn, sku_id: l.sku_id, qty: delta, status: 'AVAILABLE', location_id: lpn.current_location_id, reason: `Cycle count ${task.id}`, incident_id: incident.id, reference_type: 'count_task', reference_id: task.id, task_id: task.id });
    } else {
      if (available < -delta) {
        skipped.push({ line_id: l.id, reason: `INSUFFICIENT_AVAILABLE: only ${available} AVAILABLE (rest allocated/locked)` });
        continue;
      }
      movementId = await removeInventory(tx, ctx, { movement_type: 'COUNT_ADJUST_OUT', from_lpn: lpn, sku_id: l.sku_id, qty: -delta, status: 'AVAILABLE', reason: `Cycle count ${task.id}`, incident_id: incident.id, reference_type: 'count_task', reference_id: task.id, task_id: task.id });
    }
    await tx.count_lines.update({ where: { id: l.id }, data: { status: 'ADJUSTED', adjustment_movement_id: movementId } });
    adjusted++;
  }
  const status = skipped.some((s) => s.reason === 'INVENTORY_MOVED_SINCE_COUNT') ? 'RECOUNT' : 'APPROVED';
  await tx.count_tasks.update({ where: { id: task.id }, data: { status, approved_by: ctx.userId, approved_at: new Date(), notes: input.reason } });
  await tx.incidents.update({ where: { id: incident.id }, data: { status: adjusted ? 'RESOLVED' : 'IN_REVIEW', resolution: `${adjusted} ajuste(s) aplicados; ${skipped.length} omitidos`, resolved_by: ctx.userId, resolved_at: new Date() } });
  await audit(tx, ctx, { action: 'count.approve', entity_type: 'count_task', entity_id: task.id, after: { adjusted, skipped, status, created_lpns: created_lpns.map((c) => c.lpn) }, reason: input.reason });
  return { status, adjusted, skipped, created_lpns, incident_id: incident.id };
}


/** Any ledger movement that touched the pallet or the spot after the physical observation: the count no longer describes what is there. */
export async function movedSince(tx: Tx, lpnId: string | null, locationId: string, since: Date): Promise<boolean> {
  const rows = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM inventory_movements
    WHERE occurred_at > ${since.toISOString()}::timestamptz AND (from_location_id = ${locationId}::uuid OR to_location_id = ${locationId}::uuid
      OR (${lpnId}::uuid IS NOT NULL AND (from_lpn_id = ${lpnId}::uuid OR to_lpn_id = ${lpnId}::uuid)))`;
  return (rows[0]?.n ?? 0n) > 0n;
}

// ---------------------------------------------------------------------------
// Physical count imported from a spreadsheet (one row per location + product, optional LPN).
// It becomes an ordinary count task in PENDING_APPROVAL: the supervisor sees every difference, and approval applies
// the same guards as a handheld count — above all, a pallet that moved after the count date is never adjusted.
// ---------------------------------------------------------------------------
const COL_LOCATION = ['ubicacion', 'ubicación', 'location', 'location_code', 'posicion', 'posición', 'loc'];
const COL_SKU = ['sku', 'clave', 'clave wms', 'clave_wms', 'codigo', 'código', 'articulo', 'artículo', 'modelo', 'producto'];
const COL_QTY = ['cantidad', 'qty', 'piezas', 'conteo', 'verificacion', 'verificación', 'contado', 'existencia', 'fisico', 'físico'];
const COL_LPN = ['lpn', 'tarima', 'pallet'];
const pick = (r: Row, names: string[]) => { for (const n of names) if (r[n] !== undefined) return r[n]!; return undefined; };

export interface CountImportInput { rows: Row[]; parse_errors: RowError[]; counted_at: Date; full: boolean; file_name: string; mode: 'VALIDATE' | 'APPLY'; notes?: string }
export interface CountImportLine { location: string; lpn: string | null; sku: string; system: string; counted: string; variance: string; moved_since_count: boolean; note: string | null }

export async function importCount(tx: Tx, ctx: ActorContext, input: CountImportInput) {
  if (input.counted_at.getTime() > Date.now() + 60_000) throw new RuleError('COUNT_IN_FUTURE', 'counted_at cannot be in the future');
  const errors: RowError[] = [...input.parse_errors];
  if (!input.rows.length) throw new RuleError('EMPTY_FILE', 'The file has no rows');
  const sample = input.rows[0]!;
  if (pick(sample, COL_LOCATION) === undefined || pick(sample, COL_SKU) === undefined || pick(sample, COL_QTY) === undefined) {
    throw new RuleError('MISSING_COLUMNS', `Columns required: ubicacion, sku, cantidad (optional lpn). Found: ${Object.keys(sample).filter((k) => k !== '__row').join(', ')}`);
  }
  // resolve every row
  type Counted = { location_id: string; location: string; sku_id: string; sku: string; lpn_id: string | null; lpn: string | null; qty: bigint; rows: number[] };
  const counted = new Map<string, Counted>();
  const locCache = new Map<string, { id: string; code: string; warehouse_id: string; zone_id: string | null } | null>();
  const skuCache = new Map<string, { id: string; code: string } | null>();
  for (const r of input.rows) {
    const rowNo = Number(r.__row ?? 0);
    const locRaw = normalizeLocationCode(pick(r, COL_LOCATION) ?? '');
    const skuRaw = (pick(r, COL_SKU) ?? '').trim();
    const qtyRaw = (pick(r, COL_QTY) ?? '').trim().replace(/,/g, '');
    const lpnRaw = (pick(r, COL_LPN) ?? '').trim().toUpperCase();
    if (!locRaw && !skuRaw && !qtyRaw) continue;
    if (!locRaw) { errors.push({ row: rowNo, column: 'ubicacion', message: 'Ubicación vacía' }); continue; }
    if (!skuRaw) { errors.push({ row: rowNo, column: 'sku', message: 'SKU vacío' }); continue; }
    if (!/^\d+(\.0+)?$/.test(qtyRaw)) { errors.push({ row: rowNo, column: 'cantidad', message: qtyRaw ? `Cantidad inválida "${qtyRaw}"` : 'Cantidad vacía (pon 0 si no hay nada)' }); continue; }
    let loc = locCache.get(locRaw);
    if (loc === undefined) {
      const found = await tx.locations.findFirst({ where: { OR: [{ code: locRaw }, { barcode: locRaw }, { barcode: `LOC-${locRaw}` }] }, select: { id: true, code: true, warehouse_id: true, zone_id: true, is_active: true } });
      loc = found && found.is_active ? found : null;
      locCache.set(locRaw, loc);
    }
    if (!loc) { errors.push({ row: rowNo, column: 'ubicacion', message: `Ubicación desconocida o inactiva: ${locRaw}` }); continue; }
    let sku = skuCache.get(skuRaw);
    if (sku === undefined) {
      try { const f = await resolveImportSku(tx, skuRaw); sku = { id: f.id, code: f.code }; } catch { sku = null; }
      skuCache.set(skuRaw, sku);
    }
    if (!sku) { errors.push({ row: rowNo, column: 'sku', message: `SKU desconocido: ${skuRaw}` }); continue; }
    let lpn: { id: string; code: string } | null = null;
    if (lpnRaw) {
      const f = await tx.lpns.findUnique({ where: { code: lpnRaw }, select: { id: true, code: true, current_location_id: true } });
      if (!f) { errors.push({ row: rowNo, column: 'lpn', message: `LPN desconocido: ${lpnRaw}` }); continue; }
      lpn = f;
    }
    const key = `${loc.id}|${sku.id}|${lpn?.id ?? ''}`;
    const cur = counted.get(key);
    const qty = BigInt(qtyRaw.split('.')[0]!);
    if (cur) { cur.qty += qty; cur.rows.push(rowNo); }
    else counted.set(key, { location_id: loc.id, location: loc.code, sku_id: sku.id, sku: sku.code, lpn_id: lpn?.id ?? null, lpn: lpn?.code ?? null, qty, rows: [rowNo] });
  }
  // scope: the listed locations, plus (full count) every active storage spot in the zones that appear in the file
  const listed = new Set<string>([...counted.values()].map((c) => c.location_id));
  const scope = new Set(listed);
  if (input.full) {
    const zoneIds = [...new Set([...locCache.values()].filter((l): l is NonNullable<typeof l> => !!l && !!l.zone_id).map((l) => l.zone_id!))];
    const more = await tx.locations.findMany({ where: { zone_id: { in: zoneIds }, is_active: true, location_type: { in: ['RESERVE', 'PICKING'] } }, select: { id: true } });
    for (const l of more) scope.add(l.id);
  }
  const scopeIds = [...scope];
  // what the system has on those spots right now (stored pallets only; pallets in flight are reported, not counted)
  const sys = scopeIds.length
    ? await tx.$queryRaw<{ lpn_id: string; lpn: string; location_id: string; location: string; sku_id: string; sku: string; qty: bigint }[]>`
      SELECT l.id AS lpn_id, l.code AS lpn, l.current_location_id AS location_id, loc.code AS location, b.sku_id, s.code AS sku, sum(b.qty)::bigint AS qty
        FROM lpns l JOIN inventory_balances b ON b.lpn_id = l.id AND b.qty > 0 JOIN skus s ON s.id = b.sku_id JOIN locations loc ON loc.id = l.current_location_id
       WHERE l.current_location_id = ANY(${scopeIds}::uuid[]) AND l.status = 'STORED'
       GROUP BY l.id, l.code, l.current_location_id, loc.code, b.sku_id, s.code ORDER BY loc.code, l.code, s.code`
    : [];
  const inFlight = scopeIds.length
    ? await tx.$queryRaw<{ lpn: string; status: string; location: string }[]>`SELECT l.code AS lpn, l.status, loc.code AS location FROM lpns l JOIN locations loc ON loc.id = l.current_location_id
       WHERE l.current_location_id = ANY(${scopeIds}::uuid[]) AND l.status NOT IN ('STORED','CONSUMED','SHIPPED','CANCELLED') AND EXISTS (SELECT 1 FROM inventory_balances b WHERE b.lpn_id = l.id AND b.qty > 0) ORDER BY loc.code`
    : [];
  // match: explicit LPN rows first, then (location, sku) pools spread over the pallets there (largest first, remainder on the last)
  type Line = { location_id: string; location: string; lpn_id: string | null; lpn: string | null; sku_id: string; sku: string; system: bigint; counted: bigint; note: string | null };
  const lines: Line[] = [];
  const used = new Set<string>();
  const byCell = new Map<string, typeof sys>();
  for (const r of sys) { const k = `${r.location_id}|${r.sku_id}`; byCell.set(k, [...(byCell.get(k) ?? []), r]); }
  for (const c of counted.values()) {
    if (!c.lpn_id) continue;
    const r = sys.find((x) => x.lpn_id === c.lpn_id && x.sku_id === c.sku_id);
    used.add(c.lpn_id + '|' + c.sku_id);
    const note = r && r.location_id !== c.location_id ? `El WMS tiene la tarima en ${r.location}` : null;
    lines.push({ location_id: c.location_id, location: c.location, lpn_id: c.lpn_id, lpn: c.lpn, sku_id: c.sku_id, sku: c.sku, system: r?.qty ?? 0n, counted: c.qty, note: c.rows.length > 1 ? `Suma de ${c.rows.length} filas` : note });
  }
  for (const c of counted.values()) {
    if (c.lpn_id) continue;
    const pallets = (byCell.get(`${c.location_id}|${c.sku_id}`) ?? []).filter((r) => !used.has(r.lpn_id + '|' + r.sku_id)).sort((a, b) => (a.qty > b.qty ? -1 : 1));
    const multi = c.rows.length > 1 ? `Suma de ${c.rows.length} filas` : null;
    if (!pallets.length) {
      lines.push({ location_id: c.location_id, location: c.location, lpn_id: null, lpn: null, sku_id: c.sku_id, sku: c.sku, system: 0n, counted: c.qty, note: multi ?? 'Sin tarima en el WMS: se creará una nueva al aprobar' });
      continue;
    }
    let pool = c.qty;
    pallets.forEach((r, i) => {
      used.add(r.lpn_id + '|' + r.sku_id);
      const take = i === pallets.length - 1 ? pool : pool < r.qty ? pool : r.qty;
      pool -= take;
      lines.push({ location_id: r.location_id, location: r.location, lpn_id: r.lpn_id, lpn: r.lpn, sku_id: r.sku_id, sku: r.sku, system: r.qty, counted: take, note: pallets.length > 1 ? `Conteo repartido entre ${pallets.length} tarimas` : multi });
    });
  }
  for (const r of sys) {
    if (used.has(r.lpn_id + '|' + r.sku_id)) continue;
    // in scope but not in the file: nobody saw it
    lines.push({ location_id: r.location_id, location: r.location, lpn_id: r.lpn_id, lpn: r.lpn, sku_id: r.sku_id, sku: r.sku, system: r.qty, counted: 0n, note: listed.has(r.location_id) ? 'No aparece en el archivo' : 'Ubicación no listada (conteo completo)' });
  }
  const out: CountImportLine[] = [];
  let moved = 0;
  for (const l of lines) {
    const m = await movedSince(tx, l.lpn_id, l.location_id, input.counted_at);
    if (m) moved++;
    out.push({ location: l.location, lpn: l.lpn, sku: l.sku, system: l.system.toString(), counted: l.counted.toString(), variance: (l.counted - l.system).toString(), moved_since_count: m, note: l.note });
  }
  const variances = lines.filter((l) => l.counted !== l.system).length;
  const summary = {
    rows: input.rows.length,
    errors: errors.length,
    locations: scopeIds.length,
    lines: lines.length,
    matched: lines.length - variances,
    variances,
    moved_since_count: moved,
    new_pallets: lines.filter((l) => !l.lpn_id && l.counted > 0n).length,
    not_found: lines.filter((l) => l.lpn_id && l.counted === 0n && l.system > 0n).length,
    total_counted: lines.reduce((a, l) => a + l.counted, 0n).toString(),
    total_system: lines.reduce((a, l) => a + l.system, 0n).toString(),
  };
  if (input.mode === 'VALIDATE') return { status: 'VALIDATED' as const, task_id: null, summary, errors, lines: out, in_flight: inFlight };
  if (errors.length) throw new RuleError('IMPORT_ERRORS', `${errors.length} fila(s) con error; corrige el archivo antes de aplicar`);
  if (!lines.length) throw new RuleError('NOTHING_TO_COUNT', 'No hay líneas que contar');
  const status = variances ? 'PENDING_APPROVAL' : 'CLOSED';
  const task = await tx.count_tasks.create({
    data: {
      count_type: 'IMPORT', scope: { location_ids: scopeIds }, status, is_blind: false, created_by: ctx.userId, completed_at: new Date(),
      notes: [`Importado de ${input.file_name}`, `conteo del ${input.counted_at.toISOString().slice(0, 16).replace('T', ' ')} UTC`, input.full ? 'conteo completo' : 'solo ubicaciones listadas', input.notes ?? ''].filter(Boolean).join(' · ').slice(0, 2000),
    },
  });
  await tx.count_lines.createMany({
    data: lines.map((l) => ({ count_task_id: task.id, location_id: l.location_id, lpn_id: l.lpn_id, sku_id: l.sku_id, system_qty: l.system, counted_qty: l.counted, final_qty: l.counted, variance: l.counted - l.system, counted_by: ctx.userId, counted_at: input.counted_at, status: l.counted === l.system ? 'MATCHED' : 'VARIANCE' })),
  });
  await audit(tx, ctx, { action: 'count.import', entity_type: 'count_task', entity_id: task.id, after: { file: input.file_name, counted_at: input.counted_at.toISOString(), full: input.full, ...summary }, reason: input.notes ?? null });
  return { status, task_id: task.id, summary, errors, lines: out, in_flight: inFlight };
}
