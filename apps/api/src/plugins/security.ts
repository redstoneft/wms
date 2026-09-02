import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { loadConfig } from '../config.js';
import { ForbiddenError } from '../errors.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF defense in depth for a cookie-authenticated JSON API:
 *  1. Session cookie is SameSite=Strict (browsers don't send it cross-site).
 *  2. Every mutating request must carry `X-Requested-With: wms-client`
 *     (a custom header forces a CORS preflight, which cross-origin pages fail).
 *  3. If an Origin/Referer header is present it must be in ALLOWED_ORIGINS.
 */
export default fp(async function securityPlugin(app: FastifyInstance) {
  const cfg = loadConfig();
  const allowed = new Set(cfg.allowedOrigins);

  app.addHook('onRequest', async (req) => {
    if (!MUTATING.has(req.method)) return;
    const xrw = req.headers['x-requested-with'];
    if (xrw !== 'wms-client') {
      throw new ForbiddenError('Missing X-Requested-With header', { code: 'CSRF' });
    }
    const origin = req.headers.origin;
    if (origin && !allowed.has(origin)) throw new ForbiddenError('Origin not allowed', { code: 'CSRF' });
    if (!origin && req.headers.referer) {
      try {
        const u = new URL(req.headers.referer);
        if (!allowed.has(u.origin)) throw new ForbiddenError('Referer not allowed', { code: 'CSRF' });
      } catch (e) {
        if (e instanceof ForbiddenError) throw e;
        throw new ForbiddenError('Bad referer', { code: 'CSRF' });
      }
    }
  });
});
