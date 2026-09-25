// Delivery calendar: the whiteboard by the office door ("Coppel 1-Oct 9:00 · Nave 1 5:00pm"), kept from the handheld
// and shown full screen on a TV. The TV reads a board link with its own token (no user session, read-only).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zDelivery, zDeliveryUpdate, zUuid } from '@wms/shared';
import { getDb } from '../../db.js';
import { ForbiddenError, NotFoundError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import { generateToken, sha256 } from '../../lib/crypto.js';
import { buildRokuZip } from './roku.js';

const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

async function resolveRefs(input: { customer_code?: string; order_number?: string }) {
  const db = getDb();
  const customer = input.customer_code ? await db.customers.findUnique({ where: { code: input.customer_code }, select: { id: true, name: true } }) : null;
  if (input.customer_code && !customer) throw new NotFoundError('customer', input.customer_code);
  const order = input.order_number ? await db.orders.findFirst({ where: { order_number: input.order_number }, select: { id: true } }) : null;
  if (input.order_number && !order) throw new NotFoundError('order', input.order_number);
  return { customer, order };
}

/** Upcoming board: overdue but not done, plus the next `days` days; grouped by date on the client. */
async function upcoming(days: number) {
  const db = getDb();
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - 30);
  const to = new Date();
  to.setUTCDate(to.getUTCDate() + days);
  const rows = await db.delivery_appointments.findMany({
    where: { delivery_date: { gte: from, lte: to }, status: { not: 'CANCELLED' } },
    orderBy: [{ delivery_date: 'asc' }, { delivery_time: 'asc' }, { created_at: 'asc' }],
  });
  const today = dateOnly(new Date());
  return rows
    .filter((r) => r.status === 'PLANNED' || dateOnly(r.delivery_date) >= today)
    .map((r) => ({ id: r.id, title: r.title, delivery_date: dateOnly(r.delivery_date), delivery_time: r.delivery_time, notes: r.notes, status: r.status, overdue: r.status === 'PLANNED' && dateOnly(r.delivery_date) < today }));
}

export async function deliveryRoutes(app: FastifyInstance) {
  const db = getDb();
  const manage = app.requirePermission('deliveries.manage');

  app.get('/deliveries', { preHandler: manage }, async (req) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(120).default(21) }).parse(req.query);
    return upcoming(q.days);
  });

  app.post('/deliveries', { preHandler: manage }, async (req, reply) => {
    const body = zDelivery.parse(req.body);
    const { customer, order } = await resolveRefs(body);
    const r = await db.delivery_appointments.create({
      data: { title: body.title, customer_id: customer?.id ?? null, order_id: order?.id ?? null, delivery_date: new Date(`${body.delivery_date}T00:00:00Z`), delivery_time: body.delivery_time ?? null, notes: body.notes ?? null, created_by: req.actor!.userId },
    });
    await audit(db, req.actor!, { action: 'delivery.create', entity_type: 'delivery', entity_id: r.id, after: { title: r.title, date: body.delivery_date, time: body.delivery_time ?? null, notes: body.notes ?? null } });
    reply.status(201);
    return { ...r, delivery_date: body.delivery_date };
  });

  app.patch('/deliveries/:id', { preHandler: manage }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const body = zDeliveryUpdate.parse(req.body);
    const before = await db.delivery_appointments.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('delivery', id);
    const { customer, order } = await resolveRefs(body);
    const r = await db.delivery_appointments.update({
      where: { id },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.customer_code !== undefined ? { customer_id: customer?.id ?? null } : {}),
        ...(body.order_number !== undefined ? { order_id: order?.id ?? null } : {}),
        ...(body.delivery_date !== undefined ? { delivery_date: new Date(`${body.delivery_date}T00:00:00Z`) } : {}),
        ...(body.delivery_time !== undefined ? { delivery_time: body.delivery_time } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        updated_by: req.actor!.userId,
      },
    });
    await audit(db, req.actor!, { action: 'delivery.update', entity_type: 'delivery', entity_id: id, before: { title: before.title, date: dateOnly(before.delivery_date), status: before.status }, after: { title: r.title, date: dateOnly(r.delivery_date), time: r.delivery_time, status: r.status } });
    return { ...r, delivery_date: dateOnly(r.delivery_date) };
  });

  app.delete('/deliveries/:id', { preHandler: manage }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const before = await db.delivery_appointments.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('delivery', id);
    await db.delivery_appointments.update({ where: { id }, data: { status: 'CANCELLED', updated_by: req.actor!.userId } });
    await audit(db, req.actor!, { action: 'delivery.cancel', entity_type: 'delivery', entity_id: id, before: { title: before.title, date: dateOnly(before.delivery_date) } });
    return { id, status: 'CANCELLED' };
  });

  /** A read-only link for a TV: /board?k=<token>. Shown once; generate another to rotate. */
  app.post('/deliveries/board-link', { preHandler: manage }, async (req, reply) => {
    const body = z.object({ name: z.string().trim().min(1).max(80).default('TV almacén') }).parse(req.body ?? {});
    if (!req.actor!.permissions.has('orders.manage') && !req.actor!.permissions.has('settings.manage')) throw new ForbiddenError('Solo un supervisor genera el enlace del tablero');
    const token = `wmsb_${generateToken(24)}`;
    const b = await db.delivery_boards.create({ data: { name: body.name, token_hash: sha256(token), created_by: req.actor!.userId } });
    await audit(db, req.actor!, { action: 'delivery.board_link', entity_type: 'delivery_board', entity_id: b.id, after: { name: b.name } });
    reply.status(201);
    return { id: b.id, name: b.name, token };
  });
  /** Roku TVs have no browser: a sideloadable channel with a fresh board link baked in. */
  app.post('/deliveries/board-roku', { preHandler: manage }, async (req, reply) => {
    if (!req.actor!.permissions.has('orders.manage') && !req.actor!.permissions.has('settings.manage')) throw new ForbiddenError('Solo un supervisor genera el tablero para Roku');
    const token = `wmsb_${generateToken(24)}`;
    const b = await db.delivery_boards.create({ data: { name: 'Roku TV', token_hash: sha256(token), created_by: req.actor!.userId } });
    await audit(db, req.actor!, { action: 'delivery.board_roku', entity_type: 'delivery_board', entity_id: b.id, after: { name: b.name } });
    const origin = `${req.headers['x-forwarded-proto'] ?? 'https'}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;
    const zip = await buildRokuZip(`${origin}/api/board/deliveries?k=${token}&days=21`);
    reply.header('Content-Type', 'application/zip').header('Content-Disposition', 'attachment; filename="tablero_roku.zip"');
    return reply.send(zip);
  });

  app.get('/deliveries/board-links', { preHandler: manage }, async () => db.delivery_boards.findMany({ where: { revoked_at: null }, select: { id: true, name: true, created_at: true }, orderBy: { created_at: 'desc' } }));
  app.delete('/deliveries/board-links/:id', { preHandler: manage }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    await db.delivery_boards.update({ where: { id }, data: { revoked_at: new Date() } });
    return { id, revoked: true };
  });

  /** Public (token) feed for the TV board: no session, read-only, calendar only. */
  app.get('/board/deliveries', async (req) => {
    const q = z.object({ k: z.string().min(20).max(80), days: z.coerce.number().int().min(1).max(60).default(14) }).parse(req.query);
    const board = await db.delivery_boards.findFirst({ where: { token_hash: sha256(q.k), revoked_at: null } });
    if (!board) throw new ForbiddenError('Enlace del tablero inválido o revocado');
    return { board: board.name, generated_at: new Date().toISOString(), items: await upcoming(q.days) };
  });
}
