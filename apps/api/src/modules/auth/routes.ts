import type { FastifyInstance } from 'fastify';
import { zChangePassword, zLogin, zMfaVerify } from '@wms/shared';
import { loadConfig } from '../../config.js';
import { UnauthorizedError } from '../../errors.js';
import { cookieOptions, SESSION_COOKIE } from '../../plugins/auth.js';
import * as svc from './service.js';

export async function authRoutes(app: FastifyInstance) {
  const cfg = loadConfig();

  app.post(
    '/auth/login',
    {
      config: { rateLimit: { max: cfg.LOGIN_RATE_LIMIT_MAX, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const body = zLogin.parse(req.body);
      const result = await svc.login({
        username: body.username,
        password: body.password,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        deviceId: body.device_id ?? (req.headers['x-device-id'] as string | undefined) ?? null,
        requestId: req.id,
      });
      reply.setCookie(SESSION_COOKIE, result.token, cookieOptions(result.ttl_hours));
      return {
        user: result.user,
        mfa_required: result.mfa_required,
        mfa_enrollment_required: result.mfa_enrollment_required,
      };
    },
  );

  app.post('/auth/logout', async (req, reply) => {
    if (req.actor && req.sessionId) await svc.logout(req.sessionId, req.actor);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    if (!req.actor) throw new UnauthorizedError();
    return svc.me(req.actor, req.mfaPending);
  });

  // MFA — these endpoints are usable while mfaPending (that is their purpose)
  app.post('/auth/mfa/enroll', async (req) => {
    if (!req.actor) throw new UnauthorizedError();
    return svc.beginMfaEnrollment(req.actor.userId);
  });
  app.post('/auth/mfa/enroll/confirm', async (req) => {
    if (!req.actor || !req.sessionId) throw new UnauthorizedError();
    const { code } = zMfaVerify.parse(req.body);
    await svc.confirmMfaEnrollment(req.actor.userId, req.sessionId, code, req.actor);
    return { ok: true };
  });
  app.post(
    '/auth/mfa/verify',
    { config: { rateLimit: { max: cfg.LOGIN_RATE_LIMIT_MAX, timeWindow: '1 minute' } } },
    async (req) => {
      if (!req.actor || !req.sessionId) throw new UnauthorizedError();
      const { code } = zMfaVerify.parse(req.body);
      await svc.verifyMfa(req.actor.userId, req.sessionId, code, req.actor);
      return { ok: true };
    },
  );

  app.post('/auth/password', { preHandler: app.requireAuth }, async (req) => {
    const body = zChangePassword.parse(req.body);
    await svc.changePassword(req.actor!, body.current_password, body.new_password, req.sessionId);
    return { ok: true };
  });

  app.get('/auth/sessions', { preHandler: app.requireAuth }, async (req) => svc.listSessions(req.actor!.userId));
}
