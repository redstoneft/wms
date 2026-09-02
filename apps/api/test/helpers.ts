// Integration test harness: builds the Fastify app against the test DB and
// gives every test an isolated warehouse fixture (unique codes), API clients
// per role, and raw SQL access for invariants.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Role } from '@wms/shared';
import { buildApp } from '../src/app.js';
import { getDb, withTx } from '../src/db.js';
import { hashPassword } from '../src/lib/crypto.js';
import { SYSTEM_ACTOR } from '../src/lib/context.js';
import { createInventory, createLpn } from '../src/inventory/ledger.js';
import { syncRackLocations } from '../src/modules/layout/service.js';

export const ADMIN_PASSWORD = 'Admin-Test-Password-1!';

let app: FastifyInstance | null = null;
export async function getApp(): Promise<FastifyInstance> {
  if (!app) {
    app = await buildApp({ logger: false });
    await app.ready();
  }
  return app;
}
export async function closeApp() {
  if (app) {
    await app.close();
    app = null;
  }
}

export interface Client {
  username: string;
  cookie: string;
  get: (url: string) => Promise<{ status: number; body: any }>;
  post: (url: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any; headers: Record<string, unknown> }>;
  patch: (url: string, body?: unknown) => Promise<{ status: number; body: any }>;
  del: (url: string) => Promise<{ status: number; body: any }>;
}

const bigintReplacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

export async function clientFor(username: string, password: string): Promise<Client> {
  const a = await getApp();
  const res = await a.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'wms-client', 'content-type': 'application/json' }, payload: JSON.stringify({ username, password }) });
  if (res.statusCode !== 200) throw new Error(`login failed for ${username}: ${res.statusCode} ${res.body}`);
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0]! : (setCookie as string);
  const cookie = raw.split(';')[0]!;
  const h = (extra: Record<string, string> = {}) => ({ cookie, 'x-requested-with': 'wms-client', 'content-type': 'application/json', ...extra });
  const parse = (r: { statusCode: number; body: string; headers: Record<string, unknown> }) => {
    let body: any = r.body;
    try {
      body = r.body ? JSON.parse(r.body) : null;
    } catch {
      /* text */
    }
    if (r.statusCode >= 400 && process.env.DEBUG_HTTP) console.log('[http]', r.statusCode, JSON.stringify(body).slice(0, 600));
    return { status: r.statusCode, body, headers: r.headers };
  };
  return {
    username,
    cookie,
    get: async (url) => parse(await a.inject({ method: 'GET', url: `/api${url}`, headers: h() })),
    post: async (url, body, extra) => parse(await a.inject({ method: 'POST', url: `/api${url}`, headers: h(extra), payload: body === undefined ? undefined : JSON.stringify(body, bigintReplacer) })),
    patch: async (url, body) => parse(await a.inject({ method: 'PATCH', url: `/api${url}`, headers: h(), payload: JSON.stringify(body ?? {}, bigintReplacer) })),
    del: async (url) => parse(await a.inject({ method: 'DELETE', url: `/api${url}`, headers: h() })),
  };
}

export async function admin(): Promise<Client> {
  // admin needs MFA; tests use a dedicated SUPERVISOR-equivalent admin without MFA: create a non-admin superuser per run
  return userWithRoles('tadmin', ['SUPERVISOR', 'INVENTORY_CONTROL']);
}

const created = new Map<string, string>();
export async function userWithRoles(prefix: string, roles: Role[]): Promise<Client> {
  const db = getDb();
  const username = `${prefix}_${randomUUID().slice(0, 8)}`.toLowerCase();
  const password = `Pw-${username}-Test-1!`;
  const roleRows = await db.roles.findMany({ where: { code: { in: roles } } });
  await db.users.create({ data: { username, full_name: username, password_hash: await hashPassword(password), user_roles: { create: roleRows.map((r) => ({ role_id: r.id })) } } });
  created.set(username, password);
  return clientFor(username, password);
}

