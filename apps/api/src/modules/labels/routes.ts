import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zPrintLabel, zUuid } from '@wms/shared';
import { getDb } from '../../db.js';
import { labelBatch, locationLabelSheetHtml, locationLabelsAsEmbarquePedido, printLabel, printLocationBatch } from './service.js';
import { withTx } from '../../db.js';
import { audit } from '../../lib/audit.js';
import { renderZpl } from '@wms/shared';

export async function labelRoutes(app: FastifyInstance) {
  const db = getDb();

  app.post('/labels/preview', { preHandler: app.requirePermission('labels.print') }, async (req) => {
    const body = zPrintLabel.parse(req.body);
    return printLabel(req.actor!, body, 'PREVIEW');
  });

  app.post('/labels/print', { preHandler: app.requirePermission('labels.print') }, async (req) => {
    const body = zPrintLabel.parse(req.body);
    return printLabel(req.actor!, body, 'PRINT');
  });

  const zBatch = z
    .object({
      rack_id: zUuid.optional(),
      zone_id: zUuid.optional(),
      warehouse_id: zUuid.optional(),
      /** comma-separated location codes/barcodes for loose labels (max 500) */
      codes: z
        .string()
        .trim()
        .max(20000)
        .optional()
        .transform((v) => (v ? v.split(/[,\s]+/).filter(Boolean).slice(0, 500) : undefined)),
      title: z.string().trim().max(60).optional(),
      /** LOCATION (default): the slots; LPN: the pallets stored in them */
      kind: z
        .string()
        .trim()
        .optional()
        .transform((v) => (v && v.toUpperCase() === 'LPN' ? 'LPN' : 'LOCATION') as 'LOCATION' | 'LPN'),
      /** sheet paper: A4 (default) or LETTER (carta) */
      paper: z
        .string()
        .trim()
        .optional()
        .transform((v) => (v && ['LETTER', 'CARTA'].includes(v.toUpperCase()) ? 'LETTER' : 'A4') as 'A4' | 'LETTER'),
    });

  /** Printable sheet (any printer / save as PDF) with one label per location of a rack or zone. */
  app.get('/labels/locations.html', { preHandler: app.requirePermission('labels.print') }, async (req, reply) => {
    const q = zBatch.parse(req.query);
    const html = await locationLabelSheetHtml(q, q.paper);
    await withTx((tx) => audit(tx, req.actor!, { action: 'labels.location_sheet', entity_type: 'rack', entity_id: q.rack_id ?? q.zone_id ?? q.warehouse_id ?? q.title ?? '-', after: { ...q, codes: q.codes?.length } }));
    reply.type('text/html; charset=utf-8');
    return html;
  });

  /** ZPL file with every location label of a rack or zone (send to a Zebra with any tool). */
  app.get('/labels/locations.zpl', { preHandler: app.requirePermission('labels.print') }, async (req, reply) => {
    const q = zBatch.parse(req.query);
    const { title, entries } = await labelBatch(q);
    const models = entries.map((e) => e.model);
    await withTx((tx) => audit(tx, req.actor!, { action: 'labels.location_zpl', entity_type: 'rack', entity_id: q.rack_id ?? q.zone_id ?? q.warehouse_id ?? q.title ?? '-', after: { ...q, labels: models.length } }));
    reply.type('text/plain; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${title.replace(/[^A-Za-z0-9_-]+/g, '_')}.zpl"`);
    return models.map((m) => renderZpl(m)).join('\n');
  });

  /** Export for the Embarque label app: the rack as a pedido JSON with pre-rendered ZPL. */
  app.get('/labels/locations.embarque.json', { preHandler: app.requirePermission('labels.print') }, async (req, reply) => {
    const q = zBatch.parse(req.query);
    const pedido = await locationLabelsAsEmbarquePedido(q);
    await withTx((tx) => audit(tx, req.actor!, { action: 'labels.location_export_embarque', entity_type: 'rack', entity_id: q.rack_id ?? q.zone_id ?? q.warehouse_id ?? q.title ?? '-', after: { ...q, oc: pedido.encabezado.num_orden_compra, labels: pedido.etiquetas.length } }));
    reply.type('application/json; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${pedido.encabezado.num_orden_compra}.json"`);
    return JSON.stringify(pedido);
  });

  /** Direct print of a whole rack/zone on a Zebra (one audited label_print per position). */
  app.post('/labels/print-batch', { preHandler: app.requirePermission('labels.print') }, async (req) => {
    const body = zBatch.extend({ printer_id: zUuid.optional() }).parse(req.body);
    return printLocationBatch(req.actor!, body, body.printer_id);
  });

  /** The print queue: what is waiting (or being printed) per printer. Visible from any device. */
  app.get('/labels/queue', { preHandler: app.requirePermission('labels.print') }, async () => {
    const rows = await db.$queryRaw<{ printer_id: string | null; printer: string | null; queued: bigint; printing: bigint; oldest: Date | null }[]>`
      SELECT lp.printer_id, p.name AS printer,
             COUNT(*) FILTER (WHERE lp.status = 'QUEUED')::bigint AS queued,
             COUNT(*) FILTER (WHERE lp.status = 'PRINTING')::bigint AS printing,
             MIN(lp.created_at) AS oldest
      FROM label_prints lp LEFT JOIN printers p ON p.id = lp.printer_id
      WHERE lp.status IN ('QUEUED', 'PRINTING')
      GROUP BY lp.printer_id, p.name ORDER BY p.name`;
    return { printers: rows.map((r) => ({ ...r, queued: Number(r.queued), printing: Number(r.printing) })), total: rows.reduce((a, r) => a + Number(r.queued) + Number(r.printing), 0) };
  });
  /** Empties the print queue (one printer or all): the pending labels are cancelled, nothing else is touched. Audited. */
  app.post('/labels/queue/clear', { preHandler: app.requirePermission('labels.print') }, async (req) => {
    const body = z.object({ printer_id: zUuid.optional() }).parse(req.body ?? {});
    return withTx(async (tx) => {
      const where = { status: { in: ['QUEUED', 'PRINTING'] }, ...(body.printer_id ? { printer_id: body.printer_id } : {}) };
      const victims = await tx.label_prints.findMany({ where, select: { id: true, label_type: true, entity_id: true, printer_id: true } });
      if (victims.length) await tx.label_prints.updateMany({ where: { id: { in: victims.map((v) => v.id) } }, data: { status: 'CANCELLED', error: `Cola vaciada por ${req.actor!.username}`, claimed_at: null } });
      await audit(tx, req.actor!, { action: 'labels.queue_cleared', entity_type: 'printer', entity_id: body.printer_id ?? 'ALL', after: { cancelled: victims.length, labels: victims.slice(0, 200).map((v) => `${v.label_type}:${v.entity_id}`) } });
      return { cancelled: victims.length };
    });
  });
  app.get('/labels/history', { preHandler: app.requirePermission('labels.print') }, async (req) => {
    const q = z.object({ entity_id: z.string().optional(), label_type: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return db.label_prints.findMany({
      where: { ...(q.entity_id ? { entity_id: q.entity_id } : {}), ...(q.label_type ? { label_type: q.label_type } : {}), status: { not: 'PREVIEW' } },
      select: { id: true, label_type: true, entity_id: true, is_reprint: true, reprint_reason: true, printed_by: true, status: true, error: true, created_at: true, printer_id: true },
      orderBy: { created_at: 'desc' },
      take: q.limit,
    });
  });

  app.get('/labels/:id/zpl', { preHandler: app.requirePermission('labels.print') }, async (req, reply) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const row = await db.label_prints.findUnique({ where: { id } });
    if (!row) return reply.status(404).send({ error: 'NOT_FOUND' });
    reply.type('text/plain');
    return row.zpl;
  });
}
