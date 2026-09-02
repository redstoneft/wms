// Aspel SAE → WMS synchronisation.
//
// Direction: SAE (via its Supabase mirrors) is the master for SKUs, customers,
// suppliers and purchase orders; the PEDIDOS project is the master for customer
// orders (retail POs parsed from the customers' documents). The WMS never pushes
// data back and NEVER creates or changes inventory from SAE: physical stock only
// enters through receiving/counts. Existencias de SAE are compared, not applied.
//
// Rules of engagement
//  * idempotent: re-running never duplicates anything (external_ref / codes)
//  * conservative: rows the WMS already operates on (orders in picking, POs with
//    receipts) are never rewritten; differences are reported, not forced
//  * everything is logged in integration_runs + audit
import type { Tx } from '../../db.js';
import { getDb, withTx } from '../../db.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';
import { cancelOrder, createOrder } from '../orders/service.js';
import { createIncident } from '../incidents/service.js';
import { fetchAll, key, num, requireSource, saeConfig } from './supabase.js';

export const SAE_ENTITIES = ['skus', 'customers', 'suppliers', 'purchase_orders', 'customer_orders'] as const;
export type SaeEntity = (typeof SAE_ENTITIES)[number];

export interface SyncResult {
  entity: SaeEntity;
  run_id: string;
  status: 'OK' | 'FAILED';
  source_rows: number;
  created: number;
  updated: number;
  skipped: number;
  errors: { ref: string; message: string }[];
  notes?: string;
}

class Counters {
  source_rows = 0;
  created = 0;
  updated = 0;
  skipped = 0;
  errors: { ref: string; message: string }[] = [];
  err(ref: string, message: string) {
    if (this.errors.length < 500) this.errors.push({ ref, message });
    this.skipped++;
  }
}

async function withRun(entity: SaeEntity, trigger: 'SCHEDULED' | 'MANUAL', ctx: ActorContext, fn: (c: Counters) => Promise<string | void>): Promise<SyncResult> {
  const db = getDb();
  const run = await db.integration_runs.create({ data: { source: 'SAE', entity, trigger, user_id: ctx.userId === '00000000-0000-7000-8000-000000000000' ? null : ctx.userId } });
  const c = new Counters();
  let status: 'OK' | 'FAILED' = 'OK';
  let notes: string | undefined;
  try {
    notes = (await fn(c)) ?? undefined;
  } catch (e) {
    status = 'FAILED';
    notes = (e as Error).message;
  }
  await db.integration_runs.update({
    where: { id: run.id },
    data: { status, finished_at: new Date(), source_rows: c.source_rows, created: c.created, updated: c.updated, skipped: c.skipped, errors: c.errors.length ? c.errors : undefined, notes: notes ?? null },
  });
  await withTx((tx) => audit(tx, ctx, { action: `integration.sae.${entity}`, entity_type: 'integration_run', entity_id: run.id, after: { status, source_rows: c.source_rows, created: c.created, updated: c.updated, skipped: c.skipped, errors: c.errors.length, notes } }));
  return { entity, run_id: run.id, status, source_rows: c.source_rows, created: c.created, updated: c.updated, skipped: c.skipped, errors: c.errors, notes };
}

// ---------------------------------------------------------------------------
// SKUs
// ---------------------------------------------------------------------------
interface RawArticle { cve_art: string; descr: string | null; lin_prod: string | null; uni_med: string | null; uni_emp: number | null; fac_conv: number | null; peso: number | null; con_lote: string | null; status: string }
interface Alias { cve_art: string; modelo: string; capa: string }
interface Producto { sku_interno: string; gtin: string | null; activo: boolean }
interface PedidoLinea { sku_interno: string; piezas_por_caja: number | null }

/** Case size per SAE code: customer order lines are the most reliable source, then SAE's packaging unit. */
function caseQtyFor(code: string, model: string | null, ppcByCode: Map<string, number>, ppcByModel: Map<string, number>, article: RawArticle): bigint | null {
  const stripped = code.replace(/^\.+/, '').replace(/\.+$/, '');
  const fromOrders = ppcByCode.get(code) ?? ppcByCode.get(stripped) ?? (model ? ppcByModel.get(model) : undefined);
  if (fromOrders && fromOrders > 1) return BigInt(Math.round(fromOrders));
  const emp = num(article.uni_emp);
  if (emp > 1 && Number.isInteger(emp)) return BigInt(emp);
  return null;
}

