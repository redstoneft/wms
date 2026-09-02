import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { UomTable, UomError, validateUomHierarchy } from './uom.js';

const table = new UomTable([
  { uom_code: 'PIECE', base_qty: 1n },
  { uom_code: 'CASE', base_qty: 6n },
  { uom_code: 'PALLET', base_qty: 240n },
]);

describe('UomTable', () => {
  it('converts exactly to base units', () => {
    expect(table.toBase(1n, 'PALLET')).toBe(240n);
    expect(table.toBase(3n, 'CASE')).toBe(18n);
    expect(table.toBase(7n, 'PIECE')).toBe(7n);
  });
  it('rejects negative quantities', () => {
    expect(() => table.toBase(-1n, 'CASE')).toThrow(UomError);
  });
  it('rejects unknown UoM for the SKU', () => {
    expect(() => table.toBase(1n, 'INNER')).toThrow(/not defined/);
  });
  it('fromBaseExact refuses partial units', () => {
    expect(table.fromBaseExact(12n, 'CASE')).toBe(2n);
    expect(() => table.fromBaseExact(13n, 'CASE')).toThrow(/not a whole number/);
  });
  it('breakdown uses the largest packaging first', () => {
    expect(table.breakdown(250n)).toEqual({ PALLET: 1n, CASE: 1n, PIECE: 4n });
    expect(table.format(250n)).toBe('1 PALLET + 1 CASE + 4 PIECE');
    expect(table.format(0n)).toBe('0 PIECE');
  });
  it('PIECE must be 1 and base quantities positive', () => {
    expect(() => new UomTable([{ uom_code: 'PIECE', base_qty: 2n }])).toThrow(UomError);
    expect(() => new UomTable([{ uom_code: 'CASE', base_qty: 0n }])).toThrow(UomError);
    expect(() => new UomTable([{ uom_code: 'CASE', base_qty: 6n }, { uom_code: 'CASE', base_qty: 12n }])).toThrow(/duplicate/);
  });
  it('validateUomHierarchy detects non-multiples and inversions', () => {
    expect(validateUomHierarchy([{ uom_code: 'PIECE', base_qty: 1n }, { uom_code: 'CASE', base_qty: 6n }, { uom_code: 'PALLET', base_qty: 100n }])).toHaveLength(1);
    expect(validateUomHierarchy([{ uom_code: 'PIECE', base_qty: 1n }, { uom_code: 'INNER', base_qty: 12n }, { uom_code: 'CASE', base_qty: 6n }]).length).toBeGreaterThan(0);
    expect(validateUomHierarchy([{ uom_code: 'PIECE', base_qty: 1n }, { uom_code: 'CASE', base_qty: 6n }, { uom_code: 'PALLET', base_qty: 240n }])).toEqual([]);
  });

  it('property: toBase then breakdown always reconstructs the same base quantity', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10_000n }), fc.bigInt({ min: 2n, max: 50n }), fc.bigInt({ min: 2n, max: 100n }), fc.bigInt({ min: 0n, max: 1_000_000n }), (_p, caseQ, palletCases, base) => {
        const t = new UomTable([
          { uom_code: 'PIECE', base_qty: 1n },
          { uom_code: 'CASE', base_qty: caseQ },
          { uom_code: 'PALLET', base_qty: caseQ * palletCases },
        ]);
        const b = t.breakdown(base);
        const back = (b.PALLET ?? 0n) * caseQ * palletCases + (b.CASE ?? 0n) * caseQ + (b.PIECE ?? 0n);
        return back === base && (b.CASE ?? 0n) < palletCases && (b.PIECE ?? 0n) < caseQ;
      }),
    );
  });

  it('property: conversions are exact integers (no rounding ever)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 12n }), fc.bigInt({ min: 1n, max: 1000n }), (qty, factor) => {
        const t = new UomTable([{ uom_code: 'PIECE', base_qty: 1n }, { uom_code: 'CASE', base_qty: factor }]);
        const base = t.toBase(qty, 'CASE');
        return t.fromBaseExact(base, 'CASE') === qty;
      }),
    );
  });
});
