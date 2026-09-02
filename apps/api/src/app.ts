import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { loadConfig, type Config } from './config.js';
import { AppError, translateDbError } from './errors.js';
import { jsonReplacer } from './lib/serialize.js';
import authPlugin from './plugins/auth.js';
import securityPlugin from './plugins/security.js';
import { registerRoutes } from './routes.js';
import { getDb } from './db.js';

export interface BuildOptions {
  config?: Config;
  logger?: boolean;
}

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const cfg = opts.config ?? loadConfig();
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: cfg.LOG_LEVEL,
            redact: {
              paths: [
                'req.headers.cookie',
                'req.headers.authorization',
                'res.headers["set-cookie"]',
                '*.password',
                '*.new_password',
                '*.current_password',
                '*.token',
                '*.secret',
                '*.mfa_secret_enc',
              ],
              censor: '[REDACTED]',
            },
            ...(cfg.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } } : {}),
          },
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined)?.slice(0, 64) ?? randomUUID(),
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });

  // JSON with bigint support
  app.setReplySerializer((payload) => JSON.stringify(payload, jsonReplacer));
  // Tolerate empty JSON bodies (handheld clients always send Content-Type: application/json)
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (!text.trim()) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  await app.register(helmet, {
    contentSecurityPolicy: false, // API only; the SPA sets its own CSP via nginx
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // same-origin / non-browser
      cb(null, cfg.allowedOrigins.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Requested-With', 'Idempotency-Key', 'X-Device-Id', 'X-Request-Id'],
    exposedHeaders: ['Idempotent-Replayed', 'X-Request-Id'],
  });
  await app.register(cookie, { secret: cfg.APP_ENCRYPTION_KEY, hook: 'onRequest' });
  await app.register(rateLimit, {
    global: true,
    max: cfg.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    keyGenerator: (req) => (req.actor?.userId ?? req.ip) as string,
    allowList: () => cfg.isTest,
  });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 5 } });
  await app.register(securityPlugin);
  await app.register(authPlugin);

  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Request-Id', req.id);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: 'Invalid request',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        request_id: req.id,
      });
    }
    if (err instanceof AppError) {
      if (err.status >= 500) req.log.error({ err }, 'app error');
      return reply.status(err.status).send({ error: err.code, message: err.message, details: err.details, request_id: req.id });
    }
    const translated = translateDbError(err);
    if (translated) {
      return reply.status(translated.status).send({ error: translated.code, message: translated.message, details: translated.details, request_id: req.id });
    }
    const anyErr = err as { statusCode?: number; validation?: unknown; code?: string; message?: string };
    if (anyErr.statusCode === 429) {
      return reply.status(429).send({ error: 'RATE_LIMITED', message: 'Too many requests', request_id: req.id });
    }
    if (anyErr.statusCode && anyErr.statusCode < 500) {
      return reply.status(anyErr.statusCode).send({ error: anyErr.code ?? 'BAD_REQUEST', message: anyErr.message, request_id: req.id });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error', request_id: req.id });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: 'NOT_FOUND', message: `Route ${req.method} ${req.url} not found`, request_id: req.id });
  });

  await registerRoutes(app);

  app.addHook('onClose', async () => {
    // pool is shared across app instances in tests; closed explicitly by the test harness
    void getDb();
  });

  return app;
}