export async function syncSkus(ctx: ActorContext, trigger: 'SCHEDULED' | 'MANUAL' = 'MANUAL'): Promise<SyncResult> {
  const cfg = saeConfig();
  return withRun('skus', trigger, ctx, async (c) => {
    const raw = requireSource(cfg.raw, 'raw');
    const erp = cfg.erp;
    const articles = await fetchAll<RawArticle>(raw, 'sae_inve01', { select: 'cve_art,descr,lin_prod,uni_med,uni_emp,fac_conv,peso,con_lote,status', order: 'cve_art' });
    c.source_rows = articles.length;
    const aliases = erp ? await fetchAll<Alias>(erp, 'sku_alias', { select: 'cve_art,modelo,capa' }) : [];
    const productos = erp ? await fetchAll<Producto>(erp, 'productos', { select: 'sku_interno,gtin,activo' }) : [];
    const lineas = erp ? await fetchAll<PedidoLinea>(erp, 'pedido_lineas', { select: 'sku_interno,piezas_por_caja' }) : [];
    const aliasByCode = new Map(aliases.map((a) => [key(a.cve_art), a]));
    const gtinByCode = new Map(productos.filter((p) => p.gtin && p.activo !== false).map((p) => [key(p.sku_interno), key(p.gtin)]));
    const ppcByCode = new Map<string, number>();
    const ppcByModel = new Map<string, number>();
    for (const l of lineas) {
      const ppc = num(l.piezas_por_caja);
      if (ppc > 1) {
        ppcByCode.set(key(l.sku_interno), ppc);
        const a = aliasByCode.get(key(l.sku_interno));
        if (a) ppcByModel.set(key(a.modelo), ppc);
      }
    }
    const seen = new Set<string>();
    const db = getDb();
    for (const a of articles) {
      const code = key(a.cve_art);
      // SAE keys may start with '.' (packaging variants) and contain spaces (normalised to '_')
      if (!code || !/^[A-Za-z0-9.][A-Za-z0-9._\-/ ]*$/.test(code)) {
        c.err(code || '(vacío)', 'clave SAE inválida para el WMS');
        continue;
      }
      const safeCode = code.replace(/\s+/g, '_');
      seen.add(safeCode);
      const alias = aliasByCode.get(code);
      const model = alias ? key(alias.modelo) : safeCode.replace(/^\.+/, '').replace(/\.+$/, '');
      const layer = alias ? key(alias.capa) : null;
      const active = key(a.status) === 'A';
      try {
        await withTx(async (tx) => {
          const existing = (await tx.skus.findFirst({ where: { external_source: 'SAE', external_ref: code } })) ?? (await tx.skus.findUnique({ where: { code: safeCode } }));
          const data = {
            description: (a.descr ?? code).trim().slice(0, 300) || code,
            family: a.lin_prod ? key(a.lin_prod).slice(0, 60) : null,
            unit_weight_kg: num(a.peso) > 0 ? num(a.peso) : undefined,
            requires_lot: key(a.con_lote) === 'S',
            external_source: 'SAE',
            external_ref: code,
            model_code: model.slice(0, 64),
            packaging_layer: layer ? layer.slice(0, 10) : null,
            is_active: active,
          };
          let skuId: string;
          if (existing) {
            await tx.skus.update({ where: { id: existing.id }, data });
            skuId = existing.id;
            c.updated++;
          } else {
            const created = await tx.skus.create({ data: { code: safeCode, abc_class: 'C', ...data, uoms: { create: [{ uom_code: 'PIECE', base_qty: 1n }] } } });
            skuId = created.id;
            c.created++;
          }
          // UoM: PIECE always; CASE only when we can determine it and it is not already defined
          await tx.sku_uoms.upsert({ where: { sku_id_uom_code: { sku_id: skuId, uom_code: 'PIECE' } }, create: { sku_id: skuId, uom_code: 'PIECE', base_qty: 1n }, update: {} });
          const caseQty = caseQtyFor(code, model, ppcByCode, ppcByModel, a);
          if (caseQty) {
            const cur = await tx.sku_uoms.findUnique({ where: { sku_id_uom_code: { sku_id: skuId, uom_code: 'CASE' } } });
            if (!cur) await tx.sku_uoms.create({ data: { sku_id: skuId, uom_code: 'CASE', base_qty: caseQty } });
            else if (cur.base_qty !== caseQty) c.errors.push({ ref: code, message: `CASE en WMS = ${cur.base_qty} pero SAE/pedidos indican ${caseQty}; no se cambió (revisar)` });
          }
          // GTIN as PIECE barcode
          // exact code first; the stripped code only for the BASE article (never for CAJA/PIEZA variants)
          const stripped = code.replace(/^\.+/, '').replace(/\.+$/, '');
          const gtin = gtinByCode.get(code) ?? ((!layer || layer === 'BASE') && stripped !== code ? gtinByCode.get(stripped) : undefined);
          if (gtin && /^[0-9]{8,14}$/.test(gtin)) {
            const clash = await tx.sku_barcodes.findUnique({ where: { barcode: gtin } });
            if (!clash) await tx.sku_barcodes.create({ data: { sku_id: skuId, barcode: gtin, uom_code: 'PIECE' } });
            else if (clash.sku_id !== skuId) c.errors.push({ ref: code, message: `GTIN ${gtin} ya pertenece a otro SKU; no se asignó` });
          }
        });
      } catch (e) {
        c.err(code, (e as Error).message.slice(0, 200));
      }
    }
    // SAE articles that disappeared from the feed: deactivate only when they hold no inventory
    const stale = await db.skus.findMany({ where: { external_source: 'SAE', is_active: true, code: { notIn: [...seen] } }, select: { id: true, code: true } });
    let deactivated = 0;
    for (const s of stale) {
      const inv = await db.inventory_balances.count({ where: { sku_id: s.id, qty: { gt: 0n } } });
      if (inv === 0) {
        await db.skus.update({ where: { id: s.id }, data: { is_active: false } });
        deactivated++;
      } else c.errors.push({ ref: s.code, message: 'ya no existe en SAE pero tiene inventario en el WMS; sigue activo' });
    }
    return `alias=${aliases.length} gtin=${gtinByCode.size} ppc=${ppcByCode.size} desactivados=${deactivated}`;
  });
}

