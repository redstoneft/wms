// Label models and ZPL generation for Zebra printers (203 dpi default).
// Pure functions: the API renders ZPL for printing and the same model is used
// by the web client for the on-screen preview.

import type { LabelType } from './enums.js';

export interface LabelModelBase {
  label_type: LabelType;
  /** primary human-readable identifier printed large */
  title: string;
  /** barcode payload (Code 128) */
  barcode: string;
  /** optional QR payload */
  qr?: string;
  lines: { label: string; value: string }[];
  footer?: string;
  copies?: number;
}

export interface LpnLabelModel extends LabelModelBase {
  label_type: 'LPN';
  sku_lines: { sku: string; description: string; qty: string; cases: string }[];
}

export type LabelModel = LabelModelBase | LpnLabelModel;

export interface LabelDimensions {
  width_mm: number;
  height_mm: number;
  dpi: 203 | 300;
}

/** Same stock as the company's other label apps (HEB/Alsuper/Casa Ley templates): 101.6 × 84 mm = 812 × 671 dots @203 dpi. */
export const DEFAULT_LABEL: LabelDimensions = { width_mm: 101.6, height_mm: 84, dpi: 203 };

const mmToDots = (mm: number, dpi: number) => Math.round((mm / 25.4) * dpi);

/** ZPL field data must not contain control characters: ^ ~ and \ are escaped via ^FH hex. */
export function zplEscape(s: string): string {
  // Use ^FH (hex field) with '_' as indicator. Replace non printable and special chars.
  return s
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/_/g, '_5F')
    .replace(/\^/g, '_5E')
    .replace(/~/g, '_7E')
    .replace(/\\/g, '_5C')
    .replace(/[^\x20-\x7E_]/g, (ch) => {
      // encode UTF-8 bytes as hex (printer must have ^CI28)
      const bytes = new TextEncoder().encode(ch);
      return Array.from(bytes)
        .map((b) => '_' + b.toString(16).toUpperCase().padStart(2, '0'))
        .join('');
    });
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Renders a label model into ZPL II.
 * Layout (101.6 × 84 mm @203 dpi = 812 × 671 dots), top to bottom:
 *  - header band with the label type
 *  - title (large)
 *  - Code128 barcode with human-readable text
 *  - key/value lines (two columns when there are many), QR at the right
 *  - LPN: compact SKU table with as many rows as fit
 *  - footer on the last line
 * Every block is placed from a running `y`, so the label never overflows the stock.
 */
