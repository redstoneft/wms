import type { FastifyInstance } from 'fastify';
import { zHandheldOrder, zLpnRecount, zSelfTask } from '@wms/shared';
import { withTx } from '../../db.js';
import { createHandheldOrder, createSelfTask, recountLpn } from './service.js';

export async function wmTaskRoutes(app: FastifyInstance) {
  /** Re-receive a pallet (what it really holds). Applied at once with counts.approve; otherwise a finished count for approval. */
  app.post('/wm/lpn-recount', { preHandler: app.requirePermission('tasks.self_create') }, async (req, reply) => {
    const body = zLpnRecount.parse(req.body);
    const r = await withTx((tx) => recountLpn(tx, req.actor!, body));
    reply.status(201);
    return r;
  });
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