// ---------------------------------------------------------------------------
// Customers & suppliers
// ---------------------------------------------------------------------------
interface RawParty { clave: string; nombre: string | null; rfc: string | null; status: string; calle?: string | null; numext?: string | null; colonia?: string | null; municipio?: string | null; estado?: string | null; codigo?: string | null; mail?: string | null; telefono?: string | null }
interface PedidosCliente { id: string; nombre: string; codigo_interno: string | null; cliente_sae_id: string | null; rfc: string | null; razon_social: string | null; activo: boolean }

const addr = (p: RawParty) => [p.calle, p.numext, p.colonia, p.municipio, p.estado, p.codigo].map((x) => key(x)).filter(Boolean).join(', ').slice(0, 500) || null;

export async function syncCustomers(ctx: ActorContext, trigger: 'SCHEDULED' | 'MANUAL' = 'MANUAL'): Promise<SyncResult> {
  const cfg = saeConfig();
  return withRun('customers', trigger, ctx, async (c) => {
    const raw = requireSource(cfg.raw, 'raw');
    const rows = await fetchAll<RawParty>(raw, 'sae_clie01', { select: 'clave,nombre,rfc,status,calle,numext,colonia,municipio,estado,codigo', order: 'clave' });
    const retail = cfg.erp ? await fetchAll<PedidosCliente>(cfg.erp, 'clientes', { select: 'id,nombre,codigo_interno,cliente_sae_id,rfc,razon_social,activo' }) : [];
    c.source_rows = rows.length + retail.length;
    const db = getDb();
    for (const r of rows) {
      const code = key(r.clave);
      if (!code) continue;
      const data = { name: key(r.nombre).slice(0, 200) || code, tax_id: key(r.rfc).slice(0, 40) || null, address: addr(r), external_source: 'SAE', external_ref: code, is_active: key(r.status) === 'A' };
      const existing = (await db.customers.findFirst({ where: { external_source: 'SAE', external_ref: code } })) ?? (await db.customers.findUnique({ where: { code } }));
      if (existing) {
        await db.customers.update({ where: { id: existing.id }, data });
        c.updated++;
      } else {
        await db.customers.create({ data: { code, ...data } });
        c.created++;
      }
    }
    // retail accounts of the orders platform (WALMART, HEB, ...): separate identity unless linked to a SAE client
    for (const r of retail) {
      const code = key(r.codigo_interno) || key(r.nombre).toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 40);
      if (!code) continue;
      const linked = r.cliente_sae_id ? await db.customers.findFirst({ where: { external_source: 'SAE', external_ref: key(r.cliente_sae_id) } }) : null;
      const existing = linked ?? (await db.customers.findFirst({ where: { external_source: 'PEDIDOS', external_ref: r.id } })) ?? (await db.customers.findUnique({ where: { code } }));
      const data = { name: key(r.razon_social) || key(r.nombre) || code, tax_id: key(r.rfc) || undefined, is_active: r.activo !== false };
      if (existing) {
        await db.customers.update({ where: { id: existing.id }, data: { ...data, ...(linked ? {} : { external_source: 'PEDIDOS', external_ref: r.id }) } });
        c.updated++;
      } else {
        await db.customers.create({ data: { code, ...data, external_source: 'PEDIDOS', external_ref: r.id } });
        c.created++;
      }
    }
  });
}

