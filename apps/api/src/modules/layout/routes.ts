import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zCreateAisle, zCreateAreaLocation, zCreateRack, zCreateZone, zUpdateLocation, zUpdateRack, zUpdateZone, zUuid } from '@wms/shared';
import { getDb, withTx } from '../../db.js';
import { ConflictError, NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import { syncRackLocations } from './service.js';

export async function layoutRoutes(app: FastifyInstance) {
  const db = getDb();
  const read = app.requirePermission('layout.read');
  const manage = app.requirePermission('layout.manage');

  app.get('/warehouses', { preHandler: read }, async () => db.warehouses.findMany({ orderBy: { code: 'asc' } }));
  app.post('/warehouses', { preHandler: manage }, async (req, reply) => {
    const body = z
      .object({
        code: z.string().trim().min(1).max(20),
        name: z.string().trim().min(1).max(120),
        address: z.string().trim().max(500).optional(),
        width_m: z.number().positive().max(10000).default(60),
        depth_m: z.number().positive().max(10000).default(40),
        height_m: z.number().positive().max(100).default(10),
      })
      .parse(req.body);
    const w = await withTx(async (tx) => {
      const r = await tx.warehouses.create({ data: body });
      await audit(tx, req.actor!, { action: 'warehouse.create', entity_type: 'warehouse', entity_id: r.id, after: r });
      return r;
    });
    reply.status(201);
    return w;
  });
  app.patch('/warehouses/:id', { preHandler: manage }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const body = z
      .object({ name: z.string().trim().min(1).max(120).optional(), address: z.string().trim().max(500).optional(), width_m: z.number().positive().optional(), depth_m: z.number().positive().optional(), height_m: z.number().positive().optional() })
      .parse(req.body);
    return withTx(async (tx) => {
      const before = await tx.warehouses.findUnique({ where: { id } });
      if (!before) throw new NotFoundError('warehouse', id);
      const after = await tx.warehouses.update({ where: { id }, data: body });
      await audit(tx, req.actor!, { action: 'warehouse.update', entity_type: 'warehouse', entity_id: id, before, after });
      return after;
    });
  });

  // ---------- zones ----------
  app.get('/zones', { preHandler: read }, async (req) => {
    const q = z.object({ warehouse_id: zUuid.optional() }).parse(req.query);
    return db.zones.findMany({ where: q.warehouse_id ? { warehouse_id: q.warehouse_id } : {}, include: { aisles: { include: { racks: true } } }, orderBy: { code: 'asc' } });
  });
  app.post('/zones', { preHandler: manage }, async (req, reply) => {
    const body = zCreateZone.parse(req.body);
    const zone = await withTx(async (tx) => {
      const r = await tx.zones.create({ data: { ...body, color: body.color ?? null } });
      await audit(tx, req.actor!, { action: 'zone.create', entity_type: 'zone', entity_id: r.id, after: r });
      return r;
    });
    reply.status(201);
    return zone;
  });
  app.patch('/zones/:id', { preHandler: manage }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const body = zUpdateZone.parse(req.body);
    return withTx(async (tx) => {
      const before = await tx.zones.findUnique({ where: { id } });
      if (!before) throw new NotFoundError('zone', id);
      const after = await tx.zones.update({ where: { id }, data: body });
      await audit(tx, req.actor!, { action: 'zone.update', entity_type: 'zone', entity_id: id, before, after });
      return after;
    });
  });

  // ---------- aisles ----------
  app.post('/aisles', { preHandler: manage }, async (req, reply) => {
    const body = zCreateAisle.parse(req.body);
    const a = await withTx(async (tx) => {
      const r = await tx.aisles.create({ data: { zone_id: body.zone_id, code: body.code, name: body.name ?? null } });
      await audit(tx, req.actor!, { action: 'aisle.create', entity_type: 'aisle', entity_id: r.id, after: r });
      return r;
    });
    reply.status(201);
    return a;
  });

  // ---------- racks ----------
  app.get('/racks', { preHandler: read }, async (req) => {
    const q = z.object({ zone_id: zUuid.optional(), aisle_id: zUuid.optional() }).parse(req.query);
    return db.racks.findMany({
      where: { ...(q.aisle_id ? { aisle_id: q.aisle_id } : {}), ...(q.zone_id ? { aisle: { zone_id: q.zone_id } } : {}) },
      include: { aisle: { include: { zone: true } } },
      orderBy: { code: 'asc' },
    });
  });
  app.post('/racks', { preHandler: manage }, async (req, reply) => {
    const body = zCreateRack.parse(req.body);
    const rack = await withTx(async (tx) => {
      const aisle = await tx.aisles.findUnique({ where: { id: body.aisle_id } });
      if (!aisle) throw new NotFoundError('aisle', body.aisle_id);
      const { generate_locations, location_type, pallet_capacity, max_weight_kg, ...rackData } = body;
      const r = await tx.racks.create({ data: rackData });
      let gen = { created: 0, updated: 0, deactivated: 0 };
      if (generate_locations) {
        gen = await syncRackLocations(tx, { ...r, bay_width_m: Number(r.bay_width_m), level_height_m: Number(r.level_height_m), depth_m: Number(r.depth_m), x_m: Number(r.x_m), y_m: Number(r.y_m) }, { location_type, pallet_capacity, max_weight_kg });
      }
      await audit(tx, req.actor!, { action: 'rack.create', entity_type: 'rack', entity_id: r.id, after: { ...r, generated: gen } });
      return { ...r, generated: gen };
    });
    reply.status(201);
    return rack;
  });
  app.patch('/racks/:id', { preHandler: manage }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const body = zUpdateRack.parse(req.body);
    return withTx(async (tx) => {
      const before = await tx.racks.findUnique({ where: { id } });
      if (!before) throw new NotFoundError('rack', id);
      const after = await tx.racks.update({ where: { id }, data: body });
      const sample = await tx.locations.findFirst({ where: { rack_id: id } });
      const gen = await syncRackLocations(
        tx,
        { ...after, bay_width_m: Number(after.bay_width_m), level_height_m: Number(after.level_height_m), depth_m: Number(after.depth_m), x_m: Number(after.x_m), y_m: Number(after.y_m) },
        { location_type: sample?.location_type ?? 'RESERVE', pallet_capacity: sample?.pallet_capacity ?? 1, max_weight_kg: sample ? Number(sample.max_weight_kg) : 1500 },
      );
      await audit(tx, req.actor!, { action: 'rack.update', entity_type: 'rack', entity_id: id, before, after: { ...after, generated: gen } });
      return { ...after, generated: gen };
    });
  });

  // ---------- locations ----------
  app.get('/locations', { preHandler: read }, async (req) => {
    const q = z
      .object({
        warehouse_id: zUuid.optional(),
        zone_id: zUuid.optional(),
        rack_id: zUuid.optional(),
        type: z.string().optional(),
        status: z.string().optional(),
        q: z.string().trim().max(60).optional(),
        limit: z.coerce.number().int().min(1).max(5000).default(500),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const rows = await db.$queryRaw<Record<string, unknown>[]>`
      SELECT l.id, l.code, l.barcode, l.location_type, l.admin_status, l.zone_id, l.rack_id, l.warehouse_id, l.bay, l.level, l.position,
             l.x_m, l.y_m, l.z_m, l.width_m, l.depth_m, l.height_m, l.pallet_capacity, l.max_weight_kg, l.pick_sequence, l.is_active, l.block_reason, l.restrictions,
             o.status, o.lpn_count, o.total_qty, o.weight_kg, o.reserved_count
        FROM locations l JOIN v_location_occupancy o ON o.location_id = l.id
       WHERE l.is_active
         AND (${q.warehouse_id ?? null}::uuid IS NULL OR l.warehouse_id = ${q.warehouse_id ?? null}::uuid)
         AND (${q.zone_id ?? null}::uuid IS NULL OR l.zone_id = ${q.zone_id ?? null}::uuid)
         AND (${q.rack_id ?? null}::uuid IS NULL OR l.rack_id = ${q.rack_id ?? null}::uuid)
         AND (${q.type ?? null}::text IS NULL OR l.location_type = ${q.type ?? null})
         AND (${q.status ?? null}::text IS NULL OR o.status = ${q.status ?? null})
         AND (${q.q ?? null}::text IS NULL OR l.code ILIKE '%' || ${q.q ?? ''} || '%')
       ORDER BY l.code LIMIT ${q.limit} OFFSET ${q.offset}`;
    return { items: rows };
  });

  app.get('/locations/:idOrCode', { preHandler: read }, async (req) => {
    const key = (req.params as { idOrCode: string }).idOrCode;
    const isUuid = z.string().uuid().safeParse(key).success;
    const loc = await db.$queryRaw<Record<string, unknown>[]>`
      SELECT l.*, o.status, o.lpn_count, o.total_qty, o.weight_kg, o.reserved_count, z.code AS zone_code, r.code AS rack_code
        FROM locations l JOIN v_location_occupancy o ON o.location_id = l.id
        LEFT JOIN zones z ON z.id = l.zone_id LEFT JOIN racks r ON r.id = l.rack_id
       WHERE ${isUuid ? key : null}::uuid = l.id OR l.code = ${key.toUpperCase()} OR l.barcode = ${key}`;
    const row = loc[0];
    if (!row) throw new NotFoundError('location', key);
    const lpns = await db.$queryRaw<Record<string, unknown>[]>`
      SELECT l.id, l.code, l.status, l.lpn_type, l.order_id,
             json_agg(json_build_object('sku_code', s.code, 'description', s.description, 'status', b.status, 'qty', b.qty::text) ORDER BY s.code) AS contents
        FROM lpns l JOIN inventory_balances b ON b.lpn_id = l.id AND b.qty > 0 JOIN skus s ON s.id = b.sku_id
       WHERE l.current_location_id = ${row.id as string}::uuid GROUP BY l.id ORDER BY l.code`;
    const last = await db.$queryRaw<Record<string, unknown>[]>`
      SELECT m.id, m.movement_type, m.occurred_at, m.qty, s.code AS sku_code, u.username
        FROM inventory_movements m JOIN skus s ON s.id = m.sku_id LEFT JOIN users u ON u.id = m.user_id
       WHERE m.to_location_id = ${row.id as string}::uuid OR m.from_location_id = ${row.id as string}::uuid
       ORDER BY m.id DESC LIMIT 1`;
    return { ...row, lpns, last_movement: last[0] ?? null };
  });

  app.post('/locations', { preHandler: manage }, async (req, reply) => {
    const body = zCreateAreaLocation.parse(req.body);
    const loc = await withTx(async (tx) => {
      const code = body.code.toUpperCase();
      const clash = await tx.locations.findFirst({ where: { OR: [{ warehouse_id: body.warehouse_id, code }, { barcode: `LOC-${code}` }] } });
      if (clash) throw new ConflictError('LOCATION_EXISTS', `Location ${code} already exists`);
      const r = await tx.locations.create({ data: { ...body, code, barcode: `LOC-${code}`, zone_id: body.zone_id ?? null } });
      await audit(tx, req.actor!, { action: 'location.create', entity_type: 'location', entity_id: r.id, after: r });
      return r;
    });
    reply.status(201);
    return loc;
  });

  app.patch('/locations/:id', { preHandler: manage }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const body = zUpdateLocation.parse(req.body);
    return withTx(async (tx) => {
      const before = await tx.locations.findUnique({ where: { id } });
      if (!before) throw new NotFoundError('location', id);
      if (body.admin_status && body.admin_status !== 'ACTIVE' && !body.reason) {
        throw new RuleError('REASON_REQUIRED', 'Blocking or quarantining a location requires a reason');
      }
      if (body.is_active === false) {
        const occupied = await tx.lpns.count({ where: { current_location_id: id } });
        if (occupied) throw new RuleError('LOCATION_OCCUPIED', `Location holds ${occupied} LPN(s); move them first`);
      }
      const { reason, ...data } = body;
      const after = await tx.locations.update({
        where: { id },
        data: { ...data, block_reason: body.admin_status === 'ACTIVE' ? null : (body.block_reason ?? reason ?? before.block_reason) },
      });
      await audit(tx, req.actor!, { action: 'location.update', entity_type: 'location', entity_id: id, before, after, reason: reason ?? null });
      return after;
    });
  });

  // ---------- 3D map payload: everything the digital twin needs in one call ----------
  app.get('/map', { preHandler: read }, async (req) => {
    const q = z.object({ warehouse_id: zUuid.optional() }).parse(req.query);
    const wh = q.warehouse_id
      ? await db.warehouses.findUnique({ where: { id: q.warehouse_id } })
      : await db.warehouses.findFirst({ where: { is_active: true }, orderBy: { created_at: 'asc' } });
    if (!wh) throw new NotFoundError('warehouse');
    const [zones, racks, locations, occupancy] = await Promise.all([
      db.zones.findMany({ where: { warehouse_id: wh.id, is_active: true }, include: { aisles: true } }),
      db.racks.findMany({ where: { is_active: true, aisle: { zone: { warehouse_id: wh.id } } }, include: { aisle: { include: { zone: true } } } }),
      db.$queryRaw<Record<string, unknown>[]>`
        SELECT l.id, l.code, l.barcode, l.location_type, l.zone_id, l.rack_id, l.bay, l.level, l.position,
               l.x_m::float8 AS x, l.y_m::float8 AS y, l.z_m::float8 AS z, l.width_m::float8 AS w, l.depth_m::float8 AS d, l.height_m::float8 AS h,
               l.pallet_capacity, o.status, o.lpn_count, o.total_qty::text AS total_qty, o.weight_kg::float8 AS weight_kg
          FROM locations l JOIN v_location_occupancy o ON o.location_id = l.id
         WHERE l.warehouse_id = ${wh.id}::uuid AND l.is_active`,
      db.$queryRaw<{ scope: string; id: string; total: bigint; occupied: bigint }[]>`
        SELECT 'zone' AS scope, l.zone_id::text AS id, count(*) AS total, count(*) FILTER (WHERE o.status IN ('OCCUPIED','PARTIAL')) AS occupied
          FROM locations l JOIN v_location_occupancy o ON o.location_id = l.id WHERE l.warehouse_id = ${wh.id}::uuid AND l.is_active AND l.zone_id IS NOT NULL GROUP BY l.zone_id
        UNION ALL
        SELECT 'rack', l.rack_id::text, count(*), count(*) FILTER (WHERE o.status IN ('OCCUPIED','PARTIAL'))
          FROM locations l JOIN v_location_occupancy o ON o.location_id = l.id WHERE l.warehouse_id = ${wh.id}::uuid AND l.is_active AND l.rack_id IS NOT NULL GROUP BY l.rack_id
        UNION ALL
        SELECT 'warehouse', l.warehouse_id::text, count(*), count(*) FILTER (WHERE o.status IN ('OCCUPIED','PARTIAL'))
          FROM locations l JOIN v_location_occupancy o ON o.location_id = l.id WHERE l.warehouse_id = ${wh.id}::uuid AND l.is_active GROUP BY l.warehouse_id`,
    ]);
    const num = (v: unknown) => Number(v);
    return {
      warehouse: { ...wh, width_m: num(wh.width_m), depth_m: num(wh.depth_m), height_m: num(wh.height_m) },
      zones: zones.map((z) => ({ ...z, x_m: num(z.x_m), y_m: num(z.y_m), width_m: num(z.width_m), depth_m: num(z.depth_m) })),
      racks: racks.map((r) => ({
        id: r.id,
        code: r.code,
        aisle_code: r.aisle.code,
        zone_id: r.aisle.zone_id,
        zone_code: r.aisle.zone.code,
        bays: r.bays,
        levels: r.levels,
        positions_per_bay: r.positions_per_bay,
        bay_width_m: Number(r.bay_width_m),
        level_height_m: Number(r.level_height_m),
        depth_m: Number(r.depth_m),
        x_m: Number(r.x_m),
        y_m: Number(r.y_m),
        rotation_deg: r.rotation_deg,
      })),
      locations,
      occupancy: occupancy.map((o) => ({ scope: o.scope, id: o.id, total: Number(o.total), occupied: Number(o.occupied), pct: o.total ? Math.round((Number(o.occupied) / Number(o.total)) * 1000) / 10 : 0 })),
      generated_at: new Date().toISOString(),
    };
  });

  /** Search for the map: SKU → locations, LPN → location, order → staging/lpn locations. */
  app.get('/map/search', { preHandler: read }, async (req) => {
    const q = z.object({ type: z.enum(['SKU', 'LPN', 'LOCATION', 'ORDER']), q: z.string().trim().min(1).max(64) }).parse(req.query);
    switch (q.type) {
      case 'SKU': {
        const rows = await db.$queryRaw<{ location_id: string; code: string; lpn_code: string; qty: bigint; status: string }[]>`
          SELECT l.current_location_id AS location_id, loc.code, l.code AS lpn_code, b.qty, b.status
            FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id JOIN skus s ON s.id = b.sku_id JOIN locations loc ON loc.id = l.current_location_id
           WHERE b.qty > 0 AND (s.code = ${q.q} OR s.id::text = ${q.q} OR EXISTS (SELECT 1 FROM sku_barcodes sb WHERE sb.sku_id = s.id AND sb.barcode = ${q.q}))`;
        return { type: 'SKU', hits: rows };
      }
      case 'LPN': {
        const rows = await db.$queryRaw<{ location_id: string | null; code: string | null; lpn_code: string; status: string }[]>`
          SELECT l.current_location_id AS location_id, loc.code, l.code AS lpn_code, l.status FROM lpns l LEFT JOIN locations loc ON loc.id = l.current_location_id
           WHERE l.code = ${q.q.toUpperCase()}`;
        return { type: 'LPN', hits: rows };
      }
      case 'LOCATION': {
        const rows = await db.$queryRaw<{ location_id: string; code: string }[]>`SELECT id AS location_id, code FROM locations WHERE code = ${q.q.toUpperCase()} OR barcode = ${q.q}`;
        return { type: 'LOCATION', hits: rows };
      }
      case 'ORDER': {
        const rows = await db.$queryRaw<{ location_id: string | null; code: string | null; lpn_code: string; kind: string }[]>`
          SELECT l.current_location_id AS location_id, loc.code, l.code AS lpn_code, 'OUTBOUND_LPN' AS kind
            FROM lpns l JOIN orders o ON o.id = l.order_id LEFT JOIN locations loc ON loc.id = l.current_location_id WHERE o.order_number = ${q.q}
          UNION ALL
          SELECT sa.location_id, loc.code, NULL, 'STAGING' FROM staging_assignments sa JOIN orders o ON o.id = sa.order_id JOIN locations loc ON loc.id = sa.location_id
           WHERE o.order_number = ${q.q} AND sa.released_at IS NULL
          UNION ALL
          SELECT l.current_location_id, loc.code, l.code, 'ALLOCATED_FROM' FROM allocations a JOIN order_lines ol ON ol.id = a.order_line_id JOIN orders o ON o.id = ol.order_id
            JOIN lpns l ON l.id = a.lpn_id LEFT JOIN locations loc ON loc.id = l.current_location_id WHERE o.order_number = ${q.q} AND a.status = 'ACTIVE'`;
        return { type: 'ORDER', hits: rows };
      }
    }
  });
}
