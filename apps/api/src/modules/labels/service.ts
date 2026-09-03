import net from 'node:net';
import bwipjs from 'bwip-js';
import { renderZpl, validateZpl, type LabelModel, type LabelType, type LpnLabelModel } from '@wms/shared';
import type { Tx } from '../../db.js';
import { getDb, withTx } from '../../db.js';
import { ForbiddenError, NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';

const fmtDate = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ');

/** Builds the label model for any printable entity from live data. */
export async function buildLabelModel(tx: Tx, labelType: LabelType, entityId: string): Promise<LabelModel> {
  switch (labelType) {
    case 'LPN': {
      const lpn = await tx.lpns.findFirst({
        where: { OR: [{ id: isUuid(entityId) ? entityId : undefined }, { code: entityId.toUpperCase() }] },
        include: { receipt: true, container: true, supplier: true, balances: { include: { sku: true } }, current_location: true },
      });
      if (!lpn) throw new NotFoundError('LPN', entityId);
      const skuLines = lpn.balances
        .filter((b) => b.qty > 0n)
        .map((b) => ({ sku: b.sku.code, description: b.sku.description, qty: b.qty.toString(), cases: '' }));
      const cases = lpn.cases_count ? String(lpn.cases_count) : '';
      if (skuLines.length === 1 && skuLines[0]) skuLines[0].cases = cases;
      const m: LpnLabelModel = {
        label_type: 'LPN',
        title: lpn.code,
        barcode: lpn.code,
        qr: lpn.code,
        lines: [
          { label: 'FECHA', value: fmtDate(lpn.created_at) },
          { label: 'RECEPCION', value: lpn.receipt?.receipt_number ?? '-' },
          { label: 'CONTENEDOR', value: lpn.container?.container_number ?? '-' },
          { label: 'PROVEEDOR', value: lpn.supplier?.name ?? '-' },
          { label: 'CAJAS', value: cases || '-' },
          ...(lpn.lot ? [{ label: 'LOTE', value: lpn.lot }] : []),
          ...(lpn.expiry_date ? [{ label: 'CADUCIDAD', value: lpn.expiry_date.toISOString().slice(0, 10) }] : []),
        ],
        sku_lines: skuLines,
        footer: `${skuLines.length} SKU(s) · ${lpn.current_location?.code ?? 'sin ubicar'}`,
      };
      return m;
    }
    case 'LOCATION': {
      const loc = await tx.locations.findFirst({ where: { OR: [{ id: isUuid(entityId) ? entityId : undefined }, { code: entityId.toUpperCase() }, { barcode: entityId }] }, include: { zone: true } });
      if (!loc) throw new NotFoundError('location', entityId);
      return {
        label_type: 'LOCATION',
        title: loc.code,
        barcode: loc.barcode,
        qr: loc.barcode,
        lines: [
          { label: 'TIPO', value: loc.location_type },
          { label: 'ZONA', value: loc.zone?.code ?? '-' },
          ...(loc.level ? [{ label: 'NIVEL', value: String(loc.level) }] : []),
          { label: 'CAP', value: `${loc.pallet_capacity} PLT / ${loc.max_weight_kg} kg` },
        ],
      };
    }
    case 'STAGING': {
      const loc = await tx.locations.findFirst({ where: { OR: [{ id: isUuid(entityId) ? entityId : undefined }, { code: entityId.toUpperCase() }] } });
      if (!loc || loc.location_type !== 'STAGING') throw new NotFoundError('staging location', entityId);
      const assignment = await tx.staging_assignments.findFirst({ where: { location_id: loc.id, released_at: null }, include: { order: { include: { customer: true } } } });
      return {
        label_type: 'STAGING',
        title: loc.code,
        barcode: loc.barcode,
        lines: [
          { label: 'PEDIDO', value: assignment?.order.order_number ?? 'LIBRE' },
          { label: 'CLIENTE', value: assignment?.order.customer.name ?? '-' },
          { label: 'DESTINO', value: assignment?.order.destination ?? '-' },
        ],
      };
    }
    case 'ORDER': {
      const order = await tx.orders.findFirst({ where: { OR: [{ id: isUuid(entityId) ? entityId : undefined }, { order_number: entityId }] }, include: { customer: true, lines: true } });
      if (!order) throw new NotFoundError('order', entityId);
      const total = order.lines.reduce((a, l) => a + l.required_qty, 0n);
      return {
        label_type: 'ORDER',
        title: order.order_number,
        barcode: `ORD-${order.order_number}`,
        qr: `ORD-${order.order_number}`,
        lines: [
          { label: 'CLIENTE', value: order.customer.name },
          { label: 'DESTINO', value: order.destination ?? '-' },
          { label: 'LINEAS', value: String(order.lines.length) },
          { label: 'PIEZAS', value: total.toString() },
          { label: 'PRIORIDAD', value: String(order.priority) },
        ],
      };
    }
    case 'SHIPMENT': {
      const sh = await tx.shipments.findFirst({ where: { OR: [{ id: isUuid(entityId) ? entityId : undefined }, { shipment_number: entityId }] }, include: { carrier: true, orders: true } });
      if (!sh) throw new NotFoundError('shipment', entityId);
      return {
        label_type: 'SHIPMENT',
        title: sh.shipment_number,
        barcode: `SHP-${sh.shipment_number}`,
        qr: `SHP-${sh.shipment_number}`,
        lines: [
          { label: 'TRANSPORTE', value: sh.carrier?.name ?? '-' },
          { label: 'UNIDAD', value: `${sh.vehicle ?? '-'} ${sh.plates ?? ''}`.trim() },
          { label: 'CHOFER', value: sh.driver_name ?? '-' },
          { label: 'PEDIDOS', value: String(sh.orders.length) },
          { label: 'DESTINO', value: sh.destination ?? '-' },
        ],
      };
    }
    case 'CASE': {
      // entityId = "<SKU_CODE>" or "<SKU_CODE>|<qty>"
      const [skuCode] = entityId.split('|');
      const sku = await tx.skus.findUnique({ where: { code: skuCode! }, include: { barcodes: true, uoms: true } });
      if (!sku) throw new NotFoundError('SKU', skuCode!);
      const caseBarcode = sku.barcodes.find((b) => b.uom_code === 'CASE')?.barcode ?? sku.barcodes[0]?.barcode ?? sku.code;
      const caseUom = sku.uoms.find((u) => u.uom_code === 'CASE');
      return {
        label_type: 'CASE',
        title: sku.code,
        barcode: caseBarcode,
        lines: [
          { label: 'DESC', value: sku.description },
          { label: 'CONTENIDO', value: caseUom ? `${caseUom.base_qty} PZA` : '-' },
          { label: 'FAMILIA', value: sku.family ?? '-' },
        ],
      };
    }
  }
}

/** PNG preview (data URL) rendered from the same model — barcode via bwip-js. */
export async function renderPreview(model: LabelModel): Promise<{ zpl: string; barcode_png: string; qr_png: string | null }> {
  const zpl = renderZpl(model);
  const errors = validateZpl(zpl);
  if (errors.length) throw new RuleError('ZPL_INVALID', errors.join('; '));
  const barcode = await bwipjs.toBuffer({ bcid: 'code128', text: model.barcode, scale: 2, height: 12, includetext: true, textxalign: 'center' });
  const qr = model.qr ? await bwipjs.toBuffer({ bcid: 'qrcode', text: model.qr, scale: 3 }) : null;
  return {
    zpl,
    barcode_png: `data:image/png;base64,${barcode.toString('base64')}`,
    qr_png: qr ? `data:image/png;base64,${qr.toString('base64')}` : null,
  };
}

/** Sends raw ZPL to a Zebra printer over TCP 9100. */
export function sendToPrinter(host: string, port: number, zpl: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`printer ${host}:${port} timeout`));
    }, timeoutMs);
    socket.on('connect', () => {
      socket.write(zpl, 'utf8', () => {
        socket.end();
      });
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export interface PrintRequest {
  label_type: LabelType;
  entity_id: string;
  printer_id?: string;
  copies: number;
  reprint_reason?: string;
}

/**
 * Prints (or records a preview of) a label. Reprints are detected automatically
 * (a previous successful print of the same entity exists), require the
 * `labels.reprint` permission and a reason, and are audited.
 */
export async function printLabel(ctx: ActorContext, req: PrintRequest, mode: 'PRINT' | 'PREVIEW') {
  const db = getDb();
  const result = await withTx(async (tx) => {
    const model = await buildLabelModel(tx, req.label_type, req.entity_id);
    model.copies = req.copies;
    const zpl = renderZpl(model);
    const errors = validateZpl(zpl);
    if (errors.length) throw new RuleError('ZPL_INVALID', errors.join('; '));

    const lpnId = req.label_type === 'LPN' ? (await tx.lpns.findFirst({ where: { code: model.title } }))?.id ?? null : null;
    const previous = await tx.label_prints.count({ where: { label_type: req.label_type, entity_id: model.title, status: { in: ['SENT', 'QUEUED'] } } });
    const isReprint = previous > 0;
    if (mode === 'PRINT' && isReprint) {
      if (!ctx.permissions.has('labels.reprint')) throw new ForbiddenError('Reprinting labels requires the labels.reprint permission');
      if (!req.reprint_reason) throw new RuleError('REPRINT_REASON_REQUIRED', 'A reason is required to reprint a label');
    }
    let printer = null as null | { id: string; host: string; port: number; code: string };
    if (mode === 'PRINT') {
      printer = req.printer_id
        ? await tx.printers.findUnique({ where: { id: req.printer_id } })
        : await tx.printers.findFirst({ where: { is_default: true, is_active: true } });
      if (!printer) throw new RuleError('NO_PRINTER', 'No printer configured');
    }
    const row = await tx.label_prints.create({
      data: {
        label_type: req.label_type,
        entity_id: model.title,
        lpn_id: lpnId,
        printer_id: printer?.id ?? null,
        is_reprint: mode === 'PRINT' && isReprint,
        reprint_reason: mode === 'PRINT' ? (req.reprint_reason ?? null) : null,
        printed_by: ctx.userId,
        zpl,
        status: mode === 'PRINT' ? 'QUEUED' : 'PREVIEW',
      },
    });
    if (mode === 'PRINT') {
      await audit(tx, ctx, {
        action: isReprint ? 'label.reprint' : 'label.print',
        entity_type: 'label',
        entity_id: row.id,
        after: { label_type: req.label_type, entity: model.title, printer: printer?.code, copies: req.copies },
        reason: req.reprint_reason ?? null,
      });
    }
    return { row, model, zpl, printer };
  });

  if (mode === 'PREVIEW') {
    const preview = await renderPreview(result.model);
    return { print_id: result.row.id, model: result.model, ...preview, is_reprint: false };
  }

  try {
    await sendToPrinter(result.printer!.host, result.printer!.port, result.zpl);
    await db.label_prints.update({ where: { id: result.row.id }, data: { status: 'SENT' } });
    return { print_id: result.row.id, status: 'SENT', model: result.model, zpl: result.zpl, is_reprint: result.row.is_reprint };
  } catch (e) {
    await db.label_prints.update({ where: { id: result.row.id }, data: { status: 'FAILED', error: (e as Error).message } });
    throw new RuleError('PRINTER_UNREACHABLE', `Could not send label to printer: ${(e as Error).message}`, { print_id: result.row.id });
  }
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// ---------------------------------------------------------------------------
// Location labels in batch (a whole rack or zone): printable sheet for any
// office printer, ZPL file for Zebra, or direct print. Used to label a rack
// before it goes into operation.
// ---------------------------------------------------------------------------
export interface LocationBatchFilter { rack_id?: string; zone_id?: string; warehouse_id?: string }

export async function locationLabelBatch(filter: LocationBatchFilter) {
  const db = getDb();
  if (!filter.rack_id && !filter.zone_id && !filter.warehouse_id) throw new RuleError('FILTER_REQUIRED', 'Indique rack_id, zone_id o warehouse_id');
  const rows = await db.locations.findMany({
    where: { is_active: true, ...(filter.rack_id ? { rack_id: filter.rack_id } : {}), ...(filter.zone_id ? { zone_id: filter.zone_id } : {}), ...(filter.warehouse_id ? { warehouse_id: filter.warehouse_id } : {}) },
    include: { zone: true, rack: { include: { aisle: true } } },
    orderBy: [{ pick_sequence: 'asc' }, { code: 'asc' }],
  });
  if (!rows.length) throw new NotFoundError('locations', JSON.stringify(filter));
  const title = filter.rack_id && rows[0]?.rack ? `Rack ${rows[0].rack.aisle.code}-${rows[0].rack.code} · ${rows[0].zone?.name ?? ''}` : rows[0]?.zone ? `Zona ${rows[0].zone.code} · ${rows[0].zone.name}` : 'Ubicaciones';
  const models: LabelModel[] = rows.map((loc) => ({
    label_type: 'LOCATION',
    title: loc.code,
    barcode: loc.barcode,
    qr: loc.barcode,
    lines: [
      { label: 'TIPO', value: loc.location_type },
      { label: 'ZONA', value: loc.zone?.code ?? '-' },
      ...(loc.level ? [{ label: 'NIVEL', value: String(loc.level) }] : []),
      { label: 'CAP', value: `${loc.pallet_capacity} PLT / ${loc.max_weight_kg} kg` },
    ],
  }));
  return { title, rows, models };
}

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Self-contained HTML sheet (A4, 3 labels of 101.6 × 84 mm per page — the same stock as the company's other label apps) with Code128 barcodes as embedded PNGs. */
export async function locationLabelSheetHtml(filter: LocationBatchFilter): Promise<string> {
  const { title, rows } = await locationLabelBatch(filter);
  const cells: string[] = [];
  for (const loc of rows) {
    const png = await bwipjs.toBuffer({ bcid: 'code128', text: loc.barcode, scale: 3, height: 18, includetext: false });
    const levelTxt = loc.level ? `NIVEL ${loc.level}` : loc.location_type;
    const where = loc.rack ? `Pasillo ${esc(loc.rack.aisle.code)} · Rack ${esc(loc.rack.code)} · Módulo ${loc.bay ?? '-'} · Pos ${loc.position ?? '-'}` : `${esc(loc.zone?.name ?? '')}`;
    cells.push(`<div class="l"><div class="code">${esc(loc.code)}</div><img src="data:image/png;base64,${png.toString('base64')}" alt=""><div class="bc">${esc(loc.barcode)}</div><div class="meta"><b>${esc(levelTxt)}</b> · ${where}</div></div>`);
  }
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
@page{size:A4;margin:8mm}body{margin:0;font-family:Helvetica,Arial,sans-serif;color:#000}
.sheet{display:grid;grid-template-columns:101.6mm;gap:6mm;justify-content:center;padding:2mm}
.l{width:101.6mm;height:84mm;box-sizing:border-box;border:0.3mm dashed #888;padding:5mm 6mm;display:flex;flex-direction:column;align-items:center;justify-content:space-between;page-break-inside:avoid;break-inside:avoid}
.code{font-size:11mm;font-weight:900;letter-spacing:0.3mm;font-family:Menlo,Consolas,monospace;white-space:nowrap}
img{height:26mm;max-width:90mm}.bc{font-family:Menlo,Consolas,monospace;font-size:4.5mm}.meta{font-size:4.2mm;color:#222;text-align:center;line-height:1.35}
.hdr{padding:4mm 6mm 0;font-size:4mm;color:#444}@media print{.hdr{display:none}}
</style></head><body><div class="hdr">${esc(title)} · ${rows.length} etiquetas de 101.6 × 84 mm · imprimir al 100 % (sin ajustar a la página)</div><div class="sheet">${cells.join('')}</div></body></html>`;
}

/** Prints every location of a rack/zone on a Zebra printer, one label per position, in walking order. */
export async function printLocationBatch(ctx: ActorContext, filter: LocationBatchFilter, printerId?: string) {
  const { rows } = await locationLabelBatch(filter);
  let sent = 0;
  const failed: { code: string; error: string }[] = [];
  for (const loc of rows) {
    try {
      await printLabel(ctx, { label_type: 'LOCATION', entity_id: loc.code, printer_id: printerId, copies: 1, reprint_reason: 'Etiquetado de rack en lote' }, 'PRINT');
      sent++;
    } catch (e) {
      failed.push({ code: loc.code, error: (e as Error).message.slice(0, 120) });
      if (failed.length >= 3 && sent === 0) break; // printer clearly unreachable: stop early
    }
  }
  return { total: rows.length, sent, failed };
}
