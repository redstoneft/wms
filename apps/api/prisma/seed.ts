// Seed.
//   npx tsx prisma/seed.ts            → BASE data only (roles, permissions, admin, settings). Safe for production.
//   npx tsx prisma/seed.ts --demo     → BASE + realistic DEMO warehouse (never run against production).
//   SEED_ADMIN_PASSWORD env overrides the initial admin password (default: Admin-Change-Me-1!).
import 'dotenv/config';
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES, type Permission, type Role } from '@wms/shared';
import { closeDb, getDb, withTx } from '../src/db.js';
import { hashPassword } from '../src/lib/crypto.js';
import { SYSTEM_ACTOR } from '../src/lib/context.js';
import { createInventory, createLpn } from '../src/inventory/ledger.js';
import { syncRackLocations } from '../src/modules/layout/service.js';

const DEMO = process.argv.includes('--demo');
const db = getDb();

async function seedBase() {
  for (const [code, description] of Object.entries(PERMISSIONS)) {
    await db.permissions.upsert({ where: { code }, create: { code, description }, update: { description } });
  }
  const perms = await db.permissions.findMany();
  const permId = new Map(perms.map((p) => [p.code as Permission, p.id]));
  const names: Record<Role, string> = {
    ADMIN: 'Administrador',
    SUPERVISOR: 'Supervisor',
    RECEIVING: 'Recepción',
    FORKLIFT: 'Montacarguista',
    PICKER: 'Surtidor',
    VERIFIER: 'Verificador',
    LOADER: 'Cargador',
    INVENTORY_CONTROL: 'Control de inventarios',
  };
  for (const role of ROLES) {
    const r = await db.roles.upsert({ where: { code: role }, create: { code: role, name: names[role], is_system: true }, update: { name: names[role] } });
    await db.role_permissions.deleteMany({ where: { role_id: r.id } });
    await db.role_permissions.createMany({ data: ROLE_PERMISSIONS[role].map((p) => ({ role_id: r.id, permission_id: permId.get(p)! })) });
  }
  const adminRole = await db.roles.findUniqueOrThrow({ where: { code: 'ADMIN' } });
  const existing = await db.users.findUnique({ where: { username: 'admin' } });
  if (!existing) {
    const pw = process.env.SEED_ADMIN_PASSWORD ?? 'Admin-Change-Me-1!';
    await db.users.create({ data: { username: 'admin', full_name: 'Administrador', password_hash: await hashPassword(pw), user_roles: { create: [{ role_id: adminRole.id }] } } });
    console.log(`[seed] admin user created (password: ${process.env.SEED_ADMIN_PASSWORD ? '<from env>' : pw}) — MFA enrollment required at first login`);
  }
  for (const [code, description] of [
    ['DAMAGE_SUSPECTED', 'Posible daño, pendiente de inspección'],
    ['QUALITY_HOLD', 'Retención de calidad'],
    ['CUSTOMER_RETURN', 'Devolución de cliente en inspección'],
    ['LABEL_MISMATCH', 'Etiqueta no coincide con contenido'],
    ['EXPIRED', 'Producto caducado'],
  ] as const) {
    await db.quarantine_reasons.upsert({ where: { code }, create: { code, description }, update: { description } });
  }
  await db.settings.upsert({ where: { key: 'allocation_strategy' }, create: { key: 'allocation_strategy', value: 'FIFO', description: 'Default allocation strategy' }, update: {} });
  await db.settings.upsert({ where: { key: 'require_mfa_for_admin' }, create: { key: 'require_mfa_for_admin', value: true }, update: {} });
  if ((await db.slotting_rules.count()) === 0) {
    await db.slotting_rules.create({ data: { name: 'Default', priority: 100, weights: { same_sku: 30, abc_proximity: 20, zone_match: 25, fill_rack: 10, level_low_heavy: 15, family_affinity: 10 } } });
  }
  console.log('[seed] base data ready');
}

