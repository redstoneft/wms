import type { Tx } from '../db.js';
import type { ActorContext } from './context.js';

export interface AuditEntry {
  action: string; // e.g. 'lpn.putaway', 'order.cancel'
  entity_type: string;
  entity_id?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

const SENSITIVE_KEYS = /pass|secret|token|hash|mfa/i;

/** Strip anything that looks like a secret before it reaches the audit log. */
export function scrub(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(scrub);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '[REDACTED]' : scrub(v);
    }
    return out;
  }
  return value;
}

/** Writes an audit row inside the caller's transaction (atomic with the change). */
export async function audit(tx: Tx, ctx: ActorContext, entry: AuditEntry): Promise<void> {
  await tx.audit_logs.create({
    data: {
      user_id: ctx.userId,
      username: ctx.username,
      action: entry.action,
      entity_type: entry.entity_type,
      entity_id: entry.entity_id ?? null,
      before: entry.before === undefined ? undefined : (scrub(entry.before) as object),
      after: entry.after === undefined ? undefined : (scrub(entry.after) as object),
      reason: entry.reason ?? null,
      ip: ctx.ip,
      device_id: ctx.deviceId,
      request_id: ctx.requestId,
    },
  });
}
