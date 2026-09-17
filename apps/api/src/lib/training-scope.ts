import type { FastifyRequest } from 'fastify';
import { getDb } from '../db.js';

/**
 * Operational screens hide what was done in the school warehouse. Exceptions: the caller asks for it
 * (`?include_training=true`, supervisors reviewing) or the caller is in the middle of a training exercise
 * (a prepared, not yet completed step) — the trainee works the real screens against the school warehouse.
 */
export async function includeTraining(req: FastifyRequest): Promise<boolean> {
  const q = req.query as Record<string, unknown> | undefined;
  if (q?.include_training === 'true' || q?.include_training === true) return true;
  const uid = req.actor?.userId;
  if (!uid) return false;
  const active = await getDb().training_progress.count({ where: { user_id: uid, status: 'PENDING', prepared_at: { not: null } } });
  return active > 0;
}
/** Prisma `where` fragment. */
export async function trainingWhere(req: FastifyRequest): Promise<{ is_training?: boolean }> {
  return (await includeTraining(req)) ? {} : { is_training: false };
}
