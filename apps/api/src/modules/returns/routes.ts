import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zClassifyReturnLine, zCreateReturn, zReceiveReturnLine, zUuid } from '@wms/shared';
import { getDb, withTx } from '../../db.js';
import { NotFoundError } from '../../errors.js';
import { fingerprint, runIdempotent } from '../../lib/idempotency.js';
import * as svc from './service.js';

export async function returnRoutes(app: FastifyInstance) {
  const db = getDb();
  const perm = app.requirePermission('returns.manage');

  app.get('/returns', { preHandler: app.requirePermission('orders.read') }, async (req) => {
    const q = z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return db.returns.findMany({ where: q.status ? { status: { in: q.status.split(',') } } : {}, include: { customer: true, original_order: { select: { order_number: true } }, lines: { include: { sku: true } } }, orderBy: { created_at: 'desc' }, take: q.limit });
  });
  app.get('/returns/:id', { preHandler: app.requirePermission('orders.read') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const r = await db.returns.findUnique({ where: { id }, include: { customer: true, original_order: true, lines: { include: { sku: true } } } });
    if (!r) throw new NotFoundError('return', id);
    const lpns = await db.lpns.findMany({ where: { id: { in: r.lines.map((l) => l.lpn_id).filter((x): x is string => !!x) } }, select: { id: true, code: true, status: true } });
    return { ...r, lpns };
  });
  app.post('/returns', { preHandler: perm }, async (req, reply) => {
    const body = zCreateReturn.parse(req.body);
    const r = await withTx((tx) => svc.createReturn(tx, req.actor!, body));
    reply.status(201);
    return r;
  });
  app.post('/returns/receive', { preHandler: perm }, async (req, reply) => {
    const body = zReceiveReturnLine.parse(req.body);
    const r = await runIdempotent(req.actor!, fingerprint('POST', '/returns/receive', body), async (tx) => ({ status: 200, body: await svc.receiveReturnLine(tx, req.actor!, body) }));
    if (r.replayed) reply.header('Idempotent-Replayed', 'true');
    return r.body;
  });
  app.post('/returns/classify', { preHandler: perm }, async (req, reply) => {
    const body = zClassifyReturnLine.parse(req.body);
    const r = await runIdempotent(req.actor!, fingerprint('POST', '/returns/classify', body), async (tx) => ({ status: 200, body: await svc.classifyReturnLine(tx, req.actor!, body) }));
    if (r.replayed) reply.header('Idempotent-Replayed', 'true');
    return r.body;
  });
  app.post('/returns/:id/close', { preHandler: perm }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    return withTx((tx) => svc.closeReturn(tx, req.actor!, id));
  });
}
