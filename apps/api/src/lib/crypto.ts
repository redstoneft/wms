import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string | Buffer, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;

// ---- password hashing: scrypt (N=2^15, r=8, p=1), format: scrypt$N$r$p$salt$hash ----
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [alg, n, r, p, saltB64, hashB64] = stored.split('$');
    if (alg !== 'scrypt' || !n || !r || !p || !saltB64 || !hashB64) return false;
    const expected = Buffer.from(hashB64, 'base64');
    const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

// ---- opaque session tokens: 32 random bytes, stored as sha256 ----
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
export function sha256(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

// ---- AES-256-GCM for secrets at rest (MFA seeds) ----
function keyFromConfig(secret: string): Buffer {
  // Accept base64 32 bytes or any string ≥ 32 chars (derived via sha256).
  const b = Buffer.from(secret, 'base64');
  if (b.length === 32) return b;
  return createHash('sha256').update(secret).digest();
}
export function encryptSecret(plain: string, appKey: string): string {
  const key = keyFromConfig(appKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${ct.toString('base64url')}.${tag.toString('base64url')}`;
}
export function decryptSecret(enc: string, appKey: string): string {
  const [v, ivB, ctB, tagB] = enc.split('.');
  if (v !== 'v1' || !ivB || !ctB || !tagB) throw new Error('bad ciphertext');
  const key = keyFromConfig(appKey);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64url')), decipher.final()]).toString('utf8');
}

// ---- TOTP (RFC 6238) — SHA1, 6 digits, 30s, ±1 step tolerance ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}
export function hotp(secretB32: string, counter: number, digits = 6): string {
  const key = base32Decode(secretB32);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const h = createHmac('sha1', key).update(msg).digest();
  const offset = h[h.length - 1]! & 0x0f;
  const code = ((h[offset]! & 0x7f) << 24) | ((h[offset + 1]! & 0xff) << 16) | ((h[offset + 2]! & 0xff) << 8) | (h[offset + 3]! & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}
export function totp(secretB32: string, at: number = Date.now(), step = 30, digits = 6): string {
  return hotp(secretB32, Math.floor(at / 1000 / step), digits);
}
export function verifyTotp(secretB32: string, code: string, at: number = Date.now(), window = 1): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const counter = Math.floor(at / 1000 / 30);
  for (let w = -window; w <= window; w++) {
    const expected = hotp(secretB32, counter + w);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return true;
  }
  return false;
}
export function totpUri(secretB32: string, account: string, issuer = 'WMS'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
