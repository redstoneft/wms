import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zPrintLabel, zUuid } from '@wms/shared';
import { getDb } from '../../db.js';
import { printLabel } from './service.js';

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