async function seedDemo() {
  if (await db.warehouses.findUnique({ where: { code: 'CEDIS-01' } })) {
    console.log('[seed] demo warehouse already exists, skipping demo seed');
    return;
  }
  const roles = await db.roles.findMany();
  const roleId = (c: Role) => roles.find((r) => r.code === c)!.id;
  const demoUsers: [string, string, Role[]][] = [
    ['supervisor', 'Laura Supervisora', ['SUPERVISOR']],
    ['recepcion', 'Miguel Recepción', ['RECEIVING']],
    ['montacargas', 'Carlos Montacargas', ['FORKLIFT']],
    ['surtidor', 'Ana Surtidora', ['PICKER']],
    ['surtidor2', 'Pedro Surtidor', ['PICKER']],
    ['verificador', 'Rosa Verificadora', ['VERIFIER']],
    ['cargador', 'Jorge Cargador', ['LOADER']],
    ['inventarios', 'Sofía Inventarios', ['INVENTORY_CONTROL']],
  ];
  for (const [username, full_name, rs] of demoUsers) {
    if (await db.users.findUnique({ where: { username } })) continue;
    await db.users.create({ data: { username, full_name, password_hash: await hashPassword(`${username}-Demo-1!`), user_roles: { create: rs.map((r) => ({ role_id: roleId(r) })) } } });
  }
  console.log('[seed] demo users: <username>-Demo-1! (e.g. surtidor / surtidor-Demo-1!)');

  const wh = await db.warehouses.create({ data: { code: 'CEDIS-01', name: 'CEDIS Principal', width_m: 70, depth_m: 45, height_m: 10 } });
  const zone = (code: string, name: string, zone_type: string, x: number, y: number, w: number, d: number, color: string) =>
    db.zones.create({ data: { warehouse_id: wh.id, code, name, zone_type, x_m: x, y_m: y, width_m: w, depth_m: d, color } });
  const zREC = await zone('REC', 'Recepción', 'RECEIVING', 0, 0, 16, 10, '#38bdf8');
  const zSTG = await zone('STG', 'Staging', 'STAGING', 18, 0, 22, 10, '#a78bfa');
  const zSHP = await zone('SHP', 'Embarques', 'SHIPPING', 42, 0, 16, 10, '#34d399');
  const zQAR = await zone('QAR', 'Cuarentena', 'QUARANTINE', 60, 0, 10, 10, '#f87171');
  const zRET = await zone('RET', 'Devoluciones', 'RETURNS', 60, 12, 10, 8, '#fb923c');
  const zA = await zone('A', 'Almacén reserva', 'STORAGE', 0, 14, 44, 31, '#94a3b8');
  const zP = await zone('P', 'Picking', 'PICKING', 46, 22, 12, 23, '#fbbf24');

  const area = (zoneId: string, code: string, type: string, x: number, y: number, w: number, d: number, cap: number) =>
    db.locations.create({ data: { warehouse_id: wh.id, zone_id: zoneId, code, barcode: `LOC-${code}`, location_type: type, x_m: x, y_m: y, width_m: w, depth_m: d, height_m: 3, pallet_capacity: cap, max_weight_kg: 50000 } });
  await area(zREC.id, 'DOCK-01', 'RECEIVING', 1, 1, 6, 8, 30);
  await area(zREC.id, 'DOCK-02', 'RECEIVING', 9, 1, 6, 8, 30);
  for (let i = 1; i <= 6; i++) await area(zSTG.id, `STG-${String(i).padStart(2, '0')}`, 'STAGING', 18 + (i - 1) * 3.6, 1, 3.2, 8, 10);
  await area(zSHP.id, 'SHIP-01', 'SHIPPING', 43, 1, 7, 8, 40);
  await area(zSHP.id, 'SHIP-02', 'SHIPPING', 51, 1, 6, 8, 40);
  await area(zQAR.id, 'QAR-01', 'QUARANTINE', 61, 1, 8, 8, 20);
  await area(zRET.id, 'RET-01', 'RETURNS', 61, 13, 8, 6, 12);
  await area(zRET.id, 'DMG-01', 'DAMAGED', 61, 20, 8, 4, 8);

  // storage racks: zone A, 3 aisles × 2 racks each, 8 bays × 4 levels
  let rackCount = 0;
  for (let a = 1; a <= 3; a++) {
    const aisle = await db.aisles.create({ data: { zone_id: zA.id, code: String(a).padStart(2, '0') } });
    for (let r = 1; r <= 2; r++) {
      const geom = { bays: 8, levels: 4, positions_per_bay: 1, bay_width_m: 2.7, level_height_m: 1.8, depth_m: 1.2, x_m: 1 + (r - 1) * 23, y_m: 15 + (a - 1) * 9, rotation_deg: 0 };
      const rack = await db.racks.create({ data: { aisle_id: aisle.id, code: `R${String(r).padStart(2, '0')}`, ...geom } });
      await withTx((tx) => syncRackLocations(tx, { ...rack, ...geom }, { location_type: 'RESERVE', pallet_capacity: 1, max_weight_kg: 1500 }));
      rackCount++;
    }
  }
  // picking rack: zone P, floor level pallets 2 levels
  const pAisle = await db.aisles.create({ data: { zone_id: zP.id, code: '01' } });
  const pGeom = { bays: 8, levels: 2, positions_per_bay: 1, bay_width_m: 2.7, level_height_m: 1.8, depth_m: 1.2, x_m: 47, y_m: 23, rotation_deg: 90 };
  const pRack = await db.racks.create({ data: { aisle_id: pAisle.id, code: 'R01', ...pGeom } });
  await withTx((tx) => syncRackLocations(tx, { ...pRack, ...pGeom }, { location_type: 'PICKING', pallet_capacity: 1, max_weight_kg: 1500 }));
  console.log(`[seed] layout: ${rackCount + 1} racks, ${await db.locations.count()} locations`);

  // master data
  const families = ['OLLAS', 'SARTENES', 'VAJILLAS', 'CUCHILLERIA', 'ACCESORIOS'];
  const skus: { id: string; code: string; abc_class: string; caseQty: bigint; palletCases: bigint }[] = [];
  for (let i = 1; i <= 30; i++) {
    const fam = families[(i - 1) % families.length]!;
    const abc = i <= 8 ? 'A' : i <= 18 ? 'B' : 'C';
    const caseQty = fam === 'VAJILLAS' ? 4n : fam === 'CUCHILLERIA' ? 12n : 6n;
    const palletCases = fam === 'VAJILLAS' ? 30n : 40n;
    const sku = await db.skus.create({
      data: {
        code: `SKU-${String(i).padStart(4, '0')}`,
        description: `${fam.charAt(0) + fam.slice(1).toLowerCase()} modelo ${i}`,
        family: fam,
        compatibility_group: 'GENERAL',
        abc_class: abc,
        unit_weight_kg: fam === 'VAJILLAS' ? 2.5 : 0.9,
        pallet_height_cm: 160,
        uoms: { create: [{ uom_code: 'PIECE', base_qty: 1n }, { uom_code: 'CASE', base_qty: caseQty }, { uom_code: 'PALLET', base_qty: caseQty * palletCases }] },
        barcodes: { create: [{ barcode: `750${String(1000000000 + i)}`, uom_code: 'PIECE' }, { barcode: `1750${String(1000000000 + i)}`, uom_code: 'CASE' }] },
      },
    });
    skus.push({ id: sku.id, code: sku.code, abc_class: sku.abc_class, caseQty, palletCases });
  }
  const customers: { id: string; name: string }[] = [];
  for (const [code, name] of [['CLI-001', 'Walmart de México'], ['CLI-002', 'HEB'], ['CLI-003', 'Woolworth'], ['CLI-004', 'Casa Ley'], ['CLI-005', 'Alsuper']] as const) {
    customers.push(await db.customers.create({ data: { code, name, address: 'CEDIS cliente' } }));
  }
  const suppliers: { id: string }[] = [];
  for (const [code, name] of [['PROV-001', 'Zhejiang Cookware Co.'], ['PROV-002', 'Guangdong Tableware Ltd.'], ['PROV-003', 'Yiwu Kitchen Accessories']] as const) {
    suppliers.push(await db.suppliers.create({ data: { code, name } }));
  }
  const carriers: { id: string }[] = [];
  for (const [code, name] of [['TRP-001', 'Transportes del Norte'], ['TRP-002', 'Fletes Rápidos'], ['TRP-003', 'Logística Bajío']] as const) {
    carriers.push(await db.carriers.create({ data: { code, name } }));
  }
  await db.printers.create({ data: { code: 'ZEBRA-REC', name: 'Zebra ZT411 Recepción', host: '192.168.1.50', port: 9100, is_default: true } });
  await db.printers.create({ data: { code: 'ZEBRA-EMB', name: 'Zebra ZD421 Embarques', host: '192.168.1.51', port: 9100 } });

  // initial inventory: pallets in reserve (FIFO dates spread over 60 days)
  const reserve = await db.locations.findMany({ where: { location_type: 'RESERVE' }, orderBy: { code: 'asc' } });
  const picking = await db.locations.findMany({ where: { location_type: 'PICKING' }, orderBy: { code: 'asc' } });
  let pallets = 0;
  await withTx(async (tx) => {
    let li = 0;
    for (let i = 0; i < skus.length; i++) {
      const sku = skus[i]!;
      const nPallets = sku.abc_class === 'A' ? 4 : sku.abc_class === 'B' ? 2 : 1;
      for (let p = 0; p < nPallets && li < reserve.length; p++) {
        const loc = reserve[li++]!;
        const lpn = await createLpn(tx, SYSTEM_ACTOR, { warehouse_id: wh.id, lpn_type: 'STORAGE', location_id: loc.id, supplier_id: suppliers[i % suppliers.length]!.id, cases_count: Number(sku.palletCases) });
        const ageDays = 60 - (i * 3 + p * 7) % 60;
        await tx.lpns.update({ where: { id: lpn.id }, data: { status: 'STORED', created_at: new Date(Date.now() - ageDays * 86400_000) } });
        await createInventory(tx, SYSTEM_ACTOR, { movement_type: 'INITIAL_LOAD', to_lpn: lpn, sku_id: sku.id, qty: sku.caseQty * sku.palletCases, uom_code: 'PALLET', uom_qty: 1n, status: 'AVAILABLE', location_id: loc.id, reason: 'Demo initial inventory' });
        pallets++;
      }
    }
    // picking faces for A items with replenishment rules
    for (let i = 0; i < 8 && i < picking.length; i++) {
      const sku = skus[i]!;
      const loc = picking[i]!;
      const lpn = await createLpn(tx, SYSTEM_ACTOR, { warehouse_id: wh.id, lpn_type: 'STORAGE', location_id: loc.id, cases_count: 10 });
      await tx.lpns.update({ where: { id: lpn.id }, data: { status: 'STORED' } });
      await createInventory(tx, SYSTEM_ACTOR, { movement_type: 'INITIAL_LOAD', to_lpn: lpn, sku_id: sku.id, qty: sku.caseQty * 10n, uom_code: 'CASE', uom_qty: 10n, status: 'AVAILABLE', location_id: loc.id, reason: 'Demo picking face' });
      await tx.replenishment_rules.create({ data: { sku_id: sku.id, pick_location_id: loc.id, min_qty: sku.caseQty * 4n, max_qty: sku.caseQty * 20n } });
      pallets++;
    }
  });
  console.log(`[seed] inventory: ${pallets} pallets`);

  // inbound: PO + scheduled container
  const po = await db.purchase_orders.create({
    data: {
      po_number: 'OC-2026-0001',
      supplier_id: suppliers[0]!.id,
      expected_date: new Date(),
      lines: { create: skus.slice(0, 5).map((s, i) => ({ line_no: i + 1, sku_id: s.id, ordered_qty: s.caseQty * s.palletCases * 2n, uom_code: 'PALLET', uom_qty: 2n })) },
    },
  });
  await db.containers.create({ data: { container_number: 'MSKU1234567', supplier_id: suppliers[0]!.id, po_id: po.id, carrier_id: carriers[0]!.id, bl_number: 'BL-88231', seal_number: 'SL-4471', plates: 'ABC-123-D', scheduled_at: new Date(Date.now() + 3600_000), status: 'SCHEDULED' } });
  await db.containers.create({ data: { container_number: 'TCLU7654321', supplier_id: suppliers[1]!.id, carrier_id: carriers[1]!.id, bl_number: 'BL-88232', scheduled_at: new Date(Date.now() + 86400_000), status: 'SCHEDULED' } });

  // orders
  for (let o = 1; o <= 5; o++) {
    const cust = customers[(o - 1) % customers.length]!;
    const lines = [];
    for (let l = 0; l < 3 + (o % 3); l++) {
      const s = skus[(o * 3 + l) % skus.length]!;
      const cases = BigInt(2 + ((o + l) % 5));
      lines.push({ line_no: l + 1, sku_id: s.id, required_qty: s.caseQty * cases, uom_code: 'CASE', uom_qty: cases });
    }
    await db.orders.create({ data: { order_number: `PED-${48570 + o}`, customer_id: cust.id, destination: `CEDIS ${cust.name}`, order_date: new Date(), priority: o <= 2 ? 1 : 5, status: 'IMPORTED', source: 'IMPORT', lines: { create: lines } } });
  }
  console.log('[seed] demo: 5 orders, 2 containers, 1 PO');
}

async function main() {
  await seedBase();
  if (DEMO) await seedDemo();
  await closeDb();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
