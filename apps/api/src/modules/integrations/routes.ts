// Integration layer — decoupled entry point for external systems (Aspel SAE,
// TMS, e-commerce). The WMS core knows nothing about SAE: this module only
// translates external payloads into the same commands the UI uses.
//
// Authentication: `X-Api-Key` (hashed comparison against INTEGRATION_API_KEY)
// acting as the service user `integration` (created on demand, role SUPERVISOR
// restricted here to order/PO/master-data commands). Every call is audited and
// idempotent by external reference (order_number / po_number).
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { permissionsForRoles, zOrderLineInput } from '@wms/shared';
import { getDb, withTx } from '../../db.js';
import { ForbiddenError, UnauthorizedError } from '../../errors.js';
import type { ActorContext } from '../../lib/context.js';
import { hashPassword } from '../../lib/crypto.js';
import { createOrder } from '../orders/service.js';
import { audit } from '../../lib/audit.js';

const zSaeOrder = z.object({
  order_number: z.string().trim().min(1).max(60), // SAE folio, e.g. "PED-48571"
  customer_code: z.string().trim().min(1).max(40),
  destination: z.string().trim().max(500).optional(),
  order_date: z.coerce.date().optional(),
  priority: z.number().int().min(1).max(9).default(5),
  external_ref: z.string().trim().max(80).optional(), // SAE document id
  notes: z.string().trim().max(2000).optional(),
  lines: z.array(zOrderLineInput).min(1).max(1000),
});
const zSaeBatch = z.object({ orders: z.array(zSaeOrder).min(1).max(200) });

async function integrationActor(req: FastifyRequest): Promise<ActorContext> {
  const configured = process.env.INTEGRATION_API_KEY;
  const provided = req.headers['x-api-key'];
  if (!configured || configured.length < 24) throw new ForbiddenError('Integration API is disabled (INTEGRATION_API_KEY not configured)');
  if (typeof provided !== 'string') throw new UnauthorizedError('Missing X-Api-Key');
  const a = createHash('sha256').update(configured).digest();
  const b = createHash('sha256').update(provided).digest();
  if (!timingSafeEqual(a, b)) throw new UnauthorizedError('Invalid API key');
  const db = getDb();
  let user = await db.users.findUnique({ where: { username: 'integration' } });
  if (!user) {
    const role = await db.roles.findUniqueOrThrow({ where: { code: 'SUPERVISOR' } });
    user = await db.users.create({ data: { username: 'integration', full_name: 'Integración externa (SAE)', password_hash: await hashPassword(createHash('sha256').update(configured).digest('hex')), user_roles: { create: [{ role_id: role.id }] } } });
  }
  return {
    userId: user.id,
    username: 'integration',
    roles: ['SUPERVISOR'],
    permissions: new Set([...permissionsForRoles(['SUPERVISOR'])].filter((p) => ['orders.manage', 'orders.read', 'masterdata.read', 'inventory.read', 'shipments.read'].includes(p))),
    deviceId: 'integration',
    ip: req.ip,
    requestId: req.id,
    idempotencyKey: null,
  };
}

export async function integrationRoutes(app: FastifyInstance) {
  const db = getDb();

  /** Upsert-by-number import of sales orders from SAE. Existing order numbers are skipped (never duplicated). */
  app.post('/integrations/sae/orders', async (req) => {
    const ctx = await integrationActor(req);
    const body = zSaeBatch.parse(req.body);
    const created: string[] = [];
    const skipped: string[] = [];
    const errors: { order_number: string; error: string }[] = [];
    for (const o of body.orders) {
      try {
        await withTx(async (tx) => {
          if (await tx.orders.findUnique({ where: { order_number: o.order_number } })) {
            skipped.push(o.order_number);
            return;
          }
          await createOrder(tx, ctx, { ...o, source: 'SAE' });
          created.push(o.order_number);
        });
      } catch (e) {
        errors.push({ order_number: o.order_number, error: (e as Error & { code?: string }).code ?? (e as Error).message });
      }
    }
    await withTx((tx) => audit(tx, ctx, { action: 'integration.sae.orders', entity_type: 'integration', after: { created, skipped, errors } }));
    return { created, skipped, errors };
  });

  /** Outbound status feed for SAE: what happened to its orders (shipped quantities per SKU, truck, timestamps). */
  app.get('/integrations/sae/orders/:orderNumber/status', async (req) => {
    await integrationActor(req);
    const num = (req.params as { orderNumber: string }).orderNumber;
    const o = await db.orders.findUnique({ where: { order_number: num }, include: { lines: { include: { sku: true } }, shipment: { include: { carrier: true } }, customer: true } });
    if (!o) return { found: false };
    return {
      found: true,
      order_number: o.order_number,
      status: o.status,
      customer_code: o.customer.code,
      lines: o.lines.map((l) => ({ sku: l.sku.code, required: l.required_qty, picked: l.picked_qty, verified: l.verified_qty, loaded: l.loaded_qty })),
      shipment: o.shipment ? { number: o.shipment.shipment_number, status: o.shipment.status, carrier: o.shipment.carrier?.name ?? null, vehicle: o.shipment.vehicle, plates: o.shipment.plates, released_at: o.shipment.released_at, departed_at: o.shipment.departed_at } : null,
    };
  });

  /** Inventory snapshot for SAE reconciliation: available/allocated per SKU. */
  app.get('/integrations/inventory', async (req) => {
    await integrationActor(req);
    return db.$queryRaw<Record<string, unknown>[]>`
      SELECT s.code AS sku, s.description,
             COALESCE(sum(b.qty) FILTER (WHERE b.status = 'AVAILABLE'), 0)::text AS available,
             COALESCE(sum(b.qty) FILTER (WHERE b.status = 'ALLOCATED'), 0)::text AS allocated,
             COALESCE(sum(b.qty) FILTER (WHERE b.status IN ('QUARANTINE','DAMAGED','BLOCKED')), 0)::text AS locked,
             COALESCE(sum(b.qty), 0)::text AS total
        FROM skus s LEFT JOIN inventory_balances b ON b.sku_id = s.id AND b.qty > 0
       WHERE s.is_active GROUP BY s.id ORDER BY s.code`;
  });
}
