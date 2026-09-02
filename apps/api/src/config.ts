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
  IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).default(168),
  // 'false' (default), 'true' (trust all proxies — only on a private network) or a comma-separated list of proxy IPs/CIDRs
  TRUST_PROXY: z.string().default('false'),
  ALLOW_INSECURE_COOKIE: z.string().default('false').transform((v) => v === 'true' || v === '1'),
});

export type Config = z.infer<typeof schema> & { allowedOrigins: string[]; isProd: boolean; isTest: boolean; trustProxy: boolean | string[] };

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
    trustProxy: parsed.data.TRUST_PROXY === 'true' ? true : parsed.data.TRUST_PROXY === 'false' || parsed.data.TRUST_PROXY.trim() === '' ? false : parsed.data.TRUST_PROXY.split(',').map((s) => s.trim()).filter(Boolean),
  };
  if (cfg.isProd && !cfg.COOKIE_SECURE && !cfg.ALLOW_INSECURE_COOKIE) {
    throw new Error('COOKIE_SECURE=false in production is not allowed. Terminate TLS in front of the API and set COOKIE_SECURE=true, or set ALLOW_INSECURE_COOKIE=true explicitly for a trusted private network.');
  }
  if (Object.keys(overrides).length === 0) cached = cfg;
  return cfg;
}
