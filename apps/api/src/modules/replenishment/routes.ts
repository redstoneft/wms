import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zReplenRule, zUuid } from '@wms/shared';
import { getDb, withTx } from '../../db.js';
import * as svc from './service.js';

export async function replenishmentRoutes(app: FastifyInstance) {
  const db = getDb();
  app.get('/replenishment/rules', { preHandler: app.requirePermission('inventory.read') }, async () =>
    db.$queryRaw<Record<string, unknown>[]>`
      SELECT r.*, s.code AS sku_code, l.code AS location_code,
             COALESCE((SELECT sum(b.qty) FROM lpns lp JOIN inventory_balances b ON b.lpn_id = lp.id AND b.sku_id = r.sku_id AND b.status IN ('AVAILABLE','ALLOCATED') WHERE lp.current_location_id = r.pick_location_id), 0)::text AS current_qty
        FROM replenishment_rules r JOIN skus s ON s.id = r.sku_id JOIN locations l ON l.id = r.pick_location_id ORDER BY s.code`,
  );
  app.post('/replenishment/rules', { preHandler: app.requirePermission('counts.manage') }, async (req, reply) => {
    const body = zReplenRule.parse(req.body);
    const r = await withTx((tx) => svc.upsertRule(tx, req.actor!, body));
    reply.status(201);
    return r;
  });
  app.delete('/replenishment/rules/:id', { preHandler: app.requirePermission('counts.manage') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    await db.replenishment_rules.update({ where: { id }, data: { is_active: false } });
    return { ok: true };
  });
  app.get('/replenishment/tasks', { preHandler: app.requirePermission('replenishment.execute') }, async (req) => {
    const q = z.object({ status: z.string().default('PENDING,IN_PROGRESS') }).parse(req.query);
    return svc.listTasks(q.status.split(','));
  });
  app.post('/replenishment/evaluate', { preHandler: app.requirePermission('counts.manage') }, async (req) => svc.evaluateReplenishmentRules(req.actor!));
  app.post('/replenishment/tasks/:id/start', { preHandler: app.requirePermission('replenishment.execute') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    return withTx((tx) => svc.startReplenishment(tx, req.actor!, id));
  });
}
