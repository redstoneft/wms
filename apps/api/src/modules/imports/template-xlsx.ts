// Excel template for a bulk import: the data sheet plus the reference catalogues the person filling it needs
// (our SKUs with every SAE key/GTIN, the location codes, customers/suppliers) and a filling guide.
// The import parser reads only the FIRST sheet, so the data sheet must stay first.
import ExcelJS from 'exceljs';
import type { ImportType } from '@wms/shared';
import { getDb } from '../../db.js';
import { TEMPLATES } from './service.js';

type Help = { desc: string; required: boolean; example: string };

const GENERIC_HELP: Record<string, Help> = {
  sku: { desc: 'Código WMS del producto o cualquiera de sus alias: clave de SAE tal como viene en la caja o GTIN. Ver pestaña SKUs.', required: true, example: '636570' },
  qty: { desc: 'Cantidad contada, número entero sin decimales, en la unidad indicada en uom_code.', required: true, example: '40' },
  uom_code: { desc: 'Unidad de la cantidad: PIECE (piezas), CASE (cajas), INNER, PALLET. Vacío = PIECE.', required: false, example: 'CASE' },
  pieces_per_case: { desc: 'Solo con uom_code = CASE: cuántas piezas trae cada caja contada en ESTA fila. Un mismo artículo puede venir con distinto factor de empaque, por eso se escribe aquí y no se toma del catálogo. Si se deja vacío se usa "Piezas por caja" de la pestaña SKUs.', required: false, example: '6' },
  location_code: { desc: 'Código de la ubicación tal como está en su etiqueta, sin el prefijo LOC-. Ver pestaña Ubicaciones.', required: true, example: 'ALM-A-R01-N01-P01' },
  lot: { desc: 'Lote impreso en el producto. Obligatorio solo si el SKU requiere lote (pestaña SKUs).', required: false, example: 'L2409' },
  expiry_date: { desc: 'Caducidad en formato AAAA-MM-DD. Obligatoria solo si el SKU requiere caducidad.', required: false, example: '2027-03-31' },
  lpn: { desc: 'Identificador del pallet. Vacío = el sistema genera un LPN nuevo por fila. Repite el mismo texto en varias filas para un pallet mixto (varios productos en la misma tarima).', required: false, example: 'TARIMA-07' },
  customer_code: { desc: 'Código del cliente. Ver pestaña Clientes.', required: true, example: 'CLI-001' },
  supplier_code: { desc: 'Código del proveedor. Ver pestaña Proveedores.', required: true, example: 'PROV-001' },
  order_number: { desc: 'Número de pedido; las filas con el mismo número forman un pedido.', required: true, example: 'PED-48571' },
  po_number: { desc: 'Número de orden de compra; las filas con el mismo número forman una OC.', required: true, example: 'OC-2026-001' },
  order_date: { desc: 'Fecha AAAA-MM-DD.', required: false, example: '2026-09-01' },
  expected_date: { desc: 'Fecha esperada de llegada AAAA-MM-DD.', required: false, example: '2026-09-15' },
  priority: { desc: 'Prioridad 1 (urgente) a 5.', required: false, example: '3' },
  destination: { desc: 'Destino o sucursal.', required: false, example: 'CEDIS Monterrey' },
  barcode: { desc: 'Código de barras completo.', required: true, example: '7501234567890' },
  description: { desc: 'Descripción del producto.', required: true, example: 'Olla express 6L' },
};
const REQUIRED_BY_TYPE: Partial<Record<ImportType, string[]>> = {
  INITIAL_INVENTORY: ['location_code', 'sku', 'qty'],
  ORDERS: ['order_number', 'customer_code', 'sku', 'qty'],
  PURCHASE_ORDERS: ['po_number', 'supplier_code', 'sku', 'qty'],
  BARCODES: ['sku', 'barcode'],
  SKUS: ['sku', 'description'],
};

const HEAD_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
const REQ_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } };

function styleHeader(ws: ExcelJS.Worksheet, n: number) {
  const row = ws.getRow(1);
  for (let c = 1; c <= n; c++) {
    const cell = row.getCell(c);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = HEAD_FILL;
    cell.alignment = { vertical: 'middle' };
  }
  row.height = 20;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: n } };
}

export interface XlsxTemplateSummary {
  sheets: string[];
  skus: number;
  locations: number;
}

