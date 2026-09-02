import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db.js';

export async function auditRoutes(app: FastifyInstance) {
  const db = getDb();
  app.get('/audit', { preHandler: app.requirePermission('audit.read') }, async (req) => {
    const q = z
      .object({
        entity_type: z.string().max(60).optional(),
        entity_id: z.string().max(64).optional(),
        user_id: z.string().uuid().optional(),
        action: z.string().max(80).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        before_id: z.coerce.bigint().optional(),
      })
      .parse(req.query);
    const items = await db.audit_logs.findMany({
      where: {
        ...(q.entity_type ? { entity_type: q.entity_type } : {}),
        ...(q.entity_id ? { entity_id: q.entity_id } : {}),
        ...(q.user_id ? { user_id: q.user_id } : {}),
        ...(q.action ? { action: { startsWith: q.action } } : {}),
        ...(q.from || q.to ? { occurred_at: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
        ...(q.before_id ? { id: { lt: q.before_id } } : {}),
      },
      orderBy: { id: 'desc' },
      take: q.limit,
    });
    return { items, next_before_id: items.length === q.limit ? items[items.length - 1]!.id : null };
  });
}
