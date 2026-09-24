import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zAssemblyComplete, zAssemblyFinish, zAssemblyStart, zReason, zUuid } from '@wms/shared';
import { withTx } from '../../db.js';
import { includeTraining } from '../../lib/training-scope.js';
import { fingerprint, runIdempotent } from '../../lib/idempotency.js';
import * as svc from './service.js';

export async function assemblyRoutes(app: FastifyInstance) {
  const exec = app.requirePermission('assembly.execute');
  const read = app.requirePermission('inventory.read');

  /** One call does the whole conversion atomically (idempotent: the same body twice returns the same order). */
  app.post('/assembly', { preHandler: exec }, async (req, reply) => {
    const body = zAssemblyComplete.parse(req.body);
    const r = await runIdempotent(req.actor!, fingerprint('POST', '/assembly', body), async (tx) => ({ status: 201, body: await svc.completeAssembly(tx, req.actor!, body) }));
    reply.status(r.status);
    if (r.replayed) reply.header('Idempotent-Replayed', 'true');
    return r.body;
  });

  /** Phase 1: components go to the station and stay blocked; the order is open (IN_PROGRESS). */
  app.post('/assembly/start', { preHandler: exec }, async (req, reply) => {
    const body = zAssemblyStart.parse(req.body);
    const r = await runIdempotent(req.actor!, fingerprint('POST', '/assembly/start', body), async (tx) => ({ status: 201, body: await svc.startAssembly(tx, req.actor!, body) }));
    reply.status(r.status);
    if (r.replayed) reply.header('Idempotent-Replayed', 'true');
    return r.body;
  });
  /** Phase 2: pallets produced + defective pieces; inputs consumed, order COMPLETED. */
  app.post('/assembly/:id/complete', { preHandler: exec }, async (req, reply) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const body = zAssemblyFinish.parse(req.body);
    const r = await runIdempotent(req.actor!, fingerprint('POST', `/assembly/${id}/complete`, body), async (tx) => ({ status: 200, body: await svc.finishAssembly(tx, req.actor!, id, body) }));
    if (r.replayed) reply.header('Idempotent-Replayed', 'true');
    return r.body;
  });
  app.post('/assembly/:id/cancel', { preHandler: exec }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const body = z.object({ reason: zReason }).parse(req.body);
    return withTx((tx) => svc.cancelAssembly(tx, req.actor!, id, body.reason));
  });

  app.get('/assembly', { preHandler: read }, async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), sku: z.string().trim().optional(), status: z.string().trim().optional() }).parse(req.query);
    const include_training = await includeTraining(req);
    return withTx((tx) => svc.listAssemblies(tx, { ...q, include_training }));
  });

  app.get('/assembly/:id', { preHandler: read }, async (req) => withTx((tx) => svc.getAssembly(tx, zUuid.parse((req.params as { id: string }).id))));
}
