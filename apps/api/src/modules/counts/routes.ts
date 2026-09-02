import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zApproveCount, zCreateCount, zSubmitCount, zUuid } from '@wms/shared';
import { getDb, withTx } from '../../db.js';
import { fingerprint, runIdempotent } from '../../lib/idempotency.js';
import * as svc from './service.js';

export async function countRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get('/counts', { preHandler: app.requirePermission('counts.execute') }, async (req) => {
    const q = z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const tasks = await db.count_tasks.findMany({
      where: q.status ? { status: { in: q.status.split(',') } } : {},
      include: { _count: { select: { lines: true } } },
      orderBy: { created_at: 'desc' },
      take: q.limit,
    });
    return tasks.map((t) => ({ ...t, lines: t._count.lines }));
  });

  app.get('/counts/:id', { preHandler: app.requirePermission('counts.execute') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    return withTx((tx) => svc.taskForCounter(tx, id, req.actor!));
  });

  app.post('/counts', { preHandler: app.requirePermission('counts.manage') }, async (req, reply) => {
    const body = zCreateCount.parse(req.body);
    const t = await withTx((tx) => svc.createCountTask(tx, req.actor!, body));
    reply.status(201);
    return t;
  });

  app.post('/counts/submit', { preHandler: app.requirePermission('counts.execute') }, async (req, reply) => {
    const body = zSubmitCount.parse(req.body);
    const r = await runIdempotent(req.actor!, fingerprint('POST', '/counts/submit', body), async (tx) => ({ status: 200, body: await svc.submitCount(tx, req.actor!, body) }));
    if (r.replayed) reply.header('Idempotent-Replayed', 'true');
    return r.body;
  });

  app.post('/counts/:id/finish', { preHandler: app.requirePermission('counts.execute') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    return withTx((tx) => svc.finishCounting(tx, req.actor!, id));
  });

  app.post('/counts/approve', { preHandler: app.requirePermission('counts.approve') }, async (req) => {
    const body = zApproveCount.parse(req.body);
    return withTx((tx) => svc.approveCount(tx, req.actor!, body));
  });
}
