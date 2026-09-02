// LOAD / PERFORMANCE test. Generates a large dataset directly through the ledger
// (thousands of SKUs, tens of thousands of LPNs, hundreds of thousands of
// movements) and then measures API latency under concurrent users.
//
//   npx tsx test/load/run-load.ts            (defaults: 2,000 SKUs, 20,000 LPNs, ~300k movements)
//   SCALE=0.1 npx tsx test/load/run-load.ts  (10% for a quick run)
//
// Uses the TEST database (DATABASE_URL_TEST). Never run against production.
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import autocannon from 'autocannon';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? 'postgresql://wms:change-me-in-production@localhost:5432/wms_test';
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY ?? 'test-encryption-key-test-encryption-key-1234';
process.env.LOG_LEVEL = 'silent';

const SCALE = Number(process.env.SCALE ?? '1');
const N_SKUS = Math.max(50, Math.round(2000 * SCALE));
const N_LPNS = Math.max(200, Math.round(20000 * SCALE));
const N_ORDERS = Math.max(20, Math.round(2000 * SCALE));

async function main() {
  const { getDb, withTx, closeDb } = await import('../../src/db.js');
  const { buildApp } = await import('../../src/app.js');
  const { SYSTEM_ACTOR } = await import('../../src/lib/context.js');
  const { createInventory, createLpn, recordMovement, lockLpn } = await import('../../src/inventory/ledger.js');
  const { syncRackLocations } = await import('../../src/modules/layout/service.js');
  const { hashPassword } = await import('../../src/lib/crypto.js');
  const db = getDb();
  const t0 = Date.now();
  const tag = `L${randomUUID().slice(0, 4).toUpperCase()}`;
  console.log(`[load] scale=${SCALE} skus=${N_SKUS} lpns=${N_LPNS} orders=${N_ORDERS}`);

  // ---- layout: enough slots for every pallet
  const wh = await db.warehouses.create({ data: { code: `WH-${tag}`, name: 'Load test', width_m: 200, depth_m: 120 } });
  const zA = await db.zones.create({ data: { warehouse_id: wh.id, code: `A${tag}`, name: 'A', zone_type: 'STORAGE' } });
  const zREC = await db.zones.create({ data: { warehouse_id: wh.id, code: `R${tag}`, name: 'R', zone_type: 'RECEIVING' } });
  const zSTG = await db.zones.create({ data: { warehouse_id: wh.id, code: `S${tag}`, name: 'S', zone_type: 'STAGING' } });
  const dock = await db.locations.create({ data: { warehouse_id: wh.id, zone_id: zREC.id, code: `DOCK-${tag}`, barcode: `LOC-DOCK-${tag}`, location_type: 'RECEIVING', pallet_capacity: 1000, max_weight_kg: 1e7, height_m: 5 } });
  for (let i = 1; i <= 20; i++) await db.locations.create({ data: { warehouse_id: wh.id, zone_id: zSTG.id, code: `STG${i}-${tag}`, barcode: `LOC-STG${i}-${tag}`, location_type: 'STAGING', pallet_capacity: 20, max_weight_kg: 1e6, height_m: 5 } });
  const slotsNeeded = N_LPNS + 500;
  const bays = 40;
  const levels = 5;
  const racksNeeded = Math.ceil(slotsNeeded / (bays * levels));
  let aisleNo = 1;
  for (let r = 0; r < racksNeeded; r++) {
    if (r % 4 === 0) aisleNo++;
    const aisle = (await db.aisles.findFirst({ where: { zone_id: zA.id, code: String(aisleNo).padStart(2, '0') } })) ?? (await db.aisles.create({ data: { zone_id: zA.id, code: String(aisleNo).padStart(2, '0') } }));
    const geom = { bays, levels, positions_per_bay: 1, bay_width_m: 2.7, level_height_m: 1.8, depth_m: 1.2, x_m: (r % 4) * 30, y_m: 10 + Math.floor(r / 4) * 8, rotation_deg: 0 };
    const rack = await db.racks.create({ data: { aisle_id: aisle.id, code: `R${String((r % 4) + 1).padStart(2, '0')}`, ...geom } });
    await withTx((tx) => syncRackLocations(tx, { ...rack, ...geom }, { location_type: 'RESERVE', pallet_capacity: 1, max_weight_kg: 2000 }));
  }
  const slots = await db.locations.findMany({ where: { warehouse_id: wh.id, location_type: 'RESERVE' }, select: { id: true } });
  console.log(`[load] layout ready: ${racksNeeded} racks, ${slots.length} slots (${Date.now() - t0} ms)`);

  // ---- master data
  const customer = await db.customers.create({ data: { code: `C-${tag}`, name: 'Load customer' } });
  const skuIds: string[] = [];
  for (let i = 0; i < N_SKUS; i += 500) {
    const batch = Array.from({ length: Math.min(500, N_SKUS - i) }, (_, j) => ({ code: `LS-${tag}-${i + j}`, description: `Load sku ${i + j}`, abc_class: (i + j) % 10 === 0 ? 'A' : 'C', unit_weight_kg: 1 }));
    await db.skus.createMany({ data: batch });
  }
  const skus = await db.skus.findMany({ where: { code: { startsWith: `LS-${tag}-` } }, select: { id: true, code: true } });
  await db.sku_uoms.createMany({ data: skus.flatMap((s) => [{ sku_id: s.id, uom_code: 'PIECE', base_qty: 1n }, { sku_id: s.id, uom_code: 'CASE', base_qty: 6n }]) });
  await db.sku_barcodes.createMany({ data: skus.map((s, i) => ({ sku_id: s.id, barcode: `LB${tag}${i}`, uom_code: 'CASE' })) });
  skuIds.push(...skus.map((s) => s.id));
  console.log(`[load] ${skus.length} skus (${Date.now() - t0} ms)`);

  // ---- inventory: N_LPNS pallets via the ledger, then a churn of movements (allocate/deallocate/status) to reach ~15 movements per pallet
  const lpnIds: string[] = [];
  const CHUNK = 200;
  for (let i = 0; i < N_LPNS; i += CHUNK) {
    await withTx(async (tx) => {
      for (let j = i; j < Math.min(i + CHUNK, N_LPNS); j++) {
        const lpn = await createLpn(tx, SYSTEM_ACTOR, { warehouse_id: wh.id, lpn_type: 'STORAGE', location_id: slots[j]!.id });
        await tx.lpns.update({ where: { id: lpn.id }, data: { status: 'STORED' } });
        await createInventory(tx, SYSTEM_ACTOR, { movement_type: 'INITIAL_LOAD', to_lpn: lpn, sku_id: skuIds[j % skuIds.length]!, qty: 240n, status: 'AVAILABLE', location_id: slots[j]!.id });
        lpnIds.push(lpn.id);
      }
    });
    if ((i / CHUNK) % 10 === 0) process.stdout.write(`\r[load] pallets ${Math.min(i + CHUNK, N_LPNS)}/${N_LPNS}`);
  }
  console.log(`\n[load] pallets done (${Date.now() - t0} ms)`);
  const churnRounds = Math.max(1, Math.round(14 * Math.min(1, SCALE * 2)));
  for (let round = 0; round < churnRounds; round++) {
    for (let i = 0; i < lpnIds.length; i += CHUNK) {
      await withTx(async (tx) => {
        for (let j = i; j < Math.min(i + CHUNK, lpnIds.length); j++) {
          const lpn = await lockLpn(tx, lpnIds[j]!);
          const sku = skuIds[j % skuIds.length]!;
          const toStatus = round % 2 === 0 ? 'ALLOCATED' : 'AVAILABLE';
          const fromStatus = round % 2 === 0 ? 'AVAILABLE' : 'ALLOCATED';
          await recordMovement(tx, SYSTEM_ACTOR, { movement_type: round % 2 === 0 ? 'ALLOCATE' : 'DEALLOCATE', sku_id: sku, qty: 6n, from_lpn_id: lpn.id, to_lpn_id: lpn.id, from_location_id: lpn.current_location_id, to_location_id: lpn.current_location_id, from_status: fromStatus, to_status: toStatus });
        }
      });
    }
    process.stdout.write(`\r[load] churn round ${round + 1}/${churnRounds}`);
  }
  const movements = await db.inventory_movements.count();
  console.log(`\n[load] movements in DB: ${movements} (${Date.now() - t0} ms)`);

  // ---- orders
  for (let i = 0; i < N_ORDERS; i += 100) {
    await withTx(async (tx) => {
      for (let j = i; j < Math.min(i + 100, N_ORDERS); j++) {
        await tx.orders.create({ data: { order_number: `LO-${tag}-${j}`, customer_id: customer.id, status: 'ACCEPTED', lines: { create: [{ line_no: 1, sku_id: skuIds[j % skuIds.length]!, required_qty: 12n, uom_code: 'CASE', uom_qty: 2n }] } } });
      }
    });
  }
  console.log(`[load] ${N_ORDERS} orders (${Date.now() - t0} ms)`);

  // ---- integrity + heavy queries timing
  const time = async (label: string, fn: () => Promise<unknown>) => {
    const s = performance.now();
    const r = await fn();
    console.log(`[load] ${label}: ${Math.round(performance.now() - s)} ms`);
    return r;
  };
  const diffs = (await time('inventory_reconcile()', () => db.$queryRaw`SELECT count(*) AS n FROM inventory_reconcile()`)) as { n: bigint }[];
  console.log(`[load] reconcile discrepancies: ${diffs[0]!.n}`);
  await time('v_location_occupancy (warehouse)', () => db.$queryRaw`SELECT count(*) FROM v_location_occupancy WHERE warehouse_id = ${wh.id}::uuid`);
  await time('map payload query', () => db.$queryRaw`SELECT l.id, o.status FROM locations l JOIN v_location_occupancy o ON o.location_id = l.id WHERE l.warehouse_id = ${wh.id}::uuid`);
  await time('sku inventory summary', () => db.$queryRaw`SELECT * FROM v_sku_inventory LIMIT 100`);
  await time('lpn timeline (one pallet)', () => db.$queryRaw`SELECT * FROM inventory_movements WHERE to_lpn_id = ${lpnIds[0]}::uuid OR from_lpn_id = ${lpnIds[0]}::uuid`);

  // ---- HTTP load with concurrent users
  const password = 'Load-User-Pass-1!';
  const roles = await db.roles.findMany({ where: { code: { in: ['SUPERVISOR'] } } });
  const u = await db.users.create({ data: { username: `load_${tag.toLowerCase()}`, full_name: 'load', password_hash: await hashPassword(password), user_roles: { create: roles.map((r) => ({ role_id: r.id })) } } });
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  const base = `http://127.0.0.1:${addr.port}`;
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'wms-client', 'content-type': 'application/json' }, payload: JSON.stringify({ username: u.username, password }) });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const headers = { cookie, 'x-requested-with': 'wms-client', 'content-type': 'application/json' };

  const run = (title: string, opts: Partial<autocannon.Options>) =>
    new Promise<void>((resolve) => {
      autocannon({ url: base, connections: 50, duration: 10, headers, ...opts } as autocannon.Options, (err, res) => {
        if (err) console.error(err);
        else console.log(`[load] ${title}: ${res.requests.average.toFixed(0)} req/s, p50 ${res.latency.p50} ms, p99 ${res.latency.p99} ms, non-2xx ${res.non2xx}, errors ${res.errors}`);
        resolve();
      });
    });
  await run('GET /api/dashboard (50 conc)', { requests: [{ method: 'GET', path: '/api/dashboard' }] });
  await run('GET /api/inventory/lpns?limit=100 (50 conc)', { requests: [{ method: 'GET', path: '/api/inventory/lpns?limit=100' }] });
  await run(`GET /api/map (20 conc, ${slots.length} slots)`, { connections: 20, requests: [{ method: 'GET', path: `/api/map?warehouse_id=${wh.id}` }] });
  // allocation storm: 100 concurrent allocations of distinct orders
  const orders = await db.orders.findMany({ where: { order_number: { startsWith: `LO-${tag}-` } }, select: { id: true }, take: 400 });
  let idx = 0;
  await run('POST /api/orders/allocate (100 conc, distinct orders)', {
    connections: 100,
    amount: orders.length,
    requests: [{ method: 'POST', path: '/api/orders/allocate', setupRequest: (req) => ({ ...req, body: JSON.stringify({ order_id: orders[idx++ % orders.length]!.id, allow_partial: true }) }) }],
  });
  const allocated = await db.orders.count({ where: { order_number: { startsWith: `LO-${tag}-` }, status: { in: ['ALLOCATED', 'PARTIALLY_ALLOCATED'] } } });
  console.log(`[load] orders allocated after storm: ${allocated}/${orders.length}`);
  const diffs2 = (await db.$queryRaw`SELECT count(*) AS n FROM inventory_reconcile()`) as { n: bigint }[];
  const neg = (await db.$queryRaw`SELECT count(*) AS n FROM inventory_balances WHERE qty < 0`) as { n: bigint }[];
  console.log(`[load] FINAL reconcile discrepancies=${diffs2[0]!.n} negatives=${neg[0]!.n} total=${Date.now() - t0} ms`);
  await app.close();
  await closeDb();
  if (Number(diffs2[0]!.n) !== 0 || Number(neg[0]!.n) !== 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