export function renderZpl(model: LabelModel, dims: LabelDimensions = DEFAULT_LABEL): string {
  const W = mmToDots(dims.width_mm, dims.dpi);
  const H = mmToDots(dims.height_mm, dims.dpi);
  const margin = mmToDots(3, dims.dpi);
  const scale = dims.dpi / 203;
  const s = (n: number) => Math.round(n * scale);
  const copies = Math.max(1, Math.min(10, model.copies ?? 1));
  const isLpn = model.label_type === 'LPN' && 'sku_lines' in model;
  const bottom = H - margin - (model.footer ? s(26) : 0); // usable bottom edge

  const out: string[] = [];
  out.push('^XA');
  out.push('^CI28'); // UTF-8
  out.push(`^PW${W}`);
  out.push(`^LL${H}`);
  out.push('^LH0,0');
  out.push(`^PQ${copies}`);

  // header band
  out.push(`^FO${margin},${margin}^GB${W - 2 * margin},${s(38)},${s(38)}^FS`);
  out.push(`^FO${margin + s(12)},${margin + s(6)}^FR^A0N,${s(28)},${s(28)}^FH^FD${zplEscape(model.label_type)}^FS`);

  // title large (shrinks for long codes such as ALM-A-R01-N02-P05)
  let y = margin + s(46);
  const titleSize = model.title.length > 18 ? s(52) : model.title.length > 12 ? s(64) : s(80);
  out.push(`^FO${margin},${y}^A0N,${titleSize},${titleSize}^FH^FD${zplEscape(truncate(model.title, 24))}^FS`);
  y += titleSize + s(8);

  // barcode Code128 (with text below); shorter on LPN labels to leave room for the SKU table
  const bcHeight = isLpn ? s(70) : s(95);
  out.push(`^BY${Math.max(2, s(3))},3,${bcHeight}`);
  out.push(`^FO${margin},${y}^BCN,${bcHeight},Y,N,N^FH^FD${zplEscape(model.barcode)}^FS`);
  y += bcHeight + s(36);

  // QR at the right of the lines block
  const qrW = model.qr ? s(150) : 0;
  if (model.qr) out.push(`^FO${W - margin - qrW},${y}^BQN,2,${s(5)}^FH^FDLA,${zplEscape(model.qr)}^FS`);

  // key/value lines: one column, or two columns when there are more than 4
  const lineH = s(26);
  const twoCols = model.lines.length > 4;
  const colW = twoCols ? Math.floor((W - 2 * margin - qrW) / 2) : W - 2 * margin - qrW;
  const perCol = twoCols ? Math.ceil(model.lines.length / 2) : model.lines.length;
  model.lines.forEach((l, i) => {
    const col = twoCols ? Math.floor(i / perCol) : 0;
    const row = twoCols ? i % perCol : i;
    const x = margin + col * colW;
    const ly = y + row * lineH;
    if (ly + lineH > bottom) return;
    out.push(`^FO${x},${ly}^A0N,${s(20)},${s(20)}^FH^FD${zplEscape(truncate(l.label, 10))}:^FS`);
    out.push(`^FO${x + s(120)},${ly}^A0N,${s(24)},${s(24)}^FH^FD${zplEscape(truncate(l.value, twoCols ? 16 : 30))}^FS`);
  });
  y += perCol * lineH;
  if (model.qr) y = Math.max(y, margin + s(46) + titleSize + s(8) + bcHeight + s(36) + qrW);

  // SKU table for LPN labels: only the rows that fit
  if (isLpn) {
    y += s(6);
    out.push(`^FO${margin},${y}^GB${W - 2 * margin},2,2^FS`);
    y += s(6);
    out.push(`^FO${margin},${y}^A0N,${s(20)},${s(20)}^FDSKU^FS`);
    out.push(`^FO${margin + s(250)},${y}^A0N,${s(20)},${s(20)}^FDDESCRIPCION^FS`);
    out.push(`^FO${W - margin - s(170)},${y}^A0N,${s(20)},${s(20)}^FDCANT^FS`);
    out.push(`^FO${W - margin - s(70)},${y}^A0N,${s(20)},${s(20)}^FDCJS^FS`);
    y += s(24);
    const rowH = s(26);
    const fit = Math.max(0, Math.floor((bottom - y - s(22)) / rowH));
    const shown = model.sku_lines.slice(0, Math.min(fit, model.sku_lines.length));
    for (const sl of shown) {
      out.push(`^FO${margin},${y}^A0N,${s(22)},${s(22)}^FH^FD${zplEscape(truncate(sl.sku, 16))}^FS`);
      out.push(`^FO${margin + s(250)},${y}^A0N,${s(20)},${s(20)}^FH^FD${zplEscape(truncate(sl.description, 22))}^FS`);
      out.push(`^FO${W - margin - s(170)},${y}^A0N,${s(22)},${s(22)}^FH^FD${zplEscape(sl.qty)}^FS`);
      out.push(`^FO${W - margin - s(70)},${y}^A0N,${s(22)},${s(22)}^FH^FD${zplEscape(sl.cases)}^FS`);
      y += rowH;
    }
    if (model.sku_lines.length > shown.length) {
      out.push(`^FO${margin},${y}^A0N,${s(20)},${s(20)}^FD+${model.sku_lines.length - shown.length} mas^FS`);
    }
  }

  // footer
  if (model.footer) {
    out.push(`^FO${margin},${H - margin - s(24)}^A0N,${s(20)},${s(20)}^FH^FD${zplEscape(truncate(model.footer, 70))}^FS`);
  }

  out.push('^XZ');
  return out.join('\n');
}

/** Basic structural validation of generated ZPL (used by tests and print service). */
export function validateZpl(zpl: string): string[] {
  const errors: string[] = [];
  if (!zpl.startsWith('^XA')) errors.push('missing ^XA');
  if (!zpl.trimEnd().endsWith('^XZ')) errors.push('missing ^XZ');
  const fo = (zpl.match(/\^FO/g) ?? []).length;
  const fs = (zpl.match(/\^FS/g) ?? []).length;
  if (fo !== fs) errors.push(`unbalanced fields: ${fo} ^FO vs ${fs} ^FS`);
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(zpl)) errors.push('control characters present');
  return errors;
}
