import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validateUomHierarchy, zCreateParty, zCreateSku, zUpdateSku, zUuid } from '@wms/shared';
import { getDb, withTx } from '../../db.js';
import { ConflictError, NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';

const zList = z.object({
  q: z.string().trim().max(100).optional(),
  active: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function masterDataRoutes(app: FastifyInstance) {
  const db = getDb();

  // ---------------- SKUs ----------------
  app.get('/skus', { preHandler: app.requirePermission('masterdata.read') }, async (req) => {
    const q = zList.parse(req.query);
    const where = {
      ...(q.q ? { OR: [{ code: { contains: q.q, mode: 'insensitive' as const } }, { description: { contains: q.q, mode: 'insensitive' as const } }] } : {}),
      ...(q.active ? { is_active: q.active === 'true' } : {}),
    };
    const [items, total] = await Promise.all([
      db.skus.findMany({ where, include: { uoms: true, barcodes: true }, orderBy: { code: 'asc' }, take: q.limit, skip: q.offset }),
      db.skus.count({ where }),
    ]);
    return { items, total };
  });

  app.get('/skus/:id', { preHandler: app.requirePermission('masterdata.read') }, async (req) => {
    const id = (req.params as { id: string }).id;
    const sku = await db.skus.findFirst({ where: { OR: [{ id: z.string().uuid().safeParse(id).success ? id : undefined }, { code: id }] }, include: { uoms: true, barcodes: true } });
    if (!sku) throw new NotFoundError('SKU', id);
    const inventory = await db.$queryRaw<{ status: string; qty: bigint; lpn_count: number }[]>`
      SELECT status, qty, lpn_count FROM v_sku_inventory WHERE sku_id = ${sku.id}::uuid`;
    return { ...sku, inventory };
  });

  app.post('/skus', { preHandler: app.requirePermission('masterdata.manage') }, async (req, reply) => {
    const body = zCreateSku.parse(req.body);
    const uoms = normalizeUoms(body.uoms);
    const sku = await withTx(async (tx) => {
      if (await tx.skus.findUnique({ where: { code: body.code } })) throw new ConflictError('SKU_EXISTS', `SKU ${body.code} already exists`);
      for (const b of body.barcodes) {
        const clash = await tx.sku_barcodes.findUnique({ where: { barcode: b.barcode } });
        if (clash) throw new ConflictError('BARCODE_EXISTS', `Barcode ${b.barcode} is already assigned`);
      }
      const s = await tx.skus.create({
        data: {
          code: body.code,
          description: body.description,
          family: body.family ?? null,
          compatibility_group: body.compatibility_group ?? null,
          abc_class: body.abc_class,
          unit_weight_kg: body.unit_weight_kg,
          case_length_cm: body.case_length_cm ?? null,
          case_width_cm: body.case_width_cm ?? null,
          case_height_cm: body.case_height_cm ?? null,
          pallet_height_cm: body.pallet_height_cm ?? null,
          requires_lot: body.requires_lot,
          requires_expiry: body.requires_expiry,
          allow_negative: body.allow_negative,
          uoms: { create: uoms.map((u) => ({ uom_code: u.uom_code, base_qty: u.base_qty })) },
          barcodes: { create: body.barcodes.map((b) => ({ barcode: b.barcode, uom_code: b.uom_code })) },
        },
        include: { uoms: true, barcodes: true },
      });
      await audit(tx, req.actor!, { action: 'sku.create', entity_type: 'sku', entity_id: s.id, after: s });
      return s;
    });
    reply.status(201);
    return sku;
  });

  app.patch('/skus/:id', { preHandler: app.requirePermission('masterdata.manage') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const body = zUpdateSku.parse(req.body);
    return withTx(async (tx) => {
      const before = await tx.skus.findUnique({ where: { id }, include: { uoms: true, barcodes: true } });
      if (!before) throw new NotFoundError('SKU', id);
      const { uoms, barcodes, ...rest } = body;
      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) data[k] = v;
      await tx.skus.update({ where: { id }, data });
      if (uoms) {
        const norm = normalizeUoms(uoms);
        // UoM changes are only allowed when they keep all existing barcodes valid
        await tx.sku_uoms.deleteMany({ where: { sku_id: id } });
        await tx.sku_uoms.createMany({ data: norm.map((u) => ({ sku_id: id, uom_code: u.uom_code, base_qty: u.base_qty })) });
      }
      if (barcodes) {
        for (const b of barcodes) {
          const clash = await tx.sku_barcodes.findUnique({ where: { barcode: b.barcode } });
          if (clash && clash.sku_id !== id) throw new ConflictError('BARCODE_EXISTS', `Barcode ${b.barcode} belongs to another SKU`);
        }
        await tx.sku_barcodes.deleteMany({ where: { sku_id: id } });
        await tx.sku_barcodes.createMany({ data: barcodes.map((b) => ({ sku_id: id, barcode: b.barcode, uom_code: b.uom_code })) });
      }
      const after = await tx.skus.findUnique({ where: { id }, include: { uoms: true, barcodes: true } });
      await audit(tx, req.actor!, { action: 'sku.update', entity_type: 'sku', entity_id: id, before, after });
      return after;
    });
  });

  // ---------------- parties ----------------
  for (const [path, table, label] of [
    ['customers', 'customers', 'customer'],
    ['suppliers', 'suppliers', 'supplier'],
    ['carriers', 'carriers', 'carrier'],
  ] as const) {
    app.get(`/${path}`, { preHandler: app.requirePermission('masterdata.read') }, async (req) => {
      const q = zList.parse(req.query);
      const where = q.q ? { OR: [{ code: { contains: q.q, mode: 'insensitive' as const } }, { name: { contains: q.q, mode: 'insensitive' as const } }] } : {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const model = (db as any)[table];
      const [items, total] = await Promise.all([model.findMany({ where, orderBy: { code: 'asc' }, take: q.limit, skip: q.offset }), model.count({ where })]);
      return { items, total };
    });
    app.post(`/${path}`, { preHandler: app.requirePermission('masterdata.manage') }, async (req, reply) => {
      const body = zCreateParty.parse(req.body);
      const row = await withTx(async (tx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const model = (tx as any)[table];
        if (await model.findUnique({ where: { code: body.code } })) throw new ConflictError('CODE_EXISTS', `${label} ${body.code} already exists`);
        const data: Record<string, unknown> = { code: body.code, name: body.name };
        if (table !== 'carriers') data.tax_id = body.tax_id ?? null;
        if (table === 'suppliers') data.contact = body.contact ?? null;
        if (table === 'customers') data.address = body.address ?? null;
        const r = await model.create({ data });
        await audit(tx, req.actor!, { action: `${label}.create`, entity_type: label, entity_id: r.id, after: r });
        return r;
      });
      reply.status(201);
      return row;
    });
    app.patch(`/${path}/:id`, { preHandler: app.requirePermission('masterdata.manage') }, async (req) => {
      const id = zUuid.parse((req.params as { id: string }).id);
      const body = zCreateParty.partial().extend({ is_active: z.boolean().optional() }).parse(req.body);
      return withTx(async (tx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const model = (tx as any)[table];
        const before = await model.findUnique({ where: { id } });
        if (!before) throw new NotFoundError(label, id);
        const data: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(body)) if (v !== undefined && k !== 'code') data[k] = v;
        const after = await model.update({ where: { id }, data });
        await audit(tx, req.actor!, { action: `${label}.update`, entity_type: label, entity_id: id, before, after });
        return after;
      });
    });
  }

  // ---------------- printers ----------------
  const zPrinter = z.object({
    code: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(120),
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65535).default(9100),
    dpi: z.union([z.literal(203), z.literal(300)]).default(203),
    label_width_mm: z.number().int().min(20).max(300).default(100),
    label_height_mm: z.number().int().min(20).max(400).default(150),
    is_default: z.boolean().default(false),
  });
  app.get('/printers', { preHandler: app.requireAuth }, async () => db.printers.findMany({ orderBy: { code: 'asc' } }));
  app.post('/printers', { preHandler: app.requirePermission('printers.manage') }, async (req, reply) => {
    const body = zPrinter.parse(req.body);
    const p = await withTx(async (tx) => {
      if (body.is_default) await tx.printers.updateMany({ data: { is_default: false } });
      const r = await tx.printers.create({ data: body });
      await audit(tx, req.actor!, { action: 'printer.create', entity_type: 'printer', entity_id: r.id, after: r });
      return r;
    });
    reply.status(201);
    return p;
  });
  app.patch('/printers/:id', { preHandler: app.requirePermission('printers.manage') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const body = zPrinter.partial().extend({ is_active: z.boolean().optional() }).parse(req.body);
    return withTx(async (tx) => {
      const before = await tx.printers.findUnique({ where: { id } });
      if (!before) throw new NotFoundError('printer', id);
      if (body.is_default) await tx.printers.updateMany({ data: { is_default: false } });
      const after = await tx.printers.update({ where: { id }, data: body });
      await audit(tx, req.actor!, { action: 'printer.update', entity_type: 'printer', entity_id: id, before, after });
      return after;
    });
  });

  app.get('/quarantine-reasons', { preHandler: app.requireAuth }, async () => db.quarantine_reasons.findMany({ where: { is_active: true } }));
  app.post('/quarantine-reasons', { preHandler: app.requirePermission('settings.manage') }, async (req, reply) => {
    const body = z.object({ code: z.string().trim().min(1).max(40), description: z.string().trim().min(1).max(300) }).parse(req.body);
    const r = await db.quarantine_reasons.upsert({ where: { code: body.code }, create: body, update: { description: body.description, is_active: true } });
    reply.status(201);
    return r;
  });
}

/** Ensures PIECE exists and the hierarchy is coherent. */
function normalizeUoms(uoms: { uom_code: 'PALLET' | 'CASE' | 'INNER' | 'PIECE'; base_qty: bigint }[]) {
  const list = uoms.some((u) => u.uom_code === 'PIECE') ? [...uoms] : [...uoms, { uom_code: 'PIECE' as const, base_qty: 1n }];
  const errors = validateUomHierarchy(list);
  if (errors.length) throw new RuleError('INVALID_UOM_HIERARCHY', errors.join('; '));
  return list;
}
