import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zAuthorize, zUuid } from '@wms/shared';
import { getDb, withTx, type Tx } from '../../db.js';
import { ForbiddenError, NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';

/**
 * Supervisor authorizations for exceptions. Exactly one APPROVED authorization
 * can exist per (exception_type, entity) — enforced by a partial unique index —
 * so two supervisors can never both approve the same exception. Consuming an
 * authorization is atomic with the operation that uses it.
 */
export async function consumeAuthorization(
  tx: Tx,
  id: string,
  expected: { exception_type: string; entity_type: string; entity_id: string },
): Promise<{ supervisor_id: string; reason: string }> {
  const rows = await tx.$queryRaw<{ id: string; exception_type: string; entity_type: string; entity_id: string; status: string; supervisor_id: string; reason: string }[]>`
    SELECT id, exception_type, entity_type, entity_id, status, supervisor_id, reason FROM authorizations WHERE id = ${id}::uuid FOR UPDATE`;
  const a = rows[0];
  if (!a) throw new NotFoundError('authorization', id);
  if (a.status !== 'APPROVED') throw new RuleError('AUTHORIZATION_USED', `Authorization already ${a.status.toLowerCase()}`);
  if (a.exception_type !== expected.exception_type || a.entity_type !== expected.entity_type || a.entity_id !== expected.entity_id) {
    throw new RuleError('AUTHORIZATION_MISMATCH', 'Authorization does not match this operation', { expected, got: a });
  }
  await tx.authorizations.update({ where: { id }, data: { status: 'CONSUMED', consumed_at: new Date() } });
  return { supervisor_id: a.supervisor_id, reason: a.reason };
}

export async function createAuthorization(tx: Tx, ctx: ActorContext, input: z.infer<typeof zAuthorize>) {
  if (!ctx.permissions.has('exceptions.authorize')) throw new ForbiddenError('Only supervisors can authorize exceptions');
  const a = await tx.authorizations.create({
    data: {
      exception_type: input.exception_type,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      requested_by: input.requested_by ?? ctx.userId,
      supervisor_id: ctx.userId,
      reason: input.reason,
    },
  });
  await audit(tx, ctx, { action: 'exception.authorize', entity_type: input.entity_type, entity_id: input.entity_id, after: a, reason: input.reason });
  return a;
}

export async function authorizationRoutes(app: FastifyInstance) {
  const db = getDb();
  app.get('/authorizations', { preHandler: app.requirePermission('exceptions.authorize') }, async (req) => {
    const q = z.object({ entity_type: z.string().optional(), entity_id: z.string().optional(), status: z.string().optional() }).parse(req.query);
    return db.authorizations.findMany({
      where: { ...(q.entity_type ? { entity_type: q.entity_type } : {}), ...(q.entity_id ? { entity_id: q.entity_id } : {}), ...(q.status ? { status: q.status } : {}) },
      orderBy: { created_at: 'desc' },
      take: 200,
    });
  });
  app.post('/authorizations', { preHandler: app.requirePermission('exceptions.authorize') }, async (req, reply) => {
    const body = zAuthorize.parse(req.body);
    const a = await withTx((tx) => createAuthorization(tx, req.actor!, body));
    reply.status(201);
    return a;
  });
  app.post('/authorizations/:id/revoke', { preHandler: app.requirePermission('exceptions.authorize') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    return withTx(async (tx) => {
      const a = await tx.authorizations.findUnique({ where: { id } });
      if (!a) throw new NotFoundError('authorization', id);
      if (a.status !== 'APPROVED') throw new RuleError('AUTHORIZATION_USED', `Authorization already ${a.status.toLowerCase()}`);
      const r = await tx.authorizations.update({ where: { id }, data: { status: 'REVOKED' } });
      await audit(tx, req.actor!, { action: 'exception.revoke', entity_type: a.entity_type, entity_id: a.entity_id, before: a, after: r });
      return r;
    });
  });
}
