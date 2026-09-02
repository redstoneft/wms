import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from './generated/prisma/client.js';
import { loadConfig } from './config.js';

// NOTE: no global pg type-parser overrides — Prisma's adapter installs its own
// parsers (BIGINT → bigint for both model queries and $queryRaw). A global
// override breaks Prisma aggregates (count() expects a JS integer).

export type Db = PrismaClient;
export type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

let prisma: PrismaClient | null = null;
let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const cfg = loadConfig();
    pool = new pg.Pool({
      connectionString: cfg.DATABASE_URL,
      max: cfg.isTest ? 60 : 50,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'wms-api',
    });
    pool.on('error', (err) => {
      // logged by server; a broken idle client is discarded by the pool
      console.error('[pg pool] idle client error', err.message);
    });
  }
  return pool;
}

export function getDb(): PrismaClient {
  if (!prisma) {
    const adapter = new PrismaPg(getPool());
    prisma = new PrismaClient({
      adapter,
      log: loadConfig().LOG_LEVEL === 'trace' ? ['query', 'warn', 'error'] : ['warn', 'error'],
      transactionOptions: { maxWait: 5_000, timeout: 30_000 },
    });
  }
  return prisma;
}

export async function closeDb(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Run fn inside a transaction. Retries once on serialization/deadlock failures. */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>, opts?: { retries?: number }): Promise<T> {
  const db = getDb();
  const retries = opts?.retries ?? 2;
  let attempt = 0;
  for (;;) {
    try {
      return await db.$transaction(async (tx) => fn(tx as unknown as Tx));
    } catch (e) {
      const code = sqlState(e);
      // 40001 serialization_failure, 40P01 deadlock_detected
      if ((code === '40001' || code === '40P01') && attempt < retries) {
        attempt++;
        await new Promise((r) => setTimeout(r, 10 + Math.random() * 40 * attempt));
        continue;
      }
      throw e;
    }
  }
}

/** Extracts the PostgreSQL SQLSTATE from a Prisma/pg error, if any. */
export function sqlState(e: unknown): string | undefined {
  if (!e || typeof e !== 'object') return undefined;
  const any = e as {
    code?: unknown;
    meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown; code?: unknown } } };
    cause?: unknown;
    driverAdapterError?: { cause?: { originalCode?: unknown } };
  };
  // Prisma 7 driver adapters: meta.driverAdapterError.cause.originalCode holds the real SQLSTATE
  const adapterCode = any.meta?.driverAdapterError?.cause?.originalCode ?? any.driverAdapterError?.cause?.originalCode;
  if (typeof adapterCode === 'string') return adapterCode;
  if (typeof any.meta?.code === 'string') return any.meta.code;
  if (typeof any.code === 'string' && /^[0-9A-Z]{5}$/.test(any.code)) return any.code;
  if (any.cause) return sqlState(any.cause);
  return undefined;
}

/** Extracts the raw PostgreSQL error message from a Prisma/pg error. */
export function sqlMessage(e: unknown): string {
  if (!e || typeof e !== 'object') return String(e);
  const any = e as { message?: unknown; meta?: { message?: unknown; driverAdapterError?: { cause?: { originalMessage?: unknown; message?: unknown } } }; cause?: unknown };
  const adapterMsg = any.meta?.driverAdapterError?.cause?.originalMessage ?? any.meta?.driverAdapterError?.cause?.message;
  if (typeof adapterMsg === 'string') return adapterMsg;
  if (typeof any.meta?.message === 'string') return any.meta.message;
  if (any.cause) {
    const inner = sqlMessage(any.cause);
    if (inner) return inner;
  }
  return typeof any.message === 'string' ? any.message : String(e);
}