export async function syncSuppliers(ctx: ActorContext, trigger: 'SCHEDULED' | 'MANUAL' = 'MANUAL'): Promise<SyncResult> {
  const cfg = saeConfig();
  return withRun('suppliers', trigger, ctx, async (c) => {
    const raw = requireSource(cfg.raw, 'raw');
    const rows = await fetchAll<RawParty>(raw, 'sae_prov01', { select: 'clave,nombre,rfc,status,mail,telefono', order: 'clave' });
    c.source_rows = rows.length;
    const db = getDb();
    for (const r of rows) {
      const code = key(r.clave);
      if (!code) continue;
      const data = { name: key(r.nombre).slice(0, 200) || code, tax_id: key(r.rfc).slice(0, 40) || null, contact: [key(r.mail), key(r.telefono)].filter(Boolean).join(' · ').slice(0, 500) || null, external_source: 'SAE', external_ref: code, is_active: key(r.status) === 'A' };
      const existing = (await db.suppliers.findFirst({ where: { external_source: 'SAE', external_ref: code } })) ?? (await db.suppliers.findUnique({ where: { code } }));
      if (existing) {
        await db.suppliers.update({ where: { id: existing.id }, data });
        c.updated++;
      } else {
        await db.suppliers.create({ data: { code, ...data } });
        c.created++;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Purchase orders (SAE compras) → expected receipts
// ---------------------------------------------------------------------------
interface Compra { cve_doc: string; tipo: string | null; cve_prov: string | null; fecha: string | null; fecha_rec: string | null; estado: string | null; su_refer: string | null }
interface CompraLinea { cve_doc: string; cve_art: string; cantidad: number | null; costo: number | null }

export async function syncPurchaseOrders(ctx: ActorContext, trigger: 'SCHEDULED' | 'MANUAL' = 'MANUAL'): Promise<SyncResult> {
  const cfg = saeConfig();
  return withRun('purchase_orders', trigger, ctx, async (c) => {
    const erp = requireSource(cfg.erp, 'erp');
    const since = new Date(Date.now() - cfg.poSinceDays * 86400_000).toISOString().slice(0, 10);
    const compras = await fetchAll<Compra>(erp, 'sae_compras', { select: 'cve_doc,tipo,cve_prov,fecha,fecha_rec,estado,su_refer', estado: 'eq.E', fecha: `gte.${since}`, order: 'fecha.desc' });
    c.source_rows = compras.length;
    if (!compras.length) return `sin órdenes de compra emitidas desde ${since}`;
    const docs = compras.map((x) => key(x.cve_doc));
    const lines = await fetchAll<CompraLinea>(erp, 'sae_compras_lineas', { select: 'cve_doc,cve_art,cantidad,costo', cve_doc: `in.(${compras.map((x) => `"${String(x.cve_doc).replace(/"/g, '')}"`).join(',')})` });
    const byDoc = new Map<string, CompraLinea[]>();
    for (const l of lines) byDoc.set(key(l.cve_doc), [...(byDoc.get(key(l.cve_doc)) ?? []), l]);
    for (const po of compras) {
      const number = key(po.cve_doc);
      if (!docs.includes(number)) continue;
      try {
        await withTx(async (tx) => {
          const supplierCode = key(po.cve_prov);
          const supplier = (await tx.suppliers.findFirst({ where: { external_source: 'SAE', external_ref: supplierCode } })) ?? (await tx.suppliers.findUnique({ where: { code: supplierCode } }));
          if (!supplier) throw new Error(`proveedor SAE ${supplierCode || '?'} no existe en el WMS (sincronice proveedores)`);
          // aggregate lines per SKU (SAE may repeat an article)
          const agg = new Map<string, bigint>();
          for (const l of byDoc.get(number) ?? []) {
            const q = BigInt(Math.round(num(l.cantidad)));
            if (q <= 0n) continue;
            agg.set(key(l.cve_art), (agg.get(key(l.cve_art)) ?? 0n) + q);
          }
          if (agg.size === 0) throw new Error('sin líneas con cantidad > 0');
          const resolved: { sku_id: string; qty: bigint }[] = [];
          const missing: string[] = [];
          for (const [art, qty] of agg) {
            const sku = (await tx.skus.findFirst({ where: { external_source: 'SAE', external_ref: art } })) ?? (await tx.skus.findUnique({ where: { code: art.replace(/\s+/g, '_') } }));
            if (!sku) missing.push(art);
            else resolved.push({ sku_id: sku.id, qty });
          }
          if (missing.length) throw new Error(`SKUs no encontrados: ${missing.join(', ')}`);
          const existing = (await tx.purchase_orders.findFirst({ where: { external_source: 'SAE', external_ref: number } })) ?? (await tx.purchase_orders.findUnique({ where: { po_number: number } }));
          const header = { supplier_id: supplier.id, expected_date: po.fecha_rec ? new Date(po.fecha_rec) : po.fecha ? new Date(po.fecha) : null, notes: key(po.su_refer) ? `Ref. proveedor: ${key(po.su_refer)}` : null, external_source: 'SAE', external_ref: number };
          if (existing) {
            const received = await tx.purchase_order_lines.aggregate({ where: { po_id: existing.id }, _sum: { received_qty: true } });
            if (existing.status !== 'OPEN' || (received._sum.received_qty ?? 0n) > 0n) {
              c.skipped++;
              return;
            }
            await tx.purchase_orders.update({ where: { id: existing.id }, data: header });
            await tx.purchase_order_lines.deleteMany({ where: { po_id: existing.id } });
            await tx.purchase_order_lines.createMany({ data: resolved.map((r, i) => ({ po_id: existing.id, line_no: i + 1, sku_id: r.sku_id, ordered_qty: r.qty, uom_code: 'PIECE', uom_qty: r.qty })) });
            c.updated++;
          } else {
            await tx.purchase_orders.create({ data: { po_number: number, ...header, created_by: null, lines: { create: resolved.map((r, i) => ({ line_no: i + 1, sku_id: r.sku_id, ordered_qty: r.qty, uom_code: 'PIECE', uom_qty: r.qty })) } } });
            c.created++;
          }
        });
      } catch (e) {
        c.err(number, (e as Error).message.slice(0, 200));
      }
    }
    return `desde ${since}`;
  });
}

// ---------------------------------------------------------------------------
// Customer orders (retail POs from the PEDIDOS platform) → WMS orders
// ---------------------------------------------------------------------------
interface Pedido { id: string; cliente_id: string; num_orden_compra: string; fecha_pedido: string | null; fecha_envio: string | null; fecha_cancelacion: string | null; cedis_codigo: string | null; estatus: string; instrucciones?: string | null }
interface PedidoLineaFull { pedido_id: string; num_linea: string; sku_cliente: string | null; sku_interno: string | null; gtin: string | null; cantidad: number | null; cantidad_surtir: number | null; uom: string | null; piezas_por_caja: number | null }
interface Cedis { codigo: string; nombre: string | null; ciudad: string | null; estado: string | null }

const CANCELLED_STATES = new Set(['cancelado', 'cancelada', 'rechazado', 'rechazada']);
const CLOSED_STATES = new Set(['surtido', 'embarcado', 'facturado', 'entregado', 'cerrado', 'completado']);

async function resolveSkuForOrder(tx: Tx, skuInterno: string, gtin: string | null): Promise<{ id: string; code: string } | null> {
  const code = key(skuInterno);
  const candidates = [code, `.${code}`, `${code}.`].filter(Boolean);
  for (const cnd of candidates) {
    const s = (await tx.skus.findFirst({ where: { external_source: 'SAE', external_ref: cnd, is_active: true } })) ?? (await tx.skus.findFirst({ where: { code: cnd, is_active: true } }));
    if (s) return { id: s.id, code: s.code };
  }
  if (gtin) {
    const b = await tx.sku_barcodes.findUnique({ where: { barcode: key(gtin) }, include: { sku: true } });
    if (b?.sku.is_active) return { id: b.sku.id, code: b.sku.code };
  }
  const base = await tx.skus.findFirst({ where: { model_code: code, packaging_layer: 'BASE', is_active: true } });
  return base ? { id: base.id, code: base.code } : null;
}

export async function syncCustomerOrders(ctx: ActorContext, trigger: 'SCHEDULED' | 'MANUAL' = 'MANUAL'): Promise<SyncResult> {
  const cfg = saeConfig();
  return withRun('customer_orders', trigger, ctx, async (c) => {
    const erp = requireSource(cfg.erp, 'erp');
    const since = new Date(Date.now() - cfg.poSinceDays * 86400_000).toISOString().slice(0, 10);
    const pedidos = await fetchAll<Pedido>(erp, 'pedidos', { select: 'id,cliente_id,num_orden_compra,fecha_pedido,fecha_envio,fecha_cancelacion,cedis_codigo,estatus,instrucciones', fecha_pedido: `gte.${since}`, order: 'fecha_pedido.desc' });
    c.source_rows = pedidos.length;
    if (!pedidos.length) return `sin pedidos desde ${since}`;
    const lines = await fetchAll<PedidoLineaFull>(erp, 'pedido_lineas', { select: 'pedido_id,num_linea,sku_cliente,sku_interno,gtin,cantidad,cantidad_surtir,uom,piezas_por_caja', pedido_id: `in.(${pedidos.map((p) => p.id).join(',')})` });
    const cedis = await fetchAll<Cedis>(erp, 'cedis', { select: 'codigo,nombre,ciudad,estado' }).catch(() => [] as Cedis[]);
    const cedisByCode = new Map(cedis.map((x) => [key(x.codigo), x]));
    const byPedido = new Map<string, PedidoLineaFull[]>();
    for (const l of lines) byPedido.set(l.pedido_id, [...(byPedido.get(l.pedido_id) ?? []), l]);
    for (const p of pedidos) {
      const ref = p.id;
      const number = key(p.num_orden_compra);
      const st = key(p.estatus).toLowerCase();
      try {
        await withTx(async (tx) => {
          const existing = await tx.orders.findFirst({ where: { source: 'SAE', external_ref: ref } });
          if (CANCELLED_STATES.has(st)) {
            if (!existing || existing.status === 'CANCELLED') {
              c.skipped++;
              return;
            }
            if (['IMPORTED', 'ACCEPTED', 'ALLOCATED', 'PARTIALLY_ALLOCATED'].includes(existing.status)) {
              await cancelOrder(tx, ctx, { order_id: existing.id, reason: `Cancelado en la plataforma de pedidos (estatus ${st})` });
              c.updated++;
            } else {
              await createIncident(tx, ctx, { incident_type: 'OTHER', severity: 'HIGH', title: `Pedido ${existing.order_number} cancelado externamente durante surtido/embarque`, description: `La plataforma de pedidos reporta estatus '${st}'. Revisar antes de embarcar.`, entity_type: 'order', entity_id: existing.id, order_id: existing.id });
              c.errors.push({ ref: number, message: 'cancelado externamente con surtido en curso: incidencia creada' });
            }
            return;
          }
          if (CLOSED_STATES.has(st)) {
            c.skipped++;
            return;
          }
          if (existing && existing.status !== 'IMPORTED') {
            c.skipped++; // already being worked in the warehouse: never rewrite
            return;
          }
          const customer = await tx.customers.findFirst({ where: { external_source: 'PEDIDOS', external_ref: p.cliente_id } });
          if (!customer) throw new Error(`cliente ${p.cliente_id} no sincronizado (ejecute clientes)`);
          const ls = byPedido.get(p.id) ?? [];
          if (!ls.length) throw new Error('pedido sin líneas');
          const resolved: { sku_code: string; qty: bigint; ppc: number }[] = [];
          const missing: string[] = [];
          for (const l of ls) {
            const qty = BigInt(Math.round(num(l.cantidad_surtir ?? l.cantidad)));
            if (qty <= 0n) continue;
            const sku = l.sku_interno ? await resolveSkuForOrder(tx, l.sku_interno, l.gtin) : null;
            if (!sku) {
              missing.push(`${l.num_linea}:${key(l.sku_interno) || key(l.sku_cliente) || key(l.gtin)}`);
              continue;
            }
            resolved.push({ sku_code: sku.code, qty, ppc: num(l.piezas_por_caja) });
          }
          if (missing.length) throw new Error(`líneas sin SKU en el WMS: ${missing.join(', ')}`);
          if (!resolved.length) throw new Error('sin líneas con cantidad > 0');
          const cd = p.cedis_codigo ? cedisByCode.get(key(p.cedis_codigo)) : undefined;
          const destination = [key(p.cedis_codigo), cd ? key(cd.nombre) : '', cd ? [key(cd.ciudad), key(cd.estado)].filter(Boolean).join(', ') : ''].filter(Boolean).join(' · ').slice(0, 500) || undefined;
          const daysLeft = p.fecha_cancelacion ? Math.floor((new Date(p.fecha_cancelacion).getTime() - Date.now()) / 86400_000) : 99;
          const priority = daysLeft <= 1 ? 1 : daysLeft <= 3 ? 2 : daysLeft <= 6 ? 3 : 5;
          const notes = [`Pedido plataforma ${p.id}`, p.fecha_envio ? `Envío: ${p.fecha_envio}` : '', p.fecha_cancelacion ? `Cancela: ${p.fecha_cancelacion}` : '', key(p.instrucciones)].filter(Boolean).join(' · ').slice(0, 2000);
          if (existing) {
            await tx.order_lines.deleteMany({ where: { order_id: existing.id } });
            await tx.orders.update({ where: { id: existing.id }, data: { customer_id: customer.id, destination: destination ?? null, order_date: p.fecha_pedido ? new Date(p.fecha_pedido) : null, priority, notes, version: { increment: 1 } } });
            const skuRows = await tx.skus.findMany({ where: { code: { in: resolved.map((r) => r.sku_code) } } });
            await tx.order_lines.createMany({ data: resolved.map((r, i) => ({ order_id: existing.id, line_no: i + 1, sku_id: skuRows.find((s) => s.code === r.sku_code)!.id, required_qty: r.qty, uom_code: 'PIECE', uom_qty: r.qty })) });
            c.updated++;
          } else {
            let orderNumber = number || `PED-${p.id.slice(0, 8)}`;
            const clash = await tx.orders.findUnique({ where: { order_number: orderNumber } });
            if (clash && clash.external_ref !== ref) orderNumber = `${orderNumber}-${customer.code}`;
            await createOrder(tx, ctx, { order_number: orderNumber, customer_code: customer.code, destination, order_date: p.fecha_pedido ? new Date(p.fecha_pedido) : undefined, priority, external_ref: ref, notes, source: 'SAE', lines: resolved.map((r) => ({ sku_code: r.sku_code, qty: r.qty, uom_code: 'PIECE' })) });
            c.created++;
          }
        });
      } catch (e) {
        c.err(number || ref, (e as Error).message.slice(0, 200));
      }
    }
    return `desde ${since}`;
  });
}

// ---------------------------------------------------------------------------
// Stock comparison (never applied automatically)
// ---------------------------------------------------------------------------
interface SaeStock { cve_art: string; descripcion: string | null; existencia: number | null; actualizado_en: string | null }

const abs = (v: bigint) => (v < 0n ? -v : v);

export async function compareStock() {
  const cfg = saeConfig();
  const erp = requireSource(cfg.erp, 'erp');
  const rows = await fetchAll<SaeStock>(erp, 'sae_inventario', { select: 'cve_art,descripcion,existencia,actualizado_en', order: 'cve_art' });
  const db = getDb();
  const wms = await db.$queryRaw<{ sku_id: string; code: string; external_ref: string | null; total: bigint; available: bigint }[]>`
    SELECT s.id AS sku_id, s.code, s.external_ref, COALESCE(sum(b.qty), 0)::bigint AS total, COALESCE(sum(b.qty) FILTER (WHERE b.status = 'AVAILABLE'), 0)::bigint AS available
      FROM skus s LEFT JOIN inventory_balances b ON b.sku_id = s.id AND b.qty > 0
     WHERE s.external_source = 'SAE' GROUP BY s.id`;
  const byRef = new Map(wms.map((w) => [w.external_ref ?? w.code, w]));
  const lines = rows.map((r) => {
    const code = key(r.cve_art);
    const w = byRef.get(code);
    const sae = BigInt(Math.round(num(r.existencia)));
    const total = w?.total ?? 0n;
    return { sku: code, description: r.descripcion, in_wms: !!w, sae_existencia: sae, wms_total: total, wms_available: w?.available ?? 0n, diff: total - sae };
  });
  const differing = lines.filter((l) => l.diff !== 0n);
  return {
    checked_at: new Date().toISOString(),
    sae_updated_at: rows[0]?.actualizado_en ?? null,
    skus_sae: rows.length,
    skus_matching: lines.length - differing.length,
    skus_differing: differing.length,
    sae_units: lines.reduce((a, l) => a + l.sae_existencia, 0n),
    wms_units: lines.reduce((a, l) => a + l.wms_total, 0n),
    differences: differing.sort((a, b) => (abs(b.diff) > abs(a.diff) ? 1 : abs(b.diff) < abs(a.diff) ? -1 : a.sku.localeCompare(b.sku))).slice(0, 2000),
  };
}

export async function syncAll(ctx: ActorContext, trigger: 'SCHEDULED' | 'MANUAL', entities: readonly SaeEntity[] = SAE_ENTITIES): Promise<SyncResult[]> {
  const out: SyncResult[] = [];
  // master data first so documents can resolve references
  const order: SaeEntity[] = ['suppliers', 'customers', 'skus', 'purchase_orders', 'customer_orders'];
  for (const e of order) {
    if (!entities.includes(e)) continue;
    const fn = { skus: syncSkus, customers: syncCustomers, suppliers: syncSuppliers, purchase_orders: syncPurchaseOrders, customer_orders: syncCustomerOrders }[e];
    out.push(await fn(ctx, trigger));
  }
  return out;
}

/** Scheduled entry point: one instance at a time (advisory lock), silent when not configured. */
export async function scheduledSaeSync(ctx: ActorContext): Promise<SyncResult[] | { skipped: string }> {
  const cfg = saeConfig();
  if (!cfg.erp && !cfg.raw) return { skipped: 'not configured' };
  const db = getDb();
  const lock = await db.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext('sae-sync')) AS ok`;
  if (!lock[0]?.ok) return { skipped: 'another instance is syncing' };
  try {
    return await syncAll(ctx, 'SCHEDULED');
  } finally {
    await db.$queryRaw`SELECT pg_advisory_unlock(hashtext('sae-sync'))`;
  }
}
