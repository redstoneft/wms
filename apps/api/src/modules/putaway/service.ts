import type { Tx } from '../../db.js';
import { ConflictError, NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';
import { lockLocation, lockLocationByBarcode, lockLpn, lockLpnByCode, moveLpn, type LocationRow, type LpnRow } from '../../inventory/ledger.js';
import { checkLocationAccepts, evaluateFit, locationOccupancy, lpnProfile, type LpnProfile } from '../../inventory/location-rules.js';
import { consumeAuthorization } from '../authorizations/routes.js';

// ---------------------------------------------------------------------
// Slotting engine: scores every candidate location and records WHY.
// ---------------------------------------------------------------------

export interface SlottingWeights {
  same_sku: number; // prefer locations/racks that already hold this SKU
  abc_proximity: number; // A items close to picking (low pick_sequence / low levels)
  zone_match: number; // zone type STORAGE for reserve pallets
  fill_rack: number; // prefer racks already partially used (consolidation)
  level_low_heavy: number; // heavy pallets on low levels
  family_affinity: number; // same family nearby
}

export const DEFAULT_WEIGHTS: SlottingWeights = {
  same_sku: 30,
  abc_proximity: 20,
  zone_match: 25,
  fill_rack: 10,
  level_low_heavy: 15,
  family_affinity: 10,
};

interface Candidate {
  id: string;
  code: string;
  location_type: string;
  zone_type: string | null;
  rack_id: string | null;
  level: number | null;
  pick_sequence: number | null;
  pallet_capacity: number;
  max_weight_kg: string;
  height_m: string;
  restrictions: Record<string, unknown> | null;
  admin_status: string;
  is_active: boolean;
  lpn_count: number;
  reserved_count: number;
  weight_kg: string;
  has_same_sku: boolean;
  rack_has_same_sku: boolean;
  rack_lpn_count: number;
  has_same_family: boolean;
  compat_groups: (string | null)[] | null;
}

export interface SlottingExplanation {
  chosen: { location_id: string; code: string; score: number } | null;
  factors: { factor: string; points: number; detail: string }[];
  rejected_sample: { code: string; reasons: string[] }[];
  candidates_evaluated: number;
  weights: SlottingWeights;
  alternatives: { code: string; score: number }[];
}

async function loadWeights(tx: Tx, profile: LpnProfile, abc: string): Promise<SlottingWeights> {
  const rules = await tx.slotting_rules.findMany({ where: { is_active: true }, orderBy: { priority: 'asc' } });
  for (const r of rules) {
    const cond = (r.conditions ?? {}) as { family?: string; abc_class?: string };
    if (cond.family && !profile.families.includes(cond.family)) continue;
    if (cond.abc_class && cond.abc_class !== abc) continue;
    return { ...DEFAULT_WEIGHTS, ...(r.weights as Partial<SlottingWeights>) };
  }
  return DEFAULT_WEIGHTS;
}

/**
 * Computes the best storage location for an LPN. Pure read (no locks) — the
 * actual reservation happens when the task is created, and the fit is
 * re-validated with locks at confirmation time.
 */
export async function suggestLocation(tx: Tx, lpn: LpnRow): Promise<SlottingExplanation> {
  const profile = await lpnProfile(tx, lpn);
  if (profile.sku_ids.length === 0) throw new RuleError('EMPTY_LPN', `LPN ${lpn.code} has no inventory`);
  const skuMeta = await tx.$queryRaw<{ abc_class: string }[]>`SELECT abc_class FROM skus WHERE id = ANY(${profile.sku_ids}::uuid[]) ORDER BY abc_class LIMIT 1`;
  const abc = skuMeta[0]?.abc_class ?? 'C';
  const weights = await loadWeights(tx, profile, abc);
  const families = profile.families.filter((f): f is string => !!f);

  const candidates = await tx.$queryRaw<Candidate[]>`
    WITH occ AS (
      SELECT l.current_location_id AS location_id, count(DISTINCT l.id) AS lpn_count, sum(b.qty * s.unit_weight_kg) AS weight_kg,
             bool_or(b.sku_id = ANY(${profile.sku_ids}::uuid[])) AS has_same_sku,
             bool_or(s.family = ANY(${families}::text[])) AS has_same_family,
             array_agg(DISTINCT s.compatibility_group) AS compat_groups
        FROM lpns l JOIN inventory_balances b ON b.lpn_id = l.id AND b.qty > 0 JOIN skus s ON s.id = b.sku_id
       WHERE l.current_location_id IS NOT NULL AND l.id <> ${lpn.id}::uuid
       GROUP BY l.current_location_id
    ), res AS (
      SELECT x.location_id, count(*) AS reserved_count FROM (
        SELECT suggested_location_id AS location_id FROM putaway_tasks WHERE status IN ('PENDING','ASSIGNED','IN_PROGRESS') AND lpn_id <> ${lpn.id}::uuid AND suggested_location_id IS NOT NULL
        UNION ALL SELECT to_location_id FROM transfers WHERE status = 'IN_TRANSIT' AND lpn_id <> ${lpn.id}::uuid
      ) x GROUP BY x.location_id
    ), rack_stats AS (
      SELECT loc.rack_id, count(DISTINCT l.id) AS rack_lpn_count, bool_or(b.sku_id = ANY(${profile.sku_ids}::uuid[])) AS rack_has_same_sku
        FROM locations loc JOIN lpns l ON l.current_location_id = loc.id JOIN inventory_balances b ON b.lpn_id = l.id AND b.qty > 0
       WHERE loc.rack_id IS NOT NULL GROUP BY loc.rack_id
    )
    SELECT loc.id, loc.code, loc.location_type, z.zone_type, loc.rack_id, loc.level, loc.pick_sequence, loc.pallet_capacity,
           loc.max_weight_kg::text AS max_weight_kg, loc.height_m::text AS height_m, loc.restrictions, loc.admin_status, loc.is_active,
           COALESCE(occ.lpn_count, 0)::int AS lpn_count, COALESCE(res.reserved_count, 0)::int AS reserved_count,
           COALESCE(occ.weight_kg, 0)::text AS weight_kg, COALESCE(occ.has_same_sku, false) AS has_same_sku,
           COALESCE(rs.rack_has_same_sku, false) AS rack_has_same_sku, COALESCE(rs.rack_lpn_count, 0)::int AS rack_lpn_count,
           COALESCE(occ.has_same_family, false) AS has_same_family, occ.compat_groups
      FROM locations loc
      LEFT JOIN zones z ON z.id = loc.zone_id
      LEFT JOIN occ ON occ.location_id = loc.id
      LEFT JOIN res ON res.location_id = loc.id
      LEFT JOIN rack_stats rs ON rs.rack_id = loc.rack_id
     WHERE loc.warehouse_id = ${lpn.warehouse_id}::uuid AND loc.is_active AND loc.admin_status = 'ACTIVE'
       AND loc.location_type IN ('RESERVE','PICKING')
       AND COALESCE(occ.lpn_count, 0) + COALESCE(res.reserved_count, 0) < loc.pallet_capacity`;

  const rejected: { code: string; reasons: string[] }[] = [];
  const scored: { c: Candidate; score: number; factors: { factor: string; points: number; detail: string }[] }[] = [];
  for (const c of candidates) {
    const fit = evaluateFit(
      { ...c, warehouse_id: lpn.warehouse_id, zone_id: null, barcode: '', restrictions: c.restrictions } as unknown as LocationRow,
      { lpn_count: c.lpn_count, reserved_count: c.reserved_count, weight_kg: Number(c.weight_kg), lpn_ids: [], sku_ids: [], compatibility_groups: c.compat_groups ?? [] },
      profile,
    );
    if (!fit.ok) {
      if (rejected.length < 10) rejected.push({ code: c.code, reasons: fit.reasons });
      continue;
    }
    const factors: { factor: string; points: number; detail: string }[] = [];
    let score = 0;
    if (c.has_same_sku) {
      factors.push({ factor: 'same_sku', points: weights.same_sku, detail: 'location already holds this SKU' });
      score += weights.same_sku;
    } else if (c.rack_has_same_sku) {
      const p = Math.round(weights.same_sku * 0.6);
      factors.push({ factor: 'same_sku_rack', points: p, detail: 'rack already holds this SKU' });
      score += p;
    }
    // ABC: A wants low pick_sequence & low level; C tolerates far/high
    if (c.pick_sequence !== null) {
      const rank = Math.min(1, c.pick_sequence / 5_000_000); // 0 near .. 1 far
      const want = abc === 'A' ? 1 - rank : abc === 'B' ? 1 - Math.abs(rank - 0.5) * 2 : rank;
      const p = Math.round(weights.abc_proximity * want);
      factors.push({ factor: 'abc_proximity', points: p, detail: `class ${abc}, route rank ${rank.toFixed(2)}` });
      score += p;
    }
    if (c.zone_type === 'STORAGE' && c.location_type === 'RESERVE') {
      factors.push({ factor: 'zone_match', points: weights.zone_match, detail: 'reserve storage zone' });
      score += weights.zone_match;
    } else if (c.location_type === 'PICKING') {
      const p = -Math.round(weights.zone_match / 2);
      factors.push({ factor: 'zone_match', points: p, detail: 'picking face reserved for replenishment' });
      score += p;
    }
    if (c.rack_lpn_count > 0) {
      const p = Math.round(weights.fill_rack * Math.min(1, c.rack_lpn_count / 10));
      factors.push({ factor: 'fill_rack', points: p, detail: `rack has ${c.rack_lpn_count} pallets (consolidation)` });
      score += p;
    }
    if (c.level !== null) {
      const heavy = profile.weight_kg >= 500;
      const p = heavy ? Math.round(weights.level_low_heavy * (1 / c.level)) : Math.round(weights.level_low_heavy * 0.3);
      factors.push({ factor: 'level_low_heavy', points: p, detail: `level ${c.level}, pallet ${Math.round(profile.weight_kg)} kg` });
      score += p;
    }
    if (c.has_same_family) {
      factors.push({ factor: 'family_affinity', points: weights.family_affinity, detail: 'neighbours share product family' });
      score += weights.family_affinity;
    }
    scored.push({ c, score, factors });
  }
  scored.sort((a, b) => b.score - a.score || a.c.code.localeCompare(b.c.code));
  const best = scored[0];
  return {
    chosen: best ? { location_id: best.c.id, code: best.c.code, score: best.score } : null,
    factors: best?.factors ?? [],
    rejected_sample: rejected,
    candidates_evaluated: candidates.length,
    weights,
    alternatives: scored.slice(1, 4).map((s) => ({ code: s.c.code, score: s.score })),
  };
}

// ---------------------------------------------------------------------
// Put-away tasks
// ---------------------------------------------------------------------

/** Put-away only applies to pallets waiting in an inbound area (RECEIVING/RETURNS) whose stock is free. Storage-to-storage moves go through transfers. */
async function assertPutawayEligible(tx: Tx, lpn: LpnRow, opts: { skipLocationCheck?: boolean } = {}) {
  if (lpn.current_location_id && !opts.skipLocationCheck) {
    const loc = await tx.locations.findUnique({ where: { id: lpn.current_location_id }, select: { location_type: true, code: true } });
    if (loc && !['RECEIVING', 'RETURNS'].includes(loc.location_type)) {
      throw new RuleError('LPN_ALREADY_STORED', `LPN ${lpn.code} is already stored at ${loc.code}; use a transfer to move it`);
    }
  }
  const busy = await tx.$queryRaw<{ status: string }[]>`SELECT DISTINCT status FROM inventory_balances WHERE lpn_id = ${lpn.id}::uuid AND qty > 0 AND status IN ('ALLOCATED','PICKING','STAGING','LOADED','IN_TRANSFER')`;
  if (busy.length) throw new RuleError('LPN_NOT_FREE', `LPN ${lpn.code} has inventory in ${busy.map((b) => b.status).join(', ')} and cannot be put away`);
}

export async function createPutawayTask(tx: Tx, ctx: ActorContext, lpn: LpnRow, opts: { allowStoredLocation?: boolean } = {}) {
  const existing = await tx.putaway_tasks.findFirst({ where: { lpn_id: lpn.id, status: { in: ['PENDING', 'ASSIGNED', 'IN_PROGRESS'] } } });
  if (existing) return existing;
  // allowStoredLocation: legitimate flows that leave a pallet in an aisle (e.g. picked goods returned to stock on cancellation)
  await assertPutawayEligible(tx, lpn, { skipLocationCheck: opts.allowStoredLocation });
  const suggestion = await suggestLocation(tx, lpn);
  const task = await tx.putaway_tasks.create({
    data: {
      lpn_id: lpn.id,
      suggested_location_id: suggestion.chosen?.location_id ?? null,
      status: 'PENDING',
      explanation: JSON.parse(JSON.stringify(suggestion)),
    },
  });
  await audit(tx, ctx, { action: 'putaway.task_created', entity_type: 'putaway_task', entity_id: task.id, after: { lpn: lpn.code, suggested: suggestion.chosen?.code ?? null, score: suggestion.chosen?.score } });
  return task;
}

/** Operator scans an LPN: returns the task with the target location (and starts it). */
export async function startPutaway(tx: Tx, ctx: ActorContext, lpnCode: string) {
  const lpn = await lockLpnByCode(tx, lpnCode);
  if (lpn.status !== 'STORED' && lpn.status !== 'OPEN') throw new RuleError('LPN_STATUS', `LPN ${lpn.code} is ${lpn.status}; only stored pallets can be put away`);
  let task = await tx.putaway_tasks.findFirst({ where: { lpn_id: lpn.id, status: { in: ['PENDING', 'ASSIGNED', 'IN_PROGRESS'] } } });
  // an existing task was created by a legitimate flow (receiving close, returns, cancelled picking): only the stock-status rule applies
  await assertPutawayEligible(tx, lpn, { skipLocationCheck: !!task });
  if (!task) {
    if (lpn.status === 'OPEN') throw new RuleError('LPN_NOT_CLOSED', `LPN ${lpn.code} is still open in receiving; close it first`);
    task = await createPutawayTask(tx, ctx, lpn);
  }
  if (task.assigned_to && task.assigned_to !== ctx.userId && task.status === 'IN_PROGRESS') {
    throw new ConflictError('TASK_TAKEN', 'Another operator is already moving this pallet');
  }
  if (!task.suggested_location_id) {
    // try again — maybe space freed up
    const s = await suggestLocation(tx, lpn);
    if (!s.chosen) throw new RuleError('NO_LOCATION_AVAILABLE', `No location can accept LPN ${lpn.code}`, { explanation: s });
    task = await tx.putaway_tasks.update({ where: { id: task.id }, data: { suggested_location_id: s.chosen.location_id, explanation: JSON.parse(JSON.stringify(s)) } });
  }
  task = await tx.putaway_tasks.update({ where: { id: task.id }, data: { status: 'IN_PROGRESS', assigned_to: ctx.userId, started_at: task.started_at ?? new Date(), version: { increment: 1 } } });
  const target = await tx.locations.findUnique({ where: { id: task.suggested_location_id! } });
  const contents = await tx.$queryRaw<{ sku_code: string; description: string; qty: bigint }[]>`
    SELECT s.code AS sku_code, s.description, sum(b.qty)::bigint AS qty FROM inventory_balances b JOIN skus s ON s.id = b.sku_id WHERE b.lpn_id = ${lpn.id}::uuid AND b.qty > 0 GROUP BY s.code, s.description`;
  await audit(tx, ctx, { action: 'putaway.start', entity_type: 'putaway_task', entity_id: task.id, after: { lpn: lpn.code, target: target?.code } });
  return { task, lpn: { id: lpn.id, code: lpn.code, current_location_id: lpn.current_location_id }, target: target ? { id: target.id, code: target.code, barcode: target.barcode } : null, contents };
}

/**
 * Operator scans the destination. If it differs from the suggestion the move
 * is REJECTED unless a supervisor authorization for this task is provided.
 * The location is re-validated under lock (capacity, weight, compatibility).
 */
export async function confirmPutaway(
  tx: Tx,
  ctx: ActorContext,
  input: { task_id: string; lpn_code: string; location_barcode: string; override_reason?: string; authorization_id?: string },
) {
  const taskRows = await tx.$queryRaw<{ id: string; lpn_id: string; suggested_location_id: string | null; status: string; assigned_to: string | null }[]>`
    SELECT id, lpn_id, suggested_location_id, status, assigned_to FROM putaway_tasks WHERE id = ${input.task_id}::uuid FOR UPDATE`;
  const task = taskRows[0];
  if (!task) throw new NotFoundError('putaway task', input.task_id);
  if (task.status === 'COMPLETED') throw new ConflictError('TASK_COMPLETED', 'This put-away was already confirmed');
  if (task.status === 'CANCELLED') throw new RuleError('TASK_CANCELLED', 'Task was cancelled');

  const lpn = await lockLpn(tx, task.lpn_id);
  if (lpn.code !== input.lpn_code.trim().toUpperCase()) throw new RuleError('WRONG_LPN', `Scanned LPN ${input.lpn_code} does not match task LPN ${lpn.code}`);
  await assertPutawayEligible(tx, lpn, { skipLocationCheck: true });
  const scanned = await lockLocationByBarcode(tx, input.location_barcode);

  let overrideBy: string | null = null;
  let overrideReason: string | null = null;
  if (scanned.id !== task.suggested_location_id) {
    if (!input.authorization_id) {
      const suggested = task.suggested_location_id ? await tx.locations.findUnique({ where: { id: task.suggested_location_id } }) : null;
      throw new RuleError('WRONG_LOCATION', `UBICACIÓN INCORRECTA: expected ${suggested?.code ?? '?'}, scanned ${scanned.code}`, {
        expected: suggested?.code ?? null,
        scanned: scanned.code,
        hint: 'A supervisor authorization (PUTAWAY_LOCATION_OVERRIDE) is required to store the pallet elsewhere',
      });
    }
    const auth = await consumeAuthorization(tx, input.authorization_id, { exception_type: 'PUTAWAY_LOCATION_OVERRIDE', entity_type: 'putaway_task', entity_id: task.id }, ctx);
    overrideBy = auth.supervisor_id;
    overrideReason = input.override_reason ?? auth.reason;
    if (!overrideReason) throw new RuleError('REASON_REQUIRED', 'Override requires a reason');
  }

  const fit = await checkLocationAccepts(tx, scanned, lpn);
  if (!fit.ok) throw new RuleError('LOCATION_REJECTED', `Location ${scanned.code} cannot accept LPN ${lpn.code}: ${fit.reasons.join(', ')}`, fit);
  if (scanned.location_type !== 'RESERVE' && scanned.location_type !== 'PICKING') {
    throw new RuleError('LOCATION_TYPE', `Location ${scanned.code} is ${scanned.location_type}; put-away requires a storage location`);
  }

  const movementIds = await moveLpn(tx, ctx, {
    movement_type: 'PUTAWAY',
    lpn,
    to_location_id: scanned.id,
    task_id: task.id,
    reference_type: 'putaway_task',
    reference_id: task.id,
    reason: overrideReason,
  });
  await tx.putaway_tasks.update({
    where: { id: task.id },
    data: { status: 'COMPLETED', final_location_id: scanned.id, completed_at: new Date(), override_by: overrideBy, override_reason: overrideReason, assigned_to: ctx.userId, version: { increment: 1 } },
  });
  await tx.lpns.update({ where: { id: lpn.id }, data: { status: 'STORED', lpn_type: 'STORAGE' } });
  await audit(tx, ctx, {
    action: overrideBy ? 'putaway.confirm_override' : 'putaway.confirm',
    entity_type: 'lpn',
    entity_id: lpn.id,
    before: { location_id: lpn.current_location_id },
    after: { location: scanned.code, movements: movementIds.map(String) },
    reason: overrideReason,
  });
  return { lpn_code: lpn.code, location: scanned.code, movements: movementIds, overridden: !!overrideBy };
}

export async function cancelPutaway(tx: Tx, ctx: ActorContext, taskId: string, reason: string) {
  const t = await tx.putaway_tasks.findUnique({ where: { id: taskId } });
  if (!t) throw new NotFoundError('putaway task', taskId);
  if (t.status === 'COMPLETED') throw new RuleError('TASK_COMPLETED', 'Completed tasks cannot be cancelled');
  await tx.putaway_tasks.update({ where: { id: taskId }, data: { status: 'CANCELLED' } });
  await audit(tx, ctx, { action: 'putaway.cancel', entity_type: 'putaway_task', entity_id: taskId, reason });
  return { ok: true };
}

/** Re-runs the engine for a pending task (e.g. the location got blocked meanwhile). */
export async function resuggest(tx: Tx, ctx: ActorContext, taskId: string) {
  const t = await tx.putaway_tasks.findUnique({ where: { id: taskId } });
  if (!t) throw new NotFoundError('putaway task', taskId);
  if (!['PENDING', 'ASSIGNED', 'IN_PROGRESS'].includes(t.status)) throw new RuleError('TASK_STATUS', `Task is ${t.status}`);
  const lpn = await lockLpn(tx, t.lpn_id);
  const s = await suggestLocation(tx, lpn);
  const updated = await tx.putaway_tasks.update({ where: { id: taskId }, data: { suggested_location_id: s.chosen?.location_id ?? null, explanation: JSON.parse(JSON.stringify(s)) } });
  await audit(tx, ctx, { action: 'putaway.resuggest', entity_type: 'putaway_task', entity_id: taskId, before: { suggested: t.suggested_location_id }, after: { suggested: s.chosen?.code ?? null } });
  return { task: updated, explanation: s };
}

export { lockLocation, locationOccupancy };
