import type { FastifyBaseLogger } from 'fastify';
import { purgeExpiredIdempotencyKeys } from './lib/idempotency.js';
import { getDb } from './db.js';
import { evaluateReplenishmentRules } from './modules/replenishment/service.js';
import { SYSTEM_ACTOR } from './lib/context.js';

/**
 * Lightweight in-process background jobs. Deliberately simple (no extra
 * infrastructure): each job is idempotent and safe to run on several API
 * instances because all state lives in PostgreSQL with unique constraints.
 */
export function startBackgroundJobs(log: FastifyBaseLogger): () => void {
  const timers: NodeJS.Timeout[] = [];

  const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
    const t = setInterval(async () => {
      try {
        const r = await fn();
        log.debug({ job: name, result: r }, 'job done');
      } catch (e) {
        log.error({ job: name, err: e }, 'job failed');
      }
    }, ms);
    t.unref();
    timers.push(t);
  };

  every(15 * 60_000, 'purge-idempotency-keys', purgeExpiredIdempotencyKeys);
  every(10 * 60_000, 'purge-expired-sessions', async () => {
    const r = await getDb().sessions.deleteMany({ where: { expires_at: { lt: new Date(Date.now() - 7 * 86400_000) } } });
    return r.count;
  });
  every(60_000, 'replenishment-scan', () => evaluateReplenishmentRules(SYSTEM_ACTOR));

  return () => timers.forEach((t) => clearInterval(t));
}
