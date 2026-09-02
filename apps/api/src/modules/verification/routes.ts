import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zCompleteVerification, zStartVerification, zUuid, zVerifyScan } from '@wms/shared';
import { getDb, withTx } from '../../db.js';
import { fingerprint, runIdempotent } from '../../lib/idempotency.js';
import * as svc from './service.js';

export async function verificationRoutes(app: FastifyInstance) {
  const db = getDb();
  const perm = app.requirePermission('verification.execute');

  app.get('/verifications/pending-orders', { preHandler: perm }, async () =>
    db.$queryRaw<Record<string, unknown>[]>`
      SELECT o.id, o.order_number, o.priority, c.name AS customer, o.picker_id, u.username AS picker, sl.code AS staging_code,
             (SELECT count(*) FROM lpns l WHERE l.order_id = o.id AND l.status = 'STAGED') AS staged_lpns
        FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN users u ON u.id = o.picker_id
        LEFT JOIN staging_assignments sa ON sa.order_id = o.id AND sa.released_at IS NULL LEFT JOIN locations sl ON sl.id = sa.location_id
       WHERE o.status = 'STAGED' ORDER BY o.priority, o.created_at`,
  );

  app.get('/verifications/:id', { preHandler: perm }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    return withTx((tx) => svc.verificationView(tx, id, req.actor!));
  });

  app.post('/verifications/start', { preHandler: perm }, async (req, reply) => {
    const body = zStartVerification.parse(req.body);
    const r = await withTx((tx) => svc.startVerification(tx, req.actor!, body));
    reply.status(201);
    return r;
  });

  app.post('/verifications/scan', { preHandler: perm }, async (req, reply) => {
    const body = zVerifyScan.parse(req.body);
    const r = await runIdempotent(req.actor!, fingerprint('POST', '/verifications/scan', body), async (tx) => ({ status: 200, body: await svc.verifyScan(tx, req.actor!, body) }));
    if (r.replayed) reply.header('Idempotent-Replayed', 'true');
    return r.body;
  });

  app.post('/verifications/complete', { preHandler: perm }, async (req) => {
    const body = zCompleteVerification.parse(req.body);
    return withTx((tx) => svc.completeVerification(tx, req.actor!, body.verification_id));
  });

  app.get('/verifications', { preHandler: perm }, async (req) => {
    const q = z.object({ order_id: zUuid.optional(), status: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return db.verifications.findMany({ where: { ...(q.order_id ? { order_id: q.order_id } : {}), ...(q.status ? { status: q.status } : {}) }, include: { order: { select: { order_number: true } } }, orderBy: { started_at: 'desc' }, take: q.limit });
  });
}