/** A fresh isolated warehouse with zones, docks, staging, 1 reserve rack, 1 picking rack and N SKUs. */
export interface Fixture {
  tag: string;
  warehouse_id: string;
  dock: { id: string; code: string; barcode: string };
  staging: { id: string; code: string; barcode: string }[];
  ship_dock: { id: string; code: string; barcode: string };
  quarantine: { id: string; code: string; barcode: string };
  returns: { id: string; code: string; barcode: string };
  reserve: { id: string; code: string; barcode: string }[];
  picking: { id: string; code: string; barcode: string }[];
  skus: { id: string; code: string; piece_barcode: string; case_barcode: string; case_qty: bigint; pallet_qty: bigint }[];
  customer: { id: string; code: string };
  supplier: { id: string; code: string };
  carrier: { id: string; code: string };
}

export async function makeFixture(opts: { skus?: number; reserveBays?: number; levels?: number } = {}): Promise<Fixture> {
  const db = getDb();
  const tag = randomUUID().slice(0, 6).toUpperCase();
  const wh = await db.warehouses.create({ data: { code: `WH-${tag}`, name: `Test ${tag}` } });
  const zone = (code: string, zone_type: string) => db.zones.create({ data: { warehouse_id: wh.id, code: `${code}${tag}`, name: code, zone_type } });
  const zREC = await zone('REC', 'RECEIVING');
  const zSTG = await zone('STG', 'STAGING');
  const zSHP = await zone('SHP', 'SHIPPING');
  const zQAR = await zone('QAR', 'QUARANTINE');
  const zRET = await zone('RET', 'RETURNS');
  const zA = await zone('A', 'STORAGE');
  const zP = await zone('P', 'PICKING');
  const area = async (zoneId: string, code: string, type: string, cap = 50) => {
    const l = await db.locations.create({ data: { warehouse_id: wh.id, zone_id: zoneId, code: `${code}-${tag}`, barcode: `LOC-${code}-${tag}`, location_type: type, pallet_capacity: cap, max_weight_kg: 100000, height_m: 5 } });
    return { id: l.id, code: l.code, barcode: l.barcode };
  };
  const dock = await area(zREC.id, 'DOCK', 'RECEIVING');
  const staging = [await area(zSTG.id, 'STG1', 'STAGING', 10), await area(zSTG.id, 'STG2', 'STAGING', 10), await area(zSTG.id, 'STG3', 'STAGING', 10)];
  const ship_dock = await area(zSHP.id, 'SHIP', 'SHIPPING');
  const quarantine = await area(zQAR.id, 'QAR', 'QUARANTINE');
  const returns = await area(zRET.id, 'RET', 'RETURNS');
  const aisle = await db.aisles.create({ data: { zone_id: zA.id, code: '01' } });
  const geom = { bays: opts.reserveBays ?? 6, levels: opts.levels ?? 3, positions_per_bay: 1, bay_width_m: 2.7, level_height_m: 1.8, depth_m: 1.2, x_m: 0, y_m: 10, rotation_deg: 0 };
  const rack = await db.racks.create({ data: { aisle_id: aisle.id, code: 'R01', ...geom } });
  await withTx((tx) => syncRackLocations(tx, { ...rack, ...geom }, { location_type: 'RESERVE', pallet_capacity: 1, max_weight_kg: 1500 }));
  const pAisle = await db.aisles.create({ data: { zone_id: zP.id, code: '01' } });
  const pGeom = { ...geom, bays: 4, levels: 1, x_m: 20, y_m: 20 };
  const pRack = await db.racks.create({ data: { aisle_id: pAisle.id, code: 'R01', ...pGeom } });
  await withTx((tx) => syncRackLocations(tx, { ...pRack, ...pGeom }, { location_type: 'PICKING', pallet_capacity: 1, max_weight_kg: 1500 }));
  const reserve = (await db.locations.findMany({ where: { rack_id: rack.id }, orderBy: { code: 'asc' } })).map((l) => ({ id: l.id, code: l.code, barcode: l.barcode }));
  const picking = (await db.locations.findMany({ where: { rack_id: pRack.id }, orderBy: { code: 'asc' } })).map((l) => ({ id: l.id, code: l.code, barcode: l.barcode }));
  const skus = [];
  for (let i = 1; i <= (opts.skus ?? 3); i++) {
    const code = `SKU-${tag}-${i}`;
    const s = await db.skus.create({
      data: {
        code,
        description: `Test sku ${i}`,
        family: 'TEST',
        abc_class: i === 1 ? 'A' : 'C',
        unit_weight_kg: 1,
        pallet_height_cm: 150,
        uoms: { create: [{ uom_code: 'PIECE', base_qty: 1n }, { uom_code: 'CASE', base_qty: 6n }, { uom_code: 'PALLET', base_qty: 240n }] },
        barcodes: { create: [{ barcode: `P${tag}${i}`, uom_code: 'PIECE' }, { barcode: `C${tag}${i}`, uom_code: 'CASE' }] },
      },
    });
    skus.push({ id: s.id, code, piece_barcode: `P${tag}${i}`, case_barcode: `C${tag}${i}`, case_qty: 6n, pallet_qty: 240n });
  }
  const customer = await db.customers.create({ data: { code: `CLI-${tag}`, name: `Customer ${tag}` } });
  const supplier = await db.suppliers.create({ data: { code: `SUP-${tag}`, name: `Supplier ${tag}` } });
  const carrier = await db.carriers.create({ data: { code: `CAR-${tag}`, name: `Carrier ${tag}` } });
  return { tag, warehouse_id: wh.id, dock, staging, ship_dock, quarantine, returns, reserve, picking, skus, customer: { id: customer.id, code: customer.code }, supplier: { id: supplier.id, code: supplier.code }, carrier: { id: carrier.id, code: carrier.code } };
}

