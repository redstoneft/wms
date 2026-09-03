import type { FastifyInstance } from 'fastify';
import { zChangePassword, zLogin, zMfaVerify } from '@wms/shared';
import { loadConfig } from '../../config.js';
import { UnauthorizedError } from '../../errors.js';
import { cookieOptions, SESSION_COOKIE, TRUSTED_COOKIE } from '../../plugins/auth.js';
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
        trustedToken: (() => {
          const raw = req.cookies?.[TRUSTED_COOKIE];
          if (!raw) return null;
          const u = req.unsignCookie(raw);
          return u.valid ? u.value : null;
        })(),
      });
      reply.setCookie(SESSION_COOKIE, result.token, cookieOptions(result.ttl_hours));
      return {
        user: result.user,
        mfa_required: result.mfa_required,
        mfa_enrollment_required: result.mfa_enrollment_required,
        mfa_via_trusted_device: result.mfa_via_trusted_device ?? false,
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
    async (req, reply) => {
      if (!req.actor || !req.sessionId) throw new UnauthorizedError();
      const { code, remember_device } = zMfaVerify.parse(req.body);
      const r = await svc.verifyMfa(req.actor.userId, req.sessionId, code, { ...req.actor, userAgent: req.headers['user-agent'] ?? null }, remember_device);
      // the trusted-device cookie outlives the session on purpose: it is what lets this browser skip MFA next time
      if (r.trusted_token) reply.setCookie(TRUSTED_COOKIE, r.trusted_token, { ...cookieOptions(), maxAge: r.trusted_days * 86400 });
      return { ok: true, device_remembered: !!r.trusted_token, trusted_days: r.trusted_token ? r.trusted_days : 0 };
    },
  );

  /** Browsers remembered for MFA ("dispositivos de confianza") of the current user. */
  app.get('/auth/devices', { preHandler: app.requireAuth }, async (req) => svc.listTrustedDevices(req.actor!.userId));
  app.delete('/auth/devices/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const n = await svc.revokeTrustedDevices(req.actor!, req.actor!.userId, id);
    if (req.cookies?.[TRUSTED_COOKIE]) reply.clearCookie(TRUSTED_COOKIE, { path: '/' });
    return { ok: true, revoked: n };
  });
  app.delete('/auth/devices', { preHandler: app.requireAuth }, async (req, reply) => {
    const n = await svc.revokeTrustedDevices(req.actor!, req.actor!.userId, null);
    reply.clearCookie(TRUSTED_COOKIE, { path: '/' });
    return { ok: true, revoked: n };
  });

  app.post('/auth/password', { preHandler: app.requireAuth }, async (req) => {
    const body = zChangePassword.parse(req.body);
    await svc.changePassword(req.actor!, body.current_password, body.new_password, req.sessionId);
    return { ok: true };
  });

  app.get('/auth/sessions', { preHandler: app.requireAuth }, async (req) => svc.listSessions(req.actor!.userId));
}
