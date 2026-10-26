import type { FastifyRequest } from 'fastify';

/**
 * The address clients must use to reach this WMS. Behind the production proxy the inner nginx reports its own scheme
 * (http) in X-Forwarded-Proto while the world speaks https; an http address in a launcher makes the station's POSTs hit
 * the http→https redirect and arrive as GETs (bodies lost). So: https unless we are plainly on a local host.
 */
export function publicOrigin(req: FastifyRequest): string {
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost');
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host) || /\.(localhost|test)(:\d+)?$/i.test(host);
  const forwarded = String(req.headers['x-forwarded-proto'] ?? '');
  const proto = local ? (forwarded || 'http') : 'https';
  return `${proto}://${host}`;
}
