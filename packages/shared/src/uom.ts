// Exact, auditable unit-of-measure conversions.
// All inventory quantities are stored in the base unit (PIECE) as bigint.
// Conversions are integers only: 1 PALLET = 40 CASE, 1 CASE = 6 PIECE ⇒
// PALLET.base_qty = 240, CASE.base_qty = 6, PIECE.base_qty = 1.

import type { UomCode } from './enums.js';

export interface UomDefinition {
  uom_code: UomCode;
  /** how many base units (PIECE) one unit of this UoM contains */
  base_qty: bigint;
}

export class UomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UomError';
  }
}

export class UomTable {
  private readonly map: Map<UomCode, bigint>;

  constructor(defs: readonly UomDefinition[]) {
    this.map = new Map();
    for (const d of defs) {
      if (d.base_qty <= 0n) throw new UomError(`base_qty must be > 0 for ${d.uom_code}`);
      if (d.uom_code === 'PIECE' && d.base_qty !== 1n) throw new UomError('PIECE base_qty must be 1');
      if (this.map.has(d.uom_code)) throw new UomError(`duplicate uom ${d.uom_code}`);
      this.map.set(d.uom_code, d.base_qty);
    }
    if (!this.map.has('PIECE')) this.map.set('PIECE', 1n);
  }

  has(code: UomCode): boolean {
    return this.map.has(code);
  }

  baseQty(code: UomCode): bigint {
    const v = this.map.get(code);
    if (v === undefined) throw new UomError(`UoM ${code} not defined for SKU`);
    return v;
  }

  /** qty expressed in `code` → base units. Exact. */
  toBase(qty: bigint, code: UomCode): bigint {
    if (qty < 0n) throw new UomError('quantity must be >= 0');
    return qty * this.baseQty(code);
  }

  /**
   * base units → qty in `code`. Only exact conversions are allowed; a remainder
   * is an error (the caller must handle partial units explicitly).
   */
  fromBaseExact(base: bigint, code: UomCode): bigint {
    const f = this.baseQty(code);
    if (base % f !== 0n) throw new UomError(`${base} base units is not a whole number of ${code}`);
    return base / f;
  }

  /** base units → { whole units of code, remainder in base units } */
  fromBase(base: bigint, code: UomCode): { qty: bigint; remainder: bigint } {
    const f = this.baseQty(code);
    return { qty: base / f, remainder: base % f };
  }

  /**
   * Break a base quantity down into the largest packaging first:
   * e.g. 250 pieces with PALLET=240, CASE=6 → 1 PALLET, 1 CASE, 4 PIECE.
   */
  breakdown(base: bigint): Partial<Record<UomCode, bigint>> {
    if (base < 0n) throw new UomError('quantity must be >= 0');
    const ordered = [...this.map.entries()].sort((a, b) => (a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0));
    const out: Partial<Record<UomCode, bigint>> = {};
    let rest = base;
    for (const [code, f] of ordered) {
      const n = rest / f;
      if (n > 0n) {
        out[code] = n;
        rest -= n * f;
      }
    }
    return out;
  }

  /** Human readable, e.g. "1 PALLET + 1 CASE + 4 PIECE". */
  format(base: bigint): string {
    const b = this.breakdown(base);
    const parts = (Object.keys(b) as UomCode[]).map((k) => `${b[k]} ${k}`);
    return parts.length ? parts.join(' + ') : '0 PIECE';
  }
}

/** Validates that a set of UoM definitions is coherent (bigger units are multiples of smaller). */
export function validateUomHierarchy(defs: readonly UomDefinition[]): string[] {
  const errors: string[] = [];
  const t = new UomTable(defs);
  const order: UomCode[] = ['PIECE', 'INNER', 'CASE', 'PALLET'];
  const present = order.filter((c) => t.has(c));
  for (let i = 1; i < present.length; i++) {
    const small = present[i - 1]!;
    const big = present[i]!;
    if (t.baseQty(big) % t.baseQty(small) !== 0n) {
      errors.push(`${big} (${t.baseQty(big)}) is not a multiple of ${small} (${t.baseQty(small)})`);
    }
    if (t.baseQty(big) <= t.baseQty(small)) {
      errors.push(`${big} must be larger than ${small}`);
    }
  }
  return errors;
}
