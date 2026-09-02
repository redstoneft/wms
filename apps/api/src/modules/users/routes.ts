import type { FastifyInstance } from 'fastify';
import { zCreateUser, zUpdateUser, zUuid, type Role } from '@wms/shared';
import { getDb, withTx } from '../../db.js';
import { ConflictError, NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import { hashPassword } from '../../lib/crypto.js';

export async function userRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get('/users', { preHandler: app.requirePermission('users.manage') }, async () => {
    const users = await db.users.findMany({
      include: { user_roles: { include: { role: true } } },
      orderBy: { username: 'asc' },
    });
    return users.map((u) => ({
      id: u.id,
      username: u.username,
      full_name: u.full_name,
      email: u.email,
      is_active: u.is_active,
      mfa_enabled: u.mfa_enabled,
      locked_until: u.locked_until,
      roles: u.user_roles.map((r) => r.role.code),
      created_at: u.created_at,
    }));
  });

  // Lightweight directory for pickers/verifiers assignment (no sensitive data)
  app.get('/users/directory', { preHandler: app.requireAuth }, async () => {
    const users = await db.users.findMany({
      where: { is_active: true },
      select: { id: true, username: true, full_name: true, user_roles: { select: { role: { select: { code: true } } } } },
      orderBy: { username: 'asc' },
    });
    return users.map((u) => ({ id: u.id, username: u.username, full_name: u.full_name, roles: u.user_roles.map((r) => r.role.code) }));
  });

  app.post('/users', { preHandler: app.requirePermission('users.manage') }, async (req, reply) => {
    const body = zCreateUser.parse(req.body);
    const hash = await hashPassword(body.password);
    const user = await withTx(async (tx) => {
      const exists = await tx.users.findUnique({ where: { username: body.username.toLowerCase() } });
      if (exists) throw new ConflictError('USERNAME_TAKEN', 'Username already exists');
      const roles = await tx.roles.findMany({ where: { code: { in: body.roles } } });
      if (roles.length !== body.roles.length) throw new RuleError('UNKNOWN_ROLE', 'Unknown role');
      const u = await tx.users.create({
        data: {
          username: body.username.toLowerCase(),
          full_name: body.full_name,
          email: body.email ?? null,
          password_hash: hash,
          user_roles: { create: roles.map((r) => ({ role_id: r.id })) },
        },
      });
      await audit(tx, req.actor!, { action: 'user.create', entity_type: 'user', entity_id: u.id, after: { username: u.username, roles: body.roles } });
      return u;
    });
    reply.status(201);
    return { id: user.id, username: user.username };
  });

  app.patch('/users/:id', { preHandler: app.requirePermission('users.manage') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const body = zUpdateUser.parse(req.body);
    await withTx(async (tx) => {
      const before = await tx.users.findUnique({ where: { id }, include: { user_roles: { include: { role: true } } } });
      if (!before) throw new NotFoundError('user', id);
      if (id === req.actor!.userId && body.is_active === false) throw new RuleError('SELF_DEACTIVATE', 'You cannot deactivate yourself');
      const data: Record<string, unknown> = {};
      if (body.full_name !== undefined) data.full_name = body.full_name;
      if (body.email !== undefined) data.email = body.email;
      if (body.is_active !== undefined) data.is_active = body.is_active;
      if (body.reset_password) {
        data.password_hash = await hashPassword(body.reset_password);
        data.password_changed_at = new Date();
        data.failed_login_count = 0;
        data.locked_until = null;
      }
      await tx.users.update({ where: { id }, data });
      if (body.roles) {
        const roles = await tx.roles.findMany({ where: { code: { in: body.roles } } });
        if (roles.length !== body.roles.length) throw new RuleError('UNKNOWN_ROLE', 'Unknown role');
        await tx.user_roles.deleteMany({ where: { user_id: id } });
        await tx.user_roles.createMany({ data: roles.map((r) => ({ user_id: id, role_id: r.id })) });
      }
      if (body.is_active === false || body.reset_password) {
        await tx.sessions.updateMany({ where: { user_id: id, revoked_at: null }, data: { revoked_at: new Date() } });
      }
      await audit(tx, req.actor!, {
        action: 'user.update',
        entity_type: 'user',
        entity_id: id,
        before: { full_name: before.full_name, email: before.email, is_active: before.is_active, roles: before.user_roles.map((r) => r.role.code as Role) },
        after: { ...body, reset_password: body.reset_password ? '[set]' : undefined },
      });
    });
    return { ok: true };
  });

  app.post('/users/:id/unlock', { preHandler: app.requirePermission('users.manage') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    await withTx(async (tx) => {
      await tx.users.update({ where: { id }, data: { failed_login_count: 0, locked_until: null } });
      await audit(tx, req.actor!, { action: 'user.unlock', entity_type: 'user', entity_id: id });
    });
    return { ok: true };
  });

  app.post('/users/:id/mfa/reset', { preHandler: app.requirePermission('users.manage') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    await withTx(async (tx) => {
      await tx.users.update({ where: { id }, data: { mfa_enabled: false, mfa_secret_enc: null } });
      await tx.sessions.updateMany({ where: { user_id: id, revoked_at: null }, data: { revoked_at: new Date() } });
      await audit(tx, req.actor!, { action: 'user.mfa_reset', entity_type: 'user', entity_id: id });
    });
    return { ok: true };
  });

  app.get('/roles', { preHandler: app.requireAuth }, async () => {
    return db.roles.findMany({ include: { role_permissions: { include: { permission: true } } }, orderBy: { code: 'asc' } }).then((rs) =>
      rs.map((r) => ({ code: r.code, name: r.name, description: r.description, permissions: r.role_permissions.map((rp) => rp.permission.code) })),
    );
  });
}
