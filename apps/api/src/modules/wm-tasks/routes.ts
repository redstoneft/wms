import type { FastifyInstance } from 'fastify';
import { zHandheldOrder, zSelfTask } from '@wms/shared';
import { withTx } from '../../db.js';
import { createHandheldOrder, createSelfTask } from './service.js';

export async function wmTaskRoutes(app: FastifyInstance) {
  /** Manual order captured on the handheld (customer + scanned products); purpose mandatory. */
  app.post('/wm/orders', { preHandler: app.requirePermission('tasks.self_create') }, async (req, reply) => {
    const body = zHandheldOrder.parse(req.body);
    const r = await withTx((tx) => createHandheldOrder(tx, req.actor!, body));
    reply.status(201);
    return r;
  });
  /** An operator creates a task for themself from the handheld; the purpose is mandatory and audited. */
  app.post('/wm/tasks', { preHandler: app.requirePermission('tasks.self_create') }, async (req, reply) => {
    const body = zSelfTask.parse(req.body);
    const r = await withTx((tx) => createSelfTask(tx, req.actor!, body));
    reply.status(201);
    return r;
  });
}
