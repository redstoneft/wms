import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zAdjustInventory, zStatusChange } from '@wms/shared';
import { getDb, withTx } from '../../db.js';
import { NotFoundError } from '../../errors.js';
import { fingerprint, runIdempotent } from '../../lib/idempotency.js';
import * as svc from './service.js';

export async function inventoryRoutes(app: FastifyInstance) {
  const db = getDb();
  const read = app.requirePermission('inventory.read');

  /** Inventory grouped by SKU (all statuses). */
  app.get('/inventory/skus', { preHandler: read }, async (req) => {
    const q = z.object({ q: z.string().trim().max(60).optional(), status: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).default(200), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    return db.$queryRaw<Record<string, unknown>[]>`
      SELECT s.id AS sku_id, s.code, s.gtin, s.description, s.abc_class, s.family,
             COALESCE(sum(b.qty) FILTER (WHERE b.status = 'AVAILABLE'), 0)::text AS available,
             COALESCE(sum(b.qty) FILTER (WHERE b.status = 'ALLOCATED'), 0)::text AS allocated,
             COALESCE(sum(b.qty) FILTER (WHERE b.status IN ('PICKING','STAGING','LOADED')), 0)::text AS outbound,
             COALESCE(sum(b.qty) FILTER (WHERE b.status IN ('QUARANTINE','DAMAGED','BLOCKED')), 0)::text AS locked,
             COALESCE(sum(b.qty) FILTER (WHERE b.status = 'IN_TRANSFER'), 0)::text AS in_transfer,
             COALESCE(sum(b.qty), 0)::text AS total, count(DISTINCT b.lpn_id)::int AS lpn_count
        FROM skus s LEFT JOIN inventory_balances b ON b.sku_id = s.id AND b.qty > 0
       WHERE s.is_active AND (${q.q ?? null}::text IS NULL OR s.code ILIKE '%' || ${q.q ?? ''} || '%' OR s.description ILIKE '%' || ${q.q ?? ''} || '%'
             OR s.gtin = ${q.q ?? ''} OR EXISTS (SELECT 1 FROM sku_barcodes sb WHERE sb.sku_id = s.id AND sb.barcode ILIKE '%' || ${q.q ?? ''} || '%'))
       GROUP BY s.id HAVING (${q.status ?? null}::text IS NULL OR bool_or(b.status = ${q.status ?? null}))
       ORDER BY s.code LIMIT ${q.limit} OFFSET ${q.offset}`;
  });

  /** Inventory by LPN with location. */
  app.get('/inventory/lpns', { preHandler: read }, async (req) => {
    const q = z
      .object({ q: z.string().trim().max(60).optional(), status: z.string().optional(), location_id: z.string().uuid().optional(), zone_id: z.string().uuid().optional(), sku: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).default(200), offset: z.coerce.number().int().min(0).default(0) })
      .parse(req.query);
    return db.$queryRaw<Record<string, unknown>[]>`
      SELECT l.id, l.code, l.status, l.lpn_type, l.created_at, l.cases_count, l.weight_kg, l.lot, l.expiry_date, loc.code AS location_code, loc.id AS location_id, z.code AS zone_code,
             o.order_number, sh.shipment_number,
             (SELECT json_agg(json_build_object('sku_code', s.code, 'description', s.description, 'status', b.status, 'qty', b.qty::text) ORDER BY s.code)
                FROM inventory_balances b JOIN skus s ON s.id = b.sku_id WHERE b.lpn_id = l.id AND b.qty > 0) AS contents,
             (SELECT COALESCE(sum(b.qty), 0)::text FROM inventory_balances b WHERE b.lpn_id = l.id) AS total_qty
        FROM lpns l LEFT JOIN locations loc ON loc.id = l.current_location_id LEFT JOIN zones z ON z.id = loc.zone_id
        LEFT JOIN orders o ON o.id = l.order_id LEFT JOIN shipments sh ON sh.id = l.shipment_id
       WHERE (${q.q ?? null}::text IS NULL OR l.code ILIKE '%' || ${q.q ?? ''} || '%')
         AND (${q.status ?? null}::text IS NULL OR l.status = ANY(string_to_array(${q.status ?? ''}, ',')))
         AND (${q.location_id ?? null}::uuid IS NULL OR l.current_location_id = ${q.location_id ?? null}::uuid)
         AND (${q.zone_id ?? null}::uuid IS NULL OR loc.zone_id = ${q.zone_id ?? null}::uuid)
         AND (${q.sku ?? null}::text IS NULL OR EXISTS (SELECT 1 FROM inventory_balances b JOIN skus s ON s.id = b.sku_id WHERE b.lpn_id = l.id AND b.qty > 0 AND s.code = ${q.sku ?? ''}))
       ORDER BY l.created_at DESC LIMIT ${q.limit} OFFSET ${q.offset}`;
  });

  app.get('/inventory/lpns/:code', { preHandler: read }, async (req) => {
    const code = (req.params as { code: string }).code.toUpperCase();
    const lpn = await db.lpns.findUnique({
      where: { code },
      include: { balances: { include: { sku: true } }, current_location: { include: { zone: true } }, receipt: true, container: true, supplier: true, order: { include: { customer: true } }, shipment: true },
    });
    if (!lpn) throw new NotFoundError('LPN', code);
    return lpn;
  });

  app.get('/inventory/lpns/:code/timeline', { preHandler: read }, async (req) => {
    const code = (req.params as { code: string }).code;
    return withTx((tx) => svc.timeline(tx, 'LPN', code));
  });
  app.get('/inventory/skus/:code/timeline', { preHandler: read }, async (req) => {
    const code = (req.params as { code: string }).code;
    return withTx((tx) => svc.timeline(tx, 'SKU', code));
  });

  /** Inventory by location / zone / warehouse. */
  app.get('/inventory/by-zone', { preHandler: read }, async () => {
    return db.$queryRaw<Record<string, unknown>[]>`
      SELECT z.id AS zone_id, z.code AS zone_code, z.zone_type, count(DISTINCT loc.id)::int AS locations, count(DISTINCT l.id)::int AS lpns,
             COALESCE(sum(b.qty), 0)::text AS qty, COALESCE(sum(b.qty * s.unit_weight_kg), 0)::text AS weight_kg
        FROM zones z JOIN locations loc ON loc.zone_id = z.id AND loc.is_active
        LEFT JOIN lpns l ON l.current_location_id = loc.id LEFT JOIN inventory_balances b ON b.lpn_id = l.id AND b.qty > 0 LEFT JOIN skus s ON s.id = b.sku_id
       GROUP BY z.id ORDER BY z.code`;
  });

  app.get('/inventory/movements', { preHandler: read }, async (req) => {
    const q = z
      .object({ lpn: z.string().optional(), sku: z.string().optional(), type: z.string().optional(), order_id: z.string().uuid().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(1000).default(200), before_id: z.coerce.bigint().optional() })
      .parse(req.query);
    return db.$queryRaw<Record<string, unknown>[]>`
      SELECT m.id::text AS id, m.movement_type, m.occurred_at, m.qty::text AS qty, m.uom_code, m.uom_qty::text AS uom_qty, s.code AS sku_code, fl.code AS from_lpn, tl.code AS to_lpn,
             floc.code AS from_location, tloc.code AS to_location, m.from_status, m.to_status, u.username, m.device_id, m.reason, m.reference_type, m.reference_id,
             o.order_number, r.receipt_number, sh.shipment_number
        FROM inventory_movements m JOIN skus s ON s.id = m.sku_id LEFT JOIN users u ON u.id = m.user_id
        LEFT JOIN lpns fl ON fl.id = m.from_lpn_id LEFT JOIN lpns tl ON tl.id = m.to_lpn_id
        LEFT JOIN locations floc ON floc.id = m.from_location_id LEFT JOIN locations tloc ON tloc.id = m.to_location_id
        LEFT JOIN orders o ON o.id = m.order_id LEFT JOIN receipts r ON r.id = m.receipt_id LEFT JOIN shipments sh ON sh.id = m.shipment_id
       WHERE (${q.lpn ?? null}::text IS NULL OR fl.code = ${q.lpn?.toUpperCase() ?? ''} OR tl.code = ${q.lpn?.toUpperCase() ?? ''})
         AND (${q.sku ?? null}::text IS NULL OR s.code = ${q.sku ?? ''})
         AND (${q.type ?? null}::text IS NULL OR m.movement_type = ${q.type ?? ''})
         AND (${q.order_id ?? null}::uuid IS NULL OR m.order_id = ${q.order_id ?? null}::uuid)
         AND (${q.from ?? null}::timestamptz IS NULL OR m.occurred_at >= ${q.from ?? null}::timestamptz)
         AND (${q.to ?? null}::timestamptz IS NULL OR m.occurred_at <= ${q.to ?? null}::timestamptz)
         AND (${q.before_id ?? null}::bigint IS NULL OR m.id < ${q.before_id ?? null}::bigint)
       ORDER BY m.id DESC LIMIT ${q.limit}`;
  });

  app.post('/inventory/adjust', { preHandler: app.requirePermission('inventory.adjust') }, async (req, reply) => {
    const body = zAdjustInventory.parse(req.body);
    const r = await runIdempotent(req.actor!, fingerprint('POST', '/inventory/adjust', body), async (tx) => ({ status: 201, body: await svc.adjustInventory(tx, req.actor!, body) }));
    reply.status(r.status);
    if (r.replayed) reply.header('Idempotent-Replayed', 'true');
    return r.body;
  });

  app.post('/inventory/status', { preHandler: app.requirePermission('inventory.quarantine') }, async (req, reply) => {
    const body = zStatusChange.parse(req.body);
    const r = await runIdempotent(req.actor!, fingerprint('POST', '/inventory/status', body), async (tx) => ({ status: 200, body: await svc.changeInventoryStatus(tx, req.actor!, body) }));
    if (r.replayed) reply.header('Idempotent-Replayed', 'true');
    return r.body;
  });

  app.get('/inventory/reconcile', { preHandler: app.requirePermission('inventory.read') }, async () => withTx((tx) => svc.reconcile(tx)));
}
