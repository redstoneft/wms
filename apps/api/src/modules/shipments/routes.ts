import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zCreateShipment, zLoadScan, zReason, zReleaseShipment, zUuid } from '@wms/shared';
import { getDb, withTx } from '../../db.js';
import { fingerprint, runIdempotent } from '../../lib/idempotency.js';
import * as svc from './service.js';

export async function shipmentRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get('/shipments', { preHandler: app.requirePermission('shipments.read') }, async (req) => {
    const q = z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return db.shipments.findMany({
      where: q.status ? { status: { in: q.status.split(',') } } : {},
      include: { carrier: true, orders: { select: { id: true, order_number: true, status: true } }, _count: { select: { lpns: true } } },
      orderBy: { created_at: 'desc' },
      take: q.limit,
    });
  });

  app.get('/shipments/:id', { preHandler: app.requirePermission('shipments.read') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    return withTx((tx) => svc.shipmentDetail(tx, id));
  });

  app.post('/shipments', { preHandler: app.requirePermission('shipments.manage') }, async (req, reply) => {
    const body = zCreateShipment.parse(req.body);
    const sh = await withTx((tx) => svc.createShipment(tx, req.actor!, body));
    reply.status(201);
    return sh;
  });

  app.post('/shipments/:id/orders', { preHandler: app.requirePermission('shipments.manage') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const body = z.object({ order_id: zUuid }).parse(req.body);
    return withTx((tx) => svc.addOrder(tx, req.actor!, id, body.order_id));
  });
  app.delete('/shipments/:id/orders/:orderId', { preHandler: app.requirePermission('shipments.manage') }, async (req) => {
    const p = z.object({ id: zUuid, orderId: zUuid }).parse(req.params);
    return withTx((tx) => svc.removeOrder(tx, req.actor!, p.id, p.orderId));
  });

  app.post('/loading/scan', { preHandler: app.requirePermission('loading.execute') }, async (req, reply) => {
    const body = zLoadScan.parse(req.body);
    const r = await runIdempotent(req.actor!, fingerprint('POST', '/loading/scan', body), async (tx) => ({ status: 200, body: await svc.loadScan(tx, req.actor!, body) }));
    if (r.replayed) reply.header('Idempotent-Replayed', 'true');
    return r.body;
  });

  app.post('/loading/unload', { preHandler: app.requirePermission('loading.execute') }, async (req, reply) => {
    const body = z.object({ shipment_id: zUuid, lpn_code: z.string().trim().min(1).max(30), reason: zReason }).parse(req.body);
    const r = await runIdempotent(req.actor!, fingerprint('POST', '/loading/unload', body), async (tx) => ({ status: 200, body: await svc.unloadScan(tx, req.actor!, body) }));
    if (r.replayed) reply.header('Idempotent-Replayed', 'true');
    return r.body;
  });

  app.get('/shipments/:id/release-check', { preHandler: app.requirePermission('shipments.read') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    return withTx((tx) => svc.releaseCheck(tx, id));
  });

  app.post('/shipments/release', { preHandler: app.requirePermission('shipments.release') }, async (req) => {
    const body = zReleaseShipment.parse(req.body);
    return withTx((tx) => svc.releaseShipment(tx, req.actor!, body));
  });

  app.post('/shipments/:id/depart', { preHandler: app.requirePermission('shipments.release') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    return withTx((tx) => svc.departShipment(tx, req.actor!, id));
  });
}
