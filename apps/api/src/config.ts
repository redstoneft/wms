import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_TEST: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_ENCRYPTION_KEY: z.string().min(32, 'APP_ENCRYPTION_KEY must be at least 32 chars (base64 of 32 random bytes)'),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
  COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  UPLOAD_DIR: z.string().default('./uploads'),
  RATE_LIMIT_MAX: z.coerce.number().int().min(10).default(2000), // per IP (many handhelds may share one NAT address)
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(3).default(10),
  IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).default(48),
});

export type Config = z.infer<typeof schema> & { allowedOrigins: string[]; isProd: boolean; isTest: boolean };

let cached: Config | null = null;

export function loadConfig(overrides: Partial<Record<string, string>> = {}): Config {
  if (cached && Object.keys(overrides).length === 0) return cached;
  const env = { ...process.env, ...overrides };
  if (env.NODE_ENV === 'test' && env.DATABASE_URL_TEST) env.DATABASE_URL = env.DATABASE_URL_TEST;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const cfg: Config = {
    ...parsed.data,
    allowedOrigins: parsed.data.ALLOWED_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    isProd: parsed.data.NODE_ENV === 'production',
    isTest: parsed.data.NODE_ENV === 'test',
  };
  if (cfg.isProd && !cfg.COOKIE_SECURE) {
    // Not fatal (may run behind TLS-terminating proxy on http), but loud.
    console.warn('[config] COOKIE_SECURE=false in production — only acceptable behind an HTTPS proxy on a trusted network');
  }
  if (Object.keys(overrides).length === 0) cached = cfg;
  return cfg;
}
