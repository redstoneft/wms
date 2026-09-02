import { expect, request, type APIRequestContext, type Page } from '@playwright/test';

export const API = process.env.E2E_API_URL ?? 'http://localhost:4000';
export const USERS = {
  supervisor: { username: 'supervisor', password: 'supervisor-Demo-1!' },
  recepcion: { username: 'recepcion', password: 'recepcion-Demo-1!' },
  montacargas: { username: 'montacargas', password: 'montacargas-Demo-1!' },
};
type User = { username: string; password: string };

// One API session per user for the whole worker: the login route is rate-limited (10/min per IP).
const sessions = new Map<string, Promise<APIRequestContext>>();

/** Logged-in API context (cookie jar) that also sends the CSRF header on mutations. */
export function apiLogin(user: User): Promise<APIRequestContext> {
  let p = sessions.get(user.username);
  if (!p) {
    p = (async () => {
      const ctx = await request.newContext({
        baseURL: API,
        extraHTTPHeaders: { 'X-Requested-With': 'wms-client', 'X-Device-Id': 'e2e-runner', Origin: 'http://localhost:5173' },
      });
      const r = await ctx.post('/api/auth/login', { data: user });
      expect(r.ok(), `login ${user.username}: ${r.status()} ${await r.text()}`).toBeTruthy();
      return ctx;
    })();
    sessions.set(user.username, p);
  }
  return p;
}

/** Authenticates the browser by injecting the session cookie of the cached API session (no extra login). */
export async function uiLogin(page: Page, user: User) {
  const ctx = await apiLogin(user);
  const state = await ctx.storageState();
  const cookie = state.cookies.find((c) => c.name === 'wms_session');
  expect(cookie, 'session cookie').toBeTruthy();
  await page.context().addCookies([{ name: cookie!.name, value: cookie!.value, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Strict' }]);
}

/** Real login through the form (used once, in auth.spec). */
export async function uiLoginForm(page: Page, user: User) {
  await page.goto('/login');
  await page.getByTestId('login-username').fill(user.username);
  await page.getByTestId('login-password').fill(user.password);
  await page.getByTestId('login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

/** Types a code into the scan input and presses Enter (emulates a keyboard-wedge scanner). */
export async function scan(page: Page, testId: string, code: string) {
  const input = page.getByTestId(testId);
  await expect(input).toBeVisible();
  await expect(input).toBeEnabled();
  await input.fill(code);
  await input.press('Enter');
}

export async function firstReceivingLocation(ctx: APIRequestContext): Promise<{ id: string; code: string; barcode: string }> {
  const r = await ctx.get('/api/locations?type=RECEIVING&limit=5');
  const j = (await r.json()) as { items: { id: string; code: string; barcode: string }[] };
  expect(j.items.length).toBeGreaterThan(0);
  return j.items[0]!;
}

export async function createReceipt(ctx: APIRequestContext): Promise<{ id: string; receipt_number: string }> {
  const dock = await firstReceivingLocation(ctx);
  const r = await ctx.post('/api/receipts', { data: { receiving_location_id: dock.id, notes: `e2e ${Date.now()}` } });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()) as { id: string; receipt_number: string };
}

export async function receiveAndClosePallet(ctx: APIRequestContext, receiptId: string, barcode = '7501000000001', qty = 12): Promise<string> {
  const scanRes = await ctx.post('/api/receipts/scan', {
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    data: { receipt_id: receiptId, barcode, qty, damaged: false },
  });
  expect(scanRes.status(), await scanRes.text()).toBe(201);
  const lpn = ((await scanRes.json()) as { lpn: { code: string } }).lpn.code;
  const close = await ctx.post('/api/receipts/lpn/close', { headers: { 'Idempotency-Key': crypto.randomUUID() }, data: { lpn_code: lpn } });
  expect(close.ok(), await close.text()).toBeTruthy();
  return lpn;
}
