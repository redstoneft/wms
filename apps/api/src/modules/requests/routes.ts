import type { FastifyInstance } from 'fastify';
import { zRequestDecision, zUuid } from '@wms/shared';
import { withTx } from '../../db.js';
import * as svc from './service.js';

export async function requestRoutes(app: FastifyInstance) {
  const perm = app.requirePermission('counts.approve');

  /** Requests waiting for a decision (re-receipts, counts with differences) + counters of other pending office work. */
  app.get('/requests', { preHandler: perm }, async () => withTx((tx) => svc.listRequests(tx)));

  /** How many are waiting (menu badge). */
  app.get('/requests/pending', { preHandler: perm }, async () => withTx(async (tx) => ({ pending: await svc.pendingRequests(tx) })));

  /** Approve (apply the operator's figures) or reject a request, with a reason. */
  app.post('/requests/:id/decide', { preHandler: perm }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const body = zRequestDecision.parse(req.body);
    return withTx((tx) => svc.decideRequest(tx, req.actor!, id, body));
  });
}
