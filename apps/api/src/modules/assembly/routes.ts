import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zAssemblyComplete, zUuid } from '@wms/shared';
import { withTx } from '../../db.js';
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

  app.get('/assembly', { preHandler: read }, async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), sku: z.string().trim().optional() }).parse(req.query);
    return withTx((tx) => svc.listAssemblies(tx, q));
  });

  app.get('/assembly/:id', { preHandler: read }, async (req) => withTx((tx) => svc.getAssembly(tx, zUuid.parse((req.params as { id: string }).id))));
}
