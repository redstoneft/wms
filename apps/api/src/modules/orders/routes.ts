import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zAllocateOrder, zCancelOrder, zCreateOrder, zUuid } from '@wms/shared';
import { getDb, withTx } from '../../db.js';
import * as svc from './service.js';

export async function orderRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get('/orders', { preHandler: app.requirePermission('orders.read') }, async (req) => {
    const q = z.object({ status: z.string().optional(), q: z.string().trim().max(60).optional(), customer_id: zUuid.optional(), limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    const where = {
      ...(q.status ? { status: { in: q.status.split(',') } } : {}),
      ...(q.customer_id ? { customer_id: q.customer_id } : {}),
      ...(q.q ? { OR: [{ order_number: { contains: q.q, mode: 'insensitive' as const } }, { customer: { name: { contains: q.q, mode: 'insensitive' as const } } }] } : {}),
    };
    const [items, total] = await Promise.all([
      db.orders.findMany({
        where,
        include: { customer: { select: { code: true, name: true } }, lines: { select: { required_qty: true, allocated_qty: true, picked_qty: true, verified_qty: true, loaded_qty: true } }, shipment: { select: { shipment_number: true } } },
        orderBy: [{ priority: 'asc' }, { created_at: 'asc' }],
        take: q.limit,
        skip: q.offset,
      }),
      db.orders.count({ where }),
    ]);
    return {
      total,
      items: items.map((o) => ({
        ...o,
        lines: undefined,
        line_count: o.lines.length,
        totals: o.lines.reduce(
          (a, l) => ({ required: a.required + l.required_qty, allocated: a.allocated + l.allocated_qty, picked: a.picked + l.picked_qty, verified: a.verified + l.verified_qty, loaded: a.loaded + l.loaded_qty }),
          { required: 0n, allocated: 0n, picked: 0n, verified: 0n, loaded: 0n },
        ),
      })),
    };
  });

  app.get('/orders/:id', { preHandler: app.requirePermission('orders.read') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    return withTx((tx) => svc.orderDetail(tx, id));
  });

  app.post('/orders', { preHandler: app.requirePermission('orders.manage') }, async (req, reply) => {
    const body = zCreateOrder.parse(req.body);
    const o = await withTx((tx) => svc.createOrder(tx, req.actor!, { ...body, source: 'MANUAL' }));
    reply.status(201);
    return o;
  });

  app.post('/orders/:id/accept', { preHandler: app.requirePermission('orders.manage') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    return withTx((tx) => svc.acceptOrder(tx, req.actor!, id));
  });

  app.post('/orders/allocate', { preHandler: app.requirePermission('orders.allocate') }, async (req) => {
    const body = zAllocateOrder.parse(req.body);
    return withTx((tx) => svc.allocateOrder(tx, req.actor!, body));
  });

  app.post('/orders/cancel', { preHandler: app.requirePermission('orders.manage') }, async (req) => {
    const body = zCancelOrder.extend({ authorization_id: zUuid.optional() }).parse(req.body);
    return withTx((tx) => svc.cancelOrder(tx, req.actor!, body));
  });
}
