import { createHash } from 'node:crypto';
import { getDb, sqlState, type Tx, withTx } from '../db.js';
import { ConflictError, translateDbError, ValidationError } from '../errors.js';
import { loadConfig } from '../config.js';
import type { ActorContext } from './context.js';

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

export function fingerprint(method: string, url: string, body: unknown): string {
  return createHash('sha256')
    .update(method)
    .update('\n')
    .update(url)
    .update('\n')
    .update(JSON.stringify(body ?? null, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
    .digest('hex');
}

/**
 * Executes `fn` exactly once per (user, Idempotency-Key).
 *
 *  - The key row is inserted in the SAME transaction as the business change,
 *    so either both commit or neither does (a crash can never produce a
 *    movement without its key or a key without its movement).
 *  - A retry with the same key returns the stored response (replayed=true).
 *  - Two concurrent identical requests: one commits, the other hits the
 *    primary-key conflict on commit, rolls back and replays the stored response.
 *  - Same key with a different payload is rejected (422) — the client is confused.
 */
export async function runIdempotent<T>(
  ctx: ActorContext,
  fp: string,
  fn: (tx: Tx) => Promise<{ status: number; body: T }>,
): Promise<IdempotentResult<T>> {
  const key = ctx.idempotencyKey;
  if (!key) {
    // Movement-producing endpoints are never executed without a key: a retry could otherwise double-record a scan.
    throw new ValidationError('Idempotency-Key header is required for this operation', { code: 'IDEMPOTENCY_KEY_REQUIRED' });
  }
  const scopeKey = `${ctx.userId}:${key}`;
  const db = getDb();

  const existing = await db.idempotency_keys.findUnique({ where: { scope_key: scopeKey } });
  if (existing) return replay(existing, fp);

  const ttlMs = loadConfig().IDEMPOTENCY_TTL_HOURS * 3600 * 1000;
  try {
    const r = await withTx(async (tx) => {
      // Serialize identical keys: concurrent duplicates wait here instead of
      // all executing the business logic and racing on the key insert.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${scopeKey}))`;
      const dup = await tx.idempotency_keys.findUnique({ where: { scope_key: scopeKey } });
      if (dup) return { status: dup.response_code, body: dup.response_body as T, replayed: true as const };
      const out = await fn(tx);
      await tx.idempotency_keys.create({
        data: {
          scope_key: scopeKey,
          user_id: ctx.userId,
          fingerprint: fp,
          response_code: out.status,
          response_body: JSON.parse(JSON.stringify(out.body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))),
          expires_at: new Date(Date.now() + ttlMs),
        },
      });
      return { ...out, replayed: false as const };
    });
    if (r.replayed) {
      const row = await db.idempotency_keys.findUnique({ where: { scope_key: scopeKey } });
      if (row) return replay(row, fp);
    }
    return r;
  } catch (e) {
    if (sqlState(e) === '23505') {
      const again = await db.idempotency_keys.findUnique({ where: { scope_key: scopeKey } });
      if (again) return replay(again, fp);
    }
    const translated = translateDbError(e);
    if (translated) throw translated;
    throw e;
  }
}

function replay<T>(row: { fingerprint: string; response_code: number; response_body: unknown }, fp: string): IdempotentResult<T> {
  if (row.fingerprint !== fp) {
    throw new ConflictError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request payload');
  }
  return { status: row.response_code, body: row.response_body as T, replayed: true };
}

export async function purgeExpiredIdempotencyKeys(): Promise<number> {
  const r = await getDb().idempotency_keys.deleteMany({ where: { expires_at: { lt: new Date() } } });
  return r.count;
}
