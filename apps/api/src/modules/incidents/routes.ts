import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zCreateIncident, zResolveIncident, zUuid } from '@wms/shared';
import { getDb, withTx } from '../../db.js';
import { NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import { createIncident } from './service.js';
import { saveAttachment } from '../attachments/service.js';

export async function incidentRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get('/incidents', { preHandler: app.requirePermission('incidents.read') }, async (req) => {
    const q = z
      .object({
        status: z.string().optional(),
        severity: z.string().optional(),
        type: z.string().optional(),
        entity_type: z.string().optional(),
        entity_id: z.string().optional(),
        order_id: zUuid.optional(),
        shipment_id: zUuid.optional(),
        lpn_id: zUuid.optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const where = {
      ...(q.status ? { status: { in: q.status.split(',') } } : {}),
      ...(q.severity ? { severity: q.severity } : {}),
      ...(q.type ? { incident_type: q.type } : {}),
      ...(q.entity_type ? { entity_type: q.entity_type } : {}),
      ...(q.entity_id ? { entity_id: q.entity_id } : {}),
      ...(q.order_id ? { order_id: q.order_id } : {}),
      ...(q.shipment_id ? { shipment_id: q.shipment_id } : {}),
      ...(q.lpn_id ? { lpn_id: q.lpn_id } : {}),
    };
    const [items, total] = await Promise.all([
      db.incidents.findMany({ where, orderBy: [{ created_at: 'desc' }], take: q.limit, skip: q.offset }),
      db.incidents.count({ where }),
    ]);
    return { items, total };
  });

  app.get('/incidents/:id', { preHandler: app.requirePermission('incidents.read') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const inc = await db.incidents.findUnique({ where: { id }, include: { comments: { orderBy: { created_at: 'asc' } } } });
    if (!inc) throw new NotFoundError('incident', id);
    const attachments = await db.attachments.findMany({ where: { entity_type: 'incident', entity_id: id } });
    const [sku, lpn, location] = await Promise.all([
      inc.sku_id ? db.skus.findUnique({ where: { id: inc.sku_id }, select: { code: true, description: true } }) : null,
      inc.lpn_id ? db.lpns.findUnique({ where: { id: inc.lpn_id }, select: { code: true } }) : null,
      inc.location_id ? db.locations.findUnique({ where: { id: inc.location_id }, select: { code: true } }) : null,
    ]);
    return { ...inc, attachments, sku, lpn, location };
  });

  app.post('/incidents', { preHandler: app.requirePermission('incidents.create') }, async (req, reply) => {
    const body = zCreateIncident.parse(req.body);
    const inc = await withTx(async (tx) => {
      const sku = body.sku_code ? await tx.skus.findUnique({ where: { code: body.sku_code } }) : null;
      if (body.sku_code && !sku) throw new NotFoundError('SKU', body.sku_code);
      const lpn = body.lpn_code ? await tx.lpns.findUnique({ where: { code: body.lpn_code.toUpperCase() } }) : null;
      if (body.lpn_code && !lpn) throw new NotFoundError('LPN', body.lpn_code);
      const loc = body.location_barcode ? await tx.locations.findFirst({ where: { OR: [{ barcode: body.location_barcode }, { code: body.location_barcode.toUpperCase() }] } }) : null;
      if (body.location_barcode && !loc) throw new NotFoundError('location', body.location_barcode);
      return createIncident(tx, req.actor!, {
        ...body,
        sku_id: sku?.id ?? null,
        lpn_id: lpn?.id ?? null,
        location_id: loc?.id ?? null,
        qty: body.qty ?? null,
      });
    });
    reply.status(201);
    return inc;
  });

  app.post('/incidents/:id/comments', { preHandler: app.requirePermission('incidents.read') }, async (req, reply) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const body = z.object({ body: z.string().trim().min(1).max(5000) }).parse(req.body);
    const c = await withTx(async (tx) => {
      const inc = await tx.incidents.findUnique({ where: { id } });
      if (!inc) throw new NotFoundError('incident', id);
      const r = await tx.incident_comments.create({ data: { incident_id: id, user_id: req.actor!.userId, body: body.body } });
      await audit(tx, req.actor!, { action: 'incident.comment', entity_type: 'incident', entity_id: id, after: { body: body.body } });
      return r;
    });
    reply.status(201);
    return c;
  });

  app.post('/incidents/:id/photos', { preHandler: app.requirePermission('incidents.create') }, async (req, reply) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const inc = await db.incidents.findUnique({ where: { id } });
    if (!inc) throw new NotFoundError('incident', id);
    const file = await req.file();
    if (!file) throw new RuleError('NO_FILE', 'Multipart file required');
    const att = await saveAttachment(req.actor!, 'incident', id, file);
    reply.status(201);
    return att;
  });

  app.post('/incidents/:id/status', { preHandler: app.requirePermission('incidents.resolve') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const body = zResolveIncident.parse(req.body);
    return withTx(async (tx) => {
      const before = await tx.incidents.findUnique({ where: { id } });
      if (!before) throw new NotFoundError('incident', id);
      if (before.status === 'CLOSED') throw new RuleError('INCIDENT_CLOSED', 'Incident is closed');
      if ((body.status === 'RESOLVED' || body.status === 'CLOSED') && !body.resolution && !before.resolution) {
        throw new RuleError('RESOLUTION_REQUIRED', 'A resolution text is required to resolve or close');
      }
      const after = await tx.incidents.update({
        where: { id },
        data: {
          status: body.status,
          resolution: body.resolution ?? before.resolution,
          resolved_by: body.status === 'RESOLVED' || body.status === 'CLOSED' ? req.actor!.userId : before.resolved_by,
          resolved_at: body.status === 'RESOLVED' || body.status === 'CLOSED' ? new Date() : before.resolved_at,
          authorized_by: body.status === 'CLOSED' ? req.actor!.userId : before.authorized_by,
        },
      });
      if (body.comment) await tx.incident_comments.create({ data: { incident_id: id, user_id: req.actor!.userId, body: body.comment } });
      await audit(tx, req.actor!, { action: `incident.${body.status.toLowerCase()}`, entity_type: 'incident', entity_id: id, before, after, reason: body.resolution ?? null });
      return after;
    });
  });

  app.post('/incidents/:id/assign', { preHandler: app.requirePermission('incidents.resolve') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const body = z.object({ assigned_to: zUuid.nullable() }).parse(req.body);
    return withTx(async (tx) => {
      const before = await tx.incidents.findUnique({ where: { id } });
      if (!before) throw new NotFoundError('incident', id);
      const after = await tx.incidents.update({ where: { id }, data: { assigned_to: body.assigned_to, status: before.status === 'OPEN' ? 'IN_REVIEW' : before.status } });
      await audit(tx, req.actor!, { action: 'incident.assign', entity_type: 'incident', entity_id: id, before, after });
      return after;
    });
  });
}
