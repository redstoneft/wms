import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, decryptSecret, encryptSecret, hashPassword, hotp, totp, verifyPassword, verifyTotp } from '../../src/lib/crypto.js';

describe('password hashing (scrypt)', () => {
  it('verifies the right password and rejects wrong/garbage', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', h)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
  });
  it('uses a random salt (same password → different hash)', async () => {
    expect(await hashPassword('a')).not.toBe(await hashPassword('a'));
  });
  it('normalizes unicode (NFKC) so composed/decomposed forms match', async () => {
    const h = await hashPassword('café-Passw0rd-long');
    expect(await verifyPassword('café-Passw0rd-long', h)).toBe(true);
  });
});

describe('TOTP (RFC 6238 test vectors, SHA1)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it('matches RFC vectors', () => {
    expect(totp(secret, 59 * 1000)).toBe('287082');
    expect(totp(secret, 1111111109 * 1000)).toBe('081804');
    expect(totp(secret, 1234567890 * 1000)).toBe('005924');
    expect(totp(secret, 2000000000 * 1000)).toBe('279037');
    expect(totp(secret, 20000000000 * 1000)).toBe('353130');
  });
  it('accepts ±1 step and rejects others', () => {
    const at = 1234567890 * 1000;
    expect(verifyTotp(secret, '005924', at)).toBe(true);
    expect(verifyTotp(secret, totp(secret, at - 30_000), at)).toBe(true);
    expect(verifyTotp(secret, totp(secret, at - 90_000), at)).toBe(false);
    expect(verifyTotp(secret, '000000', at)).toBe(false);
    expect(verifyTotp(secret, '12345', at)).toBe(false);
    expect(verifyTotp(secret, 'abcdef', at)).toBe(false);
  });
  it('base32 round-trips', () => {
    const b = Buffer.from([0, 1, 2, 250, 255, 17, 99]);
    expect(base32Decode(base32Encode(b))).toEqual(b);
  });
  it('hotp counter 0 for RFC secret is 755224', () => {
    expect(hotp(secret, 0)).toBe('755224');
  });
});

describe('AES-GCM secret encryption', () => {
  const key = 'test-encryption-key-test-encryption-key-1234';
  it('round-trips and detects tampering', () => {
    const enc = encryptSecret('JBSWY3DPEHPK3PXP', key);
    expect(decryptSecret(enc, key)).toBe('JBSWY3DPEHPK3PXP');
    const parts = enc.split('.');
    parts[2] = parts[2]!.slice(0, -2) + 'AA';
    expect(() => decryptSecret(parts.join('.'), key)).toThrow();
    expect(() => decryptSecret(enc, 'another-key-another-key-another-key-1234')).toThrow();
  });
  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    expect(encryptSecret('x', key)).not.toBe(encryptSecret('x', key));
  });
});
