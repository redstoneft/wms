import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import { permissionsForRoles, type Permission, type Role } from '@wms/shared';
import { getDb } from '../db.js';
import { ForbiddenError, UnauthorizedError } from '../errors.js';
import { sha256 } from '../lib/crypto.js';
import type { ActorContext } from '../lib/context.js';
import { loadConfig } from '../config.js';
import { getSettingsCached } from '../modules/settings/routes.js';

export const SESSION_COOKIE = 'wms_session';
/** long-lived, signed, HttpOnly: proves this browser already passed MFA ("recordar este dispositivo") */
export const TRUSTED_COOKIE = 'wms_trusted';

declare module 'fastify' {
  interface FastifyRequest {
    actor: ActorContext | null;
    sessionId: string | null;
    mfaPending: boolean;
  }
  interface FastifyInstance {
    requireAuth: preHandlerHookHandler;
    requirePermission: (...perms: Permission[]) => preHandlerHookHandler;
  }
}

export interface SessionUser {
  id: string;
  username: string;
  roles: Role[];
  mfa_enabled: boolean;
  mfa_verified: boolean;
  is_active: boolean;
}

/**
 * Resolves the session cookie to an actor on every request. Sessions are
 * opaque random tokens stored hashed; expiry and revocation are enforced here,
 * and last_seen is bumped at most once per minute.
 */
async function resolveSession(req: FastifyRequest): Promise<void> {
  req.actor = null;
  req.sessionId = null;
  req.mfaPending = false;
  const raw = req.cookies?.[SESSION_COOKIE];
  if (!raw) return;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return;
  const tokenHash = sha256(unsigned.value);
  const db = getDb();
  const session = await db.sessions.findUnique({
    where: { token_hash: tokenHash },
    include: { user: { include: { user_roles: { include: { role: true } } } } },
  });
  if (!session || session.revoked_at || session.expires_at < new Date()) return;
  if (!session.user.is_active) return;
  const roles = session.user.user_roles.map((ur) => ur.role.code as Role);
  const settings = await getSettingsCached();
  const requiresMfa = session.user.mfa_enabled || (roles.includes('ADMIN') && settings.require_mfa_for_admin !== false);
  req.mfaPending = requiresMfa && !session.mfa_verified;
  req.sessionId = session.id;
  req.actor = {
    userId: session.user.id,
    username: session.user.username,
    roles,
    permissions: req.mfaPending ? new Set<Permission>() : permissionsForRoles(roles),
    deviceId: (req.headers['x-device-id'] as string | undefined)?.slice(0, 128) ?? session.device_id ?? null,
    ip: req.ip,
    requestId: req.id,
    idempotencyKey: (req.headers['idempotency-key'] as string | undefined)?.slice(0, 200) ?? null,
  };
  if (Date.now() - session.last_seen_at.getTime() > 60_000) {
    db.sessions.update({ where: { id: session.id }, data: { last_seen_at: new Date() } }).catch(() => undefined);
  }
}

export default fp(async function authPlugin(app: FastifyInstance) {
  app.decorateRequest('actor', null);
  app.decorateRequest('sessionId', null);
  app.decorateRequest('mfaPending', false);
  app.addHook('preHandler', async (req) => {
    await resolveSession(req);
  });

  app.decorate('requireAuth', async function (req: FastifyRequest, _reply: FastifyReply) {
    if (!req.actor) throw new UnauthorizedError();
    if (req.mfaPending) throw new ForbiddenError('MFA verification required', { code: 'MFA_REQUIRED' });
  });

  app.decorate('requirePermission', (...perms: Permission[]) => {
    return async function (req: FastifyRequest, _reply: FastifyReply) {
      if (!req.actor) throw new UnauthorizedError();
      if (req.mfaPending) throw new ForbiddenError('MFA verification required', { code: 'MFA_REQUIRED' });
      const missing = perms.filter((p) => !req.actor!.permissions.has(p));
      if (missing.length) throw new ForbiddenError(`Missing permission: ${missing.join(', ')}`, { missing });
    };
  });
});

export function cookieOptions(ttlHours?: number) {
  const cfg = loadConfig();
  return {
    path: '/',
    httpOnly: true,
    secure: cfg.COOKIE_SECURE,
    sameSite: 'strict' as const,
    signed: true,
    maxAge: (ttlHours ?? cfg.SESSION_TTL_HOURS) * 3600,
  };
}
