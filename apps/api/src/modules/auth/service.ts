import { permissionsForRoles, type Role } from '@wms/shared';
import { loadConfig } from '../../config.js';
import { getSettingsCached } from '../settings/routes.js';
import { getDb, withTx } from '../../db.js';
import { AppError, ForbiddenError, NotFoundError, RuleError, UnauthorizedError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';
import {
  decryptSecret,
  encryptSecret,
  generateToken,
  generateTotpSecret,
  hashPassword,
  sha256,
  totpUri,
  verifyPassword,
  verifyTotp,
} from '../../lib/crypto.js';

const MAX_FAILED = 10;
const LOCK_MINUTES = 15;

export interface LoginResult {
  token: string;
  session_id: string;
  ttl_hours: number;
  user: { id: string; username: string; full_name: string; roles: Role[]; permissions: string[]; mfa_enabled: boolean };
  mfa_required: boolean;
  mfa_enrollment_required: boolean;
  mfa_via_trusted_device?: boolean;
}

export async function login(params: {
  username: string;
  password: string;
  ip: string | null;
  userAgent: string | null;
  deviceId: string | null;
  requestId: string;
  /** raw trusted-device token from the browser cookie, if any */
  trustedToken?: string | null;
}): Promise<LoginResult> {
  const db = getDb();
  const cfg = loadConfig();
  const user = await db.users.findUnique({
    where: { username: params.username.toLowerCase() },
    include: { user_roles: { include: { role: true } } },
  });
  // Constant-ish time: verify against a dummy hash when user does not exist.
  const dummy = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const ok = await verifyPassword(params.password, user?.password_hash ?? dummy);

  if (!user || !user.is_active) {
    throw new UnauthorizedError('Invalid credentials');
  }
  if (user.locked_until && user.locked_until > new Date()) {
    throw new AppError(423, 'ACCOUNT_LOCKED', `Account locked until ${user.locked_until.toISOString()}`);
  }
  if (!ok) {
    const failed = user.failed_login_count + 1;
    await db.users.update({
      where: { id: user.id },
      data: {
        failed_login_count: failed,
        locked_until: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
      },
    });
    await db.audit_logs.create({
      data: { user_id: user.id, username: user.username, action: 'auth.login_failed', entity_type: 'user', entity_id: user.id, ip: params.ip, request_id: params.requestId },
    });
    throw new UnauthorizedError('Invalid credentials');
  }

  const roles = user.user_roles.map((r) => r.role.code as Role);
  const isAdmin = roles.includes('ADMIN');
  const settings = await getSettingsCached();
  let mfaRequired = user.mfa_enabled || (isAdmin && settings.require_mfa_for_admin !== false);
  // "remember this device": a valid, unexpired, unrevoked trusted token of THIS user satisfies the second factor
  let trustedDeviceId: string | null = null;
  if (mfaRequired && user.mfa_enabled && params.trustedToken) {
    const td = await db.trusted_devices.findUnique({ where: { token_hash: sha256(params.trustedToken) } });
    if (td && td.user_id === user.id && !td.revoked_at && td.expires_at > new Date()) {
      mfaRequired = false;
      trustedDeviceId = td.id;
      await db.trusted_devices.update({ where: { id: td.id }, data: { last_used_at: new Date(), ip: params.ip } });
    }
  }
  const ttlHours = Number(settings.session_ttl_hours) > 0 ? Number(settings.session_ttl_hours) : cfg.SESSION_TTL_HOURS;
  const token = generateToken(32);
  const session = await withTx(async (tx) => {
    await tx.users.update({ where: { id: user.id }, data: { failed_login_count: 0, locked_until: null } });
    const s = await tx.sessions.create({
      data: {
        token_hash: sha256(token),
        user_id: user.id,
        mfa_verified: !mfaRequired,
        ip: params.ip,
        user_agent: params.userAgent?.slice(0, 512) ?? null,
        device_id: params.deviceId,
        expires_at: new Date(Date.now() + ttlHours * 3600_000),
      },
    });
    await tx.audit_logs.create({
      data: { user_id: user.id, username: user.username, action: 'auth.login', entity_type: 'session', entity_id: s.id, ip: params.ip, device_id: params.deviceId, request_id: params.requestId, after: trustedDeviceId ? { mfa_via_trusted_device: trustedDeviceId } : undefined },
    });
    return s;
  });

  return {
    token,
    session_id: session.id,
    ttl_hours: ttlHours,
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      roles,
      permissions: mfaRequired ? [] : [...permissionsForRoles(roles)],
      mfa_enabled: user.mfa_enabled,
    },
    mfa_required: mfaRequired,
    mfa_enrollment_required: mfaRequired && !user.mfa_enabled,
    mfa_via_trusted_device: !!trustedDeviceId,
  };
}

