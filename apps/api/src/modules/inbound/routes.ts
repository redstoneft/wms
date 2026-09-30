import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zCloseReceipt, zContainerTransition, zCreateContainer, zCreateReceipt, zReason, zReceiveScan, zReceiveUndo, zUuid } from '@wms/shared';
import { getDb, withTx } from '../../db.js';
import { includeTraining, trainingWhere } from '../../lib/training-scope.js';
import { ConflictError, NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import { fingerprint, runIdempotent } from '../../lib/idempotency.js';
import { saveAttachment } from '../attachments/service.js';
import { printLabel } from '../labels/service.js';
import { confirmPutaway } from '../putaway/service.js';
import { getSettings } from '../settings/routes.js';
import * as svc from './service.js';

export async function inboundRoutes(app: FastifyInstance) {
  const db = getDb();

  // ---------------- purchase orders ----------------
  app.get('/purchase-orders', { preHandler: app.requirePermission('containers.read') }, async (req) => {
    const q = z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return db.purchase_orders.findMany({ where: { ...(await trainingWhere(req)), ...(q.status ? { status: q.status } : {}) }, include: { supplier: true, lines: { include: { sku: true } } }, orderBy: { created_at: 'desc' }, take: q.limit });
  });
  app.post('/purchase-orders', { preHandler: app.requirePermission('containers.manage') }, async (req, reply) => {
    const body = z
      .object({
        po_number: z.string().trim().min(1).max(60),
        supplier_code: z.string().trim().min(1),
        expected_date: z.coerce.date().optional(),
        notes: z.string().max(2000).optional(),
        lines: z.array(z.object({ sku_code: z.string().trim().min(1), qty: z.coerce.bigint().positive(), uom_code: z.enum(['PALLET', 'CASE', 'INNER', 'PIECE']).default('CASE') })).min(1),
      })
      .parse(req.body);
    const po = await withTx(async (tx) => {
      const supplier = await tx.suppliers.findUnique({ where: { code: body.supplier_code } });
      if (!supplier) throw new NotFoundError('supplier', body.supplier_code);
      if (await tx.purchase_orders.findUnique({ where: { po_number: body.po_number } })) throw new ConflictError('PO_EXISTS', 'PO number already exists');
      const { getSkuByCode, toBaseQty } = await import('../../lib/lookup.js');
      const lines = [];
      let n = 1;
      for (const l of body.lines) {
        const sku = await getSkuByCode(tx, l.sku_code);
        const { base } = await toBaseQty(tx, sku.id, l.qty, l.uom_code);
        lines.push({ line_no: n++, sku_id: sku.id, ordered_qty: base, uom_code: l.uom_code, uom_qty: l.qty });
      }
      const r = await tx.purchase_orders.create({
        data: { po_number: body.po_number, supplier_id: supplier.id, expected_date: body.expected_date ?? null, notes: body.notes ?? null, created_by: req.actor!.userId, lines: { create: lines } },
        include: { lines: true },
      });
      await audit(tx, req.actor!, { action: 'po.create', entity_type: 'purchase_order', entity_id: r.id, after: r });
      return r;
    });
    reply.status(201);
    return po;
  });

  // ---------------- containers ----------------
  app.get('/containers', { preHandler: app.requirePermission('containers.read') }, async (req) => {
    const q = z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    const where = { ...(await trainingWhere(req)), ...(q.status ? { status: { in: q.status.split(',') } } : {}) };
    const [items, total] = await Promise.all([
      db.containers.findMany({ where, include: { supplier: true, carrier: true, po: true, receipts: { select: { id: true, receipt_number: true, status: true } } }, orderBy: [{ scheduled_at: 'asc' }, { created_at: 'desc' }], take: q.limit, skip: q.offset }),
      db.containers.count({ where }),
    ]);
    return { items, total };
  });
  app.get('/containers/:id', { preHandler: app.requirePermission('containers.read') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const c = await db.containers.findUnique({ where: { id }, include: { supplier: true, carrier: true, po: { include: { lines: { include: { sku: true } } } }, receipts: { include: { lines: { include: { sku: true } } } }, lpns: { select: { id: true, code: true, status: true } } } });
    if (!c) throw new NotFoundError('container', id);
    const photos = await db.attachments.findMany({ where: { entity_type: 'container', entity_id: id } });
    const incidents = await db.incidents.findMany({ where: { OR: [{ entity_type: 'container', entity_id: id }, { receipt_id: { in: c.receipts.map((r) => r.id) } }] } });
    return { ...c, photos, incidents };
  });
  app.post('/containers', { preHandler: app.requirePermission('containers.manage') }, async (req, reply) => {
    const body = zCreateContainer.parse(req.body);
    const c = await withTx(async (tx) => {
      if (await tx.containers.findUnique({ where: { container_number: body.container_number } })) throw new ConflictError('CONTAINER_EXISTS', 'Container number already registered');
      const r = await tx.containers.create({ data: { ...body, created_by: req.actor!.userId } });
      await audit(tx, req.actor!, { action: 'container.create', entity_type: 'container', entity_id: r.id, after: r });
      return r;
    });
    reply.status(201);
    return c;
  });
  app.post('/containers/:id/transition', { preHandler: app.requirePermission('containers.manage') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const body = zContainerTransition.parse(req.body);
    return withTx((tx) => svc.transitionContainer(tx, req.actor!, id, body));
  });
  app.post('/containers/:id/photos', { preHandler: app.requirePermission('containers.manage') }, async (req, reply) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    if (!(await db.containers.findUnique({ where: { id } }))) throw new NotFoundError('container', id);
    const file = await req.file();
    if (!file) throw new RuleError('NO_FILE', 'Multipart file required');
    const att = await saveAttachment(req.actor!, 'container', id, file);
    await withTx((tx) => audit(tx, req.actor!, { action: 'container.photo', entity_type: 'container', entity_id: id, after: { attachment_id: att.id, file: att.file_name } }));
    reply.status(201);
    return att;
  });

  // ---------------- receipts ----------------
  app.get('/receipts', { preHandler: app.requirePermission('receiving.read') }, async (req) => {
    const q = z.object({ status: z.string().optional(), container_id: zUuid.optional(), limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    const where = { ...(await trainingWhere(req)), ...(q.status ? { status: { in: q.status.split(',') } } : {}), ...(q.container_id ? { container_id: q.container_id } : {}) };
    const [items, total] = await Promise.all([
      db.receipts.findMany({ where, include: { container: { select: { container_number: true } }, lines: { include: { sku: { select: { code: true, description: true } } } } }, orderBy: { created_at: 'desc' }, take: q.limit, skip: q.offset }),
      db.receipts.count({ where }),
    ]);
    // backwards compatible: array response with pagination metadata attached
    return Object.assign(items, { total }) as unknown as typeof items & { total: number };
  });
  /** Receipts (closed or being closed) that still have pallets waiting for put-away: the handheld's "acomodo por recepción" list. */
  app.get('/receipts/pending-putaway', { preHandler: app.requirePermission('putaway.execute') }, async (req) => {
    const rows = await db.$queryRaw<{ id: string; receipt_number: string; status: string; closed_at: Date | null; container_number: string | null; pending: bigint; total: bigint }[]>`
      SELECT r.id, r.receipt_number, r.status, r.closed_at, c.container_number,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM putaway_tasks t WHERE t.lpn_id = l.id AND t.status IN ('PENDING','ASSIGNED','IN_PROGRESS')))::bigint AS pending,
             count(*)::bigint AS total
        FROM receipts r JOIN lpns l ON l.receipt_id = r.id LEFT JOIN containers c ON c.id = r.container_id
       WHERE r.status <> 'CANCELLED' AND l.status IN ('OPEN','STORED') AND (${await includeTraining(req)}::boolean OR r.is_training = false)
       GROUP BY r.id, c.container_number HAVING count(*) FILTER (WHERE EXISTS (SELECT 1 FROM putaway_tasks t WHERE t.lpn_id = l.id AND t.status IN ('PENDING','ASSIGNED','IN_PROGRESS'))) > 0
       ORDER BY r.closed_at DESC NULLS LAST, r.created_at DESC LIMIT 100`;
    return rows.map((r) => ({ ...r, pending: r.pending.toString(), total: r.total.toString() }));
  });
  /** Every pallet of a receipt with where it is and where it is going (its put-away task), to plan the whole receipt at once. */
  app.get('/receipts/:id/putaway', { preHandler: app.requirePermission('receiving.read') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const r = await db.receipts.findUnique({ where: { id }, select: { id: true, receipt_number: true, status: true } });
    if (!r) throw new NotFoundError('receipt', id);
    const rows = await db.$queryRaw<{ lpn_id: string; lpn_code: string; lpn_status: string; current_location: string | null; task_id: string | null; task_status: string | null; planned: boolean | null; target: string | null; contents: { sku: string; qty: string }[] | null }[]>`
      SELECT l.id AS lpn_id, l.code AS lpn_code, l.status AS lpn_status, cur.code AS current_location, t.id AS task_id, t.status AS task_status, t.planned, sug.code AS target,
             (SELECT json_agg(json_build_object('sku', s.code, 'qty', b.qty::text) ORDER BY s.code) FROM inventory_balances b JOIN skus s ON s.id = b.sku_id WHERE b.lpn_id = l.id AND b.qty > 0) AS contents
        FROM lpns l LEFT JOIN locations cur ON cur.id = l.current_location_id
        LEFT JOIN LATERAL (SELECT * FROM putaway_tasks t WHERE t.lpn_id = l.id ORDER BY (t.status IN ('PENDING','ASSIGNED','IN_PROGRESS')) DESC, t.created_at DESC LIMIT 1) t ON true
        LEFT JOIN locations sug ON sug.id = t.suggested_location_id
       WHERE l.receipt_id = ${id}::uuid AND l.status <> 'CANCELLED'
       ORDER BY l.code`;
    return { receipt: r, pallets: rows.map((x) => ({ ...x, contents: x.contents ?? [], pending: !!x.task_status && ['PENDING', 'ASSIGNED', 'IN_PROGRESS'].includes(x.task_status) })) };
  });
  /**
   * Closing the put-away of a receipt: every pending pallet must have a destination, and each one is put away THERE in
   * the system without scanning (same effect as confirming it in Ubicar: PUTAWAY movement, task completed, pallet stored).
   * One transaction per pallet: what fails (slot taken meanwhile, blocked…) is reported and the rest still lands.
   */
  app.post('/receipts/:id/putaway/close', { preHandler: app.requirePermission('putaway.execute') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const r = await db.receipts.findUnique({ where: { id }, select: { id: true, receipt_number: true } });
    if (!r) throw new NotFoundError('receipt', id);
    const rows = await db.$queryRaw<{ task_id: string; lpn_code: string; target: string | null; target_barcode: string | null }[]>`
      SELECT t.id AS task_id, l.code AS lpn_code, sug.code AS target, sug.barcode AS target_barcode FROM lpns l JOIN putaway_tasks t ON t.lpn_id = l.id AND t.status IN ('PENDING','ASSIGNED','IN_PROGRESS')
        LEFT JOIN locations sug ON sug.id = t.suggested_location_id WHERE l.receipt_id = ${id}::uuid AND l.status <> 'CANCELLED' ORDER BY l.code`;
    if (!rows.length) throw new RuleError('NOTHING_PENDING', `La recepción ${r.receipt_number} no tiene tarimas por acomodar`);
    const missing = rows.filter((x) => !x.target).map((x) => x.lpn_code);
    if (missing.length) throw new RuleError('PLAN_INCOMPLETE', `Faltan destinos: ${missing.join(', ')}`, { missing });
    const placed: { lpn: string; location: string }[] = [];
    const failed: { lpn: string; target: string; error: string }[] = [];
    for (const p of rows) {
      try {
        const done = await withTx((tx) => confirmPutaway(tx, req.actor!, { task_id: p.task_id, lpn_code: p.lpn_code, location_barcode: p.target_barcode! }));
        placed.push({ lpn: p.lpn_code, location: done.location });
      } catch (e) {
        failed.push({ lpn: p.lpn_code, target: p.target!, error: e instanceof Error ? e.message : String(e) });
      }
    }
    await audit(db, req.actor!, { action: 'receipt.putaway_closed', entity_type: 'receipt', entity_id: id, after: { receipt: r.receipt_number, placed, failed } });
    return { placed, failed };
  });
  /** Prints (on request only, never automatically) the label of every pallet of the receipt still to be put away; the label shows "→ DESTINO <ubicación>". */
  app.post('/receipts/:id/putaway/print', { preHandler: app.requirePermission('labels.print') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const body = z.object({ printer_id: zUuid.optional(), lpn_codes: z.array(z.string().trim().min(1).max(40)).max(500).optional() }).parse(req.body ?? {});
    const rows = await db.$queryRaw<{ lpn_code: string }[]>`
      SELECT l.code AS lpn_code FROM lpns l WHERE l.receipt_id = ${id}::uuid AND l.status <> 'CANCELLED'
         AND EXISTS (SELECT 1 FROM putaway_tasks t WHERE t.lpn_id = l.id AND t.status IN ('PENDING','ASSIGNED','IN_PROGRESS')) ORDER BY l.code`;
    const wanted = body.lpn_codes ? new Set(body.lpn_codes.map((c) => c.toUpperCase())) : null;
    const printed: string[] = [];
    const failed: { lpn: string; error: string }[] = [];
    for (const p of rows) {
      if (wanted && !wanted.has(p.lpn_code)) continue;
      try {
        await printLabel(req.actor!, { label_type: 'LPN', entity_id: p.lpn_code, copies: 1, printer_id: body.printer_id, reprint_reason: 'Etiqueta con destino de acomodo' }, 'PRINT', { allowReprint: true });
        printed.push(p.lpn_code);
      } catch (e) {
        failed.push({ lpn: p.lpn_code, error: e instanceof Error ? e.message : String(e) });
      }
    }
    await audit(db, req.actor!, { action: 'receipt.putaway_labels_printed', entity_type: 'receipt', entity_id: id, after: { printed, failed: failed.length } });
    return { printed, failed };
  });
  app.get('/receipts/:id', { preHandler: app.requirePermission('receiving.read') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const r = await db.receipts.findUnique({
      where: { id },
      include: { container: true, lines: { include: { sku: true } }, lpns: { include: { balances: { include: { sku: { select: { code: true } } } } } } },
    });
    if (!r) throw new NotFoundError('receipt', id);
    return r;
  });
  app.post('/receipts', { preHandler: app.requirePermission('receiving.scan') }, async (req, reply) => {
    const body = zCreateReceipt.parse(req.body);
    const r = await withTx((tx) => svc.createReceipt(tx, req.actor!, body));
    reply.status(201);
    return r;
  });

  // The scan endpoint is idempotent: a Wi-Fi retry with the same Idempotency-Key never double-receives.
  app.post('/receipts/scan', { preHandler: app.requirePermission('receiving.scan') }, async (req, reply) => {
    const body = zReceiveScan.parse(req.body);
    const r = await runIdempotent(req.actor!, fingerprint('POST', '/receipts/scan', body), async (tx) => ({
      status: 201,
      body: await svc.receiveScan(tx, req.actor!, body),
    }));
    reply.status(r.status);
    if (r.replayed) reply.header('Idempotent-Replayed', 'true');
    // Automatic LPN label on pallet creation (best effort, after commit; failures are recorded in label_prints)
    if (!r.replayed && r.body.lpn?.is_new) {
      const actor = req.actor!;
      void getSettings()
        .then((s) => (s.auto_print_lpn_labels === false ? null : printLabel(actor, { label_type: 'LPN', entity_id: r.body.lpn.code, copies: 1 }, 'PRINT')))
        .catch((e: Error) => req.log.warn({ err: e.message, lpn: r.body.lpn.code }, 'auto label print failed'));
    }
    return r.body;
  });

  /** Undo a scan registered by mistake while the pallet is still at the dock. */
  app.post('/receipts/undo', { preHandler: app.requirePermission('receiving.scan') }, async (req, reply) => {
    const body = zReceiveUndo.parse(req.body);
    const r = await runIdempotent(req.actor!, fingerprint('POST', '/receipts/undo', body), async (tx) => ({ status: 200, body: await svc.undoReceiveScan(tx, req.actor!, body) }));
    if (r.replayed) reply.header('Idempotent-Replayed', 'true');
    return r.body;
  });

  app.post('/receipts/lpn/close', { preHandler: app.requirePermission('receiving.scan') }, async (req) => {
    const body = z.object({ lpn_code: z.string().trim().min(1).max(30) }).parse(req.body);
    const r = await runIdempotent(req.actor!, fingerprint('POST', '/receipts/lpn/close', body), async (tx) => ({
      status: 200,
      body: await svc.closeReceivingLpn(tx, req.actor!, body.lpn_code),
    }));
    return r.body;
  });

  app.post('/receipts/complete', { preHandler: app.requirePermission('receiving.scan') }, async (req) => {
    const body = zCloseReceipt.parse(req.body);
    return withTx((tx) => svc.completeReceipt(tx, req.actor!, body));
  });

  app.post('/receipts/:id/cancel', { preHandler: app.requirePermission('receiving.close') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const body = z.object({ reason: zReason }).parse(req.body);
    return withTx((tx) => svc.cancelReceipt(tx, req.actor!, id, body.reason));
  });
  app.post('/receipts/:id/close', { preHandler: app.requirePermission('receiving.close') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    return withTx((tx) => svc.closeReceipt(tx, req.actor!, id));
  });
}
