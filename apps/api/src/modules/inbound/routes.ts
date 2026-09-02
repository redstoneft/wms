import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zCloseReceipt, zContainerTransition, zCreateContainer, zCreateReceipt, zReceiveScan, zUuid } from '@wms/shared';
import { getDb, withTx } from '../../db.js';
import { ConflictError, NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import { fingerprint, runIdempotent } from '../../lib/idempotency.js';
import { saveAttachment } from '../attachments/service.js';
import { printLabel } from '../labels/service.js';
import { getSettings } from '../settings/routes.js';
import * as svc from './service.js';

export async function inboundRoutes(app: FastifyInstance) {
  const db = getDb();

  // ---------------- purchase orders ----------------
  app.get('/purchase-orders', { preHandler: app.requirePermission('containers.read') }, async (req) => {
    const q = z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return db.purchase_orders.findMany({ where: q.status ? { status: q.status } : {}, include: { supplier: true, lines: { include: { sku: true } } }, orderBy: { created_at: 'desc' }, take: q.limit });
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
    const where = q.status ? { status: { in: q.status.split(',') } } : {};
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
    const where = { ...(q.status ? { status: { in: q.status.split(',') } } : {}), ...(q.container_id ? { container_id: q.container_id } : {}) };
    const [items, total] = await Promise.all([
      db.receipts.findMany({ where, include: { container: { select: { container_number: true } }, lines: { include: { sku: { select: { code: true, description: true } } } } }, orderBy: { created_at: 'desc' }, take: q.limit, skip: q.offset }),
      db.receipts.count({ where }),
    ]);
    // backwards compatible: array response with pagination metadata attached
    return Object.assign(items, { total }) as unknown as typeof items & { total: number };
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

  app.post('/receipts/:id/close', { preHandler: app.requirePermission('receiving.close') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    return withTx((tx) => svc.closeReceipt(tx, req.actor!, id));
  });
}