export async function templateXlsx(type: ImportType): Promise<{ buffer: Buffer; summary: XlsxTemplateSummary }> {
  const db = getDb();
  const t = TEMPLATES[type];
  const required = new Set(REQUIRED_BY_TYPE[type] ?? t.columns.slice(0, 2));
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WMS';
  wb.created = new Date();

  // 1) data sheet — first, header only (the example lives in Instrucciones so it is never imported by accident)
  const data = wb.addWorksheet(type, { properties: { tabColor: { argb: 'FF1F3A5F' } } });
  data.columns = t.columns.map((c) => ({ header: c, key: c, width: Math.max(16, c.length + 4) }));
  styleHeader(data, t.columns.length);
  t.columns.forEach((c, i) => {
    if (required.has(c)) data.getRow(1).getCell(i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB45309' } };
    if (c === 'expiry_date' || c.endsWith('_date')) data.getColumn(i + 1).numFmt = '@';
    if (c === 'sku' || c === 'barcode' || c === 'lot' || c === 'lpn' || c === 'location_code') data.getColumn(i + 1).numFmt = '@'; // keep leading zeros
  });
  const DATA_ROWS = 2000;
  const uomCol = t.columns.indexOf('uom_code');
  if (uomCol >= 0) {
    for (let r = 2; r <= DATA_ROWS; r++) {
      data.getCell(r, uomCol + 1).dataValidation = { type: 'list', allowBlank: true, formulae: ['"PIECE,CASE,INNER,PALLET"'], showErrorMessage: true, errorStyle: 'stop', errorTitle: 'Unidad', error: 'Usa PIECE, CASE, INNER o PALLET (o deja vacío = piezas).' };
    }
  }
  for (const [name, title] of [['qty', 'Cantidad'], ['pieces_per_case', 'Piezas por caja']] as const) {
    const col = t.columns.indexOf(name);
    if (col < 0) continue;
    for (let r = 2; r <= DATA_ROWS; r++) {
      data.getCell(r, col + 1).dataValidation = { type: 'whole', operator: 'greaterThan', formulae: [0], showErrorMessage: true, errorStyle: 'stop', errorTitle: title, error: 'Número entero mayor que cero.' };
    }
  }

  const sheets: string[] = [type];
  let skuCount = 0;
  let locCount = 0;

  // 2) SKUs catalogue (every file that references a product, except the SKU catalogue import itself)
  if (t.columns.includes('sku') && type !== 'SKUS') {
    const skus = await db.skus.findMany({ where: { is_active: true }, orderBy: { code: 'asc' }, include: { barcodes: { orderBy: { barcode: 'asc' } }, uoms: true } });
    skuCount = skus.length;
    const ws = wb.addWorksheet('SKUs', { properties: { tabColor: { argb: 'FF2F7D4F' } } });
    ws.columns = [
      { header: 'Código WMS', key: 'code', width: 22 },
      { header: 'Descripción', key: 'desc', width: 48 },
      { header: 'GTIN', key: 'gtin', width: 16 },
      { header: 'Claves SAE / alias (cualquiera sirve en la columna sku)', key: 'alias', width: 52 },
      { header: 'Piezas por caja', key: 'case', width: 14 },
      { header: 'Cajas por pallet', key: 'pallet', width: 14 },
      { header: 'Requiere lote', key: 'lot', width: 12 },
      { header: 'Requiere caducidad', key: 'exp', width: 16 },
      { header: 'Familia', key: 'family', width: 18 },
      { header: 'Modelo', key: 'model', width: 18 },
    ];
    styleHeader(ws, 10);
    ws.getColumn('gtin').numFmt = '@';
    ws.getColumn('alias').numFmt = '@';
    for (const s of skus) {
      const caseQ = s.uoms.find((u) => u.uom_code === 'CASE')?.base_qty;
      const palletQ = s.uoms.find((u) => u.uom_code === 'PALLET')?.base_qty;
      const alias = s.barcodes.map((b) => b.barcode).filter((b) => b !== s.code && b !== s.gtin);
      ws.addRow({
        code: s.code,
        desc: s.description,
        gtin: s.gtin ?? '',
        alias: alias.join(' ; '),
        case: caseQ ? Number(caseQ) : '',
        pallet: caseQ && palletQ ? Number(palletQ / caseQ) : '',
        lot: s.requires_lot ? 'SÍ' : 'no',
        exp: s.requires_expiry ? 'SÍ' : 'no',
        family: s.family ?? '',
        model: s.model_code ?? '',
      });
    }
    sheets.push('SKUs');
    const skuCol = t.columns.indexOf('sku');
    if (skuCount > 0 && skuCol >= 0) {
      // warning (not stop): aliases typed from the box are valid too
      for (let r = 2; r <= DATA_ROWS; r++) {
        data.getCell(r, skuCol + 1).dataValidation = { type: 'list', allowBlank: true, formulae: [`SKUs!$A$2:$A$${skuCount + 1}`], showErrorMessage: true, errorStyle: 'warning', errorTitle: 'SKU no está en la lista', error: 'No coincide con un Código WMS. Si es una clave de SAE o un GTIN de la pestaña SKUs, acepta; si no, revísalo.' };
      }
    }
  }

  // 3) Locations catalogue
  if (t.columns.includes('location_code')) {
    const locs = await db.locations.findMany({ where: { is_active: true, admin_status: 'ACTIVE' }, orderBy: { code: 'asc' }, include: { zone: { select: { code: true, name: true } }, warehouse: { select: { code: true } } } });
    locCount = locs.length;
    const ws = wb.addWorksheet('Ubicaciones', { properties: { tabColor: { argb: 'FFB45309' } } });
    ws.columns = [
      { header: 'Código (location_code)', key: 'code', width: 24 },
      { header: 'Tipo', key: 'type', width: 12 },
      { header: 'Zona', key: 'zone', width: 22 },
      { header: 'Almacén', key: 'wh', width: 12 },
      { header: 'Módulo', key: 'bay', width: 8 },
      { header: 'Nivel', key: 'level', width: 8 },
      { header: 'Posición', key: 'pos', width: 8 },
    ];
    styleHeader(ws, 7);
    for (const l of locs) {
      ws.addRow({ code: l.code, type: l.location_type, zone: l.zone ? `${l.zone.code} · ${l.zone.name}` : '', wh: l.warehouse.code, bay: l.bay ?? '', level: l.level ?? '', pos: l.position ?? '' });
    }
    sheets.push('Ubicaciones');
    const locCol = t.columns.indexOf('location_code');
    if (locCount > 0 && locCol >= 0) {
      for (let r = 2; r <= DATA_ROWS; r++) {
        data.getCell(r, locCol + 1).dataValidation = { type: 'list', allowBlank: true, formulae: [`Ubicaciones!$A$2:$A$${locCount + 1}`], showErrorMessage: true, errorStyle: 'stop', errorTitle: 'Ubicación', error: 'La ubicación no existe. Copia el código exacto de la pestaña Ubicaciones.' };
      }
    }
  }

  // 4) Customers / suppliers
  if (t.columns.includes('customer_code')) {
    const rows = await db.customers.findMany({ where: { is_active: true }, orderBy: { code: 'asc' }, select: { code: true, name: true, tax_id: true } });
    const ws = wb.addWorksheet('Clientes');
    ws.columns = [{ header: 'Código (customer_code)', key: 'code', width: 22 }, { header: 'Nombre', key: 'name', width: 44 }, { header: 'RFC', key: 'tax_id', width: 16 }];
    styleHeader(ws, 3);
    rows.forEach((r) => ws.addRow({ code: r.code, name: r.name, tax_id: r.tax_id ?? '' }));
    sheets.push('Clientes');
  }
  if (t.columns.includes('supplier_code')) {
    const rows = await db.suppliers.findMany({ where: { is_active: true }, orderBy: { code: 'asc' }, select: { code: true, name: true, tax_id: true } });
    const ws = wb.addWorksheet('Proveedores');
    ws.columns = [{ header: 'Código (supplier_code)', key: 'code', width: 22 }, { header: 'Nombre', key: 'name', width: 44 }, { header: 'RFC', key: 'tax_id', width: 16 }];
    styleHeader(ws, 3);
    rows.forEach((r) => ws.addRow({ code: r.code, name: r.name, tax_id: r.tax_id ?? '' }));
    sheets.push('Proveedores');
  }

  // 5) Instructions
  const ins = wb.addWorksheet('Instrucciones', { properties: { tabColor: { argb: 'FF6B7280' } } });
  ins.columns = [
    { header: 'Columna', key: 'col', width: 18 },
    { header: 'Obligatoria', key: 'req', width: 12 },
    { header: 'Qué se captura', key: 'desc', width: 90 },
    { header: 'Ejemplo', key: 'ex', width: 22 },
  ];
  styleHeader(ins, 4);
  t.columns.forEach((c, i) => {
    const h = GENERIC_HELP[c];
    const row = ins.addRow({ col: c, req: required.has(c) ? 'SÍ' : 'no', desc: h?.desc ?? t.description, ex: h?.example ?? t.example[i] ?? '' });
    if (required.has(c)) row.getCell(2).fill = REQ_FILL;
    row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
  });
  ins.addRow({});
  const notes = [
    `Captura solo en la pestaña "${type}" (la primera). El sistema ignora las demás pestañas: son catálogos de consulta.`,
    'No cambies ni muevas los encabezados de la fila 1. Una fila por registro; sin filas vacías intermedias.',
    'Guarda como .xlsx y súbelo en WMS → Importaciones → tipo ' + type + '. Primero "Validar": si hay un solo error en cualquier fila, no se aplica nada.',
    'Corrige los errores que marque (fila y columna), vuelve a subir, valida de nuevo y entonces "Aplicar". Un mismo archivo no se puede aplicar dos veces.',
  ];
  if (type === 'INITIAL_INVENTORY') {
    notes.push(
      'Cada fila (o grupo de filas con el mismo lpn) crea una tarima real con etiqueta LPN. Imprime esas etiquetas en Etiquetas → LPN y pégalas en la tarima.',
      'Si contaste cajas: uom_code = CASE, qty = número de cajas y pieces_per_case = piezas que trae cada caja de esa fila (el mismo artículo puede venir en cajas de distinto tamaño). Piezas = qty × pieces_per_case.',
      'Una ubicación puede tener varias filas (varios productos). Una tarima mixta = mismo lpn en varias filas y misma ubicación.',
    );
  }
  notes.forEach((n, i) => {
    const row = ins.addRow({ col: `Paso ${i + 1}`, desc: n });
    row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
    row.getCell(1).font = { bold: true };
  });
  sheets.push('Instrucciones');

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, summary: { sheets, skus: skuCount, locations: locCount } };
}