export async function logout(sessionId: string, ctx: ActorContext): Promise<void> {
  await withTx(async (tx) => {
    await tx.sessions.update({ where: { id: sessionId }, data: { revoked_at: new Date() } });
    await audit(tx, ctx, { action: 'auth.logout', entity_type: 'session', entity_id: sessionId });
  });
}

export async function me(ctx: ActorContext, mfaPending: boolean) {
  const user = await getDb().users.findUnique({ where: { id: ctx.userId } });
  if (!user) throw new NotFoundError('user');
  return {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    email: user.email,
    roles: ctx.roles,
    permissions: [...ctx.permissions],
    mfa_enabled: user.mfa_enabled,
    mfa_pending: mfaPending,
    mfa_enrollment_required: mfaPending && !user.mfa_enabled,
  };
}

/** Step 1 of enrollment: generate a secret, store encrypted but not enabled. */
export async function beginMfaEnrollment(userId: string): Promise<{ secret: string; otpauth_uri: string }> {
  const cfg = loadConfig();
  const db = getDb();
  const user = await db.users.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError('user');
  if (user.mfa_enabled) throw new RuleError('MFA_ALREADY_ENABLED', 'MFA is already enabled');
  const secret = generateTotpSecret();
  await db.users.update({ where: { id: userId }, data: { mfa_secret_enc: encryptSecret(secret, cfg.APP_ENCRYPTION_KEY) } });
  return { secret, otpauth_uri: totpUri(secret, user.username) };
}

/** Step 2: confirm with a valid code → MFA enabled and current session verified. */
export async function confirmMfaEnrollment(userId: string, sessionId: string, code: string, ctx: ActorContext): Promise<void> {
  const cfg = loadConfig();
  const db = getDb();
  const user = await db.users.findUnique({ where: { id: userId } });
  if (!user?.mfa_secret_enc) throw new RuleError('MFA_NOT_STARTED', 'Start enrollment first');
  const secret = decryptSecret(user.mfa_secret_enc, cfg.APP_ENCRYPTION_KEY);
  if (!verifyTotp(secret, code)) throw new UnauthorizedError('Invalid MFA code');
  await withTx(async (tx) => {
    await tx.users.update({ where: { id: userId }, data: { mfa_enabled: true } });
    await tx.sessions.update({ where: { id: sessionId }, data: { mfa_verified: true } });
    await audit(tx, ctx, { action: 'auth.mfa_enrolled', entity_type: 'user', entity_id: userId });
  });
}

