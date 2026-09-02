import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zPrintLabel, zUuid } from '@wms/shared';
import { getDb } from '../../db.js';
import { locationLabelBatch, locationLabelSheetHtml, printLabel, printLocationBatch } from './service.js';
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

  const zBatch = z.object({ rack_id: zUuid.optional(), zone_id: zUuid.optional(), warehouse_id: zUuid.optional() });

  /** Printable sheet (any printer / save as PDF) with one label per location of a rack or zone. */
  app.get('/labels/locations.html', { preHandler: app.requirePermission('labels.print') }, async (req, reply) => {
    const q = zBatch.parse(req.query);
    const html = await locationLabelSheetHtml(q);
    await withTx((tx) => audit(tx, req.actor!, { action: 'labels.location_sheet', entity_type: 'rack', entity_id: q.rack_id ?? q.zone_id ?? q.warehouse_id ?? '-', after: q }));
    reply.type('text/html; charset=utf-8');
    return html;
  });

  /** ZPL file with every location label of a rack or zone (send to a Zebra with any tool). */
  app.get('/labels/locations.zpl', { preHandler: app.requirePermission('labels.print') }, async (req, reply) => {
    const q = zBatch.parse(req.query);
    const { title, models } = await locationLabelBatch(q);
    await withTx((tx) => audit(tx, req.actor!, { action: 'labels.location_zpl', entity_type: 'rack', entity_id: q.rack_id ?? q.zone_id ?? q.warehouse_id ?? '-', after: { ...q, labels: models.length } }));
    reply.type('text/plain; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${title.replace(/[^A-Za-z0-9_-]+/g, '_')}.zpl"`);
    return models.map((m) => renderZpl(m)).join('\n');
  });

  /** Direct print of a whole rack/zone on a Zebra (one audited label_print per position). */
  app.post('/labels/print-batch', { preHandler: app.requirePermission('labels.print') }, async (req) => {
    const body = zBatch.extend({ printer_id: zUuid.optional() }).parse(req.body);
    return printLocationBatch(req.actor!, body, body.printer_id);
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
