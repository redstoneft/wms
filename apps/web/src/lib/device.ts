// Per-device identity persisted in localStorage. Sent as X-Device-Id on every
// request so movements can be traced back to the handheld that produced them.

const KEY = 'wms.device_id';

export function getDeviceId(): string {
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const id = newUuid();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return 'no-storage';
  }
}

export function newUuid(): string {
  const c: Crypto = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  // RFC4122 v4 fallback
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
