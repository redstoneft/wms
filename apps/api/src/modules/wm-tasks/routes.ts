import type { FastifyInstance } from 'fastify';
import { zSelfTask } from '@wms/shared';
import { withTx } from '../../db.js';
import { createSelfTask } from './service.js';

export async function wmTaskRoutes(app: FastifyInstance) {
  /** An operator creates a task for themself from the handheld; the purpose is mandatory and audited. */
  app.post('/wm/tasks', { preHandler: app.requirePermission('tasks.self_create') }, async (req, reply) => {
    const body = zSelfTask.parse(req.body);
    const r = await withTx((tx) => createSelfTask(tx, req.actor!, body));
    reply.status(201);
    return r;
  });
}
