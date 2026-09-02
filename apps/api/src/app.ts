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

/** Best-effort error tracking: POSTs a compact JSON to ERROR_WEBHOOK_URL (Slack/Discord/PagerDuty relay). Never includes bodies or secrets. */
let lastNotify = 0;
function notifyError(requestId: string, method: string, url: string, message: string) {
  const hook = process.env.ERROR_WEBHOOK_URL;
  if (!hook) return;
  const now = Date.now();
  if (now - lastNotify < 5_000) return; // simple flood control
  lastNotify = now;
  fetch(hook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: `WMS API 500 ${method} ${url.split('?')[0]} req=${requestId}: ${message.slice(0, 300)}`, service: 'wms-api', request_id: requestId, at: new Date().toISOString() }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => undefined);
}

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

  // PostgreSQL cannot store NUL bytes in text; reject them up front (found by fuzzing).
  const hasNul = (v: unknown): boolean => {
    if (typeof v === 'string') return v.includes('\u0000');
    if (Array.isArray(v)) return v.some(hasNul);
    if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).some(hasNul);
    return false;
  };
  app.addHook('preValidation', async (req) => {
    if (hasNul(req.body) || hasNul(req.query) || hasNul(req.params)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Input contains NUL characters');
    }
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
    notifyError(req.id, req.method, req.url, anyErr.message ?? 'unknown');
    return reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error', request_id: req.id, ...(cfg.isProd ? {} : { debug: anyErr.message }) });
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
