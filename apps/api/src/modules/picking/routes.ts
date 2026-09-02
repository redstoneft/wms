import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zPickScan, zPickShort, zStageLpn, zUuid } from '@wms/shared';
import { getDb, withTx } from '../../db.js';
import { fingerprint, runIdempotent } from '../../lib/idempotency.js';
import * as svc from './service.js';

export async function pickingRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get('/picking/tasks', { preHandler: app.requirePermission('picking.execute') }, async (req) => {
    const q = z.object({ status: z.string().default('PENDING,IN_PROGRESS'), mine: z.enum(['true', 'false']).optional() }).parse(req.query);
    return db.$queryRaw<Record<string, unknown>[]>`
      SELECT pt.id, pt.status, pt.assigned_to, pt.created_at, pt.started_at, o.order_number, o.priority, c.name AS customer, u.username AS assigned_username,
             (SELECT count(*) FROM pick_task_lines l WHERE l.pick_task_id = pt.id) AS lines,
             (SELECT count(*) FROM pick_task_lines l WHERE l.pick_task_id = pt.id AND l.status = 'PICKED') AS picked_lines,
             sl.code AS staging_code
        FROM pick_tasks pt JOIN orders o ON o.id = pt.order_id JOIN customers c ON c.id = o.customer_id LEFT JOIN users u ON u.id = pt.assigned_to
        LEFT JOIN staging_assignments sa ON sa.order_id = o.id AND sa.released_at IS NULL LEFT JOIN locations sl ON sl.id = sa.location_id
       WHERE pt.status = ANY(${q.status.split(',')}::text[]) AND (${q.mine !== 'true'} OR pt.assigned_to = ${req.actor!.userId}::uuid OR pt.assigned_to IS NULL)
       ORDER BY o.priority, pt.created_at`;
  });

  app.get('/picking/tasks/:id', { preHandler: app.requirePermission('picking.execute') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    return withTx((tx) => svc.pickTaskView(tx, id));
  });

  app.post('/picking/tasks', { preHandler: app.requirePermission('picking.assign') }, async (req, reply) => {
    const body = z.object({ order_id: zUuid, assigned_to: zUuid.optional() }).parse(req.body);
    const r = await withTx((tx) => svc.createPickTask(tx, req.actor!, body.order_id, body.assigned_to));
    reply.status(201);
    return r;
  });

  app.post('/picking/tasks/:id/start', { preHandler: app.requirePermission('picking.execute') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    return withTx((tx) => svc.startPickTask(tx, req.actor!, id));
  });

  app.post('/picking/scan', { preHandler: app.requirePermission('picking.execute') }, async (req, reply) => {
    const body = zPickScan.parse(req.body);
    const r = await runIdempotent(req.actor!, fingerprint('POST', '/picking/scan', body), async (tx) => ({ status: 200, body: await svc.pickScan(tx, req.actor!, body) }));
    if (r.replayed) reply.header('Idempotent-Replayed', 'true');
    return r.body;
  });

  app.post('/picking/short', { preHandler: app.requirePermission('picking.assign') }, async (req) => {
    const body = zPickShort.parse(req.body);
    return withTx((tx) => svc.shortLine(tx, req.actor!, body));
  });

  app.post('/staging/scan', { preHandler: app.requirePermission('picking.execute') }, async (req, reply) => {
    const body = zStageLpn.parse(req.body);
    const r = await runIdempotent(req.actor!, fingerprint('POST', '/staging/scan', body), async (tx) => ({ status: 200, body: await svc.stageLpn(tx, req.actor!, body) }));
    if (r.replayed) reply.header('Idempotent-Replayed', 'true');
    return r.body;
  });

  app.get('/staging', { preHandler: app.requirePermission('orders.read') }, async () =>
    db.$queryRaw<Record<string, unknown>[]>`
      SELECT loc.id, loc.code, loc.barcode, sa.order_id, o.order_number, o.status AS order_status, c.name AS customer, sa.assigned_at,
             (SELECT count(*) FROM lpns l WHERE l.current_location_id = loc.id) AS lpn_count
        FROM locations loc LEFT JOIN staging_assignments sa ON sa.location_id = loc.id AND sa.released_at IS NULL
        LEFT JOIN orders o ON o.id = sa.order_id LEFT JOIN customers c ON c.id = o.customer_id
       WHERE loc.location_type = 'STAGING' AND loc.is_active ORDER BY loc.code`,
  );
}
