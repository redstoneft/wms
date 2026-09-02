import type { Permission, Role } from '@wms/shared';

/** Who is doing what, from which device. Passed to every service call. */
export interface ActorContext {
  userId: string;
  username: string;
  roles: Role[];
  permissions: Set<Permission>;
  deviceId: string | null;
  ip: string | null;
  requestId: string;
  /** Idempotency-Key header (already scoped) when present */
  idempotencyKey: string | null;
}

export const SYSTEM_ACTOR: ActorContext = {
  userId: '00000000-0000-7000-8000-000000000000',
  username: 'system',
  roles: ['ADMIN'],
  permissions: new Set(),
  deviceId: null,
  ip: null,
  requestId: 'system',
  idempotencyKey: null,
};

export function hasPermission(ctx: ActorContext, p: Permission): boolean {
  return ctx.permissions.has(p);
}
