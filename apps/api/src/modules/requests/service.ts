// Requests the floor staff leave for a supervisor/administrator to decide. Today: pallet re-receipts and counts with
// differences (count tasks waiting in RECOUNT or PENDING_APPROVAL). The office page lists them with the figures the
// operator captured and lets the approver apply or reject each one; nothing is adjusted without that decision.
import type { Tx } from '../../db.js';
import { ForbiddenError, NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';
import { approveCount, movedSince } from '../counts/service.js';

const RE_RECEIPT = /^Re-recepción de tarima (PLT-\d{4}-\d{8}): ?/;

export interface RequestLine {
  line_id: string;
  location: string;
  lpn: string | null;
  sku: string;
  description: string;
  /** what the system had when the operator counted */
  system_qty: string;
  /** what the operator says is really there */
  proposed_qty: string;
  delta: string;
  /** what the pallet holds right now */
  current_qty: string;
  /** false when approving would not adjust this line (the pallet moved or changed after the count) */
  applicable: boolean;
  why: string | null;
}

async function linesOf(tx: Tx, taskId: string): Promise<RequestLine[]> {
  const rows = await tx.$queryRaw<{ id: string; location_id: string; location: string; lpn_id: string | null; lpn: string | null; lpn_status: string | null; lpn_location_id: string | null; sku_id: string; sku: string; description: string; system_qty: bigint; counted_qty: bigint | null; recount_qty: bigint | null; final_qty: bigint | null; status: string; counted_at: Date | null; recounted_at: Date | null }[]>`
    SELECT l.id, l.location_id, loc.code AS location, l.lpn_id, p.code AS lpn, p.status AS lpn_status, p.current_location_id AS lpn_location_id, l.sku_id, s.code AS sku, s.description,
           l.system_qty, l.counted_qty, l.recount_qty, l.final_qty, l.status, l.counted_at, l.recounted_at
      FROM count_lines l JOIN locations loc ON loc.id = l.location_id JOIN skus s ON s.id = l.sku_id LEFT JOIN lpns p ON p.id = l.lpn_id
     WHERE l.count_task_id = ${taskId}::uuid AND l.status IN ('RECOUNT','VARIANCE')
     ORDER BY loc.code, s.code`;
  const out: RequestLine[] = [];
  for (const r of rows) {
    const proposed = r.final_qty ?? r.recount_qty ?? r.counted_qty ?? 0n;
    let current = 0n;
    if (r.lpn_id) {
      const cur = await tx.$queryRaw<{ qty: bigint }[]>`SELECT COALESCE(sum(qty), 0)::bigint AS qty FROM inventory_balances WHERE lpn_id = ${r.lpn_id}::uuid AND sku_id = ${r.sku_id}::uuid`;
      current = cur[0]?.qty ?? 0n;
    }
    const observed = r.recounted_at ?? r.counted_at;
    let why: string | null = null;
    if (r.lpn_id && r.lpn_status !== 'STORED') why = `La tarima está ${r.lpn_status}: ya no se puede ajustar`;
    else if (r.lpn_id && r.lpn_location_id !== r.location_id) why = 'La tarima ya no está en la ubicación donde se contó';
    else if (r.lpn_id && current !== r.system_qty) why = `La tarima cambió después del conteo (tenía ${r.system_qty}, hoy tiene ${current})`;
    else if (observed && (await movedSince(tx, r.lpn_id, r.location_id, observed))) why = 'Hubo movimientos en la tarima o en la ubicación después del conteo';
    out.push({ line_id: r.id, location: r.location, lpn: r.lpn, sku: r.sku, description: r.description, system_qty: r.system_qty.toString(), proposed_qty: proposed.toString(), delta: (proposed - r.system_qty).toString(), current_qty: current.toString(), applicable: why === null, why });
  }
  return out;
}

/** Everything waiting for a decision, newest first, plus counters of the other things that need attention in the office. */
export async function listRequests(tx: Tx) {
  const tasks = await tx.$queryRaw<{ id: string; status: string; notes: string | null; created_at: Date; username: string | null; full_name: string | null }[]>`
    SELECT t.id, t.status, t.notes, t.created_at, u.username, u.full_name
      FROM count_tasks t LEFT JOIN users u ON u.id = t.created_by
     WHERE t.status IN ('RECOUNT','PENDING_APPROVAL') ORDER BY t.created_at DESC LIMIT 300`;
  const requests = [];
  for (const t of tasks) {
    const m = t.notes ? RE_RECEIPT.exec(t.notes) : null;
    const lines = await linesOf(tx, t.id);
    requests.push({
      id: t.id,
      kind: m ? ('RE_RECEIPT' as const) : ('COUNT' as const),
      status: t.status,
      lpn: m?.[1] ?? null,
      purpose: m ? t.notes!.replace(RE_RECEIPT, '') : t.notes,
      requested_by: t.full_name ?? t.username,
      requested_by_username: t.username,
      created_at: t.created_at,
      lines,
      applicable: lines.length > 0 && lines.every((l) => l.applicable),
    });
  }
  const other = await tx.$queryRaw<{ incidents: bigint; receipts: bigint; returns: bigint; assemblies: bigint }[]>`
    SELECT (SELECT count(*) FROM incidents WHERE status IN ('OPEN','IN_REVIEW'))::bigint AS incidents,
           (SELECT count(*) FROM receipts WHERE status IN ('COMPLETED','WITH_INCIDENT'))::bigint AS receipts,
           (SELECT count(*) FROM returns WHERE status = 'INSPECTING')::bigint AS returns,
           (SELECT count(*) FROM assembly_orders WHERE status = 'IN_PROGRESS')::bigint AS assemblies`;
  const o = other[0]!;
  return { requests, pending: requests.length, other: { incidents_open: Number(o.incidents), receipts_to_close: Number(o.receipts), returns_inspecting: Number(o.returns), assemblies_open: Number(o.assemblies) } };
}

/** Number of requests waiting (menu badge). */
export async function pendingRequests(tx: Tx): Promise<number> {
  const r = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM count_tasks WHERE status IN ('RECOUNT','PENDING_APPROVAL')`;
  return Number(r[0]?.n ?? 0n);
}

/**
 * The approver decides on a request. A count still waiting for a second count (RECOUNT) is decided on the operator's
 * figures: the approver's review replaces the recount. Approval goes through the normal count approval, so a pallet
 * that moved after the count is never adjusted (the request stays open, flagged, to be rejected or counted again).
 */
export async function decideRequest(tx: Tx, ctx: ActorContext, id: string, input: { decision: 'APPROVE' | 'REJECT'; reason: string }) {
  if (!ctx.permissions.has('counts.approve')) throw new ForbiddenError('Deciding requests requires counts.approve');
  const rows = await tx.$queryRaw<{ id: string; status: string; notes: string | null }[]>`SELECT id, status, notes FROM count_tasks WHERE id = ${id}::uuid FOR UPDATE`;
  const task = rows[0];
  if (!task) throw new NotFoundError('request', id);
  if (!['RECOUNT', 'PENDING_APPROVAL'].includes(task.status)) throw new RuleError('REQUEST_STATUS', `La solicitud ya está ${task.status}`);
  if (task.status === 'RECOUNT') {
    // the operator's own figures become the final ones (no second count): the approver takes that responsibility
    const pend = await tx.count_lines.findMany({ where: { count_task_id: id, status: 'RECOUNT' } });
    for (const l of pend) {
      const final = l.recount_qty ?? l.counted_qty ?? 0n;
      const variance = final - l.system_qty;
      await tx.count_lines.update({ where: { id: l.id }, data: { final_qty: final, variance, status: variance === 0n ? 'MATCHED' : 'VARIANCE' } });
    }
    await tx.count_tasks.update({ where: { id }, data: { status: 'PENDING_APPROVAL', completed_at: new Date() } });
    await audit(tx, ctx, { action: 'request.direct_review', entity_type: 'count_task', entity_id: id, after: { lines: pend.length, decision: input.decision }, reason: input.reason });
  }
  const res = await approveCount(tx, ctx, { count_task_id: id, decision: input.decision, reason: input.reason });
  // keep what the operator asked for; the decision is appended instead of replacing it
  const verdict = input.decision === 'REJECT' ? 'RECHAZADA' : res.status === 'APPROVED' ? 'APROBADA' : 'NO APLICADA';
  await tx.count_tasks.update({ where: { id }, data: { notes: `${task.notes ?? ''}\n[${verdict} por ${ctx.username}] ${input.reason}`.trim() } });
  return { id, decision: input.decision, status: res.status, adjusted: res.adjusted, skipped: res.skipped };
}
