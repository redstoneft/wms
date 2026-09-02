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

export const DEFAULT_LABEL: LabelDimensions = { width_mm: 100, height_mm: 150, dpi: 203 };

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
 * Layout (100x150 mm @203dpi = 800x1200 dots):
 *  - header type band
 *  - title (large)
 *  - Code128 barcode
 *  - key/value lines
 *  - optional QR bottom-right
 */
export function renderZpl(model: LabelModel, dims: LabelDimensions = DEFAULT_LABEL): string {
  const W = mmToDots(dims.width_mm, dims.dpi);
  const H = mmToDots(dims.height_mm, dims.dpi);
  const margin = mmToDots(4, dims.dpi);
  const scale = dims.dpi / 203;
  const s = (n: number) => Math.round(n * scale);
  const copies = Math.max(1, Math.min(10, model.copies ?? 1));

  const out: string[] = [];
  out.push('^XA');
  out.push('^CI28'); // UTF-8
  out.push(`^PW${W}`);
  out.push(`^LL${H}`);
  out.push('^LH0,0');
  out.push(`^PQ${copies}`);

  // header band
  out.push(`^FO${margin},${margin}^GB${W - 2 * margin},${s(60)},${s(60)}^FS`);
  out.push(`^FO${margin + s(15)},${margin + s(12)}^FR^A0N,${s(40)},${s(40)}^FH^FD${zplEscape(model.label_type)}^FS`);

  // title large
  let y = margin + s(80);
  const titleSize = model.title.length > 14 ? s(70) : s(95);
  out.push(`^FO${margin},${y}^A0N,${titleSize},${titleSize}^FH^FD${zplEscape(truncate(model.title, 22))}^FS`);
  y += titleSize + s(15);

  // barcode Code128, height 140 dots
  const bcHeight = s(140);
  out.push(`^BY${Math.max(2, s(3))},3,${bcHeight}`);
  out.push(`^FO${margin},${y}^BCN,${bcHeight},Y,N,N^FH^FD${zplEscape(model.barcode)}^FS`);
  y += bcHeight + s(60);

  // lines
  const lineH = s(34);
  for (const l of model.lines) {
    out.push(`^FO${margin},${y}^A0N,${s(28)},${s(28)}^FH^FD${zplEscape(truncate(l.label, 14))}:^FS`);
    out.push(`^FO${margin + s(230)},${y}^A0N,${s(30)},${s(30)}^FH^FD${zplEscape(truncate(l.value, 30))}^FS`);
    y += lineH;
  }

  // SKU table for LPN labels
  if (model.label_type === 'LPN' && 'sku_lines' in model) {
    y += s(10);
    out.push(`^FO${margin},${y}^GB${W - 2 * margin},2,2^FS`);
    y += s(10);
    out.push(`^FO${margin},${y}^A0N,${s(24)},${s(24)}^FDSKU^FS`);
    out.push(`^FO${margin + s(280)},${y}^A0N,${s(24)},${s(24)}^FDDESCRIPCION^FS`);
    out.push(`^FO${W - margin - s(200)},${y}^A0N,${s(24)},${s(24)}^FDCANT^FS`);
    out.push(`^FO${W - margin - s(80)},${y}^A0N,${s(24)},${s(24)}^FDCJS^FS`);
    y += s(28);
    for (const sl of model.sku_lines.slice(0, 6)) {
      out.push(`^FO${margin},${y}^A0N,${s(26)},${s(26)}^FH^FD${zplEscape(truncate(sl.sku, 16))}^FS`);
      out.push(`^FO${margin + s(280)},${y}^A0N,${s(24)},${s(24)}^FH^FD${zplEscape(truncate(sl.description, 22))}^FS`);
      out.push(`^FO${W - margin - s(200)},${y}^A0N,${s(26)},${s(26)}^FH^FD${zplEscape(sl.qty)}^FS`);
      out.push(`^FO${W - margin - s(80)},${y}^A0N,${s(26)},${s(26)}^FH^FD${zplEscape(sl.cases)}^FS`);
      y += s(30);
    }
    if (model.sku_lines.length > 6) {
      out.push(`^FO${margin},${y}^A0N,${s(22)},${s(22)}^FD+${model.sku_lines.length - 6} mas^FS`);
      y += s(26);
    }
  }

  // QR bottom-right
  if (model.qr) {
    const qrSize = s(6);
    out.push(`^FO${W - margin - s(180)},${H - margin - s(200)}^BQN,2,${qrSize}^FH^FDLA,${zplEscape(model.qr)}^FS`);
  }

  // footer
  if (model.footer) {
    out.push(`^FO${margin},${H - margin - s(30)}^A0N,${s(22)},${s(22)}^FH^FD${zplEscape(truncate(model.footer, 60))}^FS`);
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
