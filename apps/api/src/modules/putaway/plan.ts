// Put-away planned per batch: every pallet that came from one receipt or one assembly order, on one screen, each with
// its destination; closing puts them all away without scanning; labels only on request.
import { Prisma } from '../../generated/prisma/client.js';
import { getDb, withTx } from '../../db.js';
import { NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';
import { printLabel } from '../labels/service.js';
import { confirmPutaway } from './service.js';

export type BatchKind = 'RECEIPT' | 'ASSEMBLY';
const PENDING = Prisma.sql`EXISTS (SELECT 1 FROM putaway_tasks t WHERE t.lpn_id = l.id AND t.status IN ('PENDING','ASSIGNED','IN_PROGRESS'))`;

function lpnFilter(kind: BatchKind, id: string) {
  return kind === 'RECEIPT' ? Prisma.sql`l.receipt_id = ${id}::uuid` : Prisma.sql`EXISTS (SELECT 1 FROM assembly_outputs ao WHERE ao.lpn_id = l.id AND ao.order_id = ${id}::uuid)`;
}

async function batchHeader(kind: BatchKind, id: string) {
  const db = getDb();
  if (kind === 'RECEIPT') {
    const r = await db.receipts.findUnique({ where: { id }, select: { id: true, receipt_number: true, status: true } });
    if (!r) throw new NotFoundError('receipt', id);
    return { kind, id: r.id, number: r.receipt_number, status: r.status };
  }
  const a = await db.assembly_orders.findUnique({ where: { id }, select: { id: true, code: true, status: true } });
  if (!a) throw new NotFoundError('assembly order', id);
  return { kind, id: a.id, number: a.code, status: a.status };
}

/** Receipts and assembly orders that still have pallets waiting for put-away. */
export async function listBatches(includeTraining: boolean) {
  const db = getDb();
  const rows = await db.$queryRaw<{ kind: BatchKind; id: string; number: string; status: string; label: string | null; closed_at: Date | null; pending: bigint; total: bigint }[]>`
    SELECT x.kind, x.id, x.number, x.status, x.label, x.closed_at, x.pending, x.total FROM (
      SELECT 'RECEIPT'::text AS kind, r.id, r.receipt_number AS number, r.status, c.container_number AS label, r.closed_at, r.created_at,
             count(*) FILTER (WHERE ${PENDING})::bigint AS pending, count(*)::bigint AS total
        FROM receipts r JOIN lpns l ON l.receipt_id = r.id LEFT JOIN containers c ON c.id = r.container_id
       WHERE r.status <> 'CANCELLED' AND l.status IN ('OPEN','STORED') AND (${includeTraining}::boolean OR r.is_training = false)
       GROUP BY r.id, c.container_number
      UNION ALL
      SELECT 'ASSEMBLY'::text AS kind, a.id, a.code AS number, a.status, s.code AS label, a.completed_at AS closed_at, a.created_at,
             count(*) FILTER (WHERE ${PENDING})::bigint AS pending, count(*)::bigint AS total
        FROM assembly_orders a JOIN assembly_outputs ao ON ao.order_id = a.id JOIN lpns l ON l.id = ao.lpn_id JOIN skus s ON s.id = a.output_sku_id
       WHERE a.status <> 'CANCELLED' AND l.status IN ('OPEN','STORED') AND (${includeTraining}::boolean OR a.is_training = false)
       GROUP BY a.id, s.code
    ) x WHERE x.pending > 0 ORDER BY COALESCE(x.closed_at, x.created_at) DESC LIMIT 200`;
  return rows.map((r) => ({ ...r, pending: r.pending.toString(), total: r.total.toString() }));
}

/** Every pallet of the batch with where it is and where it is going (its put-away task). */
export async function batchPallets(kind: BatchKind, id: string) {
  const db = getDb();
  const header = await batchHeader(kind, id);
  const rows = await db.$queryRaw<{ lpn_id: string; lpn_code: string; lpn_status: string; current_location: string | null; task_id: string | null; task_status: string | null; planned: boolean | null; target: string | null; contents: { sku: string; qty: string }[] | null }[]>`
    SELECT l.id AS lpn_id, l.code AS lpn_code, l.status AS lpn_status, cur.code AS current_location, t.id AS task_id, t.status AS task_status, t.planned, sug.code AS target,
           (SELECT json_agg(json_build_object('sku', s.code, 'qty', b.qty::text) ORDER BY s.code) FROM inventory_balances b JOIN skus s ON s.id = b.sku_id WHERE b.lpn_id = l.id AND b.qty > 0) AS contents
      FROM lpns l LEFT JOIN locations cur ON cur.id = l.current_location_id
      LEFT JOIN LATERAL (SELECT * FROM putaway_tasks t WHERE t.lpn_id = l.id ORDER BY (t.status IN ('PENDING','ASSIGNED','IN_PROGRESS')) DESC, t.created_at DESC LIMIT 1) t ON true
      LEFT JOIN locations sug ON sug.id = t.suggested_location_id
     WHERE ${lpnFilter(kind, id)} AND l.status <> 'CANCELLED'
     ORDER BY l.code`;
  return { batch: header, pallets: rows.map((x) => ({ ...x, contents: x.contents ?? [], pending: !!x.task_status && ['PENDING', 'ASSIGNED', 'IN_PROGRESS'].includes(x.task_status) })) };
}

/**
 * Closing: every pending pallet must have a destination, and each one is put away THERE in the system without scanning
 * (same effect as confirming it in Ubicar). One transaction per pallet: what fails is reported, the rest still lands.
 */
export async function closeBatch(actor: ActorContext, kind: BatchKind, id: string) {
  const db = getDb();
  const header = await batchHeader(kind, id);
  const rows = await db.$queryRaw<{ task_id: string; lpn_code: string; target: string | null; target_barcode: string | null }[]>`
    SELECT t.id AS task_id, l.code AS lpn_code, sug.code AS target, sug.barcode AS target_barcode FROM lpns l JOIN putaway_tasks t ON t.lpn_id = l.id AND t.status IN ('PENDING','ASSIGNED','IN_PROGRESS')
      LEFT JOIN locations sug ON sug.id = t.suggested_location_id WHERE ${lpnFilter(kind, id)} AND l.status <> 'CANCELLED' ORDER BY l.code`;
  if (!rows.length) throw new RuleError('NOTHING_PENDING', `${header.number} no tiene tarimas por acomodar`);
  const missing = rows.filter((x) => !x.target).map((x) => x.lpn_code);
  if (missing.length) throw new RuleError('PLAN_INCOMPLETE', `Faltan destinos: ${missing.join(', ')}`, { missing });
  const placed: { lpn: string; location: string }[] = [];
  const failed: { lpn: string; target: string; error: string }[] = [];
  for (const p of rows) {
    try {
      const done = await withTx((tx) => confirmPutaway(tx, actor, { task_id: p.task_id, lpn_code: p.lpn_code, location_barcode: p.target_barcode! }));
      placed.push({ lpn: p.lpn_code, location: done.location });
    } catch (e) {
      failed.push({ lpn: p.lpn_code, target: p.target!, error: e instanceof Error ? e.message : String(e) });
    }
  }
  await audit(db, actor, { action: 'putaway.batch_closed', entity_type: kind === 'RECEIPT' ? 'receipt' : 'assembly_order', entity_id: id, after: { batch: header.number, placed, failed } });
  return { placed, failed };
}

/** Prints, only on request, the label of every pallet of the batch still to be put away (the label shows "→ DESTINO …"). */
export async function printBatchLabels(actor: ActorContext, kind: BatchKind, id: string, body: { printer_id?: string; lpn_codes?: string[] }) {
  const db = getDb();
  await batchHeader(kind, id);
  const rows = await db.$queryRaw<{ lpn_code: string }[]>`SELECT l.code AS lpn_code FROM lpns l WHERE ${lpnFilter(kind, id)} AND l.status <> 'CANCELLED' AND ${PENDING} ORDER BY l.code`;
  const wanted = body.lpn_codes ? new Set(body.lpn_codes.map((c) => c.toUpperCase())) : null;
  const printed: string[] = [];
  const failed: { lpn: string; error: string }[] = [];
  for (const p of rows) {
    if (wanted && !wanted.has(p.lpn_code)) continue;
    try {
      await printLabel(actor, { label_type: 'LPN', entity_id: p.lpn_code, copies: 1, printer_id: body.printer_id, reprint_reason: 'Etiqueta con destino de acomodo' }, 'PRINT', { allowReprint: true });
      printed.push(p.lpn_code);
    } catch (e) {
      failed.push({ lpn: p.lpn_code, error: e instanceof Error ? e.message : String(e) });
    }
  }
  await audit(db, actor, { action: 'putaway.batch_labels_printed', entity_type: kind === 'RECEIPT' ? 'receipt' : 'assembly_order', entity_id: id, after: { printed, failed: failed.length } });
  return { printed, failed };
}
