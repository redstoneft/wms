import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zPutawayConfirm, zPutawayScanLpn, zReason, zUuid } from '@wms/shared';
import { getDb, withTx } from '../../db.js';
import { NotFoundError } from '../../errors.js';
import { fingerprint, runIdempotent } from '../../lib/idempotency.js';
import { lockLpnByCode } from '../../inventory/ledger.js';
import * as svc from './service.js';

export async function putawayRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get('/putaway/tasks', { preHandler: app.requirePermission('putaway.execute') }, async (req) => {
    const q = z.object({ status: z.string().default('PENDING,ASSIGNED,IN_PROGRESS'), mine: z.enum(['true', 'false']).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(req.query);
    const rows = await db.$queryRaw<Record<string, unknown>[]>`
      SELECT t.id, t.status, t.created_at, t.started_at, t.assigned_to, t.suggested_location_id, l.code AS lpn_code, l.current_location_id,
             cur.code AS current_location, sug.code AS suggested_location, u.username AS assigned_username,
             (SELECT json_agg(json_build_object('sku', s.code, 'qty', b.qty::text)) FROM inventory_balances b JOIN skus s ON s.id = b.sku_id WHERE b.lpn_id = l.id AND b.qty > 0) AS contents
        FROM putaway_tasks t JOIN lpns l ON l.id = t.lpn_id
        LEFT JOIN locations cur ON cur.id = l.current_location_id LEFT JOIN locations sug ON sug.id = t.suggested_location_id
        LEFT JOIN users u ON u.id = t.assigned_to
       WHERE t.status = ANY(${q.status.split(',')}::text[]) AND (${q.mine !== 'true'} OR t.assigned_to = ${req.actor!.userId}::uuid OR t.assigned_to IS NULL)
       ORDER BY t.created_at LIMIT ${q.limit}`;
    return rows;
  });

  app.get('/putaway/tasks/:id', { preHandler: app.requirePermission('putaway.execute') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const t = await db.putaway_tasks.findUnique({ where: { id }, include: { lpn: { include: { balances: { include: { sku: true } }, current_location: true } } } });
    if (!t) throw new NotFoundError('putaway task', id);
    const suggested = t.suggested_location_id ? await db.locations.findUnique({ where: { id: t.suggested_location_id } }) : null;
    return { ...t, suggested_location: suggested };
  });

  app.post('/putaway/suggest', { preHandler: app.requirePermission('putaway.execute') }, async (req) => {
    const body = zPutawayScanLpn.parse(req.body);
    return withTx(async (tx) => {
      const lpn = await lockLpnByCode(tx, body.lpn_code);
      return svc.suggestLocation(tx, lpn);
    });
  });

  app.post('/putaway/start', { preHandler: app.requirePermission('putaway.execute') }, async (req) => {
    const body = zPutawayScanLpn.parse(req.body);
    return withTx((tx) => svc.startPutaway(tx, req.actor!, body.lpn_code));
  });

  app.post('/putaway/confirm', { preHandler: app.requirePermission('putaway.execute') }, async (req, reply) => {
    const body = zPutawayConfirm.parse(req.body);
    const r = await runIdempotent(req.actor!, fingerprint('POST', '/putaway/confirm', body), async (tx) => ({ status: 200, body: await svc.confirmPutaway(tx, req.actor!, body) }));
    if (r.replayed) reply.header('Idempotent-Replayed', 'true');
    return r.body;
  });

  app.post('/putaway/tasks/:id/resuggest', { preHandler: app.requirePermission('putaway.execute') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    return withTx((tx) => svc.resuggest(tx, req.actor!, id));
  });

  app.post('/putaway/tasks/:id/cancel', { preHandler: app.requirePermission('putaway.override') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const body = z.object({ reason: zReason }).parse(req.body);
    return withTx((tx) => svc.cancelPutaway(tx, req.actor!, id, body.reason));
  });

  app.get('/slotting/rules', { preHandler: app.requirePermission('layout.read') }, async () => db.slotting_rules.findMany({ orderBy: { priority: 'asc' } }));
  app.post('/slotting/rules', { preHandler: app.requirePermission('settings.manage') }, async (req, reply) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(100),
        priority: z.number().int().min(1).max(1000).default(100),
        weights: z.object({ same_sku: z.number(), abc_proximity: z.number(), zone_match: z.number(), fill_rack: z.number(), level_low_heavy: z.number(), family_affinity: z.number() }).partial(),
        conditions: z.object({ family: z.string().optional(), abc_class: z.enum(['A', 'B', 'C']).optional() }).optional(),
      })
      .parse(req.body);
    const r = await db.slotting_rules.create({ data: { name: body.name, priority: body.priority, weights: body.weights, conditions: body.conditions ?? undefined } });
    reply.status(201);
    return r;
  });
  app.delete('/slotting/rules/:id', { preHandler: app.requirePermission('settings.manage') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    await db.slotting_rules.update({ where: { id }, data: { is_active: false } });
    return { ok: true };
  });
}
