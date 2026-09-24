import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { permissionsForRoles, zAuthorize, zInlineAuthorize, zUuid, type Role } from '@wms/shared';
import { getDb, withTx, type Tx } from '../../db.js';
import { AppError, ForbiddenError, NotFoundError, RuleError, UnauthorizedError } from '../../errors.js';
import { loadConfig } from '../../config.js';
import { decryptSecret, verifyPassword, verifyTotp } from '../../lib/crypto.js';
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
  ctx: ActorContext,
  /** additional users who must NOT be the authorizing supervisor (e.g. the picker of the order being verified) */
  alsoNot: Array<string | null | undefined> = [],
): Promise<{ supervisor_id: string; reason: string }> {
  const rows = await tx.$queryRaw<{ id: string; exception_type: string; entity_type: string; entity_id: string; status: string; supervisor_id: string; reason: string }[]>`
    SELECT id, exception_type, entity_type, entity_id, status, supervisor_id, reason FROM authorizations WHERE id = ${id}::uuid FOR UPDATE`;
  const a = rows[0];
  if (!a) throw new NotFoundError('authorization', id);
  if (a.status !== 'APPROVED') throw new RuleError('AUTHORIZATION_USED', `Authorization already ${a.status.toLowerCase()}`);
  if (a.exception_type !== expected.exception_type || a.entity_type !== expected.entity_type || a.entity_id !== expected.entity_id) {
    throw new RuleError('AUTHORIZATION_MISMATCH', 'Authorization does not match this operation', { expected, got: a });
  }
  // separation of duties: the person executing the exception (or otherwise involved) can never be its own authorizer
  if (a.supervisor_id === ctx.userId || alsoNot.some((u) => u && u === a.supervisor_id)) {
    throw new RuleError('SELF_AUTHORIZATION', 'The authorizing supervisor cannot be the same person who executes or is involved in the exception');
  }
  await tx.authorizations.update({ where: { id }, data: { status: 'CONSUMED', consumed_at: new Date() } });
  return { supervisor_id: a.supervisor_id, reason: a.reason };
}

export async function createAuthorization(tx: Tx, ctx: ActorContext, input: z.infer<typeof zAuthorize>) {
  if (!ctx.permissions.has('exceptions.authorize')) throw new ForbiddenError('Only supervisors can authorize exceptions');
  if (input.exception_type === 'FORCE_RELEASE_NOT_ALLOWED') {
    throw new RuleError('RELEASE_CANNOT_BE_FORCED', 'A shipment release can never be forced: every SKU must be loaded exactly as required');
  }
  if (input.exception_type === 'PUTAWAY_LOCATION_OVERRIDE' && !ctx.permissions.has('putaway.override')) {
    throw new ForbiddenError('putaway.override permission required to authorize location overrides');
  }
  if (input.requested_by && input.requested_by === ctx.userId) {
    throw new RuleError('SELF_AUTHORIZATION', 'A supervisor cannot authorize an exception requested by themselves');
  }
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

  /**
   * Inline authorization from the operator's handheld: the supervisor types their own username/password (and MFA
   * code if enrolled) on the spot. Same rules as an office authorization: the supervisor needs exceptions.authorize
   * (and putaway.override for location overrides) and can never be the operator requesting it. Failed passwords
   * count towards the supervisor's account lockout exactly like a login.
   */
  app.post('/authorizations/inline', async (req, reply) => {
    const body = zInlineAuthorize.parse(req.body);
    const actor = req.actor!;
    const cfg = loadConfig();
    const user = await db.users.findUnique({ where: { username: body.username.toLowerCase() }, include: { user_roles: { include: { role: true } } } });
    const dummy = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const ok = await verifyPassword(body.password, user?.password_hash ?? dummy);
    if (!user || !user.is_active) throw new UnauthorizedError('Usuario o contraseña del supervisor incorrectos');
    if (user.locked_until && user.locked_until > new Date()) throw new AppError(423, 'ACCOUNT_LOCKED', 'La cuenta del supervisor está bloqueada temporalmente');
    const fail = async (action: string) => {
      const failed = user.failed_login_count + 1;
      await db.users.update({ where: { id: user.id }, data: { failed_login_count: failed, locked_until: failed >= 10 ? new Date(Date.now() + 15 * 60_000) : null } });
      await db.audit_logs.create({ data: { user_id: user.id, username: user.username, action, entity_type: body.entity_type, entity_id: body.entity_id, ip: actor.ip, request_id: actor.requestId } });
    };
    if (!ok) {
      await fail('auth.inline_authorize_failed');
      throw new UnauthorizedError('Usuario o contraseña del supervisor incorrectos');
    }
    if (user.mfa_enabled) {
      if (!body.code) throw new RuleError('MFA_CODE_REQUIRED', 'Este supervisor usa código de verificación (MFA): captúralo también', { mfa: true });
      if (!user.mfa_secret_enc || !verifyTotp(decryptSecret(user.mfa_secret_enc, cfg.APP_ENCRYPTION_KEY), body.code)) {
        await fail('auth.inline_authorize_mfa_failed');
        throw new UnauthorizedError('Código de verificación incorrecto');
      }
    }
    if (user.id === actor.userId) throw new RuleError('SELF_AUTHORIZATION', 'Quien ejecuta la excepción no puede autorizarla; debe autorizar otro supervisor');
    const roles = user.user_roles.map((r) => r.role.code as Role);
    const supCtx = { ...actor, userId: user.id, username: user.username, roles, permissions: permissionsForRoles(roles) };
    const a = await withTx((tx) => createAuthorization(tx, supCtx, { exception_type: body.exception_type, entity_type: body.entity_type, entity_id: body.entity_id, requested_by: actor.userId, reason: body.reason }));
    await db.users.update({ where: { id: user.id }, data: { failed_login_count: 0 } });
    reply.status(201);
    return { id: a.id, supervisor: user.username, reason: a.reason };
  });
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
