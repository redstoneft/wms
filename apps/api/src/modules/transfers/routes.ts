import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zReason, zTransferComplete, zTransferStart, zUuid } from '@wms/shared';
import { getDb, withTx } from '../../db.js';
import { fingerprint, runIdempotent } from '../../lib/idempotency.js';
import * as svc from './service.js';

export async function transferRoutes(app: FastifyInstance) {
  const db = getDb();
  const perm = app.requirePermission('transfers.execute');

  app.get('/transfers', { preHandler: perm }, async (req) => {
    const q = z.object({ status: z.string().default('IN_TRANSIT'), limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(req.query);
    return db.$queryRaw<Record<string, unknown>[]>`
      SELECT t.*, l.code AS lpn_code, f.code AS from_code, d.code AS to_code, d.barcode AS to_barcode, u.username AS started_by_username
        FROM transfers t JOIN lpns l ON l.id = t.lpn_id JOIN locations f ON f.id = t.from_location_id JOIN locations d ON d.id = t.to_location_id
        LEFT JOIN users u ON u.id = t.started_by
       WHERE t.status = ANY(${q.status.split(',')}::text[]) ORDER BY t.started_at DESC LIMIT ${q.limit}`;
  });

  app.post('/transfers/start', { preHandler: perm }, async (req, reply) => {
    const body = zTransferStart.parse(req.body);
    const r = await runIdempotent(req.actor!, fingerprint('POST', '/transfers/start', body), async (tx) => ({ status: 201, body: await svc.startTransfer(tx, req.actor!, body) }));
    reply.status(r.status);
    if (r.replayed) reply.header('Idempotent-Replayed', 'true');
    return r.body;
  });

  app.post('/transfers/complete', { preHandler: perm }, async (req, reply) => {
    const body = zTransferComplete.parse(req.body);
    const r = await runIdempotent(req.actor!, fingerprint('POST', '/transfers/complete', body), async (tx) => ({ status: 200, body: await svc.completeTransfer(tx, req.actor!, body) }));
    if (r.replayed) reply.header('Idempotent-Replayed', 'true');
    return r.body;
  });

  app.post('/transfers/:id/cancel', { preHandler: perm }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const body = z.object({ reason: zReason }).parse(req.body);
    return withTx((tx) => svc.cancelTransfer(tx, req.actor!, id, body.reason));
  });
}