export async function verifyMfa(userId: string, sessionId: string, code: string, ctx: ActorContext & { userAgent?: string | null }, rememberDevice = false): Promise<{ trusted_token: string | null; trusted_days: number }> {
  const cfg = loadConfig();
  const db = getDb();
  const user = await db.users.findUnique({ where: { id: userId } });
  if (!user?.mfa_enabled || !user.mfa_secret_enc) throw new RuleError('MFA_NOT_ENROLLED', 'MFA not enrolled');
  if (user.locked_until && user.locked_until > new Date()) throw new AppError(423, 'ACCOUNT_LOCKED', `Account locked until ${user.locked_until.toISOString()}`);
  const secret = decryptSecret(user.mfa_secret_enc, cfg.APP_ENCRYPTION_KEY);
  if (!verifyTotp(secret, code)) {
    // brute-force protection: MFA failures count like password failures and lock the account
    const failed = user.failed_login_count + 1;
    await db.users.update({ where: { id: userId }, data: { failed_login_count: failed, locked_until: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null } });
    if (failed >= MAX_FAILED) await db.sessions.updateMany({ where: { user_id: userId, revoked_at: null }, data: { revoked_at: new Date() } });
    await db.audit_logs.create({ data: { user_id: userId, username: user.username, action: 'auth.mfa_failed', entity_type: 'session', entity_id: sessionId, ip: ctx.ip, request_id: ctx.requestId } });
    throw new UnauthorizedError('Invalid MFA code');
  }
  const settings = await getSettingsCached();
  const days = Math.max(0, Math.min(90, Number(settings.mfa_trusted_device_days ?? 30) || 0));
  const token = rememberDevice && days > 0 ? generateToken(32) : null;
  await withTx(async (tx) => {
    await tx.users.update({ where: { id: userId }, data: { failed_login_count: 0 } });
    await tx.sessions.update({ where: { id: sessionId }, data: { mfa_verified: true } });
    await audit(tx, ctx, { action: 'auth.mfa_verified', entity_type: 'session', entity_id: sessionId });
    if (token) {
      const td = await tx.trusted_devices.create({
        data: { user_id: userId, token_hash: sha256(token), device_id: ctx.deviceId, user_agent: ctx.userAgent?.slice(0, 512) ?? null, ip: ctx.ip, expires_at: new Date(Date.now() + days * 86400_000) },
      });
      await audit(tx, ctx, { action: 'auth.trusted_device_added', entity_type: 'trusted_device', entity_id: td.id, after: { days, device_id: ctx.deviceId } });
    }
  });
  return { trusted_token: token, trusted_days: days };
}

export async function listTrustedDevices(userId: string) {
  const db = getDb();
  return db.trusted_devices.findMany({ where: { user_id: userId, revoked_at: null, expires_at: { gt: new Date() } }, orderBy: { last_used_at: 'desc' }, select: { id: true, device_id: true, user_agent: true, ip: true, created_at: true, last_used_at: true, expires_at: true } });
}

/** Revokes one trusted device (or all of them when id is null). */
export async function revokeTrustedDevices(ctx: ActorContext, userId: string, id: string | null): Promise<number> {
  return withTx(async (tx) => {
    const r = await tx.trusted_devices.updateMany({ where: { user_id: userId, revoked_at: null, ...(id ? { id } : {}) }, data: { revoked_at: new Date() } });
    if (r.count) await audit(tx, ctx, { action: 'auth.trusted_device_revoked', entity_type: 'trusted_device', entity_id: id ?? userId, after: { revoked: r.count } });
    return r.count;
  });
}

export async function changePassword(ctx: ActorContext, currentPassword: string, newPassword: string, keepSessionId?: string | null): Promise<void> {
  const db = getDb();
  const user = await db.users.findUnique({ where: { id: ctx.userId } });
  if (!user) throw new NotFoundError('user');
  if (!(await verifyPassword(currentPassword, user.password_hash))) throw new ForbiddenError('Current password is incorrect');
  if (currentPassword === newPassword) throw new RuleError('SAME_PASSWORD', 'New password must differ from the current one');
  const hash = await hashPassword(newPassword);
  await withTx(async (tx) => {
    await tx.users.update({ where: { id: ctx.userId }, data: { password_hash: hash, password_changed_at: new Date() } });
    // revoke every other session (the current one stays valid) and every remembered device
    await tx.sessions.updateMany({ where: { user_id: ctx.userId, revoked_at: null, ...(keepSessionId ? { id: { not: keepSessionId } } : {}) }, data: { revoked_at: new Date() } });
    await tx.trusted_devices.updateMany({ where: { user_id: ctx.userId, revoked_at: null }, data: { revoked_at: new Date() } });
    await audit(tx, ctx, { action: 'auth.password_changed', entity_type: 'user', entity_id: ctx.userId });
  });
}

export async function listSessions(userId: string) {
  return getDb().sessions.findMany({
    where: { user_id: userId, revoked_at: null, expires_at: { gt: new Date() } },
    select: { id: true, ip: true, user_agent: true, device_id: true, created_at: true, last_seen_at: true, mfa_verified: true },
    orderBy: { last_seen_at: 'desc' },
  });
}
