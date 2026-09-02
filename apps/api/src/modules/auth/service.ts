import { permissionsForRoles, type Role } from '@wms/shared';
import { loadConfig } from '../../config.js';
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
  user: { id: string; username: string; full_name: string; roles: Role[]; permissions: string[]; mfa_enabled: boolean };
  mfa_required: boolean;
  mfa_enrollment_required: boolean;
}

export async function login(params: {
  username: string;
  password: string;
  ip: string | null;
  userAgent: string | null;
  deviceId: string | null;
  requestId: string;
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
  const mfaRequired = user.mfa_enabled || isAdmin;
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
        expires_at: new Date(Date.now() + cfg.SESSION_TTL_HOURS * 3600_000),
      },
    });
    await tx.audit_logs.create({
      data: { user_id: user.id, username: user.username, action: 'auth.login', entity_type: 'session', entity_id: s.id, ip: params.ip, device_id: params.deviceId, request_id: params.requestId },
    });
    return s;
  });

  return {
    token,
    session_id: session.id,
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

export async function verifyMfa(userId: string, sessionId: string, code: string, ctx: ActorContext): Promise<void> {
  const cfg = loadConfig();
  const db = getDb();
  const user = await db.users.findUnique({ where: { id: userId } });
  if (!user?.mfa_enabled || !user.mfa_secret_enc) throw new RuleError('MFA_NOT_ENROLLED', 'MFA not enrolled');
  const secret = decryptSecret(user.mfa_secret_enc, cfg.APP_ENCRYPTION_KEY);
  if (!verifyTotp(secret, code)) {
    await db.audit_logs.create({ data: { user_id: userId, username: user.username, action: 'auth.mfa_failed', entity_type: 'session', entity_id: sessionId, ip: ctx.ip, request_id: ctx.requestId } });
    throw new UnauthorizedError('Invalid MFA code');
  }
  await withTx(async (tx) => {
    await tx.sessions.update({ where: { id: sessionId }, data: { mfa_verified: true } });
    await audit(tx, ctx, { action: 'auth.mfa_verified', entity_type: 'session', entity_id: sessionId });
  });
}

export async function changePassword(ctx: ActorContext, currentPassword: string, newPassword: string): Promise<void> {
  const db = getDb();
  const user = await db.users.findUnique({ where: { id: ctx.userId } });
  if (!user) throw new NotFoundError('user');
  if (!(await verifyPassword(currentPassword, user.password_hash))) throw new ForbiddenError('Current password is incorrect');
  if (currentPassword === newPassword) throw new RuleError('SAME_PASSWORD', 'New password must differ from the current one');
  const hash = await hashPassword(newPassword);
  await withTx(async (tx) => {
    await tx.users.update({ where: { id: ctx.userId }, data: { password_hash: hash, password_changed_at: new Date() } });
    // revoke every other session
    await tx.sessions.updateMany({ where: { user_id: ctx.userId, revoked_at: null }, data: { revoked_at: new Date() } });
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