/** Puts a stored pallet with `qty` base units of a SKU in a location (via the ledger). */
export async function storedPallet(f: Fixture, skuIdx: number, locationId: string, qty: bigint, extra: { lot?: string; expiry?: Date } = {}) {
  return withTx(async (tx) => {
    const lpn = await createLpn(tx, SYSTEM_ACTOR, { warehouse_id: f.warehouse_id, lpn_type: 'STORAGE', location_id: locationId, lot: extra.lot ?? null, expiry_date: extra.expiry ?? null });
    await tx.lpns.update({ where: { id: lpn.id }, data: { status: 'STORED' } });
    await createInventory(tx, SYSTEM_ACTOR, { movement_type: 'INITIAL_LOAD', to_lpn: lpn, sku_id: f.skus[skuIdx]!.id, qty, status: 'AVAILABLE', location_id: locationId, reason: 'test' });
    return { id: lpn.id, code: lpn.code };
  });
}

export async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
  return getDb().$queryRawUnsafe<T[]>(query, ...params);
}

/** Asserts the ledger, balances and LPN locations agree. */
export async function expectReconciled() {
  const diffs = await sql('SELECT * FROM inventory_reconcile()');
  const locs = await sql('SELECT * FROM lpn_location_reconcile()');
  const neg = await sql<{ n: bigint }>('SELECT count(*) AS n FROM inventory_balances WHERE qty < 0');
  if (diffs.length || locs.length || Number(neg[0]?.n) > 0) {
    throw new Error(`RECONCILIATION FAILED: balance diffs=${JSON.stringify(diffs, bigintReplacer)} location diffs=${JSON.stringify(locs)} negatives=${neg[0]?.n}`);
  }
}

/** Total base units of a SKU across all statuses (in LPNs that are not shipped). */
export async function skuTotal(skuId: string): Promise<bigint> {
  const r = await sql<{ t: bigint | null }>('SELECT COALESCE(sum(qty),0)::bigint AS t FROM inventory_balances WHERE sku_id = $1::uuid', [skuId]);
  return r[0]?.t ?? 0n;
}

export const idem = () => ({ 'idempotency-key': randomUUID() });
